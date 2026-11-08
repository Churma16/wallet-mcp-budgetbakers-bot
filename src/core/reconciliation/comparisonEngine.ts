import type { WalletRecordItem } from '../../wallet/types.js';
import type {
  BankMutationItem,
  MatchedMutationPair,
  WrongAccountMutationPair,
  MissingMutationItem,
  ReconciliationComparisonResult,
} from './types.js';

/**
 * Calculates absolute calendar day distance between two ISO date strings (ignoring clock time).
 */
export function getCalendarDayDifference(dateStr1: string, dateStr2: string): number {
  const d1 = new Date(dateStr1.slice(0, 10) + 'T00:00:00Z').getTime();
  const d2 = new Date(dateStr2.slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.abs(Math.round((d1 - d2) / (24 * 60 * 60 * 1000)));
}

function doesDirectionMatch(mutationDirection: 'DEBIT' | 'CREDIT', recordType: string): boolean {
  if (mutationDirection === 'DEBIT') {
    return recordType === 'expense';
  }
  return recordType === 'income';
}

export interface ComparisonEngineOptions {
  readonly maxCalendarDayDistance?: number; // default: 1
}

/**
 * Reconciles extracted bank mutations against Wallet records using strict exact amounts
 * and Distance-Priority Greedy Pairing (exact same day preferred before 1-day tolerance).
 */
export function compareMutationsWithWalletRecords(
  mutations: readonly BankMutationItem[],
  targetAccountId: string,
  targetAccountName: string,
  walletRecords: readonly WalletRecordItem[],
  options?: ComparisonEngineOptions
): ReconciliationComparisonResult {
  const maxDayDistance = options?.maxCalendarDayDistance ?? 1;

  const targetRecords = walletRecords.filter(r => r.accountId === targetAccountId);
  const otherRecords = walletRecords.filter(r => r.accountId !== targetAccountId);

  const usedTargetRecordIds = new Set<string>();
  const usedOtherRecordIds = new Set<string>();

  const matched: MatchedMutationPair[] = [];
  const wrongAccount: WrongAccountMutationPair[] = [];
  const missing: MissingMutationItem[] = [];

  // Sort mutations chronologically for stable deterministic pairing
  const sortedMutations = [...mutations].sort((a, b) => a.date.localeCompare(b.date));

  for (const mutation of sortedMutations) {
    // 1. Look for match in target account records
    const targetCandidates = targetRecords
      .filter(rec => {
        if (usedTargetRecordIds.has(rec.id)) return false;
        if (Math.abs(rec.amount) !== mutation.amount) return false;
        if (!doesDirectionMatch(mutation.direction, rec.recordType)) return false;
        const diff = getCalendarDayDifference(rec.recordDate, mutation.date);
        return diff <= maxDayDistance;
      })
      .map(rec => ({
        record: rec,
        dayDistance: getCalendarDayDifference(rec.recordDate, mutation.date),
      }))
      .sort((a, b) => a.dayDistance - b.dayDistance);

    if (targetCandidates.length > 0) {
      const best = targetCandidates[0].record;
      usedTargetRecordIds.add(best.id);
      matched.push({
        mutation,
        walletRecord: best,
      });
      continue;
    }

    // 2. Look for cross-wallet mismatch (same amount & date range in other accounts)
    const otherCandidates = otherRecords
      .filter(rec => {
        if (usedOtherRecordIds.has(rec.id)) return false;
        if (Math.abs(rec.amount) !== mutation.amount) return false;
        if (!doesDirectionMatch(mutation.direction, rec.recordType)) return false;
        const diff = getCalendarDayDifference(rec.recordDate, mutation.date);
        return diff <= maxDayDistance;
      })
      .map(rec => ({
        record: rec,
        dayDistance: getCalendarDayDifference(rec.recordDate, mutation.date),
      }))
      .sort((a, b) => a.dayDistance - b.dayDistance);

    if (otherCandidates.length > 0) {
      const best = otherCandidates[0].record;
      usedOtherRecordIds.add(best.id);
      wrongAccount.push({
        mutation,
        walletRecord: best,
        actualAccountName: best.accountName || 'Lainnya',
      });
      continue;
    }

    // 3. Not found anywhere -> missing transaction
    missing.push({
      mutation,
      suggestedCategoryName: mutation.direction === 'DEBIT' ? 'Transportasi' : undefined,
      note: mutation.note || mutation.counterParty,
    });
  }

  // 4. Extra records in target account (not matched to any mutation in this period)
  const extraInWallet = targetRecords.filter(r => !usedTargetRecordIds.has(r.id));

  // 5. Date bounding range
  const dates = sortedMutations.map(m => m.date).filter(Boolean);
  const startDate = dates.length > 0 ? dates[0] : new Date().toISOString().slice(0, 10);
  const endDate = dates.length > 0 ? dates[dates.length - 1] : startDate;

  return {
    targetAccountId,
    targetAccountName,
    dateRange: { startDate, endDate },
    totalMutations: sortedMutations.length,
    matched,
    wrongAccount,
    missing,
    extraInWallet,
  };
}
