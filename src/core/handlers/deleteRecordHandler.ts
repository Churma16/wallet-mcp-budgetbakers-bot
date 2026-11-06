import type { IncomingUserMessageEvent, MessagingGatewayService } from '../../gateway/index.js';
import type { WalletCacheService, WalletMcpClientService } from '../../wallet/index.js';
import { TransactionMessageStore } from '../../wallet/index.js';
import {
  formatCurrencyAmount,
  formatTransactionDate,
  formatPendingCancellationMessage,
  resolveTransactionDisplayTitle,
} from '../../wallet/formatters/humanResponseFormatter.js';
import { getDefaultCurrency } from '../../config/applicationConfig.js';
import { applicationLogger } from '../../lib/logger.js';
import { getDictionary } from '../../i18n/index.js';
import type { PendingTransactionService } from '../pending.js';

const DELETE_COMMAND_PATTERN = /^(?:\/)?(?:hapus|delete|del|rm|batal|cancel)(?:\s+(?:ini|this|transaksi|transaction|transactions|rekor|catatan|record)){0,2}[!?.]*$/i;
const CANCELLATION_COMMAND_PATTERN = /^(?:\/)?(?:batal|cancel)(?:\s+(?:ini|this|transaksi|transaction|transactions|rekor|catatan|record|tiket|ticket)){0,2}[!?.]*$/i;

/**
 * Checks whether an incoming message string expresses a transaction deletion command.
 */
export function isRecordDeleteCommand(textPayload: string): boolean {
  if (!textPayload) return false;
  return DELETE_COMMAND_PATTERN.test(textPayload.trim());
}

/**
 * Coordinates conversational transaction deletion workflows triggered when a user
 * replies to a previously recorded transaction receipt card in Telegram or WhatsApp.
 */
export class DeleteRecordHandler {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly transactionMessageStore: TransactionMessageStore,
    private readonly pendingTransactionService?: PendingTransactionService
  ) {}

  public async handleDeleteRecordReply(
    event: IncomingUserMessageEvent,
    _processingStartTimestamp: number
  ): Promise<boolean> {
    if (!event.replyToMessageId || !event.textPayload) {
      return false;
    }

    if (!isRecordDeleteCommand(event.textPayload)) {
      return false;
    }

    applicationLogger.fileDetail('chat', 'Detected Record Delete Command on Reply', {
      replyToMessageId: event.replyToMessageId,
      textPayload: event.textPayload,
    });

    const dictionary = getDictionary();
    const mapping = this.transactionMessageStore.getMessageMapping(event.replyToMessageId);

    if (!mapping) {
      // 1. Check if replied message corresponds to an active pending transaction ticket prompt
      if (this.pendingTransactionService) {
        const allPending = typeof this.pendingTransactionService.getAllPendingTransactions === 'function'
          ? this.pendingTransactionService.getAllPendingTransactions()
          : [];
        const matchingPendingItem = allPending.find(item =>
          item.notificationMessageIds &&
          Object.values(item.notificationMessageIds).includes(event.replyToMessageId!)
        );

        if (matchingPendingItem) {
          const rejected = this.pendingTransactionService.rejectPendingTransaction(matchingPendingItem.ticketId);
          if (rejected) {
            const cancelMsg = formatPendingCancellationMessage(rejected);
            await this.messagingGateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              cancelMsg
            );
            return true;
          }
        }
      }

      // 2. If user issued a generic cancellation ("batal", "cancel") without a matching record mapping,
      // allow downstream handlers (e.g. clarification draft cancellation or latest pending) to process it.
      if (CANCELLATION_COMMAND_PATTERN.test(event.textPayload.trim())) {
        return false;
      }

      // 3. User explicitly issued a delete command ("hapus", "delete") on an unknown or expired message
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        dictionary.errors.recordDeleteNotFound
      );
      return true;
    }

    const idsToDelete: string[] = [mapping.recordId];
    if (mapping.partnerRecordId && !idsToDelete.includes(mapping.partnerRecordId)) {
      idsToDelete.push(mapping.partnerRecordId);
    }

    try {
      await this.walletMcpClient.deleteRecords(idsToDelete);

      // Clean up mapping from message store so it cannot be operated on again
      this.transactionMessageStore.deleteMessageMapping(event.replyToMessageId);

      // Format response receipt
      const finalAmount = mapping.amount ?? 0;
      const isTransfer = mapping.isTransfer === true;
      const isExpense = finalAmount < 0;
      const transactionTypeIcon = isTransfer ? '🔄' : isExpense ? '💸' : '💰';

      const cachedAccounts = this.walletCacheService.getAccounts();
      const targetAccount = cachedAccounts.find(account => account.id === mapping.accountId);
      const resolvedCurrency = mapping.currency || targetAccount?.currency || getDefaultCurrency();
      const formattedAmount = formatCurrencyAmount(finalAmount, resolvedCurrency, dictionary.languageCode);
      const resolvedAccountName = targetAccount?.name || mapping.accountName || 'Wallet';

      const cachedCategories = this.walletCacheService.getCategories();
      const defaultCategoryName = isTransfer ? dictionary.labels.transfer : (dictionary.labels.defaultCategory || 'Umum');
      const finalCategoryName =
        mapping.categoryName ||
        cachedCategories.find(category => category.id === mapping.categoryId)?.name ||
        defaultCategoryName;

      const recordTimestampDisplay = formatTransactionDate(
        mapping.recordDate || mapping.createdAt,
        dictionary.languageCode
      );

      const defaultTitle = isTransfer
        ? dictionary.labels.transfer
        : (isExpense ? dictionary.labels.expense : dictionary.labels.income);
      const displayTitle = resolveTransactionDisplayTitle({
        counterParty: mapping.counterParty,
        note: mapping.note,
        defaultTitle,
      });

      const responseText = dictionary.records.deleteSuccess({
        transactionTitle: displayTitle,
        formattedAmount,
        accountName: resolvedAccountName,
        categoryName: finalCategoryName,
        recordTimestampDisplay,
        transactionTypeIcon,
        isTransfer,
        labels: mapping.labels,
      });

      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        responseText
      );

      return true;
    } catch (deleteError) {
      const errorMessage =
        deleteError instanceof Error ? deleteError.message : String(deleteError);
      applicationLogger.error(`Failed to delete record '${mapping.recordId}': ${errorMessage}`);
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        dictionary.errors.recordDeleteFailed(errorMessage)
      );
      return true;
    }
  }
}
