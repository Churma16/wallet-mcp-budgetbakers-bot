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

    if (confirmationIntent.targetScope === 'ALL') {
      itemsToRecord = this.pendingTransactionManager.resolveAllPendingTransactions();
    } else if (typeof confirmationIntent.targetScope === 'number') {
      const singleItem = this.pendingTransactionManager.resolvePendingTransaction(confirmationIntent.targetScope);
      if (singleItem) {
        itemsToRecord.push(singleItem);
      }
    } else {
      const latestItem = this.pendingTransactionManager.getLatestPendingTransaction();
      if (latestItem) {
        this.pendingTransactionManager.resolvePendingTransaction(latestItem.ticketId);
        itemsToRecord.push(latestItem);
      }
    }

    if (itemsToRecord.length === 0) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '⚠️ Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
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

    applicationLogger.mcp(`Recording ${recordsToCreate.length} confirmed transaction(s) to Wallet MCP...`);
    await this.walletMcpClient.createRecords(recordsToCreate);

    const replyMessage = itemsToRecord.length === 1
      ? formatPendingConfirmationSuccess(itemsToRecord[0])
      : formatBulkPendingConfirmationSuccess(itemsToRecord);

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Confirmed & recorded ${recordsToCreate.length} pending transaction(s) to Wallet (${processingDurationMs}ms).`
    );

    return true;
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
