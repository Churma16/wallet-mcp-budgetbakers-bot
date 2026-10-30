import { IncomingUserMessageEvent } from '../services/messaging/index.js';
import {
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../types/walletTypes.js';
import { ExtractedFinancialRecordItem } from '../services/ai/index.js';
import {
  FINANCIAL_ACTION_TYPES,
  RoutingSourceValue,
} from '../constants/index.js';

export interface BaseFinancialActionContext {
  readonly event: IncomingUserMessageEvent;
  readonly processingStartTimestamp?: number;
  readonly routingSource?: RoutingSourceValue;
}

export interface CheckBalanceActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.CHECK_BALANCE;
}

export interface CheckBudgetActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.CHECK_BUDGET;
}

export interface HelpMenuActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.HELP_MENU;
}

export interface TransactionHistoryActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY;
  readonly queryOptions?: TransactionHistoryQueryOptions;
}

export interface TransactionSummaryActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY;
  readonly summaryOptions: TransactionSummaryQueryOptions;
}

export interface CreateRecordActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.CREATE_RECORD;
  readonly records: ExtractedFinancialRecordItem[];
  readonly requestReferenceInstant?: Date;
}

export interface CheckQueueActionContext extends BaseFinancialActionContext {
  readonly action: typeof FINANCIAL_ACTION_TYPES.CHECK_QUEUE;
}

export type FinancialActionContext =
  | CheckBalanceActionContext
  | CheckBudgetActionContext
  | HelpMenuActionContext
  | CheckQueueActionContext
  | TransactionHistoryActionContext
  | TransactionSummaryActionContext
  | CreateRecordActionContext;

export type FinancialActionType = FinancialActionContext['action'];

export interface FinancialActionHandler<TType extends FinancialActionType = FinancialActionType> {
  readonly action: TType;
  execute(context: Extract<FinancialActionContext, { action: TType }>): Promise<void>;
}

export class UnknownFinancialActionError extends Error {
  constructor(public readonly action: string) {
    super(`No financial action handler registered for action: ${action}`);
    this.name = 'UnknownFinancialActionError';
  }
}
