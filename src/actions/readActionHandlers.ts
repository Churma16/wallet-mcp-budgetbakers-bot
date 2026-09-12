import { FinancialActionExecutor } from '../services/financialActionExecutor.js';
import {
  CheckBalanceActionContext,
  CheckBudgetActionContext,
  FinancialActionHandler,
  HelpMenuActionContext,
  TransactionHistoryActionContext,
  TransactionSummaryActionContext,
} from './types.js';

/**
 * Handles account balance queries by delegating to the shared FinancialActionExecutor.
 */
export class CheckBalanceActionHandler implements FinancialActionHandler<'CHECK_BALANCE'> {
  public readonly action = 'CHECK_BALANCE' as const;

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
export class CheckBudgetActionHandler implements FinancialActionHandler<'CHECK_BUDGET'> {
  public readonly action = 'CHECK_BUDGET' as const;

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
export class HelpMenuActionHandler implements FinancialActionHandler<'HELP_MENU'> {
  public readonly action = 'HELP_MENU' as const;

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
export class TransactionHistoryActionHandler implements FinancialActionHandler<'TRANSACTION_HISTORY'> {
  public readonly action = 'TRANSACTION_HISTORY' as const;

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
export class TransactionSummaryActionHandler implements FinancialActionHandler<'TRANSACTION_SUMMARY'> {
  public readonly action = 'TRANSACTION_SUMMARY' as const;

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
