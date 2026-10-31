import {
  MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST,
  MAX_TRANSACTION_HISTORY_LIMIT,
  DEFAULT_SEARCH_SCAN_CACHE_TTL_MS,
  DEFAULT_MAX_SEARCH_SCAN_CACHE_ENTRIES,
} from '../constants.js';
import type {
  TransactionHistoryQueryOptions,
  TransactionSortOrder,
  WalletRecordItem,
  TransactionHistoryPage,
} from '../types.js';
import { WalletMcpRequestError } from '../mcp/errors.js';
import {
  type GetRecordsToolArgs,
  type RawRecordsResponse,
  type RawRecordsEnvelope,
  type RawRecordItem,
  extractRawArray,
} from '../mcp/toolWrappers.js';
import { matchesTransactionRecordSearch } from './transactionSearchMatcher.js';

export interface TransactionSearchScanCacheEntry {
  matchedRecords: WalletRecordItem[];
  seenMatchedRecordIds: Set<string>;
  nextOffset: number | null;
  exhausted: boolean;
  updatedAt: number;
}

/**
 * In-memory LRU and TTL-bounded store caching paginated search scan results and offsets
 * for the multi-field text search compatibility shim.
 */
export class TransactionSearchScanStore {
  public readonly cache = new Map<string, TransactionSearchScanCacheEntry>();

  constructor(
    private readonly ttlMilliseconds: number = DEFAULT_SEARCH_SCAN_CACHE_TTL_MS,
    private readonly maxEntries: number = DEFAULT_MAX_SEARCH_SCAN_CACHE_ENTRIES
  ) {}

  public clear(): void {
    this.cache.clear();
  }

  public getOrCreate(key: string, now: number): TransactionSearchScanCacheEntry {
    for (const [cacheKey, entry] of this.cache.entries()) {
      if (now - entry.updatedAt > this.ttlMilliseconds) {
        this.cache.delete(cacheKey);
      }
    }

    let entry = this.cache.get(key);
    if (!entry) {
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value as string | undefined;
        if (oldestKey) {
          this.cache.delete(oldestKey);
        }
      }
      entry = {
        matchedRecords: [],
        seenMatchedRecordIds: new Set<string>(),
        nextOffset: 0,
        exhausted: false,
        updatedAt: now,
      };
      this.cache.set(key, entry);
    }
    return entry;
  }

  public delete(key: string): void {
    this.cache.delete(key);
  }
}

export async function executeSearchScanCompatibilityShim(
  queryOptions: TransactionHistoryQueryOptions & { searchQuery: string },
  mcpCallPayload: GetRecordsToolArgs,
  resolvedLimit: number,
  resolvedOffset: number,
  resolvedSort: TransactionSortOrder,
  upstreamSortBy: string[],
  normalizeRawRecords: (rawRecordArray: readonly RawRecordItem[]) => WalletRecordItem[],
  callGetRecords: (payload: GetRecordsToolArgs) => Promise<RawRecordsResponse>,
  scanStore: TransactionSearchScanStore
): Promise<TransactionHistoryPage> {
  const searchCacheKey = JSON.stringify({
    searchQuery: queryOptions.searchQuery,
    accountId: mcpCallPayload.accountId,
    categoryId: mcpCallPayload.categoryId,
    categoryGroup: mcpCallPayload.categoryGroup,
    recordType: mcpCallPayload.recordType,
    recordDate: mcpCallPayload.recordDate,
    counterParty: mcpCallPayload.counterParty,
    note: mcpCallPayload.note,
    sortBy: upstreamSortBy,
  });

  const now = Date.now();
  const searchCacheEntry = scanStore.getOrCreate(searchCacheKey, now);

  const requestedPageEndOffset = resolvedOffset + resolvedLimit;
  const lookaheadTargetCount = requestedPageEndOffset + 1;
  let scanCallCount = 0;

  while (
    !searchCacheEntry.exhausted &&
    searchCacheEntry.matchedRecords.length < lookaheadTargetCount &&
    scanCallCount < MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST
  ) {
    const scanOffset = searchCacheEntry.nextOffset ?? 0;
    const isFreshScan = scanOffset === 0 && searchCacheEntry.matchedRecords.length === 0;
    const scanLimit = isFreshScan ? resolvedLimit : MAX_TRANSACTION_HISTORY_LIMIT;
    const scanPayload: GetRecordsToolArgs = {
      ...mcpCallPayload,
      limit: scanLimit,
      offset: scanOffset,
    };

    scanCallCount += 1;
    const rawResponse = await callGetRecords(scanPayload);
    const rawRecordArray = extractRawArray<RawRecordItem>(rawResponse, 'records', 'items');
    const rawEnvelope = !Array.isArray(rawResponse) && typeof rawResponse === 'object' && rawResponse !== null
      ? (rawResponse as RawRecordsEnvelope)
      : undefined;


    if (rawRecordArray.length === 0) {
      searchCacheEntry.exhausted = true;
      searchCacheEntry.nextOffset = null;
      searchCacheEntry.updatedAt = Date.now();
      break;
    }

    const normalizedRecords = normalizeRawRecords(rawRecordArray);
    for (const recordItem of normalizedRecords) {
      if (!matchesTransactionRecordSearch(recordItem, queryOptions.searchQuery)) {
        continue;
      }
      if (recordItem.id) {
        if (searchCacheEntry.seenMatchedRecordIds.has(recordItem.id)) {
          continue;
        }
        searchCacheEntry.seenMatchedRecordIds.add(recordItem.id);
      }
      searchCacheEntry.matchedRecords.push(recordItem);
    }

    const hasExplicitTotal = typeof rawEnvelope?.total === 'number' && Number.isFinite(rawEnvelope.total);
    const upstreamTotal = hasExplicitTotal && rawEnvelope?.total !== undefined ? Math.max(0, rawEnvelope.total) : undefined;
    const hasExplicitNextOffset = typeof rawEnvelope?.nextOffset === 'number' && Number.isFinite(rawEnvelope.nextOffset);

    let nextScanOffset: number | null = null;
    if (hasExplicitNextOffset) {
      nextScanOffset = rawEnvelope?.nextOffset ?? null;
    } else if (rawEnvelope?.nextOffset === null) {
      nextScanOffset = null;
    } else if (typeof upstreamTotal === 'number' && scanOffset + rawRecordArray.length < upstreamTotal) {
      nextScanOffset = scanOffset + rawRecordArray.length;
    } else if (Array.isArray(rawResponse) && rawRecordArray.length === scanLimit) {
      nextScanOffset = scanOffset + rawRecordArray.length;
    }

    if (nextScanOffset === null) {
      searchCacheEntry.exhausted = true;
      searchCacheEntry.nextOffset = null;
      searchCacheEntry.updatedAt = Date.now();
      break;
    }

    if (nextScanOffset <= scanOffset) {
      scanStore.delete(searchCacheKey);
      throw new WalletMcpRequestError(
        '[error] Wallet MCP search pagination did not make forward progress',
        'DEFINITIVE_FAILURE'
      );
    }

    searchCacheEntry.nextOffset = nextScanOffset;
    searchCacheEntry.updatedAt = Date.now();
  }

  const scanBudgetReached =
    !searchCacheEntry.exhausted &&
    searchCacheEntry.matchedRecords.length < lookaheadTargetCount &&
    scanCallCount >= MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST;
  const requestedPageComplete = searchCacheEntry.matchedRecords.length >= requestedPageEndOffset;
  const pageNumber = Math.floor(resolvedOffset / resolvedLimit) + 1;

  if (scanBudgetReached && !requestedPageComplete) {
    return {
      records: [],
      total: undefined,
      limit: resolvedLimit,
      offset: resolvedOffset,
      page: pageNumber,
      totalPages: undefined,
      nextOffset: null,
      hasMore: false,
      sort: resolvedSort,
      unresolvedFilters: [
        {
          filterKey: 'searchQuery',
          rawValue: queryOptions.searchQuery,
          reason: 'UNRESOLVED',
          message: 'Search verification reached its per-request scan budget. Add account, category, or date filters, or retry the same search to continue from the cached scan position.',
        },
      ],
    };
  }

  const pageRecords = searchCacheEntry.matchedRecords.slice(resolvedOffset, requestedPageEndOffset);
  const hasBufferedLookahead = searchCacheEntry.matchedRecords.length > requestedPageEndOffset;
  const continuationUnknown = scanBudgetReached && requestedPageComplete && !hasBufferedLookahead;
  const hasMore = continuationUnknown
    ? false
    : (hasBufferedLookahead || !searchCacheEntry.exhausted);
  const resolvedTotalCount = searchCacheEntry.exhausted
    ? searchCacheEntry.matchedRecords.length
    : undefined;
  const totalPagesCount = typeof resolvedTotalCount === 'number'
    ? Math.max(1, Math.ceil(resolvedTotalCount / resolvedLimit))
    : undefined;

  return {
    records: pageRecords,
    total: resolvedTotalCount,
    limit: resolvedLimit,
    offset: resolvedOffset,
    page: pageNumber,
    totalPages: totalPagesCount,
    nextOffset: hasMore ? requestedPageEndOffset : null,
    hasMore,
    continuationUnknown,
    sort: resolvedSort,
  };
}

