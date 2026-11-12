import { FinancialActionExecutor } from '../executor.js';
import { PendingTransactionService } from '../pending.js';
import { MessagingGatewayService, createTelegramPendingConfirmInlineKeyboard } from '../../gateway/index.js';
import {
  buildTransactionAttentionSummary,
  TransactionAttentionSummaryViewModel,
} from '../../wallet/formatters/transactionStatusViewModel.js';
import {
  formatTransactionAttentionSummary,
  formatPendingQueueItemCard,
  formatPendingQueueItemFromViewModel,
} from '../../wallet/formatters/transactionStatusFormatter.js';
import { getDictionary } from '../../i18n/index.js';
import { FINANCIAL_ACTION_TYPES } from '../../brain/constants.js';
import {
  CheckBalanceActionContext,
  CheckBudgetActionContext,
  CheckQueueActionContext,
  FinancialActionHandler,
  HelpMenuActionContext,
  TransactionHistoryActionContext,
  TransactionSummaryActionContext,
} from '../types.js';

/**
 * Handles account balance queries by delegating to the shared FinancialActionExecutor.
 */
export class CheckBalanceActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.CHECK_BALANCE> {
  public readonly action = FINANCIAL_ACTION_TYPES.CHECK_BALANCE;

  constructor(private readonly financialActionExecutor: FinancialActionExecutor) {}

  public async execute(context: CheckBalanceActionContext): Promise<void> {
    await this.financialActionExecutor.executeCheckBalance(context.event, {
      processingStartTimestamp: context.processingStartTimestamp,
      routingSource: context.routingSource,
    });
  }
}

/**
 * Handles budget status queries by delegating to the shared FinancialActionExecutor.
 */
export class CheckBudgetActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.CHECK_BUDGET> {
  public readonly action = FINANCIAL_ACTION_TYPES.CHECK_BUDGET;

  constructor(private readonly financialActionExecutor: FinancialActionExecutor) {}

  public async execute(context: CheckBudgetActionContext): Promise<void> {
    await this.financialActionExecutor.executeCheckBudget(context.event, {
      processingStartTimestamp: context.processingStartTimestamp,
      routingSource: context.routingSource,
    });
  }
}

/**
 * Handles help and quick-command guidance by delegating to the shared FinancialActionExecutor.
 */
export class HelpMenuActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.HELP_MENU> {
  public readonly action = FINANCIAL_ACTION_TYPES.HELP_MENU;

  constructor(private readonly financialActionExecutor: FinancialActionExecutor) {}

  public async execute(context: HelpMenuActionContext): Promise<void> {
    await this.financialActionExecutor.executeHelpMenu(context.event, {
      processingStartTimestamp: context.processingStartTimestamp,
      routingSource: context.routingSource,
    });
  }
}

/**
 * Handles transaction history queries by delegating to the shared FinancialActionExecutor.
 */
export class TransactionHistoryActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY> {
  public readonly action = FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY;

  constructor(private readonly financialActionExecutor: FinancialActionExecutor) {}

  public async execute(context: TransactionHistoryActionContext): Promise<void> {
    await this.financialActionExecutor.executeTransactionHistory(
      context.event,
      context.queryOptions,
      {
        processingStartTimestamp: context.processingStartTimestamp,
        routingSource: context.routingSource,
      }
    );
  }
}

/**
 * Handles transaction summary calculations by delegating to the shared FinancialActionExecutor.
 */
export class TransactionSummaryActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY> {
  public readonly action = FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY;

  constructor(private readonly financialActionExecutor: FinancialActionExecutor) {}

  public async execute(context: TransactionSummaryActionContext): Promise<void> {
    await this.financialActionExecutor.executeTransactionSummary(
      context.event,
      context.summaryOptions,
      {
        processingStartTimestamp: context.processingStartTimestamp,
        routingSource: context.routingSource,
      }
    );
  }
}

/**
 * Handles transaction queue / attention status queries.
 */
export class CheckQueueActionHandler implements FinancialActionHandler<typeof FINANCIAL_ACTION_TYPES.CHECK_QUEUE> {
  public readonly action = FINANCIAL_ACTION_TYPES.CHECK_QUEUE;

  constructor(
    private readonly pendingTransactionService: PendingTransactionService,
    private readonly messagingGateway: MessagingGatewayService
  ) {}

  public async execute(context: CheckQueueActionContext): Promise<void> {
    const summary = buildTransactionAttentionSummary(this.pendingTransactionService);

    // If completely empty, send the standard empty summary message
    if (summary.totalNeedingAttention === 0) {
      const replyMessage = formatTransactionAttentionSummary(summary);
      await this.messagingGateway.sendMessage(context.event.channel, context.event.chatIdentifier, replyMessage);
      return;
    }

    // If there are pending confirmation items, dispatch each as its own bubble (up to MAX_QUEUE_BUBBLES)
    if (summary.waitingConfirmationItems.length > 0) {
      const MAX_QUEUE_BUBBLES = 5;
      const itemsToDisplay = summary.waitingConfirmationItems.slice(0, MAX_QUEUE_BUBBLES);
      const remainingCount = summary.waitingConfirmationItems.length - itemsToDisplay.length;

      for (const item of itemsToDisplay) {
        const pendingItem = this.pendingTransactionService.getPendingTransaction(item.ticketId);
        const bubbleText = pendingItem
          ? formatPendingQueueItemCard(pendingItem)
          : formatPendingQueueItemFromViewModel(item);

        const replyMarkup = context.event.channel === 'telegram'
          ? createTelegramPendingConfirmInlineKeyboard(item.ticketId)
          : undefined;

        const receipt = await this.messagingGateway.sendMessage(
          context.event.channel,
          context.event.chatIdentifier,
          bubbleText,
          replyMarkup ? { replyMarkup } : undefined
        );

        if (
          receipt &&
          typeof receipt === 'object' &&
          'messageId' in receipt &&
          receipt.messageId
        ) {
          this.pendingTransactionService.updateNotificationMessageIds(item.ticketId, {
            [context.event.channel]: receipt.messageId,
            [`${context.event.channel}:${receipt.messageId}`]: receipt.messageId,
          });
        }
      }

      if (remainingCount > 0) {
        const dictionary = getDictionary();
        const remainingNotice = dictionary.status.remainingQueueNotice(remainingCount);
        await this.messagingGateway.sendMessage(context.event.channel, context.event.chatIdentifier, remainingNotice);
      }

      // If other non-standard attention items exist (uncertain or draft), send a subsequent summary bubble
      const otherTotal =
        summary.needsCheckItems.length +
        summary.waitingAccountItems.length +
        summary.waitingCategoryItems.length;

      if (otherTotal > 0) {
        const otherSummary: TransactionAttentionSummaryViewModel = {
          totalNeedingAttention: otherTotal,
          needsCheckItems: summary.needsCheckItems,
          waitingConfirmationItems: [],
          waitingAccountItems: summary.waitingAccountItems,
          waitingCategoryItems: summary.waitingCategoryItems,
        };
        const otherReplyMessage = formatTransactionAttentionSummary(otherSummary);
        await this.messagingGateway.sendMessage(context.event.channel, context.event.chatIdentifier, otherReplyMessage);
      }
      return;
    }

    // Fallback: If only uncertain or draft items exist without standard pending items
    const replyMessage = formatTransactionAttentionSummary(summary);
    await this.messagingGateway.sendMessage(context.event.channel, context.event.chatIdentifier, replyMessage);
  }
}
