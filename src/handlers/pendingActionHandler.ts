import { PendingTransactionService, PendingTransactionItem } from '../services/pendingTransactionService.js';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  isWalletMcpDefinitiveFailure,
  isWalletMcpDispatchOutcomeUnknown,
} from '../services/walletMcpService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { EmailListenerService } from '../services/emailListenerService.js';
import {
  PendingConfirmationIntent,
  ReconciliationIntent,
} from '../utils/fastPathIntentDetector.js';
import { CreateRecordInputPayload } from '../types/walletTypes.js';
import {
  formatPendingConfirmationSuccess,
  formatBulkPendingConfirmationSuccess,
  formatPendingCancellationMessage,
} from '../utils/humanResponseFormatter.js';
import {
  buildItemViewModelFromPendingItem,
  buildTransactionAttentionSummary,
} from '../services/transactionStatusViewModel.js';
import {
  formatUncertainOutcomeResponse,
  formatReconciliationRecordedResponse,
  formatReconciliationAbsentResponse,
  formatReconciliationNotFoundResponse,
  formatReconciliationAmbiguousResponse,
} from '../utils/transactionStatusFormatter.js';
import { formatAccountSelectionPrompt } from '../utils/accountClarificationFormatter.js';
import { applicationLogger } from '../utils/logger.js';

export class PendingActionHandler {
  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly emailListenerServiceGetter: () => EmailListenerService | null
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
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '[WARN] Tiket transaksi tidak tersedia, sedang diproses, atau memerlukan rekonsiliasi manual.'
      );
      return true;
    }

    const activeEmailListener = this.emailListenerServiceGetter();
    const successfulTickets: number[] = [];
    const retryableFailedTickets: number[] = [];
    const uncertainTickets: number[] = [];

    applicationLogger.mcp(`Processing ${itemsToRecord.length} claimed transaction(s) individually...`);

    for (const item of itemsToRecord) {
      try {
        const recordsForThisTransaction = this.buildRecordsForPendingItem(item);
        applicationLogger.mcp(`[Ticket #${item.ticketId}] Submitting transaction...`);
        await this.walletMcpClient.createRecords(recordsForThisTransaction);

        if (activeEmailListener) {
          activeEmailListener.recordProcessedTransaction(undefined, item.referenceNumber);
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

    const latestItem = this.pendingTransactionManager.claimLatestPendingTransaction();
    return latestItem ? [latestItem] : [];
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
      const latestItem = this.pendingTransactionManager.getLatestPendingTransaction();
      if (latestItem) {
        protectedUncertainItems = uncertainItems.filter(item => item.ticketId === latestItem.ticketId);
        if (protectedUncertainItems.length === 0) {
          const rejectedItem = this.pendingTransactionManager.rejectPendingTransaction(latestItem.ticketId);
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
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '[WARN] Tiket transaksi tidak ditemukan atau sedang diproses.'
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
