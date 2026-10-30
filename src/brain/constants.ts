/**
 * Canonical domain constants for the Brain domain, absorbing dispatch states,
 * financial action types, routing sources, and AI provider identifiers.
 */

export enum TicketDispatchState {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
  Failed = 'DEFINITIVE_FAILURE',
  Unknown = 'UNKNOWN',
}

export const DISPATCH_STATES = {
  PENDING: TicketDispatchState.Pending,
  PROCESSING: TicketDispatchState.Processing,
  CONFIRMED: TicketDispatchState.Confirmed,
  CANCELLED: TicketDispatchState.Cancelled,
  DEFINITIVE_FAILURE: TicketDispatchState.Failed,
  UNKNOWN: TicketDispatchState.Unknown,
} as const;

export type DispatchStateValue = (typeof DISPATCH_STATES)[keyof typeof DISPATCH_STATES];

export const CORRELATION_CONFIDENCE = {
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
} as const;

export type CorrelationConfidence =
  (typeof CORRELATION_CONFIDENCE)[keyof typeof CORRELATION_CONFIDENCE];

export const CORRELATION_SUGGESTED_ACTIONS = {
  MERGE_PENDING: 'MERGE_PENDING',
  ATTACH_WALLET_RECORD: 'ATTACH_WALLET_RECORD',
  CLARIFY: 'CLARIFY',
  CREATE_INDEPENDENT: 'CREATE_INDEPENDENT',
} as const;

export type CorrelationSuggestedAction =
  (typeof CORRELATION_SUGGESTED_ACTIONS)[keyof typeof CORRELATION_SUGGESTED_ACTIONS];

export const DIAGNOSTIC_STATUS = {
  SUCCESS: 'SUCCESS',
  PASS: 'PASS',
  WARN: 'WARN',
  ERROR: 'ERROR',
} as const;

export type DiagnosticStatus =
  (typeof DIAGNOSTIC_STATUS)[keyof typeof DIAGNOSTIC_STATUS];

export const FINANCIAL_ACTION_TYPES = {
  CREATE_RECORD: 'CREATE_RECORD',
  CHECK_BALANCE: 'CHECK_BALANCE',
  CHECK_BUDGET: 'CHECK_BUDGET',
  HELP_MENU: 'HELP_MENU',
  TRANSACTION_HISTORY: 'TRANSACTION_HISTORY',
  TRANSACTION_SUMMARY: 'TRANSACTION_SUMMARY',
  CHECK_QUEUE: 'CHECK_QUEUE',
} as const;

export type FinancialActionTypeValue =
  (typeof FINANCIAL_ACTION_TYPES)[keyof typeof FINANCIAL_ACTION_TYPES];

export const ROUTING_SOURCES = {
  FAST_PATH: 'fast-path',
  AI: 'ai',
  DIRECT: 'direct',
} as const;

export type RoutingSourceValue =
  (typeof ROUTING_SOURCES)[keyof typeof ROUTING_SOURCES];
