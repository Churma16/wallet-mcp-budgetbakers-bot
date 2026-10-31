import type {
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
  WalletRecordItem,
  WalletAccountItem,
  WalletCategoryItem,
  WalletMcpCapabilityQuery,
  SummaryCache,
  SummaryHistoryProvider,
} from './types.js';
import {
  isWalletMcpCapabilityRejection,
} from './errors.js';
import {
  buildNativeBreakdown,
  normalizeCurrencyCode,
  finalizeCurrencyTotals,
  type MutableCurrencyTotals,
} from './summaryHelpers.js';
import { getCompatibilityFallbackSummary } from './summaryFallback.js';
import {
  fetchRecordsAggregation,
  type AggregationInvoker,
} from './aggregation.js';
import { normalizeTransactionHistoryFilters } from './transactionHistoryFilterNormalizer.js';
import { applicationLogger } from '../lib/logger.js';
import { WALLET_MCP_TOOL_NAMES } from './constants.js';

export interface SummaryClient extends AggregationInvoker {
  fetchRecordsAggregation?(payload: WalletRecordAggregationQueryPayload): Promise<WalletRecordAggregationResponse>;
}

export async function getTransactionSummary(
  client?: SummaryClient,
  cache?: SummaryCache,
  capability?: WalletMcpCapabilityQuery,
  historyProvider?: SummaryHistoryProvider,
  queryOptions: TransactionSummaryQueryOptions = {},
  referenceDate: Date = new Date()
): Promise<TransactionSummaryResult> {
  const hasSearchGap = Boolean(queryOptions.searchQuery);
  const isAggregationSupported = capability
    ? capability.supportsTool(WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION) !== false
    : true;

  if (client && !hasSearchGap && isAggregationSupported) {
    try {
      return await getNativeTransactionSummary(client, cache, queryOptions, referenceDate);
    } catch (aggregationError) {
      if (capability && isWalletMcpCapabilityRejection(aggregationError)) {
        capability.markToolRejection(
          WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION,
          aggregationError instanceof Error ? aggregationError.message : String(aggregationError)
        );
      }
      if (historyProvider) {
        applicationLogger.fileDetail('warn', 'Native aggregation failed definitively, falling back to history summary', {
          error: aggregationError instanceof Error ? aggregationError.message : String(aggregationError),
        });
        return await getCompatibilityFallbackSummary(historyProvider, cache, queryOptions, referenceDate);
      }
      throw aggregationError;
    }
  }

  if (historyProvider) {
    return await getCompatibilityFallbackSummary(historyProvider, cache, queryOptions, referenceDate);
  }

  throw new Error('[error] getTransactionSummary requires SummaryClient or SummaryHistoryProvider');
}

async function getNativeTransactionSummary(
  client: SummaryClient,
  cache?: SummaryCache,
  queryOptions: TransactionSummaryQueryOptions = {},
  referenceDate: Date = new Date()
): Promise<TransactionSummaryResult> {
  const { groupBy = 'none', ...historyFilters } = queryOptions;
  const cachedAccounts = cache?.getAccounts() || [];
  const cachedCategories = cache?.getCategories() || [];

  const normalizationResult = normalizeTransactionHistoryFilters(
    historyFilters,
    cachedAccounts,
    cachedCategories,
    referenceDate
  );

  if (!normalizationResult.isValid) {
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

  const mcpGroupBy: string[] = ['currency', 'recordType'];
  if (groupBy === 'category') mcpGroupBy.push('category:id', 'category:name');
  else if (groupBy === 'account') mcpGroupBy.push('accountId');

  const aggregationPayload: WalletRecordAggregationQueryPayload = {
    groupBy: mcpGroupBy,
    compute: ['amount:sum'],
    isTransfer: false,
    limit: 1000,
    accountId: normalizationResult.upstreamAccountId,
    categoryId: normalizationResult.upstreamCategoryId,
    categoryGroup: normalizationResult.upstreamCategoryGroup,
    recordType: normalizationResult.upstreamRecordType,
    recordDate: normalizationResult.upstreamRecordDate,
  };

  const transferCountPayload: WalletRecordAggregationQueryPayload = {
    isTransfer: true,
    accountId: normalizationResult.upstreamAccountId,
    categoryId: normalizationResult.upstreamCategoryId,
    categoryGroup: normalizationResult.upstreamCategoryGroup,
    recordType: normalizationResult.upstreamRecordType,
    recordDate: normalizationResult.upstreamRecordDate,
  };

  const doFetch = (p: WalletRecordAggregationQueryPayload) =>
    client.fetchRecordsAggregation ? client.fetchRecordsAggregation(p) : fetchRecordsAggregation(client, p);

  const [aggregationResponse, transferResponse] = await Promise.all([
    doFetch(aggregationPayload),
    doFetch(transferCountPayload).catch(() => undefined),
  ]);

  const isTransferAvailable =
    transferResponse !== undefined &&
    Array.isArray(transferResponse.results) &&
    transferResponse.results.length > 0 &&
    typeof transferResponse.results[0]?.count === 'number';

  const excludedTransferCount = isTransferAvailable ? transferResponse.results[0].count : 0;
  const rawResults = aggregationResponse.results || [];

  if (rawResults.length === 0 || (rawResults.length === 1 && rawResults[0].count === 0)) {
    return {
      transactionCount: 0,
      excludedTransferCount,
      transferCountUnknown: !isTransferAvailable || undefined,
      totals: [],
      breakdown: [],
      groupBy,
      isMultiCurrency: false,
      isComplete: isTransferAvailable,
      appliedFilters: normalizationResult.appliedFilters,
    };
  }

  const totalsByCurrency = new Map<string, MutableCurrencyTotals>();
  for (const row of rawResults) {
    if (!row.count || row.count <= 0) continue;
    const currency = normalizeCurrencyCode(row.currency);
    let curr = totalsByCurrency.get(currency);
    if (!curr) {
      curr = { currency, income: 0, expense: 0, transactionCount: 0 };
      totalsByCurrency.set(currency, curr);
    }
    const rawAmt = typeof row['amount:sum'] === 'number' ? row['amount:sum'] : 0;
    curr.transactionCount += row.count;
    if (row.recordType === 'expense') curr.expense += Math.abs(rawAmt);
    else curr.income += Math.abs(rawAmt);
  }

  const totals = finalizeCurrencyTotals(totalsByCurrency);
  let totalTransactionCount = 0;
  for (const t of totals) totalTransactionCount += t.transactionCount;

  const isMultiCurrency = totals.length > 1;
  const breakdown = buildNativeBreakdown(rawResults, groupBy, isMultiCurrency, cachedAccounts, cachedCategories);

  return {
    transactionCount: totalTransactionCount,
    excludedTransferCount,
    transferCountUnknown: !isTransferAvailable || undefined,
    totals,
    breakdown,
    groupBy,
    isMultiCurrency,
    isComplete: isTransferAvailable,
    appliedFilters: normalizationResult.appliedFilters,
  };
}

/**
 * Service calculating financial transaction summaries and breakdowns,
 * leveraging native Wallet MCP aggregation when supported with seamless history fallback.
 */
export class TransactionSummaryService {
  private readonly walletMcpClient?: SummaryClient;
  private readonly walletCacheService?: SummaryCache;
  private readonly transactionHistoryService?: SummaryHistoryProvider;
  private readonly capabilityService?: WalletMcpCapabilityQuery;

  constructor(
    walletMcpClientOrHistoryService?: SummaryClient | SummaryHistoryProvider,
    walletCacheService?: SummaryCache,
    transactionHistoryService?: SummaryHistoryProvider,
    capabilityService?: WalletMcpCapabilityQuery
  ) {
    this.capabilityService = capabilityService;
    if (
      walletMcpClientOrHistoryService &&
      ('fetchRecordsAggregation' in walletMcpClientOrHistoryService ||
        'callMcpTool' in walletMcpClientOrHistoryService)
    ) {
      this.walletMcpClient = walletMcpClientOrHistoryService as SummaryClient;
      this.walletCacheService = walletCacheService;
      this.transactionHistoryService = transactionHistoryService;
    } else if (walletMcpClientOrHistoryService) {
      const historyService = walletMcpClientOrHistoryService as any;
      this.transactionHistoryService = historyService;
      this.walletCacheService = walletCacheService ?? historyService.getWalletCacheService?.();
      this.walletMcpClient = historyService.getWalletMcpClient?.();
    }
  }

  public async getTransactionSummary(
    queryOptions: TransactionSummaryQueryOptions = {},
    referenceDate: Date = new Date()
  ): Promise<TransactionSummaryResult> {
    if (!this.walletMcpClient && !this.transactionHistoryService) {
      throw new Error(
        'TransactionSummaryService requires WalletMcpClientService or TransactionHistoryService'
      );
    }
    return getTransactionSummary(
      this.walletMcpClient,
      this.walletCacheService,
      this.capabilityService,
      this.transactionHistoryService,
      queryOptions,
      referenceDate
    );
  }
}
