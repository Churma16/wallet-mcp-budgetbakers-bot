import { IncomingUserMessageEvent } from '../services/messaging/index.js';
import {
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../types/walletTypes.js';
import { ExtractedFinancialRecordItem } from '../services/ai/index.js';

export interface BaseFinancialActionContext {
  readonly event: IncomingUserMessageEvent;
  readonly processingStartTimestamp?: number;
  readonly routingSource?: 'fast-path' | 'ai' | 'direct';
}

export interface CheckBalanceActionContext extends BaseFinancialActionContext {
  readonly action: 'CHECK_BALANCE';
}

export interface CheckBudgetActionContext extends BaseFinancialActionContext {
  readonly action: 'CHECK_BUDGET';
}

export interface HelpMenuActionContext extends BaseFinancialActionContext {
  readonly action: 'HELP_MENU';
}

export interface TransactionHistoryActionContext extends BaseFinancialActionContext {
  readonly action: 'TRANSACTION_HISTORY';
  readonly queryOptions?: TransactionHistoryQueryOptions;
}

export interface TransactionSummaryActionContext extends BaseFinancialActionContext {
  readonly action: 'TRANSACTION_SUMMARY';
  readonly summaryOptions: TransactionSummaryQueryOptions;
}

export interface CreateRecordActionContext extends BaseFinancialActionContext {
  readonly action: 'CREATE_RECORD';
  readonly records: ExtractedFinancialRecordItem[];
  readonly requestReferenceInstant?: Date;
}

export type FinancialActionContext =
  | CheckBalanceActionContext
  | CheckBudgetActionContext
  | HelpMenuActionContext
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
