import { WalletRecordItem } from '../types/walletTypes.js';

export const MAX_SEARCH_QUERY_LENGTH = 100;

/**
 * Deterministically evaluates whether a transaction record matches a given keyword query.
 * Semantics:
 * - Checks supported transaction text fields: merchant/payee (counterParty) and note/description (note).
 * - Matching is case-insensitive and partial (substring match).
 * - Returns true if either field contains the trimmed search keyword.
 * - Handles missing, null, or undefined fields safely without throwing.
 */
export function matchesTransactionRecordSearch(
  recordItem: WalletRecordItem,
  rawSearchQuery: string
): boolean {
  if (!rawSearchQuery || typeof rawSearchQuery !== 'string') {
    return false;
  }

  const normalizedSearchKeyword = rawSearchQuery.trim().toLowerCase();
  if (normalizedSearchKeyword.length === 0) {
    return false;
  }

  if (
    recordItem.counterParty &&
    typeof recordItem.counterParty === 'string' &&
    recordItem.counterParty.toLowerCase().includes(normalizedSearchKeyword)
  ) {
    return true;
  }

  if (
    recordItem.note &&
    typeof recordItem.note === 'string' &&
    recordItem.note.toLowerCase().includes(normalizedSearchKeyword)
  ) {
    return true;
  }

  return false;
}
