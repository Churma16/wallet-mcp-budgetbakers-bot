import {
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
  MAX_TRANSACTION_HISTORY_LIMIT,
  WALLET_MCP_TOOL_NAMES,
} from './constants.js';
import type {
  TransactionHistoryQueryOptions,
  TransactionHistoryPage,
  TransactionSortOrder,
  WalletRecordItem,
  WalletAccountItem,
  WalletCategoryItem,
} from './types.js';
import {
  TransactionSearchScanStore,
  executeSearchScanCompatibilityShim,
} from './searchScan.js';
import { normalizeRawRecords } from './recordNormalizer.js';
import { normalizeTransactionHistoryFilters } from '../utils/transactionHistoryFilterNormalizer.js';

export interface HistoryClient {
  callMcpTool<T>(toolName: string, args?: Record<string, unknown>): Promise<T>;
}

export interface HistoryCache {
  getAccounts(): WalletAccountItem[];
  getCategories(): WalletCategoryItem[];
}

export async function fetchRecords(
  client: HistoryClient,
  queryOptions?: TransactionHistoryQueryOptions,
  scanStore: TransactionSearchScanStore = new TransactionSearchScanStore()
): Promise<TransactionHistoryPage> {
  const rawLimit = queryOptions?.limit;
  const resolvedLimit = (typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 1)
    ? Math.min(MAX_TRANSACTION_HISTORY_LIMIT, Math.floor(rawLimit))
    : DEFAULT_TRANSACTION_HISTORY_LIMIT;

  let resolvedOffset = 0;
  if (typeof queryOptions?.offset === 'number' && Number.isFinite(queryOptions.offset)) {
    resolvedOffset = Math.max(0, Math.floor(queryOptions.offset));
  } else if (typeof queryOptions?.page === 'number' && Number.isFinite(queryOptions.page) && queryOptions.page > 1) {
    resolvedOffset = Math.max(0, (Math.floor(queryOptions.page) - 1) * resolvedLimit);
  }

  const resolvedSort: TransactionSortOrder = queryOptions?.sort === 'oldest' ? 'oldest' : 'newest';
  const upstreamSortBy = resolvedSort === 'oldest'
    ? ['+recordDate', '+createdAt']
    : ['-recordDate', '-createdAt'];

  const mcpCallPayload: Record<string, unknown> = {
    limit: resolvedLimit,
    offset: resolvedOffset,
    sortBy: upstreamSortBy,
  };

  if (queryOptions?.accountId) {
    mcpCallPayload.accountId = Array.isArray(queryOptions.accountId)
      ? queryOptions.accountId.join(',')
      : queryOptions.accountId;
  }
  if (queryOptions?.categoryId) {
    mcpCallPayload.categoryId = Array.isArray(queryOptions.categoryId)
      ? queryOptions.categoryId
      : [queryOptions.categoryId];
  }
  if (queryOptions?.categoryGroup && (!Array.isArray(queryOptions?.categoryId) || queryOptions.categoryId.length <= 1)) {
    mcpCallPayload.categoryGroup = queryOptions.categoryGroup;
  }
  if (queryOptions?.recordType) {
    mcpCallPayload.recordType = queryOptions.recordType;
  }
  if (Array.isArray(queryOptions?.dateRange)) {
    mcpCallPayload.recordDate = queryOptions.dateRange;
  }
  if (queryOptions?.counterParty) {
    const rawCounterParty = String(queryOptions.counterParty).trim();
    mcpCallPayload.counterParty =
      rawCounterParty.startsWith('contains-i.') || rawCounterParty.startsWith('eq.') || rawCounterParty.startsWith('contains.')
        ? rawCounterParty
        : `contains-i.${rawCounterParty}`;
  }
  if (queryOptions?.note) {
    const rawNote = String(queryOptions.note).trim();
    mcpCallPayload.note =
      rawNote.startsWith('contains-i.') || rawNote.startsWith('eq.') || rawNote.startsWith('contains.')
        ? rawNote
        : `contains-i.${rawNote}`;
  }
  if (queryOptions?.searchQuery && queryOptions?.searchScanFallback === false) {
    mcpCallPayload.query = queryOptions.searchQuery;
  }

  const callGetRecords = (payload: Record<string, unknown>) =>
    client.callMcpTool<any>(WALLET_MCP_TOOL_NAMES.GET_RECORDS, payload);

  if (queryOptions?.searchQuery && queryOptions?.searchScanFallback !== false) {
    return executeSearchScanCompatibilityShim(
      queryOptions as TransactionHistoryQueryOptions & { searchQuery: string },
      mcpCallPayload,
      resolvedLimit,
      resolvedOffset,
      resolvedSort,
      upstreamSortBy,
      normalizeRawRecords,
      callGetRecords,
      scanStore
    );
  }

  const rawResponse = await callGetRecords(mcpCallPayload);
  const rawRecordArray: any[] = Array.isArray(rawResponse)
    ? rawResponse
    : (rawResponse?.records || rawResponse?.items || []);

  const pageRecords = normalizeRawRecords(rawRecordArray);
  const totalCount = typeof rawResponse?.total === 'number' && Number.isFinite(rawResponse.total)
    ? rawResponse.total
    : undefined;
  const hasMore = typeof rawResponse?.hasMore === 'boolean'
    ? rawResponse.hasMore
    : (typeof totalCount === 'number' ? resolvedOffset + pageRecords.length < totalCount : pageRecords.length === resolvedLimit);

  const nextOffset = typeof rawResponse?.nextOffset === 'number'
    ? rawResponse.nextOffset
    : (hasMore ? resolvedOffset + pageRecords.length : null);

  const totalPages = typeof totalCount === 'number'
    ? Math.max(1, Math.ceil(totalCount / resolvedLimit))
    : undefined;

  return {
    records: pageRecords,
    total: totalCount,
    limit: resolvedLimit,
    offset: resolvedOffset,
    page: Math.floor(resolvedOffset / resolvedLimit) + 1,
    totalPages,
    nextOffset,
    hasMore,
    sort: resolvedSort,
  };
}

export async function getTransactionHistory(
  client: HistoryClient,
  cache?: HistoryCache,
  queryOptions?: TransactionHistoryQueryOptions,
  referenceDate: Date = new Date(),
  scanStore?: TransactionSearchScanStore
): Promise<TransactionHistoryPage> {
  const cachedAccounts = cache?.getAccounts() || [];
  const cachedCategories = cache?.getCategories() || [];

  const normalizationResult = normalizeTransactionHistoryFilters(
    queryOptions,
    cachedAccounts,
    cachedCategories,
    referenceDate
  );

  if (!normalizationResult.isValid) {
    const fallbackLimit = (typeof queryOptions?.limit === 'number' && queryOptions.limit > 0)
      ? queryOptions.limit
      : 10;
    const fallbackSort = queryOptions?.sort === 'oldest' ? 'oldest' : 'newest';

    return {
      records: [],
      total: 0,
      limit: fallbackLimit,
      offset: 0,
      page: 1,
      totalPages: 0,
      nextOffset: null,
      hasMore: false,
      sort: fallbackSort,
      appliedFilters: normalizationResult.appliedFilters,
      unresolvedFilters: normalizationResult.unresolvedFilters,
    };
  }

  let historyPageResult: TransactionHistoryPage;
  try {
    historyPageResult = await fetchRecords(client, normalizationResult.normalizedOptions, scanStore);
  } catch (upstreamError: unknown) {
    const isSearchActive = Boolean(normalizationResult.normalizedOptions.searchQuery);
    const isUnsupportedSearch = isSearchActive && (() => {
      if (!upstreamError) return false;
      const errorObject = upstreamError as Record<string, unknown>;
      if (
        errorObject.parameter === 'query' ||
        (errorObject.data && typeof errorObject.data === 'object' && (errorObject.data as Record<string, unknown>).parameter === 'query') ||
        errorObject.field === 'query'
      ) {
        return true;
      }
      const errorMessage = upstreamError instanceof Error
        ? upstreamError.message.toLowerCase()
        : String(upstreamError).toLowerCase();
      const mentionsQuery = errorMessage.includes('query') || errorMessage.includes('search') || errorMessage.includes('text search');
      return mentionsQuery && (
        errorMessage.includes('unknown parameter') ||
        errorMessage.includes('unrecognized argument') ||
        errorMessage.includes('unsupported parameter') ||
        errorMessage.includes('not supported') ||
        errorMessage.includes('unsupported') ||
        errorMessage.includes('not available')
      );
    })();

    if (isUnsupportedSearch) {
      const fallbackLimit = (typeof queryOptions?.limit === 'number' && queryOptions.limit > 0)
        ? queryOptions.limit
        : 10;
      return {
        records: [],
        total: 0,
        limit: fallbackLimit,
        offset: 0,
        page: 1,
        totalPages: 0,
        nextOffset: null,
        hasMore: false,
        sort: queryOptions?.sort === 'oldest' ? 'oldest' : 'newest',
        appliedFilters: normalizationResult.appliedFilters,
        unresolvedFilters: [
          {
            filterKey: 'searchQuery',
            rawValue: normalizationResult.normalizedOptions.searchQuery || '',
            reason: 'UNSUPPORTED',
            subType: 'unsupported_upstream_search',
            message: 'Pencarian teks tidak didukung oleh sumber data upstream.',
          },
        ],
      };
    }
    throw upstreamError;
  }

  const enrichedRecordList: WalletRecordItem[] = historyPageResult.records.map(recordItem => {
    let enrichedAccountName = recordItem.accountName;
    if (!enrichedAccountName && recordItem.accountId && cachedAccounts.length > 0) {
      const matched = cachedAccounts.find(account => account.id === recordItem.accountId);
      if (matched) enrichedAccountName = matched.name;
    }

    let enrichedCategory = recordItem.category;
    const categoryId = recordItem.category?.id;
    if ((!enrichedCategory?.name || enrichedCategory.name === 'Unknown') && categoryId && cachedCategories.length > 0) {
      const matchedCat = cachedCategories.find(cat => cat.id === categoryId);
      if (matchedCat) {
        enrichedCategory = {
          id: matchedCat.id,
          name: matchedCat.name,
          color: enrichedCategory?.color,
          group: enrichedCategory?.group,
        };
      } else if (!enrichedCategory?.name) {
        enrichedCategory = { id: categoryId, name: 'Unknown' };
      }
    }

    return {
      ...recordItem,
      accountName: enrichedAccountName,
      category: enrichedCategory,
    };
  });

  return {
    ...historyPageResult,
    records: enrichedRecordList,
    appliedFilters: normalizationResult.appliedFilters,
  };
}

/**
 * Service orchestrating transaction history queries, paginated retrievals,
 * deterministic sorting, and entity name enrichment across accounts and categories.
 */
export class TransactionHistoryService {
  private readonly scanStore = new TransactionSearchScanStore();

  constructor(
    private readonly walletMcpClient: HistoryClient,
    private readonly walletCacheService?: HistoryCache
  ) {}

  public getWalletMcpClient(): HistoryClient {
    return this.walletMcpClient;
  }

  public getWalletCacheService(): HistoryCache | undefined {
    return this.walletCacheService;
  }

  public getTransactionHistory(
    queryOptions?: TransactionHistoryQueryOptions,
    referenceDate: Date = new Date()
  ): Promise<TransactionHistoryPage> {
    return getTransactionHistory(
      this.walletMcpClient,
      this.walletCacheService,
      queryOptions,
      referenceDate,
      this.scanStore
    );
  }
}

export * from './recordNormalizer.js';
