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
import { IncomingUserMessageEvent, MessagingGatewayService } from '../services/messaging/index.js';
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
  formatAccountSelectionUnknownDismissal,
  formatAccountSelectionUnknownOutcome,
} from '../utils/accountClarificationFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';
import { resolveAndEnsureLabels } from '../services/walletLabelResolver.js';

export class AccountClarificationHandler {
  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService
  ) {}

  public async createPendingAccountSelectionDraft(
    event: IncomingUserMessageEvent,
    originalRecords: CreateRecordInputPayload[],
    accountResolutionIssues: AccountResolutionIssue[],
    availableAccounts: WalletAccountItem[],
    availableCategories: WalletCategoryItem[]
  ): Promise<boolean> {
    const firstIssue = this.getFirstAccountResolutionIssue(accountResolutionIssues);
    if (!firstIssue || !originalRecords[firstIssue.recordIndex]) {
      return false;
    }

    const candidateAccounts = this.buildCandidateAccounts(firstIssue, availableAccounts);
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
    });

    applicationLogger.info(
      `[Account Clarification] Draft #${pendingDraft.ticketId} created for record ${firstIssue.recordIndex + 1}/${originalRecords.length}.`
    );

    try {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatAccountSelectionPrompt(pendingDraft, availableCategories)
      );
    } catch (messagingError) {
      this.pendingTransactionManager.rejectPendingAccountSelectionDraft(pendingDraft.ticketId);
      applicationLogger.error(
        `[Account Clarification] Draft #${pendingDraft.ticketId} discarded because the initial prompt could not be delivered: ${formatConciseErrorMessage(messagingError)}`
      );
      throw messagingError;
    }
    return true;
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
    // reconciliation state, not a normal cancellable draft. Any local dismissal must preserve
    // that uncertainty and must never redispatch the transaction.
    if (draftState === 'UNKNOWN') {
      if (isTargetedCancellationRequest) {
        await this.dismissUnknownDraft(event, pendingDraft);
        return true;
      }

      if (isGenericCancellationRequest) {
        // A generic cancellation may belong to a separate standard pending transaction. Let the
        // normal pending-action router see it whenever one exists. If there is no competing
        // pending transaction, it is safe to dismiss only the local UNKNOWN reconciliation state.
        if (this.pendingTransactionManager.hasPendingTransactions()) {
          return false;
        }

        await this.dismissUnknownDraft(event, pendingDraft);
        return true;
      }

      // UNKNOWN is not claimable for automatic retry. Unrelated text continues through the normal
      // router so balance/help/new-transaction commands remain usable during reconciliation.
      return false;
    }

    if (draftState === 'PROCESSING') {
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

    const selectedAccount = this.resolveAccountSelection(normalizedReply, claimedDraft.candidateAccounts);
    if (!selectedAccount) {
      this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        formatAccountSelectionPrompt(
          claimedDraft,
          this.walletCacheService.getCategories(),
          normalizedReply
        )
      );
      return true;
    }

    const updatedRecords = claimedDraft.records.map(record => ({ ...record }));
    updatedRecords[claimedDraft.pendingRecordIndex] = {
      ...updatedRecords[claimedDraft.pendingRecordIndex],
      accountId: selectedAccount.id,
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
    const validationResult = validateAndSanitizeFinancialRecords(
      updatedRecords,
      availableAccounts,
      availableCategories,
      claimedDraft.sourceUserText,
      new Date(claimedDraft.createdAt)
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
      const nextCandidates = this.buildCandidateAccounts(nextIssue, availableAccounts);
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

      try {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionPrompt(updatedDraft, availableCategories)
        );
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
      } catch (messagingError) {
        this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);
        this.pendingTransactionManager.rejectPendingAccountSelectionDraft(claimedDraft.ticketId);
        applicationLogger.error(
          `[Account Clarification] Draft #${claimedDraft.ticketId} discarded because the follow-up prompt could not be delivered: ${formatConciseErrorMessage(messagingError)}`
        );
        throw messagingError;
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

    for (const record of validationResult.sanitizedRecords) {
      if (record.labels && record.labels.length > 0) {
        const { resolvedLabelIds, resolvedLabelNames } = await resolveAndEnsureLabels(
          record.labels,
          this.walletCacheService,
          this.walletMcpClient
        );
        record.labelIds = resolvedLabelIds.length > 0 ? resolvedLabelIds : undefined;
        record.labels = resolvedLabelNames.length > 0 ? resolvedLabelNames : undefined;
      }
    }

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

  private async dismissUnknownDraft(
    event: IncomingUserMessageEvent,
    pendingDraft: PendingAccountSelectionDraft
  ): Promise<void> {
    const dismissedDraft = this.pendingTransactionManager.rejectPendingAccountSelectionDraft(
      pendingDraft.ticketId
    );
    if (!dismissedDraft) {
      return;
    }

    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      formatAccountSelectionUnknownDismissal(dismissedDraft)
    );
    applicationLogger.info(
      `[Account Clarification] UNKNOWN reconciliation draft #${dismissedDraft.ticketId} dismissed locally; no Wallet retry was sent.`
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
    availableAccounts: WalletAccountItem[]
  ): PendingAccountSelectionCandidate[] {
    const accountMap = new Map(availableAccounts.map(account => [account.id, account]));
    const sourceAccounts: PendingAccountSelectionCandidate[] = issue.candidates.length > 0
      ? issue.candidates.map(candidate => {
          const activeAccount = accountMap.get(candidate.id);
          return activeAccount
            ? {
                id: activeAccount.id,
                name: activeAccount.name,
                currency: activeAccount.currency,
                bankAccountNumber: activeAccount.bankAccountNumber,
              }
            : { ...candidate };
        })
      : availableAccounts.map(account => ({
          id: account.id,
          name: account.name,
          currency: account.currency,
          bankAccountNumber: account.bankAccountNumber,
        }));

    const uniqueAccounts = new Map<string, PendingAccountSelectionCandidate>();
    for (const account of sourceAccounts) {
      uniqueAccounts.set(account.id, account);
    }
    return Array.from(uniqueAccounts.values());
  }

  private resolveAccountSelection(
    userReply: string,
    candidateAccounts: PendingAccountSelectionCandidate[]
  ): PendingAccountSelectionCandidate | undefined {
    if (/^\d+$/.test(userReply)) {
      const selectedIndex = Number.parseInt(userReply, 10) - 1;
      if (selectedIndex >= 0 && selectedIndex < candidateAccounts.length) {
        return candidateAccounts[selectedIndex];
      }
      return undefined;
    }

    const normalizedReply = userReply.toLowerCase();
    const exactMatches = candidateAccounts.filter(
      candidate => candidate.name.toLowerCase() === normalizedReply
    );
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }
    if (exactMatches.length > 1 || normalizedReply.length < 2) {
      return undefined;
    }

    const partialMatches = candidateAccounts.filter(candidate => {
      const normalizedName = candidate.name.toLowerCase();
      return normalizedName.includes(normalizedReply) || normalizedReply.includes(normalizedName);
    });
    return partialMatches.length === 1 ? partialMatches[0] : undefined;
  }
}
