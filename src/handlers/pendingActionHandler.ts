import { PendingTransactionService, PendingTransactionItem } from '../services/pendingTransactionService.js';
import {
  WalletMcpClientService,
  isWalletMcpDispatchOutcomeUnknown,
} from '../services/walletMcpService.js';
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
        const completedRecordIndexes = new Set(
          this.pendingTransactionManager.getCompletedRecordIndexes(item.ticketId)
        );

        for (let recordIndex = 0; recordIndex < recordsForThisTransaction.length; recordIndex++) {
          if (completedRecordIndexes.has(recordIndex)) {
            applicationLogger.mcp(
              `[Ticket #${item.ticketId}] Skipping already committed record ${recordIndex + 1}/${recordsForThisTransaction.length}.`
            );
            continue;
          }

          applicationLogger.mcp(
            `[Ticket #${item.ticketId}] Submitting record ${recordIndex + 1}/${recordsForThisTransaction.length}...`
          );

          await this.walletMcpClient.createRecords([recordsForThisTransaction[recordIndex]]);
          this.pendingTransactionManager.markRecordIndexCompleted(item.ticketId, recordIndex);
        }

        if (activeEmailListener) {
          activeEmailListener.recordProcessedTransaction(undefined, item.referenceNumber);
        }

        this.pendingTransactionManager.resolvePendingTransaction(item.ticketId);
        successfulTickets.push(item.ticketId);
        applicationLogger.success(`[Ticket #${item.ticketId}] Successfully recorded.`);
      } catch (error) {
        const rawErrorMessage = error instanceof Error ? error.message : String(error);
        applicationLogger.error(`[Ticket #${item.ticketId}] Failed to record: ${rawErrorMessage}`);

        if (isWalletMcpDispatchOutcomeUnknown(error)) {
          this.pendingTransactionManager.markPendingTransactionUnknown(item.ticketId);
          uncertainTickets.push(item.ticketId);
          applicationLogger.warn(
            `[Ticket #${item.ticketId}] Dispatch outcome is unknown; automatic retry disabled to prevent duplicates.`
          );
        } else {
          this.pendingTransactionManager.releaseProcessingTransaction(item.ticketId);
          retryableFailedTickets.push(item.ticketId);
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

  private buildRecordsForPendingItem(item: PendingTransactionItem): CreateRecordInputPayload[] {
    if (item.transactionType === 'TRANSFER') {
      const transferRecords: CreateRecordInputPayload[] = [
        {
          accountId: item.matchedAccountId,
          amount: -Math.abs(item.amount),
          recordDate: item.recordDate,
          note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
          counterParty: item.destinationAccountNameHint || '',
        },
      ];

      if (item.matchedDestinationAccountId) {
        transferRecords.push({
          accountId: item.matchedDestinationAccountId,
          amount: Math.abs(item.amount),
          recordDate: item.recordDate,
          note: item.note || `Transfer dari ${item.accountNameHint || 'akun lain'}`,
          counterParty: item.accountNameHint || '',
        });
      }

      return transferRecords;
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

    const messageLines: string[] = [];

    if (successfulTickets.length > 0) {
      messageLines.push(
        `[INFO] ${successfulTickets.length}/${itemsToRecord.length} transaksi berhasil dicatat ke Wallet.`
      );
    }

    if (retryableFailedTickets.length > 0) {
      const ticketList = retryableFailedTickets.map(ticketId => `#${ticketId}`).join(', ');
      messageLines.push(
        `[ERROR] Gagal mencatat tiket ${ticketList}. Tiket tetap tersimpan dan aman untuk dicoba lagi.`
      );
      messageLines.push('Ketik "ya" untuk mencoba ulang tiket yang gagal atau "tidak" untuk membatalkan.');
    }

    if (uncertainTickets.length > 0) {
      const ticketList = uncertainTickets.map(ticketId => `#${ticketId}`).join(', ');
      messageLines.push(
        `[WARN] Status pencatatan tiket ${ticketList} belum dapat dipastikan karena respons server tidak diterima dengan pasti.`
      );
      messageLines.push(
        'Demi mencegah duplikasi, tiket tersebut tidak akan dikirim ulang otomatis. Periksa Wallet terlebih dahulu sebelum membatalkan atau memasukkan ulang transaksi.'
      );
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
        const rejectedItem = this.pendingTransactionManager.rejectPendingTransaction(latestItem.ticketId);
        if (rejectedItem) {
          rejectedItems.push(rejectedItem);
        }
      }
    }

    if (rejectedItems.length === 0) {
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        '[WARN] Tiket transaksi tidak ditemukan atau sedang diproses.'
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
