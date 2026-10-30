import type {
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletRecordItem,
} from './types.js';
import type {
  SummaryCache,
  SummaryHistoryProvider,
} from './queryTypes.js';
import {
  normalizeCurrencyCode,
  finalizeCurrencyTotals,
  buildBreakdown,
  type MutableCurrencyTotals,
} from './summaryHelpers.js';

/**
 * Calculates a transaction summary by paginating through the transaction history provider.
 * Used as a fallback when native aggregation is unsupported or when free-text searching.
 */
export async function getCompatibilityFallbackSummary(
  historyProvider: SummaryHistoryProvider,
  _cache?: SummaryCache,
  queryOptions: TransactionSummaryQueryOptions = {},
  referenceDate: Date = new Date()
): Promise<TransactionSummaryResult> {
  const { groupBy = 'none', ...historyFilters } = queryOptions;
  const collectedRecords: WalletRecordItem[] = [];
  const seenRecordIds = new Set<string>();
  let currentOffset: number | undefined = 0;
  let hasMore = true;
  let pageCount = 0;
  let excludedTransferCount = 0;
  let appliedFilters: any = undefined;

  while (hasMore && pageCount < 20) {
    pageCount += 1;
    const pageResult = await historyProvider.getTransactionHistory(
      { ...historyFilters, limit: 50, offset: currentOffset },
      referenceDate
    );
    if (!appliedFilters && (pageResult as any).appliedFilters) {
      appliedFilters = (pageResult as any).appliedFilters;
    }
    for (const recordItem of pageResult.records) {
      if (recordItem.id && seenRecordIds.has(recordItem.id)) continue;
      if (recordItem.id) seenRecordIds.add(recordItem.id);
      if (recordItem.recordType === 'transfer' || Boolean(recordItem.transfer)) {
        excludedTransferCount += 1;
        continue;
      }
      collectedRecords.push(recordItem);
    }
    hasMore = pageResult.hasMore && pageResult.nextOffset !== null && pageResult.nextOffset !== currentOffset;
    currentOffset = pageResult.nextOffset ?? undefined;
  }

  const totalsByCurrency = new Map<string, MutableCurrencyTotals>();
  for (const record of collectedRecords) {
    const currency = normalizeCurrencyCode(record.currency);
    let curr = totalsByCurrency.get(currency);
    if (!curr) {
      curr = { currency, income: 0, expense: 0, transactionCount: 0 };
      totalsByCurrency.set(currency, curr);
    }
    const absAmt = Math.abs(record.amount);
    if (record.recordType === 'expense') curr.expense += absAmt;
    else curr.income += absAmt;
    curr.transactionCount += 1;
  }

  const totals = finalizeCurrencyTotals(totalsByCurrency);
  const isMultiCurrency = totals.length > 1;
  const breakdown = buildBreakdown(collectedRecords, groupBy, isMultiCurrency);

  return {
    transactionCount: collectedRecords.length,
    excludedTransferCount,
    totals,
    breakdown,
    groupBy,
    isMultiCurrency,
    isComplete: !hasMore,
    appliedFilters,
  };
}
