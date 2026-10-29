/**
 * Canonical financial action types and message routing sources.
 */

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
