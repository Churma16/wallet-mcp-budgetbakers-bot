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

    const recordsToCreate: CreateRecordInputPayload[] = [];
    const activeEmailListener = this.emailListenerServiceGetter();

    for (const item of itemsToRecord) {
      if (item.transactionType === 'TRANSFER') {
        recordsToCreate.push({
          accountId: item.matchedAccountId,
          amount: -Math.abs(item.amount),
          recordDate: item.recordDate,
          note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
          counterParty: item.destinationAccountNameHint || '',
        });

        if (item.matchedDestinationAccountId) {
          recordsToCreate.push({
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

        recordsToCreate.push({
          accountId: item.matchedAccountId,
          categoryId: item.matchedCategoryId,
          amount: finalAmount,
          recordDate: item.recordDate,
          note: item.note,
          counterParty: item.counterParty,
        });
      }

      if (activeEmailListener) {
        activeEmailListener.recordProcessedTransaction(undefined, item.referenceNumber);
      }
    }

    // PHASE 2: Attempt MCP dispatch with error recovery
    applicationLogger.mcp(`Recording ${recordsToCreate.length} confirmed transaction(s) to Wallet MCP...`);
    try {
      await this.walletMcpClient.createRecords(recordsToCreate);

      // PHASE 3: Only delete items if MCP dispatch succeeded
      for (const item of itemsToRecord) {
        this.pendingTransactionManager.resolvePendingTransaction(item.ticketId);
      }

      const replyMessage = itemsToRecord.length === 1
        ? formatPendingConfirmationSuccess(itemsToRecord[0])
        : formatBulkPendingConfirmationSuccess(itemsToRecord);

      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      const processingDurationMs = Date.now() - processingStartTimestamp;
      applicationLogger.success(
        `[${event.channel.toUpperCase()}] Confirmed & recorded ${recordsToCreate.length} pending transaction(s) to Wallet (${processingDurationMs}ms).`
      );

      return true;
    } catch (error) {
      // ERROR RECOVERY: Items remain in pending queue, user receives failure notification with retry instructions
      applicationLogger.error(
        `[${event.channel.toUpperCase()}] Failed to record ${recordsToCreate.length} pending transaction(s) to Wallet MCP: ${error instanceof Error ? error.message : String(error)}`
      );

      let errorMessage = '[ERROR] Gagal merekam transaksi ke Wallet. ';
      
      if (itemsToRecord.length === 1) {
        errorMessage += `Tiket #${itemsToRecord[0].ticketId} tetap tersimpan di antrian. Ketik "ya" untuk mencoba lagi atau "tidak" untuk membatalkan.`;
      } else {
        errorMessage += `${itemsToRecord.length} transaksi tetap tersimpan di antrian. Ketik "ya" untuk mencoba lagi atau "tidak" untuk membatalkan.`;
      }

      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, errorMessage);

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
