import { WalletMcpClientService } from './walletMcpService.js';
import { WalletCacheService } from './walletCacheService.js';
import { TransactionHistoryService } from './transactionHistoryService.js';
import {
  TransactionCurrencyTotals,
  TransactionSummaryBreakdownItem,
  TransactionSummaryGroupBy,
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResultItem,
} from '../types/walletTypes.js';
import { normalizeTransactionHistoryFilters } from '../utils/transactionHistoryFilterNormalizer.js';
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

  return finalizeAndSortBreakdown(groupedItemMap, isMultiCurrency);
}

function finalizeAndSortBreakdown(
  groupedItemMap: Map<string, MutableBreakdownItem>,
  isMultiCurrency: boolean
): TransactionSummaryBreakdownItem[] {
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
  private readonly walletMcpClient?: WalletMcpClientService;
  private readonly walletCacheService?: WalletCacheService;
  private readonly transactionHistoryService?: TransactionHistoryService;

  constructor(
    walletMcpClientOrHistoryService?: WalletMcpClientService | TransactionHistoryService,
    walletCacheService?: WalletCacheService,
    transactionHistoryService?: TransactionHistoryService
  ) {
    if (
      walletMcpClientOrHistoryService &&
      ('fetchRecordsAggregation' in walletMcpClientOrHistoryService ||
        'callMcpTool' in walletMcpClientOrHistoryService)
    ) {
      this.walletMcpClient = walletMcpClientOrHistoryService as WalletMcpClientService;
      this.walletCacheService = walletCacheService;
      this.transactionHistoryService = transactionHistoryService;
    } else if (walletMcpClientOrHistoryService) {
      const historyService = walletMcpClientOrHistoryService as TransactionHistoryService;
      this.transactionHistoryService = historyService;
      this.walletCacheService = walletCacheService ?? historyService.getWalletCacheService?.();
      this.walletMcpClient = historyService.getWalletMcpClient?.();
    }
  }

  /**
   * Aggregates matching transactions while preserving the exact history filter semantics.
   * Prefers native Wallet MCP get_records_aggregation when available. Currency buckets
   * are kept separate and transfers are excluded from income/expense totals.
   */
  public async getTransactionSummary(
    queryOptions: TransactionSummaryQueryOptions = {},
    referenceDate: Date = new Date()
  ): Promise<TransactionSummaryResult> {
    const hasProvenSearchGap = Boolean(queryOptions.searchQuery);
    if (this.walletMcpClient && !hasProvenSearchGap) {
      return await this.getNativeTransactionSummary(queryOptions, referenceDate);
    }

    if (this.transactionHistoryService) {
      return await this.getCompatibilityFallbackSummary(queryOptions, referenceDate);
    }

    throw new Error('[error] TransactionSummaryService requires WalletMcpClientService or TransactionHistoryService');
  }

  /**
   * Native Wallet MCP get_records_aggregation workflow. Uses authoritative upstream
   * arithmetic and grouping without scanning all matching records page-by-page.
   */
  private async getNativeTransactionSummary(
    queryOptions: TransactionSummaryQueryOptions,
    referenceDate: Date
  ): Promise<TransactionSummaryResult> {
    const { groupBy = 'none', ...historyFilters } = queryOptions;

    const cachedAccountList = this.walletCacheService?.getAccounts() || [];
    const cachedCategoryList = this.walletCacheService?.getCategories() || [];

    const normalizationResult = normalizeTransactionHistoryFilters(
      historyFilters,
      cachedAccountList,
      cachedCategoryList,
      referenceDate
    );

    if (!normalizationResult.isValid) {
      applicationLogger.fileDetail('warn', 'Transaction summary filter resolution issues', {
        unresolvedFilters: normalizationResult.unresolvedFilters,
      });

      return {
        transactionCount: 0,
        excludedTransferCount: 0,
        totals: [],
        breakdown: [],
        groupBy,
        isMultiCurrency: false,
        isComplete: false,
        appliedFilters: normalizationResult.appliedFilters,
        unresolvedFilters: normalizationResult.unresolvedFilters,
      };
    }

    const mcpGroupByFields: string[] = ['currency', 'recordType'];
    if (groupBy === 'category') {
      mcpGroupByFields.push('category:id', 'category:name');
    } else if (groupBy === 'account') {
      mcpGroupByFields.push('accountId');
    }

    const aggregationPayload: WalletRecordAggregationQueryPayload = {
      groupBy: mcpGroupByFields,
      compute: ['amount:sum'],
      isTransfer: false,
      limit: 1000,
    };

    if (normalizationResult.upstreamAccountId) {
      aggregationPayload.accountId = normalizationResult.upstreamAccountId;
    }
    if (normalizationResult.upstreamCategoryId && normalizationResult.upstreamCategoryId.length > 0) {
      aggregationPayload.categoryId = normalizationResult.upstreamCategoryId;
    }
    if (normalizationResult.upstreamCategoryGroup) {
      aggregationPayload.categoryGroup = normalizationResult.upstreamCategoryGroup;
    }
    if (normalizationResult.upstreamRecordType) {
      aggregationPayload.recordType = normalizationResult.upstreamRecordType;
    }
    if (normalizationResult.upstreamRecordDate && normalizationResult.upstreamRecordDate.length > 0) {
      aggregationPayload.recordDate = normalizationResult.upstreamRecordDate;
    }

    const transferCountPayload: WalletRecordAggregationQueryPayload = {
      isTransfer: true,
    };
    if (normalizationResult.upstreamAccountId) {
      transferCountPayload.accountId = normalizationResult.upstreamAccountId;
    }
    if (normalizationResult.upstreamCategoryId && normalizationResult.upstreamCategoryId.length > 0) {
      transferCountPayload.categoryId = normalizationResult.upstreamCategoryId;
    }
    if (normalizationResult.upstreamCategoryGroup) {
      transferCountPayload.categoryGroup = normalizationResult.upstreamCategoryGroup;
    }
    if (normalizationResult.upstreamRecordType) {
      transferCountPayload.recordType = normalizationResult.upstreamRecordType;
    }
    if (normalizationResult.upstreamRecordDate && normalizationResult.upstreamRecordDate.length > 0) {
      transferCountPayload.recordDate = normalizationResult.upstreamRecordDate;
    }

    const [aggregationResponse, transferResponse] = await Promise.all([
      this.walletMcpClient!.fetchRecordsAggregation(aggregationPayload),
      this.walletMcpClient!.fetchRecordsAggregation(transferCountPayload).catch(transferError => {
        applicationLogger.fileDetail('warn', 'Failed to fetch excluded transfer count', {
          error: transferError instanceof Error ? transferError.message : String(transferError),
        });
        return undefined;
      }),
    ]);

    const isTransferCountAvailable =
      transferResponse !== undefined &&
      Array.isArray(transferResponse.results) &&
      transferResponse.results.length > 0 &&
      typeof transferResponse.results[0]?.count === 'number';

    const excludedTransferCount = isTransferCountAvailable
      ? transferResponse.results[0].count
      : 0;

    const transferCountUnknown = !isTransferCountAvailable;
    const isComplete = isTransferCountAvailable;
    const rawResults = aggregationResponse.results || [];

    if (rawResults.length === 0 || (rawResults.length === 1 && rawResults[0].count === 0)) {
      return {
        transactionCount: 0,
        excludedTransferCount,
        transferCountUnknown: transferCountUnknown || undefined,
        totals: [],
        breakdown: [],
        groupBy,
        isMultiCurrency: false,
        isComplete,
        appliedFilters: normalizationResult.appliedFilters,
      };
    }

    const totalsByCurrency = new Map<string, MutableCurrencyTotals>();
    for (const row of rawResults) {
      if (!row.count || row.count <= 0) {
        continue;
      }
      const currency = normalizeCurrencyCode(row.currency);
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

      const rawAmount = typeof row['amount:sum'] === 'number' ? row['amount:sum'] : 0;
      currencyTotals.transactionCount += row.count;

      if (row.recordType === 'expense') {
        currencyTotals.expense += Math.abs(rawAmount);
      } else {
        currencyTotals.income += Math.abs(rawAmount);
      }
    }

    const totals = finalizeCurrencyTotals(totalsByCurrency);
    let totalTransactionCount = 0;
    for (const currencyTotal of totals) {
      totalTransactionCount += currencyTotal.transactionCount;
    }

    const isMultiCurrency = totals.length > 1;
    const breakdown = this.buildNativeBreakdown(
      rawResults,
      groupBy,
      isMultiCurrency,
      cachedAccountList,
      cachedCategoryList
    );

    return {
      transactionCount: totalTransactionCount,
      excludedTransferCount,
      transferCountUnknown: transferCountUnknown || undefined,
      totals,
      breakdown,
      groupBy,
      isMultiCurrency,
      isComplete,
      appliedFilters: normalizationResult.appliedFilters,
    };
  }

  private buildNativeBreakdown(
    rawResults: WalletRecordAggregationResultItem[],
    groupBy: TransactionSummaryGroupBy,
    isMultiCurrency: boolean,
    cachedAccounts: WalletAccountItem[],
    cachedCategories: WalletCategoryItem[]
  ): TransactionSummaryBreakdownItem[] {
    if (groupBy === 'none') {
      return [];
    }

    const accountNameMap = new Map<string, string>();
    for (const account of cachedAccounts) {
      if (account.id) {
        accountNameMap.set(account.id, account.name);
      }
    }

    const categoryNameMap = new Map<string, string>();
    for (const category of cachedCategories) {
      if (category.id) {
        categoryNameMap.set(category.id, category.name);
      }
    }

    const groupedItemMap = new Map<string, MutableBreakdownItem>();

    for (const row of rawResults) {
      if (!row.count || row.count <= 0) {
        continue;
      }

      let key: string;
      let name: string | undefined;

      if (groupBy === 'category') {
        const rawCategoryId = (row['category:id'] as string | undefined)?.trim();
        key = rawCategoryId || '__uncategorized__';
        name = (row['category:name'] as string | undefined)?.trim() ||
          (rawCategoryId ? categoryNameMap.get(rawCategoryId) : undefined);
      } else {
        const rawAccountId = (row.accountId as string | undefined)?.trim();
        key = rawAccountId || '__unknown_account__';
        name = rawAccountId ? accountNameMap.get(rawAccountId) : undefined;
      }

      let groupedItem = groupedItemMap.get(key);
      if (!groupedItem) {
        groupedItem = {
          key,
          name,
          transactionCount: 0,
          totalsByCurrency: new Map<string, MutableCurrencyTotals>(),
        };
        groupedItemMap.set(key, groupedItem);
      } else if (!groupedItem.name && name) {
        groupedItem.name = name;
      }

      const currency = normalizeCurrencyCode(row.currency);
      let currencyTotals = groupedItem.totalsByCurrency.get(currency);
      if (!currencyTotals) {
        currencyTotals = {
          currency,
          income: 0,
          expense: 0,
          transactionCount: 0,
        };
        groupedItem.totalsByCurrency.set(currency, currencyTotals);
      }

      const rawAmount = typeof row['amount:sum'] === 'number' ? row['amount:sum'] : 0;
      groupedItem.transactionCount += row.count;
      currencyTotals.transactionCount += row.count;

      if (row.recordType === 'expense') {
        currencyTotals.expense += Math.abs(rawAmount);
      } else {
        currencyTotals.income += Math.abs(rawAmount);
      }
    }

    return finalizeAndSortBreakdown(groupedItemMap, isMultiCurrency);
  }

  /**
   * Compatibility fallback for environments without WalletMcpClientService access
   * (e.g. legacy unit tests) or queries with search keywords where upstream native
   * aggregation does not support free-text search.
   */
  private async getCompatibilityFallbackSummary(
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
      const historyPage = await this.transactionHistoryService!.getTransactionHistory(
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

