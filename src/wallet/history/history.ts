import {
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../constants.js';
import type {
  TransactionHistoryQueryOptions,
  TransactionHistoryPage,
  TransactionSortOrder,
  WalletRecordItem,
  WalletAccountItem,
  WalletCategoryItem,
} from '../types.js';
import {
  type WalletToolCaller,
  type GetRecordsToolArgs,
  type RawRecordsResponse,
  type RawRecordsEnvelope,
  type RawRecordItem,
  extractRawArray,
  callGetRecords,
} from '../mcp/toolWrappers.js';
import {
  TransactionSearchScanStore,
  executeSearchScanCompatibilityShim,
} from './searchScan.js';
import {
  normalizeRawRecords,
  enrichHistoryRecords,
} from '../records/recordNormalizer.js';
import { normalizeTransactionHistoryFilters } from './transactionHistoryFilterNormalizer.js';

export type HistoryClient = WalletToolCaller;

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

  const mcpCallPayload: GetRecordsToolArgs = {
    limit: resolvedLimit,
    offset: resolvedOffset,
    sortBy: upstreamSortBy,
    ...(queryOptions?.accountId
      ? {
          accountId: Array.isArray(queryOptions.accountId)
            ? queryOptions.accountId.join(',')
            : queryOptions.accountId,
        }
      : {}),
    ...(queryOptions?.categoryId
      ? {
          categoryId: Array.isArray(queryOptions.categoryId)
            ? queryOptions.categoryId
            : [queryOptions.categoryId],
        }
      : {}),
    ...(queryOptions?.categoryGroup &&
    (!Array.isArray(queryOptions?.categoryId) || queryOptions.categoryId.length <= 1)
      ? { categoryGroup: queryOptions.categoryGroup }
      : {}),
    ...(queryOptions?.recordType ? { recordType: queryOptions.recordType } : {}),
    ...(Array.isArray(queryOptions?.dateRange) ? { recordDate: queryOptions.dateRange } : {}),
    ...(queryOptions?.counterParty
      ? {
          counterParty: (() => {
            const rawCounterParty = String(queryOptions.counterParty).trim();
            return rawCounterParty.startsWith('contains-i.') ||
              rawCounterParty.startsWith('eq.') ||
              rawCounterParty.startsWith('contains.')
              ? rawCounterParty
              : `contains-i.${rawCounterParty}`;
          })(),
        }
      : {}),
    ...(queryOptions?.note
      ? {
          note: (() => {
            const rawNote = String(queryOptions.note).trim();
            return rawNote.startsWith('contains-i.') ||
              rawNote.startsWith('eq.') ||
              rawNote.startsWith('contains.')
              ? rawNote
              : `contains-i.${rawNote}`;
          })(),
        }
      : {}),
    ...(queryOptions?.searchQuery && queryOptions?.searchScanFallback === false
      ? { query: queryOptions.searchQuery }
      : {}),
  };

  const callRecordsTool = (payload: GetRecordsToolArgs): Promise<RawRecordsResponse> =>
    callGetRecords(client, payload);

  if (queryOptions?.searchQuery && queryOptions?.searchScanFallback !== false) {
    return executeSearchScanCompatibilityShim(
      queryOptions as TransactionHistoryQueryOptions & { searchQuery: string },
      mcpCallPayload,
      resolvedLimit,
      resolvedOffset,
      resolvedSort,
      upstreamSortBy,
      normalizeRawRecords,
      callRecordsTool,
      scanStore
    );
  }

  const rawResponse = await callRecordsTool(mcpCallPayload);
  const rawRecordArray = extractRawArray<RawRecordItem>(rawResponse, 'records', 'items');
  const rawEnvelope = !Array.isArray(rawResponse) && typeof rawResponse === 'object' && rawResponse !== null
    ? (rawResponse as RawRecordsEnvelope)
    : undefined;

  const pageRecords = normalizeRawRecords(rawRecordArray);
  const totalCount = typeof rawEnvelope?.total === 'number' && Number.isFinite(rawEnvelope.total)
    ? rawEnvelope.total
    : undefined;
  const hasMore = typeof rawEnvelope?.hasMore === 'boolean'
    ? rawEnvelope.hasMore
    : (typeof totalCount === 'number' ? resolvedOffset + pageRecords.length < totalCount : pageRecords.length === resolvedLimit);

  const nextOffset = typeof rawEnvelope?.nextOffset === 'number'
    ? rawEnvelope.nextOffset
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

  const enrichedRecordList = enrichHistoryRecords(
    historyPageResult.records,
    cachedAccounts,
    cachedCategories
  );

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

export * from '../records/recordNormalizer.js';

