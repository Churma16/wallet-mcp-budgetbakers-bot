import { PendingTransactionService, PendingTransactionItem } from '../services/pendingTransactionService.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { EmailListenerService } from '../services/emailListenerService.js';
import { PendingConfirmationIntent } from '../utils/fastPathIntentDetector.js';
import { CreateRecordInputPayload } from '../types/walletTypes.js';
import {
  formatPendingConfirmationSuccess,
  formatBulkPendingConfirmationSuccess,
  formatPendingCancellationMessage,
} from '../utils/humanResponseFormatter.js';
import { applicationLogger } from '../utils/logger.js';

export class PendingActionHandler {
  constructor(
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly emailListenerServiceGetter: () => EmailListenerService | null
  ) {}

  /**
   * Handles user's confirmation or rejection intent for pending transactions
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
    let itemsToRecord: PendingTransactionItem[] = [];

    // PHASE 1: Retrieve items WITHOUT deleting them yet (deferred deletion pattern)
    if (confirmationIntent.targetScope === 'ALL') {
      itemsToRecord = this.pendingTransactionManager.getAllPendingTransactions();
    } else if (typeof confirmationIntent.targetScope === 'number') {
      const singleItem = this.pendingTransactionManager.getPendingTransaction(confirmationIntent.targetScope);
      if (singleItem) {
        itemsToRecord.push(singleItem);
      }
    } else {
      const latestItem = this.pendingTransactionManager.getLatestPendingTransaction();
      if (latestItem) {
        itemsToRecord.push(latestItem);
      }
    }

    if (itemsToRecord.length === 0) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '[WARN] Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
      );
      return true;
    }

    const activeEmailListener = this.emailListenerServiceGetter();
    const successfulTickets: number[] = [];
    const failedTickets: Array<{ ticketId: number; error: string }> = [];

    // PHASE 2: Submit records PER TRANSACTION to prevent partial batch failures
    applicationLogger.mcp(`Processing ${itemsToRecord.length} transaction(s) individually...`);

    for (const item of itemsToRecord) {
      try {
        const recordsForThisTransaction: CreateRecordInputPayload[] = [];

        // Build records for this transaction
        if (item.transactionType === 'TRANSFER') {
          recordsForThisTransaction.push({
            accountId: item.matchedAccountId,
            amount: -Math.abs(item.amount),
            recordDate: item.recordDate,
            note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
            counterParty: item.destinationAccountNameHint || '',
          });

          if (item.matchedDestinationAccountId) {
            recordsForThisTransaction.push({
              accountId: item.matchedDestinationAccountId,
              amount: Math.abs(item.amount),
              recordDate: item.recordDate,
              note: item.note || `Transfer dari ${item.accountNameHint || 'akun lain'}`,
              counterParty: item.accountNameHint || '',
            });
          }
        } else {
          const finalAmount = item.transactionType === 'EXPENSE'
            ? -Math.abs(item.amount)
            : Math.abs(item.amount);

          recordsForThisTransaction.push({
            accountId: item.matchedAccountId,
            categoryId: item.matchedCategoryId,
            amount: finalAmount,
            recordDate: item.recordDate,
            note: item.note,
            counterParty: item.counterParty,
          });
        }

        // Submit this transaction's records individually
        applicationLogger.mcp(`[Ticket #${item.ticketId}] Submitting ${recordsForThisTransaction.length} record(s)...`);
        await this.walletMcpClient.createRecords(recordsForThisTransaction);

        // Mark email as processed only on success
        if (activeEmailListener) {
          activeEmailListener.recordProcessedTransaction(undefined, item.referenceNumber);
        }

        // PHASE 3: Delete only this successful ticket
        this.pendingTransactionManager.resolvePendingTransaction(item.ticketId);
        successfulTickets.push(item.ticketId);
        applicationLogger.success(`[Ticket #${item.ticketId}] Successfully recorded.`);
      } catch (error) {
        // Track failure but continue processing other transactions
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedTickets.push({ ticketId: item.ticketId, error: errorMessage });
        applicationLogger.error(
          `[Ticket #${item.ticketId}] Failed to record: ${errorMessage}`
        );
      }
    }

    // PHASE 4: Generate user notification based on results
    const processingDurationMs = Date.now() - processingStartTimestamp;

    if (successfulTickets.length > 0 && failedTickets.length === 0) {
      // All successful
      const successfulItems = itemsToRecord.filter(item => successfulTickets.includes(item.ticketId));
      const replyMessage = successfulItems.length === 1
        ? formatPendingConfirmationSuccess(successfulItems[0])
        : formatBulkPendingConfirmationSuccess(successfulItems);

      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      applicationLogger.success(
        `[${event.channel.toUpperCase()}] Confirmed & recorded ${successfulTickets.length}/${itemsToRecord.length} transaction(s) (${processingDurationMs}ms).`
      );
      return true;
    } else if (successfulTickets.length === 0 && failedTickets.length > 0) {
      // All failed - all remain in queue
      let errorMessage = '[ERROR] Gagal merekam semua transaksi ke Wallet. ';
      errorMessage += `${failedTickets.length} transaksi tetap tersimpan di antrian. Ketik "ya" untuk mencoba lagi atau "tidak" untuk membatalkan.`;
      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, errorMessage);
      applicationLogger.error(
        `[${event.channel.toUpperCase()}] Failed all ${failedTickets.length} transaction(s) (${processingDurationMs}ms).`
      );
      return true;
    } else {
      // Partial success - some recorded, some remain in queue
      let partialMessage = `[INFO] Sebagian transaksi berhasil dicatat: ${successfulTickets.length}/${itemsToRecord.length}.\n`;
      partialMessage += `[WARN] ${failedTickets.length} transaksi gagal dan tetap di antrian:\n`;
      for (const failed of failedTickets) {
        partialMessage += `  - Tiket #${failed.ticketId}: ${failed.error}\n`;
      }
      partialMessage += `Ketik "ya" untuk mencoba ulang yang gagal atau "tidak" untuk membatalkan.`;
      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, partialMessage);
      applicationLogger.warn(
        `[${event.channel.toUpperCase()}] Partial success: ${successfulTickets.length}/${itemsToRecord.length} recorded, ${failedTickets.length} remain (${processingDurationMs}ms).`
      );
      return true;
    }
  }

  private async handleRejectAction(
    event: IncomingUserMessageEvent,
    confirmationIntent: PendingConfirmationIntent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    let rejectedItems: PendingTransactionItem[] = [];

    if (confirmationIntent.targetScope === 'ALL') {
      rejectedItems = this.pendingTransactionManager.rejectAllPendingTransactions();
    } else if (typeof confirmationIntent.targetScope === 'number') {
      const singleItem = this.pendingTransactionManager.rejectPendingTransaction(confirmationIntent.targetScope);
      if (singleItem) {
        rejectedItems.push(singleItem);
      }
    } else {
      const latestItem = this.pendingTransactionManager.getLatestPendingTransaction();
      if (latestItem) {
        this.pendingTransactionManager.rejectPendingTransaction(latestItem.ticketId);
        rejectedItems.push(latestItem);
      }
    }

    if (rejectedItems.length === 0) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '⚠️ Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
      );
      return true;
    }

    const replyMessage = formatPendingCancellationMessage(
      rejectedItems.length === 1 ? rejectedItems[0] : rejectedItems
    );

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Cancelled ${rejectedItems.length} pending transaction(s) (${processingDurationMs}ms).`
    );

    return true;
  }
}
