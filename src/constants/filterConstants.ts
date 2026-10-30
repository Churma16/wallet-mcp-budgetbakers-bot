/**
 * Canonical error and resolution reasons for transaction query filters.
 */

export const FILTER_ERROR_REASONS = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_RANGE: 'INVALID_RANGE',
  UNSUPPORTED: 'UNSUPPORTED',
  UNRESOLVED: 'UNRESOLVED',
  AMBIGUOUS: 'AMBIGUOUS',
} as const;

export type FilterErrorReasonValue =
  (typeof FILTER_ERROR_REASONS)[keyof typeof FILTER_ERROR_REASONS];
