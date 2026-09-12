import { TransactionHistoryService } from './transactionHistoryService.js';
import {
  TransactionCurrencyTotals,
  TransactionSummaryBreakdownItem,
  TransactionSummaryGroupBy,
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletRecordItem,
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';

const SUMMARY_PAGE_SIZE = 50;
const MAX_SUMMARY_PAGES = 200;

interface MutableCurrencyTotals {
  currency: string;
  income: number;
  expense: number;
  transactionCount: number;
}

interface MutableBreakdownItem {
  key: string;
  name?: string;
  transactionCount: number;
  totalsByCurrency: Map<string, MutableCurrencyTotals>;
}

function normalizeCurrencyCode(currencyCode?: string): string {
  const normalizedCurrencyCode = currencyCode?.trim().toUpperCase();
  return normalizedCurrencyCode || 'UNKNOWN';
}

function addRecordToCurrencyTotals(
  totalsByCurrency: Map<string, MutableCurrencyTotals>,
  recordItem: WalletRecordItem
): void {
  const currency = normalizeCurrencyCode(recordItem.currency);
  let currencyTotals = totalsByCurrency.get(currency);

  if (!currencyTotals) {
    currencyTotals = {
      currency,
      income: 0,
      expense: 0,
      transactionCount: 0,
    };
    totalsByCurrency.set(currency, currencyTotals);
  }

  const absoluteAmount = Math.abs(recordItem.amount);
  if (recordItem.recordType === 'expense') {
    currencyTotals.expense += absoluteAmount;
  } else {
    currencyTotals.income += absoluteAmount;
  }
  currencyTotals.transactionCount += 1;
}

function finalizeCurrencyTotals(
  totalsByCurrency: Map<string, MutableCurrencyTotals>
): TransactionCurrencyTotals[] {
  return [...totalsByCurrency.values()]
    .map(currencyTotals => ({
      currency: currencyTotals.currency,
      income: currencyTotals.income,
      expense: currencyTotals.expense,
      net: currencyTotals.income - currencyTotals.expense,
      transactionCount: currencyTotals.transactionCount,
    }))
    .sort((left, right) => left.currency.localeCompare(right.currency));
}

function resolveBreakdownIdentity(
  recordItem: WalletRecordItem,
  groupBy: Exclude<TransactionSummaryGroupBy, 'none'>
): { key: string; name?: string } {
  if (groupBy === 'category') {
    const categoryId = recordItem.category?.id?.trim();
    return {
      key: categoryId || '__uncategorized__',
      name: recordItem.category?.name?.trim() || undefined,
    };
  }

  const accountId = recordItem.accountId?.trim();
  return {
    key: accountId || '__unknown_account__',
    name: recordItem.accountName?.trim() || undefined,
  };
}

function buildBreakdown(
  recordList: WalletRecordItem[],
  groupBy: TransactionSummaryGroupBy,
  isMultiCurrency: boolean
): TransactionSummaryBreakdownItem[] {
  if (groupBy === 'none') {
    return [];
  }

  const groupedItemMap = new Map<string, MutableBreakdownItem>();

  for (const recordItem of recordList) {
    const identity = resolveBreakdownIdentity(recordItem, groupBy);
    let groupedItem = groupedItemMap.get(identity.key);

    if (!groupedItem) {
      groupedItem = {
        key: identity.key,
        name: identity.name,
        transactionCount: 0,
        totalsByCurrency: new Map<string, MutableCurrencyTotals>(),
      };
      groupedItemMap.set(identity.key, groupedItem);
    } else if (!groupedItem.name && identity.name) {
      groupedItem.name = identity.name;
    }

    groupedItem.transactionCount += 1;
    addRecordToCurrencyTotals(groupedItem.totalsByCurrency, recordItem);
  }

  const finalizedBreakdown = [...groupedItemMap.values()].map(groupedItem => ({
    key: groupedItem.key,
    name: groupedItem.name,
    transactionCount: groupedItem.transactionCount,
    totals: finalizeCurrencyTotals(groupedItem.totalsByCurrency),
  }));

  if (isMultiCurrency) {
    return finalizedBreakdown.sort((left, right) =>
      (left.name || left.key).localeCompare(right.name || right.key)
    );
  }

  return finalizedBreakdown.sort((left, right) => {
    const leftTotals = left.totals[0];
    const rightTotals = right.totals[0];
    const expenseDifference = (rightTotals?.expense || 0) - (leftTotals?.expense || 0);
    if (expenseDifference !== 0) {
      return expenseDifference;
    }

    const incomeDifference = (rightTotals?.income || 0) - (leftTotals?.income || 0);
    if (incomeDifference !== 0) {
      return incomeDifference;
    }

    return (left.name || left.key).localeCompare(right.name || right.key);
  });
}

export class TransactionSummaryService {
  constructor(private readonly transactionHistoryService: TransactionHistoryService) {}

  /**
   * Aggregates matching transaction history records while preserving the exact
   * history filter semantics. Currency buckets are always kept separate and
   * transfers are excluded from income/expense totals.
   */
  public async getTransactionSummary(
    queryOptions: TransactionSummaryQueryOptions = {},
    referenceDate: Date = new Date()
  ): Promise<TransactionSummaryResult> {
    const { groupBy = 'none', ...historyFilters } = queryOptions;
    const collectedRecords: WalletRecordItem[] = [];
    const seenRecordIds = new Set<string>();
    let excludedTransferCount = 0;
    let appliedFilters: TransactionSummaryResult['appliedFilters'];
    let currentOffset = 0;
    let isComplete = false;

    for (let pageIndex = 0; pageIndex < MAX_SUMMARY_PAGES; pageIndex += 1) {
      const historyPage = await this.transactionHistoryService.getTransactionHistory(
        {
          ...historyFilters,
          limit: SUMMARY_PAGE_SIZE,
          offset: currentOffset,
          sort: 'newest',
        },
        referenceDate
      );

      appliedFilters = historyPage.appliedFilters || appliedFilters;

      if (historyPage.unresolvedFilters && historyPage.unresolvedFilters.length > 0) {
        return {
          transactionCount: 0,
          excludedTransferCount: 0,
          totals: [],
          breakdown: [],
          groupBy,
          isMultiCurrency: false,
          isComplete: false,
          appliedFilters,
          unresolvedFilters: historyPage.unresolvedFilters,
        };
      }

      if (historyPage.records.length === 0) {
        isComplete = true;
        break;
      }

      let addedRecordCount = 0;
      for (const recordItem of historyPage.records) {
        if (recordItem.id && seenRecordIds.has(recordItem.id)) {
          continue;
        }
        if (recordItem.id) {
          seenRecordIds.add(recordItem.id);
        }

        addedRecordCount += 1;
        if (recordItem.transfer) {
          excludedTransferCount += 1;
          continue;
        }
        collectedRecords.push(recordItem);
      }

      if (addedRecordCount === 0) {
        applicationLogger.fileDetail('warn', 'Transaction summary pagination stopped without forward progress', {
          offset: currentOffset,
          page: historyPage.page,
        });
        break;
      }

      if (historyPage.hasMore) {
        const candidateNextOffset = historyPage.nextOffset ?? (currentOffset + historyPage.records.length);
        if (candidateNextOffset <= currentOffset) {
          applicationLogger.fileDetail('warn', 'Transaction summary pagination returned a non-advancing offset', {
            offset: currentOffset,
            nextOffset: candidateNextOffset,
          });
          break;
        }
        currentOffset = candidateNextOffset;
        continue;
      }

      // Some Wallet MCP responses omit total/nextOffset metadata. Probe one more
      // offset when a full page is returned so summaries do not silently stop at 50.
      if (historyPage.records.length >= historyPage.limit || historyPage.continuationUnknown) {
        currentOffset += historyPage.records.length;
        continue;
      }

      isComplete = true;
      break;
    }

    if (!isComplete) {
      applicationLogger.fileDetail('warn', 'Transaction summary result is partial', {
        fetchedRecordCount: collectedRecords.length,
        maxPages: MAX_SUMMARY_PAGES,
      });
    }

    const totalsByCurrency = new Map<string, MutableCurrencyTotals>();
    for (const recordItem of collectedRecords) {
      addRecordToCurrencyTotals(totalsByCurrency, recordItem);
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
      isComplete,
      appliedFilters,
    };
  }
}
