import { WalletRecordItem } from '../types/walletTypes.js';

export const MAX_SEARCH_QUERY_LENGTH = 100;

function escapeRegularExpression(literalString: string): string {
  return literalString.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Deterministically evaluates whether a transaction record matches a given keyword query.
 * Semantics:
 * - Checks supported transaction text fields: merchant/payee (counterParty) and note/description (note).
 * - Matching is case-insensitive.
 * - For short keywords (length <= 2, e.g. "ai"), matches whole terms using word boundaries to prevent
 *   false positives on incidental substrings (e.g. "Jaya" or "Kedai").
 * - For longer keywords, performs case-insensitive substring matching.
 * - Returns true if either field matches the search keyword.
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

  const checkFieldMatch = (fieldValue?: string | null): boolean => {
    if (!fieldValue || typeof fieldValue !== 'string') {
      return false;
    }
    const lowerFieldValue = fieldValue.toLowerCase();
    if (normalizedSearchKeyword.length <= 2) {
      const wordBoundaryPattern = new RegExp(`\\b${escapeRegularExpression(normalizedSearchKeyword)}\\b`, 'i');
      return wordBoundaryPattern.test(lowerFieldValue);
    }
    return lowerFieldValue.includes(normalizedSearchKeyword);
  };

  if (checkFieldMatch(recordItem.counterParty)) {
    return true;
  }

  if (checkFieldMatch(recordItem.note)) {
    return true;
  }

  return false;
}

