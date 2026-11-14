import type {
  IncomingUserMessageEvent,
  MessagingGatewayService,
  SupportedMessengerChannel,
} from '../../gateway/index.js';
import { createTelegramDeleteConfirmInlineKeyboard } from '../../gateway/index.js';
import type { WalletCacheService, WalletMcpClientService, StoredRecordMessageMapping } from '../../wallet/index.js';
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
const DELETE_CONFIRM_COMMAND_PATTERN = /^\/delete_confirm(?:\s+(\S+))?$/i;
const DELETE_CANCEL_COMMAND_PATTERN = /^\/delete_cancel(?:\s+(\S+))?$/i;
const CONVERSATIONAL_CONFIRM_PATTERN = /^(?:ya|hapus|ok|oke|yes|y|confirm|lanjutkan|delete)$/i;
const CONVERSATIONAL_CANCEL_PATTERN = /^(?:batal|cancel|abaikan|gak|ga|gajadi|jangan|no|n|stop)$/i;

const CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export interface ActiveDeleteConfirmation {
  readonly messageId: string;
  readonly promptMessageId?: string;
  readonly expiresAt: number;
}

/**
 * Checks whether an incoming message string expresses a transaction deletion command.
 */
export function isRecordDeleteCommand(textPayload: string): boolean {
  if (!textPayload) return false;
  return DELETE_COMMAND_PATTERN.test(textPayload.trim());
}

/**
 * Checks whether an incoming message string expresses an explicit delete confirmation command.
 */
export function isDeleteConfirmationCommand(textPayload: string): boolean {
  if (!textPayload) return false;
  return DELETE_CONFIRM_COMMAND_PATTERN.test(textPayload.trim());
}

/**
 * Checks whether an incoming message string expresses an explicit delete cancellation command.
 */
export function isDeleteCancellationCommand(textPayload: string): boolean {
  if (!textPayload) return false;
  return DELETE_CANCEL_COMMAND_PATTERN.test(textPayload.trim());
}

/**
 * Coordinates conversational transaction deletion workflows triggered when a user
 * replies to a previously recorded transaction receipt card in Telegram or WhatsApp.
 * Supports interactive inline button confirmation and conversational confirmations.
 */
export class DeleteRecordHandler {
  private readonly activeConfirmations = new Map<string, ActiveDeleteConfirmation>();

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    private readonly transactionMessageStore: TransactionMessageStore,
    private readonly pendingTransactionService?: PendingTransactionService
  ) {}

  public isDeleteConfirmationCommand(textPayload: string): boolean {
    return isDeleteConfirmationCommand(textPayload);
  }

  public isDeleteCancellationCommand(textPayload: string): boolean {
    return isDeleteCancellationCommand(textPayload);
  }

  public getActiveConfirmation(chatIdentifier: string): ActiveDeleteConfirmation | undefined {
    const active = this.activeConfirmations.get(chatIdentifier);
    if (!active) return undefined;
    if (Date.now() > active.expiresAt) {
      this.activeConfirmations.delete(chatIdentifier);
      return undefined;
    }
    return active;
  }

  public hasActiveConfirmation(chatIdentifier: string): boolean {
    return this.getActiveConfirmation(chatIdentifier) !== undefined;
  }

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

    // Format confirmation prompt card
    const displayContext = this.resolveRecordDisplayContext(mapping, dictionary);

    const promptText = dictionary.records.deleteConfirmPrompt({
      transactionTitle: displayContext.displayTitle,
      formattedAmount: displayContext.formattedAmount,
      accountName: displayContext.resolvedAccountName,
      categoryName: displayContext.finalCategoryName,
      recordTimestampDisplay: displayContext.recordTimestampDisplay,
      transactionTypeIcon: displayContext.transactionTypeIcon,
      isTransfer: displayContext.isTransfer,
      destinationAccountName: mapping.destinationAccountName,
      labels: mapping.labels,
    });

    const replyMarkup = createTelegramDeleteConfirmInlineKeyboard(
      event.replyToMessageId,
      dictionary.languageCode
    );

    const promptReceipt = await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      promptText,
      { replyMarkup }
    );

    // Save active confirmation state
    this.activeConfirmations.set(event.chatIdentifier, {
      messageId: event.replyToMessageId,
      promptMessageId: promptReceipt?.messageId,
      expiresAt: Date.now() + CONFIRMATION_TIMEOUT_MS,
    });

    return true;
  }

  public async handleDeleteConfirmationCommand(event: IncomingUserMessageEvent): Promise<boolean> {
    const match = event.textPayload?.trim().match(DELETE_CONFIRM_COMMAND_PATTERN);
    const active = this.activeConfirmations.get(event.chatIdentifier);
    const targetMessageId = match?.[1] || active?.messageId;

    if (!targetMessageId) {
      return false;
    }

    this.activeConfirmations.delete(event.chatIdentifier);
    return await this.executeDelete(targetMessageId, event.channel, event.chatIdentifier);
  }

  public async handleDeleteCancellationCommand(event: IncomingUserMessageEvent): Promise<boolean> {
    this.activeConfirmations.delete(event.chatIdentifier);
    const dictionary = getDictionary();
    await this.messagingGateway.sendMessage(
      event.channel,
      event.chatIdentifier,
      dictionary.records.deleteCancelledText
    );
    return true;
  }

  public async handleConversationalReply(event: IncomingUserMessageEvent): Promise<boolean> {
    const active = this.getActiveConfirmation(event.chatIdentifier);
    if (!active) return false;

    if (
      event.replyToMessageId &&
      event.replyToMessageId !== active.messageId &&
      event.replyToMessageId !== active.promptMessageId
    ) {
      return false;
    }

    const trimmed = (event.textPayload || '').trim();
    if (CONVERSATIONAL_CONFIRM_PATTERN.test(trimmed)) {
      this.activeConfirmations.delete(event.chatIdentifier);
      return await this.executeDelete(active.messageId, event.channel, event.chatIdentifier);
    }

    if (CONVERSATIONAL_CANCEL_PATTERN.test(trimmed)) {
      this.activeConfirmations.delete(event.chatIdentifier);
      const dictionary = getDictionary();
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        dictionary.records.deleteCancelledText
      );
      return true;
    }

    return false;
  }

  public async executeDelete(
    targetMessageId: string,
    channel: SupportedMessengerChannel,
    chatIdentifier: string
  ): Promise<boolean> {
    const dictionary = getDictionary();
    const mapping = this.transactionMessageStore.getMessageMapping(targetMessageId);

    if (!mapping) {
      await this.messagingGateway.sendMessage(
        channel,
        chatIdentifier,
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
      this.transactionMessageStore.deleteMessageMapping(targetMessageId);

      // Format response receipt
      const displayContext = this.resolveRecordDisplayContext(mapping, dictionary);

      const responseText = dictionary.records.deleteSuccess({
        transactionTitle: displayContext.displayTitle,
        formattedAmount: displayContext.formattedAmount,
        accountName: displayContext.resolvedAccountName,
        categoryName: displayContext.finalCategoryName,
        recordTimestampDisplay: displayContext.recordTimestampDisplay,
        transactionTypeIcon: displayContext.transactionTypeIcon,
        isTransfer: displayContext.isTransfer,
        destinationAccountName: mapping.destinationAccountName,
        labels: mapping.labels,
      });

      await this.messagingGateway.sendMessage(
        channel,
        chatIdentifier,
        responseText
      );

      return true;
    } catch (deleteError) {
      const errorMessage =
        deleteError instanceof Error ? deleteError.message : String(deleteError);
      applicationLogger.error(`Failed to delete record '${mapping.recordId}': ${errorMessage}`);
      await this.messagingGateway.sendMessage(
        channel,
        chatIdentifier,
        dictionary.errors.recordDeleteFailed(errorMessage)
      );
      return true;
    }
  }

  private resolveRecordDisplayContext(
    mapping: StoredRecordMessageMapping,
    dictionary: ReturnType<typeof getDictionary>
  ) {
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

    return {
      displayTitle,
      formattedAmount,
      resolvedAccountName,
      finalCategoryName,
      recordTimestampDisplay,
      transactionTypeIcon,
      isTransfer,
    };
  }
}
