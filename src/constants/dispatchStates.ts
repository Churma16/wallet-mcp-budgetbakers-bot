/**
 * Canonical states for ticket dispatch lifecycle, correlation confidence/actions,
 * and diagnostic health check statuses.
 */

export enum TicketDispatchState {
  Pending = 'PENDING',
  Processing = 'PROCESSING',
  Confirmed = 'CONFIRMED',
  Cancelled = 'CANCELLED',
  Failed = 'DEFINITIVE_FAILURE',
  Unknown = 'UNKNOWN',
}

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
