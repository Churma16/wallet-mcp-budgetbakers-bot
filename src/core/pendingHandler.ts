import { PendingTransactionService, PendingTransactionItem } from './pending.js';
import {
  WalletMcpClientService,
  WalletCacheService,
  WalletMcpRequestError,
  isWalletMcpDefinitiveFailure,
  isWalletMcpDispatchOutcomeUnknown,
} from '../wallet/index.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../gateway/index.js';
import { EmailListenerService } from '../email/index.js';
import {
  PendingConfirmationIntent,
  ReconciliationIntent,
} from '../brain/index.js';
import type { CreateRecordInputPayload } from '../wallet/index.js';
import {
  formatPendingConfirmationSuccess,
  formatBulkPendingConfirmationSuccess,
  formatPendingCancellationMessage,
} from '../wallet/humanResponseFormatter.js';
import { normalizeTransactionText } from '../lib/textCasing.js';
import { getDictionary } from '../i18n/index.js';
import { SupportedLanguage } from '../i18n/types.js';
import {
  buildItemViewModelFromPendingItem,
  buildTransactionAttentionSummary,
} from '../wallet/transactionStatusViewModel.js';
import {
  formatUncertainOutcomeResponse,
  formatReconciliationRecordedResponse,
  formatReconciliationAbsentResponse,
  formatReconciliationNotFoundResponse,
  formatReconciliationAmbiguousResponse,
} from '../wallet/transactionStatusFormatter.js';
import { formatAccountSelectionPrompt } from '../brain/accountClarificationFormatter.js';
import { applicationLogger } from '../lib/logger.js';

/**
 * Processes confirmation, rejection, and explicit reconciliation commands
 * for transactions held in the pending queue awaiting user approval.
 */
export class PendingActionHandler {
  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly emailListenerServiceGetter: () => EmailListenerService | null,
    private readonly walletCacheService?: WalletCacheService
  ) {}

  /**
   * Handles user's confirmation or rejection intent for pending transactions.
   */
  public async handlePendingAction(
    event: IncomingUserMessageEvent,
    confirmationIntent: PendingConfirmationIntent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    if (confirmationIntent.actionType === 'CONFIRM') {
      return await this.handleConfirmAction(event, confirmationIntent, processingStartTimestamp);
    }

    if (confirmationIntent.actionType === 'REJECT') {
      return await this.handleRejectAction(event, confirmationIntent, processingStartTimestamp);
    }

    return false;
  }

  private async handleConfirmAction(
    event: IncomingUserMessageEvent,
    confirmationIntent: PendingConfirmationIntent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    const itemsToRecord = this.claimTargetTransactions(confirmationIntent);

    if (itemsToRecord.length === 0) {
      const outcomeMessage = this.formatConfirmFailureOutcomeMessage(confirmationIntent);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        outcomeMessage
      );
      return true;
    }

    const activeEmailListener = this.emailListenerServiceGetter();
    const successfulTickets: number[] = [];
    const retryableFailedTickets: number[] = [];
    const uncertainTickets: number[] = [];

    // Apply inline custom overrides (category, note, tags) if provided
    let effectiveCustomNote = confirmationIntent.customNote;
    let effectiveCustomTags = confirmationIntent.customTags;

    if (
      this.walletCacheService &&
      (confirmationIntent.customCategoryHint ||
        confirmationIntent.rawCustomInput ||
        confirmationIntent.customNote)
    ) {
      const categories = this.walletCacheService.getCategories();
      const normalize = (text: string) =>
        text.toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

      const candidateHints: string[] = [];

      // 1. Raw custom input stripped of leading # and punctuation: e.g. "#makan nafsu" -> "makan nafsu"
      if (confirmationIntent.rawCustomInput) {
        const cleanRaw = normalize(confirmationIntent.rawCustomInput.replace(/^#+/, ''));
        if (cleanRaw) candidateHints.push(cleanRaw);
      }

      // 2. Combined tag + note: e.g. tag "makan" + note "nafsu" -> "makan nafsu"
      if (confirmationIntent.customCategoryHint && confirmationIntent.customNote) {
        const combined = normalize(
          `${confirmationIntent.customCategoryHint} ${confirmationIntent.customNote}`
        );
        if (!candidateHints.includes(combined)) candidateHints.push(combined);
      }

      // 3. Normalized category hint alone: e.g. "makan-nafsu" -> "makan nafsu", or "makan"
      if (confirmationIntent.customCategoryHint) {
        const normalizedHint = normalize(confirmationIntent.customCategoryHint);
        if (!candidateHints.includes(normalizedHint)) candidateHints.push(normalizedHint);
      }

      // 4. Custom note alone (e.g. "Ya 2: Makan Nafsu")
      if (confirmationIntent.customNote) {
        const normalizedNote = normalize(confirmationIntent.customNote);
        if (!candidateHints.includes(normalizedNote)) candidateHints.push(normalizedNote);
      }

      // Priority A: EXACT match across all categories
      let matchedCat: (typeof categories)[0] | undefined;
      for (const hint of candidateHints) {
        matchedCat = categories.find(c => normalize(c.name) === hint);
        if (matchedCat) break;
      }

      // Priority B: If hint matches a full word boundary in category name
      if (!matchedCat) {
        for (const hint of candidateHints) {
          const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const wordRegex = new RegExp(`(^|\\s)${escaped}(\\s|$)`, 'i');

          // Check if any current item category already satisfies the word boundary hint
          const alreadySatisfiedCat = itemsToRecord
            .map(item => categories.find(c => c.id === item.matchedCategoryId))
            .find(cat => cat && wordRegex.test(normalize(cat.name)));

          if (alreadySatisfiedCat) {
            matchedCat = alreadySatisfiedCat;
            break;
          }

          matchedCat = categories.find(c => wordRegex.test(normalize(c.name)));
          if (matchedCat) break;
        }
      }

      // Priority C: Substring match only for explicit category hints (not generic notes)
      if (!matchedCat && confirmationIntent.customCategoryHint) {
        const hint = normalize(confirmationIntent.customCategoryHint);
        const alreadySatisfiedCat = itemsToRecord
          .map(item => categories.find(c => c.id === item.matchedCategoryId))
          .find(cat => cat && normalize(cat.name).includes(hint));

        if (alreadySatisfiedCat) {
          matchedCat = alreadySatisfiedCat;
        } else {
          matchedCat = categories.find(c => normalize(c.name).includes(hint));
        }
      }

      if (matchedCat) {
        for (const item of itemsToRecord) {
          item.matchedCategoryId = matchedCat.id;
          item.matchedCategoryName = matchedCat.name;
        }

        // If the entire custom input or combination matched the category (e.g. "#makan nafsu" or "Makan Nafsu"),
        // do not overwrite the item's note with a severed fragment like "nafsu" or the category name itself
        if (confirmationIntent.rawCustomInput) {
          const cleanRaw = normalize(confirmationIntent.rawCustomInput.replace(/^#+/, ''));
          if (
            cleanRaw === normalize(matchedCat.name) ||
            (confirmationIntent.customCategoryHint &&
              confirmationIntent.customNote &&
              normalize(`${confirmationIntent.customCategoryHint} ${confirmationIntent.customNote}`) ===
                normalize(matchedCat.name))
          ) {
            effectiveCustomNote = undefined;
            effectiveCustomTags = undefined;
          }
        }
      }
    }

    if (effectiveCustomNote) {
      const normalizedCustomNote = normalizeTransactionText(effectiveCustomNote) || effectiveCustomNote;
      for (const item of itemsToRecord) {
        item.note = normalizedCustomNote;
      }
    }

    if (effectiveCustomTags && effectiveCustomTags.length > 0) {
      for (const item of itemsToRecord) {
        item.labels = effectiveCustomTags;
      }
    }

    applicationLogger.mcp(`Processing ${itemsToRecord.length} claimed transaction(s) individually...`);

    for (const item of itemsToRecord) {
      try {
        const recordsForThisTransaction = this.buildRecordsForPendingItem(item);
        applicationLogger.mcp(`[Ticket #${item.ticketId}] Submitting transaction...`);
        await this.walletMcpClient.createRecords(recordsForThisTransaction);

        if (activeEmailListener) {
          const allRefs = Array.from(
            new Set([
              ...(item.referenceNumbers || []),
              ...(item.referenceNumber ? [item.referenceNumber] : []),
            ])
          ).filter(Boolean);
          if (allRefs.length > 0) {
            for (const ref of allRefs) {
              activeEmailListener.recordProcessedTransaction(undefined, ref);
            }
          } else {
            activeEmailListener.recordProcessedTransaction(undefined, item.referenceNumber);
          }
        }

        this.pendingTransactionManager.resolvePendingTransaction(item.ticketId);
        successfulTickets.push(item.ticketId);
        applicationLogger.success(`[Ticket #${item.ticketId}] Successfully recorded.`);
      } catch (error) {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        const dispatchOutcome = isWalletMcpDefinitiveFailure(error)
          ? 'DEFINITIVE_FAILURE'
          : isWalletMcpDispatchOutcomeUnknown(error)
            ? 'UNKNOWN'
            : 'UNCLASSIFIED';

        applicationLogger.error(
          `[Ticket #${item.ticketId}] Failed to record (${errorName}; outcome=${dispatchOutcome}).`
        );
        applicationLogger.fileDetail('error', 'Pending Transaction Dispatch Failure', {
          ticketId: item.ticketId,
          dispatchOutcome,
          error,
        });

        if (isWalletMcpDefinitiveFailure(error)) {
          this.pendingTransactionManager.releaseProcessingTransaction(item.ticketId);
          retryableFailedTickets.push(item.ticketId);
        } else {
          this.pendingTransactionManager.markPendingTransactionUnknown(item.ticketId);
          uncertainTickets.push(item.ticketId);
          applicationLogger.warn(
            `[Ticket #${item.ticketId}] Dispatch outcome is unknown or unclassified; automatic retry disabled to prevent duplicates.`
          );
        }
      }
    }

    const processingDurationMs = Date.now() - processingStartTimestamp;
    await this.sendConfirmationOutcomeMessage(
      event,
      itemsToRecord,
      successfulTickets,
      retryableFailedTickets,
      uncertainTickets
    );

    applicationLogger.info(
      `[${event.channel.toUpperCase()}] Confirmation result: ${successfulTickets.length} succeeded, ` +
      `${retryableFailedTickets.length} retryable failure(s), ${uncertainTickets.length} unknown outcome(s) ` +
      `(${processingDurationMs}ms).`
    );

    return true;
  }

  private claimTargetTransactions(
    confirmationIntent: PendingConfirmationIntent
  ): PendingTransactionItem[] {
    if (confirmationIntent.targetScope === 'ALL') {
      return this.pendingTransactionManager.claimAllPendingTransactions();
    }

    if (typeof confirmationIntent.targetScope === 'number') {
      const item = this.pendingTransactionManager.claimPendingTransaction(confirmationIntent.targetScope);
      return item ? [item] : [];
    }

    const oldestItem = typeof (this.pendingTransactionManager as any).claimOldestPendingTransaction === 'function'
      ? this.pendingTransactionManager.claimOldestPendingTransaction()
      : this.pendingTransactionManager.claimLatestPendingTransaction();
    return oldestItem ? [oldestItem] : [];
  }

  private formatConfirmFailureOutcomeMessage(
    confirmationIntent: PendingConfirmationIntent,
    languageCode?: SupportedLanguage
  ): string {
    const dictionary = getDictionary(languageCode);
    if (typeof confirmationIntent.targetScope === 'number') {
      const ticketId = confirmationIntent.targetScope;
      if (this.pendingTransactionManager.isTicketProcessing(ticketId)) {
        return dictionary.confirmation.itemProcessing(ticketId);
      }
      if (this.pendingTransactionManager.wasTicketRecentlyResolved(ticketId)) {
        return dictionary.confirmation.itemAlreadyResolved(ticketId);
      }
      return dictionary.confirmation.itemNotFound(ticketId);
    }

    return dictionary.confirmation.noPendingItems;
  }

  private formatRejectFailureOutcomeMessage(
    confirmationIntent: PendingConfirmationIntent,
    languageCode?: SupportedLanguage
  ): string {
    const dictionary = getDictionary(languageCode);
    if (typeof confirmationIntent.targetScope === 'number') {
      const ticketId = confirmationIntent.targetScope;
      if (this.pendingTransactionManager.isTicketProcessing(ticketId)) {
        return dictionary.confirmation.itemProcessingCannotCancel(ticketId);
      }
      return dictionary.confirmation.cancellationNotFound(ticketId);
    }

    return dictionary.confirmation.noPendingItems;
  }

  private getTotalUncertainCount(): number {
    return this.pendingTransactionManager.getUncertainTransactions().length +
      this.pendingTransactionManager.getUncertainAccountSelectionDrafts().length;
  }

  private buildRecordsForPendingItem(item: PendingTransactionItem): CreateRecordInputPayload[] {
    if (item.transactionType === 'TRANSFER') {
      if (!item.matchedDestinationAccountId) {
        throw new WalletMcpRequestError(
          'Transfer destination account was not resolved before dispatch',
          'DEFINITIVE_FAILURE'
        );
      }
      return [{
        accountId: item.matchedAccountId,
        amount: -Math.abs(item.amount),
        recordDate: item.recordDate,
        note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
        counterParty: item.destinationAccountNameHint || '',
        transfer: {
          pairingMode: 'new',
          accountId: item.matchedDestinationAccountId,
        },
      }];
    }

    const finalAmount = item.transactionType === 'EXPENSE'
      ? -Math.abs(item.amount)
      : Math.abs(item.amount);

    return [
      {
        accountId: item.matchedAccountId,
        categoryId: item.matchedCategoryId,
        amount: finalAmount,
        recordDate: item.recordDate,
        note: item.note,
        counterParty: item.counterParty,
        labels: item.labels,
      },
    ];
  }

  private async sendConfirmationOutcomeMessage(
    event: IncomingUserMessageEvent,
    itemsToRecord: PendingTransactionItem[],
    successfulTickets: number[],
    retryableFailedTickets: number[],
    uncertainTickets: number[]
  ): Promise<void> {
    if (
      successfulTickets.length === itemsToRecord.length &&
      retryableFailedTickets.length === 0 &&
      uncertainTickets.length === 0
    ) {
      const successfulItems = itemsToRecord.filter(item => successfulTickets.includes(item.ticketId));
      const replyMessage = successfulItems.length === 1
        ? formatPendingConfirmationSuccess(successfulItems[0])
        : formatBulkPendingConfirmationSuccess(successfulItems);
      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      return;
    }

    if (
      uncertainTickets.length > 0 &&
      successfulTickets.length === 0 &&
      retryableFailedTickets.length === 0
    ) {
      const uncertainItems = itemsToRecord.filter(item => uncertainTickets.includes(item.ticketId));
      const viewModels = uncertainItems.map(item =>
        buildItemViewModelFromPendingItem(item, 'NEEDS_CHECK')
      );
      const replyMessage = formatUncertainOutcomeResponse(
        viewModels,
        undefined,
        this.getTotalUncertainCount()
      );
      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      return;
    }

    const messageLines: string[] = [];

    if (successfulTickets.length > 0) {
      messageLines.push(
        `[INFO] ${successfulTickets.length}/${itemsToRecord.length} transaksi berhasil dicatat ke Wallet.`
      );
    }

    if (retryableFailedTickets.length > 0) {
      const ticketList = retryableFailedTickets.map(ticketId => `#${ticketId}`).join(', ');
      const retryCommands = retryableFailedTickets
        .map(ticketId => `"ya #${ticketId}"`)
        .join(' atau ');
      messageLines.push(
        `[ERROR] Gagal mencatat tiket ${ticketList}. Tiket tetap tersimpan dan aman untuk dicoba lagi.`
      );
      messageLines.push(`Gunakan ${retryCommands} untuk mencoba ulang tiket tersebut.`);
    }

    if (uncertainTickets.length > 0) {
      const uncertainItems = itemsToRecord.filter(item => uncertainTickets.includes(item.ticketId));
      const viewModels = uncertainItems.map(item =>
        buildItemViewModelFromPendingItem(item, 'NEEDS_CHECK')
      );
      messageLines.push(formatUncertainOutcomeResponse(
        viewModels,
        undefined,
        this.getTotalUncertainCount()
      ));
    }

    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      messageLines.join('\n')
    );
  }

  private async handleRejectAction(
    event: IncomingUserMessageEvent,
    confirmationIntent: PendingConfirmationIntent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    let rejectedItems: PendingTransactionItem[] = [];
    let protectedUncertainItems: PendingTransactionItem[] = [];
    const manager = this.pendingTransactionManager as Partial<PendingTransactionService>;
    const uncertainItems = typeof manager.getUncertainTransactions === 'function'
      ? manager.getUncertainTransactions()
      : [];

    if (confirmationIntent.targetScope === 'ALL') {
      protectedUncertainItems = uncertainItems;
      rejectedItems = this.pendingTransactionManager.rejectAllPendingTransactions();
    } else if (typeof confirmationIntent.targetScope === 'number') {
      protectedUncertainItems = uncertainItems.filter(
        item => item.ticketId === confirmationIntent.targetScope
      );
      if (protectedUncertainItems.length === 0) {
        const singleItem = this.pendingTransactionManager.rejectPendingTransaction(
          confirmationIntent.targetScope
        );
        if (singleItem) {
          rejectedItems.push(singleItem);
        }
      }
    } else {
      const manager = this.pendingTransactionManager as any;
      const targetItem = (typeof manager.getOldestPendingTransaction === 'function'
        ? manager.getOldestPendingTransaction()
        : undefined) ||
        (typeof manager.getLatestPendingTransaction === 'function'
          ? manager.getLatestPendingTransaction()
          : undefined);
      if (targetItem) {
        protectedUncertainItems = uncertainItems.filter(item => item.ticketId === targetItem.ticketId);
        if (protectedUncertainItems.length === 0) {
          const rejectedItem = this.pendingTransactionManager.rejectPendingTransaction(targetItem.ticketId);
          if (rejectedItem) {
            rejectedItems.push(rejectedItem);
          }
        }
      }
    }

    const replyMessages: string[] = [];
    if (rejectedItems.length > 0) {
      replyMessages.push(formatPendingCancellationMessage(
        rejectedItems.length === 1 ? rejectedItems[0] : rejectedItems
      ));
    }

    if (protectedUncertainItems.length > 0) {
      const viewModels = protectedUncertainItems.map(item =>
        buildItemViewModelFromPendingItem(item, 'NEEDS_CHECK')
      );
      replyMessages.push(formatUncertainOutcomeResponse(
        viewModels,
        undefined,
        this.getTotalUncertainCount()
      ));
    }

    if (replyMessages.length === 0) {
      const outcomeMessage = this.formatRejectFailureOutcomeMessage(confirmationIntent);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        outcomeMessage
      );
      return true;
    }

    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      replyMessages.join('\n\n')
    );

    if (rejectedItems.length > 0) {
      const processingDurationMs = Date.now() - processingStartTimestamp;
      applicationLogger.success(
        `[${event.channel.toUpperCase()}] Cancelled ${rejectedItems.length} pending transaction(s) (${processingDurationMs}ms).`
      );
    }

    if (protectedUncertainItems.length > 0) {
      const ticketList = protectedUncertainItems.map(item => `#${item.ticketId}`).join(', ');
      applicationLogger.info(
        `[${event.channel.toUpperCase()}] Ignored cancellation for UNKNOWN transaction(s) ${ticketList}; reconciliation is still required.`
      );
    }

    return true;
  }

  /**
   * Handles user reconciliation commands (e.g. "Sudah ada #3", "Belum ada #3", "Sudah ada", "Belum ada").
   */
  public async handleReconciliationAction(
    event: IncomingUserMessageEvent,
    intent: ReconciliationIntent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    const uncertainTransactions = this.pendingTransactionManager.getUncertainTransactions();
    const uncertainDrafts = this.pendingTransactionManager.getUncertainAccountSelectionDrafts();
    const totalUncertainCount = uncertainTransactions.length + uncertainDrafts.length;

    if (intent.targetTicketId !== undefined) {
      const targetTicketId = intent.targetTicketId;
      const matchedTransaction = uncertainTransactions.find(item => item.ticketId === targetTicketId);
      const matchedDraft = uncertainDrafts.find(draft => draft.ticketId === targetTicketId);

      if (!matchedTransaction && !matchedDraft) {
        const notFoundMessage = formatReconciliationNotFoundResponse(targetTicketId);
        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, notFoundMessage);
        return true;
      }

      if (intent.actionType === 'CONFIRM_RECORDED') {
        if (matchedTransaction) {
          this.pendingTransactionManager.resolvePendingTransaction(targetTicketId);
          const activeEmailListener = this.emailListenerServiceGetter();
          if (activeEmailListener) {
            activeEmailListener.recordProcessedTransaction(undefined, matchedTransaction.referenceNumber);
          }
        } else if (matchedDraft) {
          this.pendingTransactionManager.resolvePendingAccountSelectionDraft(targetTicketId);
        }

        const replyMessage = formatReconciliationRecordedResponse(targetTicketId);
        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const durationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[Ticket #${targetTicketId}] Reconciled as recorded in Wallet; local state closed (${durationMs}ms).`
        );
        return true;
      }

      if (intent.actionType === 'CONFIRM_ABSENT') {
        this.pendingTransactionManager.reopenUnknownTransactionAsPending(targetTicketId);
        const replyMessage = matchedDraft
          ? formatAccountSelectionPrompt(matchedDraft, [])
          : formatReconciliationAbsentResponse(targetTicketId);
        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const durationMs = Date.now() - processingStartTimestamp;
        applicationLogger.info(
          `[Ticket #${targetTicketId}] Reconciled as absent in Wallet; safely reset to PENDING (${durationMs}ms).`
        );
        return true;
      }
    } else {
      // Unnumbered reconciliation command
      if (totalUncertainCount === 0) {
        const notFoundMessage = formatReconciliationNotFoundResponse();
        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, notFoundMessage);
        return true;
      }

      if (totalUncertainCount === 1) {
        const singleTransaction = uncertainTransactions[0];
        const singleDraft = uncertainDrafts[0];
        const singleTicketId = singleTransaction?.ticketId ?? singleDraft?.ticketId;

        if (intent.actionType === 'CONFIRM_RECORDED') {
          if (singleTransaction) {
            this.pendingTransactionManager.resolvePendingTransaction(singleTicketId);
            const activeEmailListener = this.emailListenerServiceGetter();
            if (activeEmailListener) {
              activeEmailListener.recordProcessedTransaction(undefined, singleTransaction.referenceNumber);
            }
          } else if (singleDraft) {
            this.pendingTransactionManager.resolvePendingAccountSelectionDraft(singleTicketId);
          }

          const replyMessage = formatReconciliationRecordedResponse();
          await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
          const durationMs = Date.now() - processingStartTimestamp;
          applicationLogger.success(
            `[Ticket #${singleTicketId}] Reconciled as recorded via unnumbered reply (${durationMs}ms).`
          );
          return true;
        }

        if (intent.actionType === 'CONFIRM_ABSENT') {
          this.pendingTransactionManager.reopenUnknownTransactionAsPending(singleTicketId);
          const replyMessage = singleDraft
            ? formatAccountSelectionPrompt(singleDraft, [])
            : formatReconciliationAbsentResponse();
          await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
          const durationMs = Date.now() - processingStartTimestamp;
          applicationLogger.info(
            `[Ticket #${singleTicketId}] Reconciled as absent via unnumbered reply; reset to PENDING (${durationMs}ms).`
          );
          return true;
        }
      }

      // Ambiguous: multiple uncertain items exist
      const summary = buildTransactionAttentionSummary(this.pendingTransactionManager);
      const ambiguousMessage = formatReconciliationAmbiguousResponse(summary.needsCheckItems);
      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, ambiguousMessage);
      return true;
    }

    return false;
  }
}
