import {
  PendingAccountSelectionCandidate,
  PendingAccountSelectionDraft,
  PendingTransactionService,
} from '../services/pendingTransactionService.js';
import {
  WalletMcpClientService,
  isWalletMcpDefinitiveFailure,
} from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import {
  IncomingUserMessageEvent,
  MessagingGatewayService,
  SupportedMessengerChannel,
} from '../services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../types/walletTypes.js';
import {
  AccountResolutionIssue,
  validateAndSanitizeFinancialRecords,
} from '../utils/recordValidator.js';
import { formatRecordSuccessMessage } from '../utils/humanResponseFormatter.js';
import { detectPendingConfirmationAction } from '../utils/fastPathIntentDetector.js';
import {
  formatAccountSelectionCancellation,
  formatAccountSelectionProcessing,
  formatAccountSelectionPrompt,
  formatAccountSelectionRetry,
  formatAccountSelectionUnknownOutcome,
} from '../utils/accountClarificationFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';
import { WalletRecordPreparationService } from '../services/walletRecordPreparationService.js';
import { CategoryContextService } from '../services/categoryContextService.js';
import { AccountClarificationConversationService } from '../services/ai/index.js';

export class AccountClarificationHandler {
  private readonly recordPreparationService: WalletRecordPreparationService;
  private readonly conversationService: AccountClarificationConversationService;
  private readonly promptInFlightTicketIds = new Set<number>();
  private readonly promptDeliveryPromises = new Map<number, Promise<void>>();

  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    recordPreparationService?: WalletRecordPreparationService,
    private readonly categoryContextService?: CategoryContextService,
    conversationService?: AccountClarificationConversationService
  ) {
    this.recordPreparationService =
      recordPreparationService ||
      new WalletRecordPreparationService(walletCacheService, walletMcpClient);
    this.conversationService =
      conversationService ||
      new AccountClarificationConversationService();
  }

  public async createPendingAccountSelectionDraft(
    event: IncomingUserMessageEvent,
    originalRecords: CreateRecordInputPayload[],
    accountResolutionIssues: AccountResolutionIssue[],
    availableAccounts: WalletAccountItem[],
    availableCategories: WalletCategoryItem[],
    requestReferenceInstant: Date = new Date()
  ): Promise<boolean> {
    const firstIssue = this.getFirstAccountResolutionIssue(accountResolutionIssues);
    if (!firstIssue || !originalRecords[firstIssue.recordIndex]) {
      return false;
    }

    const recordCurrency = originalRecords[firstIssue.recordIndex]?.currency;
    const candidateAccounts = this.buildCandidateAccounts(firstIssue, availableAccounts, recordCurrency);
    if (candidateAccounts.length === 0) {
      return false;
    }

    const pendingDraft = this.pendingTransactionManager.addPendingAccountSelectionDraft({
      sourceType: 'USER',
      channel: event.channel,
      senderIdentifier: event.senderIdentifier,
      chatIdentifier: event.chatIdentifier,
      records: originalRecords,
      pendingRecordIndex: firstIssue.recordIndex,
      accountHint: firstIssue.accountHint,
      candidateAccounts,
      sourceUserText: event.textPayload,
      sourceReferenceInstant: requestReferenceInstant,
    });

    // Synchronously claim the draft before any await to keep it in PROCESSING
    // throughout question generation and delivery, preventing concurrent replies
    // from claiming or advancing the draft before prompt delivery completes.
    this.promptInFlightTicketIds.add(pendingDraft.ticketId);
    this.pendingTransactionManager.claimPendingAccountSelectionDraft(pendingDraft.ticketId);

    applicationLogger.info(
      `[Account Clarification] Draft #${pendingDraft.ticketId} created for record ${firstIssue.recordIndex + 1}/${originalRecords.length}.`
    );

    try {
      const promptContent = await this.conversationService.generateClarificationQuestion(
        pendingDraft,
        availableCategories
      );

      const delivered = await this.deliverClarificationPrompt(
        pendingDraft.ticketId,
        event.channel,
        event.chatIdentifier,
        promptContent,
        'initial prompt'
      );
      if (!delivered) {
        return true;
      }

      if (this.pendingTransactionManager.getPendingAccountSelectionDraft(pendingDraft.ticketId)) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(pendingDraft.ticketId);
      }
    } catch (messagingError) {
      const activeDraft = this.pendingTransactionManager.getPendingAccountSelectionDraft(pendingDraft.ticketId);
      if (activeDraft) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(pendingDraft.ticketId);
        this.pendingTransactionManager.rejectPendingAccountSelectionDraft(pendingDraft.ticketId);
        applicationLogger.error(
          `[Account Clarification] Draft #${pendingDraft.ticketId} discarded because the initial prompt could not be delivered: ${formatConciseErrorMessage(messagingError)}`
        );
        throw messagingError;
      }
    } finally {
      this.promptInFlightTicketIds.delete(pendingDraft.ticketId);
    }
    return true;
  }

  private async deliverClarificationPrompt(
    ticketId: number,
    channel: SupportedMessengerChannel,
    chatIdentifier: string,
    promptContent: string,
    contextLabel: string
  ): Promise<boolean> {
    const activeDraft = this.pendingTransactionManager.getPendingAccountSelectionDraft(ticketId);
    if (!activeDraft) {
      applicationLogger.info(
        `[Account Clarification] Draft #${ticketId} was cancelled while ${contextLabel} was generating; suppressing prompt delivery.`
      );
      return false;
    }

    const sendPromise = this.messagingGateway.sendMessage(
      channel,
      chatIdentifier,
      promptContent
    );
    const settledPromise = sendPromise.then(
      () => {},
      () => {}
    );
    this.promptDeliveryPromises.set(ticketId, settledPromise);

    try {
      await sendPromise;
    } finally {
      this.promptDeliveryPromises.delete(ticketId);
    }

    return true;
  }

  public isPromptInFlight(ticketId: number): boolean {
    return this.promptInFlightTicketIds.has(ticketId);
  }

  public async handlePendingAccountSelectionReply(
    event: IncomingUserMessageEvent,
    userReply: string,
    processingStartTimestamp: number
  ): Promise<boolean> {
    if (!this.supportsAccountSelectionDrafts()) {
      return false;
    }

    const normalizedReply = userReply.trim();
    const pendingConfirmationIntent = detectPendingConfirmationAction(normalizedReply);
    const targetedPendingTicketId = typeof pendingConfirmationIntent?.targetScope === 'number'
      ? pendingConfirmationIntent.targetScope
      : undefined;
    const targetedCancellationTicketId = pendingConfirmationIntent?.actionType === 'REJECT'
      ? targetedPendingTicketId
      : undefined;
    const latestPendingDraft = this.pendingTransactionManager.getLatestPendingAccountSelectionDraft(
      event.channel,
      event.chatIdentifier,
      event.senderIdentifier
    );

    let pendingDraft = latestPendingDraft;
    if (targetedPendingTicketId !== undefined) {
      const targetedDraft = this.pendingTransactionManager.getPendingAccountSelectionDraft(
        targetedPendingTicketId
      );

      // Explicit ticket commands such as `batal #5`, `ya #5`, or `confirm #5` belong to the
      // standard pending-action router when the referenced ticket is not this user's account
      // clarification draft. Do not let an unrelated latest clarification draft swallow them as
      // an invalid account choice.
      if (!targetedDraft || !this.isDraftScopedToEvent(targetedDraft, event)) {
        return false;
      }
      pendingDraft = targetedDraft;
    }

    if (!pendingDraft) {
      return false;
    }

    const draftState = this.pendingTransactionManager.getPendingAccountSelectionDraftState(
      pendingDraft.ticketId
    );
    const isGenericCancellationRequest = /^(?:batal|cancel)$/i.test(normalizedReply);
    const isTargetedCancellationRequest = targetedCancellationTicketId === pendingDraft.ticketId;

    // UNKNOWN means the Wallet request was already dispatched and may have committed. It is a
    // reconciliation state, not a cancellable draft. Cancellation must never remove this safety
    // state; instead remind the user to reconcile the actual Wallet outcome.
    if (draftState === 'UNKNOWN') {
      if (isTargetedCancellationRequest) {
        await this.remindUnknownDraftReconciliation(event, pendingDraft);
        return true;
      }

      if (isGenericCancellationRequest) {
        // A generic cancellation may belong to a separate standard pending transaction. Let the
        // normal pending-action router see it whenever one exists. Otherwise keep this UNKNOWN
        // draft intact and remind the user of the reconciliation protocol.
        if (this.pendingTransactionManager.hasPendingTransactions()) {
          return false;
        }

        await this.remindUnknownDraftReconciliation(event, pendingDraft);
        return true;
      }

      // UNKNOWN is not claimable for automatic retry. Unrelated text continues through the normal
      // router so balance/help/new-transaction commands remain usable during reconciliation.
      return false;
    }

    if (draftState === 'PROCESSING') {
      if (
        (isGenericCancellationRequest || isTargetedCancellationRequest) &&
        this.promptInFlightTicketIds.has(pendingDraft.ticketId)
      ) {
        this.promptInFlightTicketIds.delete(pendingDraft.ticketId);
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(pendingDraft.ticketId);
        const cancelledDraft = this.pendingTransactionManager.rejectPendingAccountSelectionDraft(
          pendingDraft.ticketId
        );

        // Serialize prompt delivery and cancellation: if prompt delivery is currently in flight,
        // await it to settle before emitting the cancellation acknowledgement so the cancellation
        // is guaranteed to be the final user-visible message.
        const inFlightDelivery = this.promptDeliveryPromises.get(pendingDraft.ticketId);
        if (inFlightDelivery) {
          await inFlightDelivery;
        }

        if (cancelledDraft) {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            formatAccountSelectionCancellation(cancelledDraft)
          );
          applicationLogger.info(
            `[Account Clarification] Draft #${cancelledDraft.ticketId} cancelled before Wallet dispatch.`
          );
        }
        return true;
      }

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatAccountSelectionProcessing(pendingDraft)
      );
      return true;
    }

    if (isGenericCancellationRequest || isTargetedCancellationRequest) {
      const cancelledDraft = this.pendingTransactionManager.rejectPendingAccountSelectionDraft(
        pendingDraft.ticketId
      );
      const inFlightDelivery = this.promptDeliveryPromises.get(pendingDraft.ticketId);
      if (inFlightDelivery) {
        await inFlightDelivery;
      }
      if (cancelledDraft) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionCancellation(cancelledDraft)
        );
        applicationLogger.info(
          `[Account Clarification] Draft #${cancelledDraft.ticketId} cancelled before Wallet dispatch.`
        );
      }
      return true;
    }

    const claimedDraft = this.pendingTransactionManager.claimPendingAccountSelectionDraft(
      pendingDraft.ticketId
    );
    if (!claimedDraft) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatAccountSelectionProcessing(pendingDraft)
      );
      return true;
    }

    const selectedAccount = await this.conversationService.interpretClarificationReply(
      normalizedReply,
      claimedDraft,
      this.walletCacheService.getCategories()
    );
    if (!selectedAccount) {
      this.promptInFlightTicketIds.add(claimedDraft.ticketId);
      try {
        const retryPrompt = await this.conversationService.generateClarificationQuestion(
          claimedDraft,
          this.walletCacheService.getCategories(),
          normalizedReply
        );

        const delivered = await this.deliverClarificationPrompt(
          claimedDraft.ticketId,
          event.channel,
          event.chatIdentifier,
          retryPrompt,
          'retry prompt'
        );
        if (!delivered) {
          return true;
        }

        if (this.pendingTransactionManager.getPendingAccountSelectionDraft(claimedDraft.ticketId)) {
          this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        }
      } catch (messagingError) {
        const activeDraft = this.pendingTransactionManager.getPendingAccountSelectionDraft(claimedDraft.ticketId);
        if (activeDraft) {
          this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
          applicationLogger.error(
            `[Account Clarification] Draft #${claimedDraft.ticketId} retry prompt delivery failed: ${formatConciseErrorMessage(messagingError)}`
          );
          throw messagingError;
        }
      } finally {
        this.promptInFlightTicketIds.delete(claimedDraft.ticketId);
      }
      return true;
    }

    const updatedRecords = claimedDraft.records.map(record => ({ ...record }));
    updatedRecords[claimedDraft.pendingRecordIndex] = {
      ...updatedRecords[claimedDraft.pendingRecordIndex],
      accountId: selectedAccount.id,
      accountHint: undefined,
    };

    // Keep the original candidate mapping for this unresolved record. A definitive MCP failure
    // returns the draft to PENDING, so replying with the same numeric option must resolve to the
    // same account on retry.
    this.pendingTransactionManager.updatePendingAccountSelectionDraft(claimedDraft.ticketId, {
      records: updatedRecords,
      accountHint: selectedAccount.name,
    });

    const availableAccounts = this.walletCacheService.getAccounts();
    const availableCategories = this.walletCacheService.getCategories();
    const referenceInstantForClarification =
      claimedDraft.sourceReferenceInstant ?? claimedDraft.createdAt;
    const validationResult = validateAndSanitizeFinancialRecords(
      updatedRecords,
      availableAccounts,
      availableCategories,
      undefined,
      referenceInstantForClarification,
      claimedDraft.sourceUserText,
      this.categoryContextService?.getConfiguration().categoryRules
    );

    if (validationResult.validationErrors.length > 0) {
      this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
      this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.validationRejected(validationResult.validationErrors.join('\n'))
      );
      return true;
    }

    const nextIssue = this.getFirstAccountResolutionIssue(validationResult.accountResolutionIssues);
    if (nextIssue) {
      const nextRecordCurrency = updatedRecords[nextIssue.recordIndex]?.currency;
      const nextCandidates = this.buildCandidateAccounts(nextIssue, availableAccounts, nextRecordCurrency);
      if (nextCandidates.length === 0) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          getDictionary().errors.validationRejected(getDictionary().errors.accountResolutionFallback)
        );
        return true;
      }

      const updatedDraft = this.pendingTransactionManager.updatePendingAccountSelectionDraft(
        claimedDraft.ticketId,
        {
          records: updatedRecords,
          pendingRecordIndex: nextIssue.recordIndex,
          accountHint: nextIssue.accountHint,
          candidateAccounts: nextCandidates,
        }
      );

      if (!updatedDraft) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
        return false;
      }

      this.promptInFlightTicketIds.add(claimedDraft.ticketId);
      try {
        const followUpPrompt = await this.conversationService.generateClarificationQuestion(
          updatedDraft,
          availableCategories
        );

        const delivered = await this.deliverClarificationPrompt(
          claimedDraft.ticketId,
          event.channel,
          event.chatIdentifier,
          followUpPrompt,
          'follow-up prompt'
        );
        if (!delivered) {
          return true;
        }

        if (this.pendingTransactionManager.getPendingAccountSelectionDraft(claimedDraft.ticketId)) {
          this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        }
      } catch (messagingError) {
        const activeDraft = this.pendingTransactionManager.getPendingAccountSelectionDraft(claimedDraft.ticketId);
        if (activeDraft) {
          this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
          this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
          applicationLogger.error(
            `[Account Clarification] Draft #${claimedDraft.ticketId} discarded because the follow-up prompt could not be delivered: ${formatConciseErrorMessage(messagingError)}`
          );
          throw messagingError;
        }
      } finally {
        this.promptInFlightTicketIds.delete(claimedDraft.ticketId);
      }
      return true;
    }

    if (!validationResult.isValid || validationResult.sanitizedRecords.length === 0) {
      this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
      this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        getDictionary().errors.validationRejected(getDictionary().errors.accountResolutionFallback)
      );
      return true;
    }

    await this.recordPreparationService.prepareRecordsForDispatch(validationResult.sanitizedRecords);

    try {
      await this.walletMcpClient.createRecords(validationResult.sanitizedRecords);
    } catch (error) {
      if (isWalletMcpDefinitiveFailure(error)) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionRetry(claimedDraft)
        );
        applicationLogger.warn(
          `[Account Clarification] Draft #${claimedDraft.ticketId} failed definitively and remains retryable.`
        );
      } else {
        this.pendingTransactionManager.markPendingAccountSelectionDraftUnknown(claimedDraft.ticketId);
        try {
          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            formatAccountSelectionUnknownOutcome(claimedDraft)
          );
        } catch (messagingError) {
          applicationLogger.error(
            `[Account Clarification] Draft #${claimedDraft.ticketId} remains UNKNOWN, but the reconciliation warning could not be delivered: ${formatConciseErrorMessage(messagingError)}`
          );
        }
        applicationLogger.warn(
          `[Account Clarification] Draft #${claimedDraft.ticketId} has an unknown dispatch outcome; automatic retry disabled.`
        );
      }
      return true;
    }

    // The Wallet write is now known to have succeeded. Resolve the draft before attempting the
    // acknowledgement so a downstream messaging failure cannot turn a committed write into an
    // UNKNOWN/retryable transaction state.
    this.pendingTransactionManager.resolvePendingAccountSelectionDraft(claimedDraft.ticketId);

    try {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatRecordSuccessMessage(
          validationResult.sanitizedRecords,
          availableAccounts,
          availableCategories
        ).trim()
      );
    } catch (messagingError) {
      applicationLogger.error(
        `[Account Clarification] Draft #${claimedDraft.ticketId} was recorded, but the success acknowledgement failed: ${formatConciseErrorMessage(messagingError)}`
      );
    }

    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[Account Clarification] Draft #${claimedDraft.ticketId} recorded after account selection (${processingDurationMs}ms).`
    );
    return true;
  }

  private supportsAccountSelectionDrafts(): boolean {
    const manager = this.pendingTransactionManager as Partial<PendingTransactionService>;
    return typeof manager.getLatestPendingAccountSelectionDraft === 'function' &&
      typeof manager.getPendingAccountSelectionDraft === 'function' &&
      typeof manager.getPendingAccountSelectionDraftState === 'function';
  }

  private async remindUnknownDraftReconciliation(
    event: IncomingUserMessageEvent,
    pendingDraft: PendingAccountSelectionDraft
  ): Promise<void> {
    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      formatAccountSelectionUnknownOutcome(pendingDraft)
    );
    applicationLogger.info(
      `[Account Clarification] Ignored cancellation for UNKNOWN draft #${pendingDraft.ticketId}; reconciliation is still required.`
    );
  }

  private isDraftScopedToEvent(
    draft: PendingAccountSelectionDraft,
    event: IncomingUserMessageEvent
  ): boolean {
    return draft.channel === event.channel &&
      draft.chatIdentifier === event.chatIdentifier &&
      draft.senderIdentifier === event.senderIdentifier;
  }

  private getFirstAccountResolutionIssue(
    accountResolutionIssues: AccountResolutionIssue[]
  ): AccountResolutionIssue | undefined {
    return [...accountResolutionIssues].sort((left, right) => left.recordIndex - right.recordIndex)[0];
  }

  private buildCandidateAccounts(
    issue: AccountResolutionIssue,
    availableAccounts: WalletAccountItem[],
    currencyHint?: string
  ): PendingAccountSelectionCandidate[] {
    const normalizedCurrencyHint = currencyHint?.trim().toUpperCase();
    const accountMap = new Map(availableAccounts.map(account => [account.id, account]));

    // Start with issue.candidates if non-empty (e.g. ambiguous matches), otherwise all available accounts
    const baseCandidatePool = issue.candidates.length > 0
      ? issue.candidates
      : availableAccounts;

    // Filter every candidate source by explicit currency hint when available
    const filteredCandidatePool = normalizedCurrencyHint
      ? baseCandidatePool.filter(candidate => {
          const activeAccount = accountMap.get(candidate.id);
          const candidateCurrency = activeAccount?.currency;
          if (!candidateCurrency) {
            return true;
          }
          return candidateCurrency.trim().toUpperCase() === normalizedCurrencyHint;
        })
      : baseCandidatePool;

    // When an explicit currency hint is provided, do NOT fall back to the full account list
    // if zero candidates match.
    const sourceAccounts: PendingAccountSelectionCandidate[] = filteredCandidatePool.map(candidate => {
      const activeAccount = accountMap.get(candidate.id);
      return activeAccount
        ? {
            id: activeAccount.id,
            name: activeAccount.name,
            currency: activeAccount.currency,
            bankAccountNumber: activeAccount.bankAccountNumber,
          }
        : { ...candidate };
    });

    const uniqueAccounts = new Map<string, PendingAccountSelectionCandidate>();
    for (const account of sourceAccounts) {
      uniqueAccounts.set(account.id, account);
    }
    return Array.from(uniqueAccounts.values());
  }
}
