import { FinancialActionExecutor } from '../executor.js';
import { PendingTransactionService } from '../pending.js';
import { MessagingGatewayService } from '../../gateway/index.js';
import { buildTransactionAttentionSummary } from '../../wallet/formatters/transactionStatusViewModel.js';
import { formatTransactionAttentionSummary } from '../../wallet/formatters/transactionStatusFormatter.js';
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
    const replyMessage = formatTransactionAttentionSummary(summary);
    await this.messagingGateway.sendMessage(context.event.channel, context.event.chatIdentifier, replyMessage);
  }
}
