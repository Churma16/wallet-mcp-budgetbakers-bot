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
import {
  formatAccountSelectionCancellation,
  formatAccountSelectionProcessing,
  formatAccountSelectionPrompt,
  formatAccountSelectionRetry,
  formatAccountSelectionUnknownOutcome,
} from '../utils/accountClarificationFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';

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
    });

    applicationLogger.info(
      `[Account Clarification] Draft #${pendingDraft.ticketId} created for record ${firstIssue.recordIndex + 1}/${originalRecords.length}.`
    );

    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      formatAccountSelectionPrompt(pendingDraft, availableCategories)
    );
    return true;
  }

  public async handlePendingAccountSelectionReply(
    event: IncomingUserMessageEvent,
    userReply: string,
    processingStartTimestamp: number
  ): Promise<boolean> {
    const pendingDraft = this.pendingTransactionManager.getLatestPendingAccountSelectionDraft(
      event.channel,
      event.chatIdentifier,
      event.senderIdentifier
    );
    if (!pendingDraft) {
      return false;
    }

    const draftState = this.pendingTransactionManager.getPendingAccountSelectionDraftState(
      pendingDraft.ticketId
    );
    const normalizedReply = userReply.trim();
    const isCancellationRequest = /^(?:batal|cancel)$/i.test(normalizedReply);

    if (isCancellationRequest) {
      if (draftState === 'PROCESSING') {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionProcessing(pendingDraft)
        );
        return true;
      }

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

    // UNKNOWN is a manual-reconciliation state, not an account-selection state. The user has
    // already received the uncertainty warning when the MCP call failed, so unrelated commands
    // must continue through the normal message router without causing an automatic retry.
    if (draftState === 'UNKNOWN') {
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
      availableCategories
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
      this.pendingTransactionManager.releaseProcessingAccountSelectionDraft(claimedDraft.ticketId);

      if (updatedDraft) {
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionPrompt(updatedDraft, availableCategories)
        );
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
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          formatAccountSelectionUnknownOutcome(claimedDraft)
        );
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
