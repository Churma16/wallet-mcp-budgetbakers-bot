import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  WalletBudgetItem,
  TransactionSortOrder,
  TransactionHistoryQueryOptions,
  WalletRecordItem,
  TransactionHistoryPage,
  WalletAgentHint,
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';
import { matchesTransactionRecordSearch } from '../utils/transactionSearchMatcher.js';
import { normalizeTransactionRecordDate } from '../utils/recordDateNormalizer.js';
import {
  OfficialWalletMcpProtocolClient,
  classifyWalletMcpProtocolFailure,
  formatWalletMcpProtocolError,
  type WalletMcpProtocolClient,
  type WalletMcpProtocolToolResult,
} from './walletMcpProtocolClient.js';

export const DEFAULT_TRANSACTION_HISTORY_LIMIT = 10;
export const MAX_TRANSACTION_HISTORY_LIMIT = 50;
export const MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST = 5;

export interface WalletMcpToolCapability {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WalletMcpRateLimitMetadata {
  limit?: number;
  remaining?: number;
  resetAt?: string;
  retryAfterSeconds?: number;
  retryAfterMilliseconds?: number;
}

export interface WalletMcpResponseMetadata {
  rateLimit?: WalletMcpRateLimitMetadata;
  agentHints?: Array<Pick<WalletAgentHint, 'type' | 'severity' | 'text'>>;
}

interface TransactionSearchScanCacheEntry {
  matchedRecords: WalletRecordItem[];
  seenMatchedRecordIds: Set<string>;
  nextOffset: number | null;
  exhausted: boolean;
  updatedAt: number;
}

export type WalletMcpDispatchOutcome = 'DEFINITIVE_FAILURE' | 'UNKNOWN';

export class WalletMcpRequestError extends Error {
  constructor(
    message: string,
    public readonly dispatchOutcome: WalletMcpDispatchOutcome
  ) {
    super(message);
    this.name = 'WalletMcpRequestError';
  }
}

export function isWalletMcpDispatchOutcomeUnknown(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'UNKNOWN';
}

export function isWalletMcpDefinitiveFailure(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'DEFINITIVE_FAILURE';
}

export class WalletMcpClientService {
  private readonly protocolClient: WalletMcpProtocolClient;
  private readonly responseMetadataByToolName = new Map<string, WalletMcpResponseMetadata>();
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private cacheLastUpdatedTimestamp: number = 0;
  private readonly cacheDurationMilliseconds: number = 1000 * 60 * 30; // 30 minutes
  private readonly transactionSearchScanCache = new Map<string, TransactionSearchScanCacheEntry>();
  private readonly transactionSearchScanCacheTtlMilliseconds = 1000 * 60 * 2; // 2 minutes
  private readonly maxTransactionSearchScanCacheEntries = 20;

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string = '',
    protocolClient?: WalletMcpProtocolClient
  ) {
    this.protocolClient = protocolClient ?? new OfficialWalletMcpProtocolClient(
      this.baseUrl,
      this.accessToken
    );
  }

  /**
   * Close the underlying MCP session when the application shuts down.
   */
  public async close(): Promise<void> {
    await this.protocolClient.close();
  }

  /**
   * Execute a Wallet tool through the official MCP client and unpack its typed payload.
   * This remains an internal adapter boundary; advertised tools are never granted semantic
   * authority merely because the server listed them.
   */
  public async callMcpTool<TToolOutput>(toolName: string, toolArguments: Record<string, unknown> = {}): Promise<TToolOutput> {
    applicationLogger.fileDetail('mcp', `Dispatched Wallet MCP Tool [${toolName}]`, {
      toolName,
      arguments: toolArguments,
    });

    let toolCallResult: WalletMcpProtocolToolResult;
    try {
      toolCallResult = await this.protocolClient.callTool(toolName, toolArguments);
    } catch (error) {
      const dispatchOutcome = classifyWalletMcpProtocolFailure(error);
      applicationLogger.fileDetail('error', `Wallet MCP SDK Failure [${toolName}]`, {
        error: error instanceof Error
          ? { name: error.name, message: formatWalletMcpProtocolError(error) }
          : formatWalletMcpProtocolError(error),
        toolName,
      });
      if (dispatchOutcome) {
        throw new WalletMcpRequestError(
          `[error] Wallet MCP request failed: ${formatWalletMcpProtocolError(error)}`,
          dispatchOutcome
        );
      }
      throw error;
    }

    const normalizedMetadata = this.normalizeResponseMetadata(toolCallResult);
    if (normalizedMetadata) {
      this.responseMetadataByToolName.set(toolName, normalizedMetadata);
    } else {
      this.responseMetadataByToolName.delete(toolName);
    }

    applicationLogger.fileDetail('mcp', `Received Wallet MCP Tool Response [${toolName}]`, {
      toolName,
      resultSummary: toolCallResult.structuredContent ?? toolCallResult.content,
      metadata: normalizedMetadata,
    });

    if (toolCallResult.isError) {
      const errorMessage = toolCallResult.content
        ?.filter(contentItem => contentItem.type === 'text' && typeof contentItem.text === 'string')
        .map(contentItem => contentItem.text)
        .join('\n') || 'Unknown tool error';
      throw new WalletMcpRequestError(
        `[error] MCP Tool '${toolName}' failed: ${formatWalletMcpProtocolError(errorMessage)}`,
        'DEFINITIVE_FAILURE'
      );
    }

    if (toolCallResult.structuredContent !== undefined) {
      return toolCallResult.structuredContent as TToolOutput;
    }

    const primaryTextContent = toolCallResult.content?.find(
      contentItem => contentItem.type === 'text' && typeof contentItem.text === 'string'
    )?.text;
    if (primaryTextContent !== undefined) {
      try {
        return JSON.parse(primaryTextContent) as TToolOutput;
      } catch {
        return primaryTextContent as unknown as TToolOutput;
      }
    }

    const { _meta: _discardedRawMetadata, ...toolResultWithoutRawMetadata } = toolCallResult;
    return toolResultWithoutRawMetadata as unknown as TToolOutput;
  }

  /**
   * Returns a bounded capability view for diagnostics and typed policy consumers.
   * Discovery does not authorize a tool for semantic/model execution.
   */
  public async listTools(): Promise<WalletMcpToolCapability[]> {
    try {
      const tools = await this.protocolClient.listTools();
      return tools
        .filter(tool => typeof tool.name === 'string' && tool.name.length > 0)
        .map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        }));
    } catch (error) {
      const dispatchOutcome = classifyWalletMcpProtocolFailure(error);
      if (dispatchOutcome) {
        throw new WalletMcpRequestError(
          `[error] Wallet MCP tool discovery failed: ${formatWalletMcpProtocolError(error)}`,
          dispatchOutcome
        );
      }
      throw error;
    }
  }

  public getLastResponseMetadata(toolName: string): WalletMcpResponseMetadata | undefined {
    const metadata = this.responseMetadataByToolName.get(toolName);
    return metadata
      ? {
          rateLimit: metadata.rateLimit ? { ...metadata.rateLimit } : undefined,
          agentHints: metadata.agentHints?.map(hint => ({ ...hint })),
        }
      : undefined;
  }

  private normalizeResponseMetadata(
    toolCallResult: WalletMcpProtocolToolResult
  ): WalletMcpResponseMetadata | undefined {
    const rawRateLimit = toolCallResult._meta?.rateLimit;
    const structuredAgentHints = (
      toolCallResult.structuredContent &&
      typeof toolCallResult.structuredContent === 'object' &&
      !Array.isArray(toolCallResult.structuredContent)
    )
      ? (toolCallResult.structuredContent as Record<string, unknown>).agentHints
      : undefined;
    const rawAgentHints = toolCallResult._meta?.agentHints ?? structuredAgentHints;

    const rateLimit = this.normalizeRateLimitMetadata(rawRateLimit);
    const agentHints = Array.isArray(rawAgentHints)
      ? rawAgentHints.slice(0, 20).flatMap(rawHint => {
          if (!rawHint || typeof rawHint !== 'object' || Array.isArray(rawHint)) {
            return [];
          }
          const hint = rawHint as Record<string, unknown>;
          if (typeof hint.type !== 'string' || hint.type.length === 0) {
            return [];
          }
          return [{
            type: hint.type,
            severity: typeof hint.severity === 'string' ? hint.severity : undefined,
            text: typeof hint.text === 'string' ? hint.text : undefined,
          }];
        })
      : undefined;

    return rateLimit || (agentHints && agentHints.length > 0)
      ? { rateLimit, agentHints }
      : undefined;
  }

  private normalizeRateLimitMetadata(rawRateLimit: unknown): WalletMcpRateLimitMetadata | undefined {
    if (!rawRateLimit || typeof rawRateLimit !== 'object' || Array.isArray(rawRateLimit)) {
      return undefined;
    }
    const metadata = rawRateLimit as Record<string, unknown>;
    const normalized: WalletMcpRateLimitMetadata = {};
    const numericFields: Array<keyof Omit<WalletMcpRateLimitMetadata, 'resetAt'>> = [
      'limit',
      'remaining',
      'retryAfterSeconds',
      'retryAfterMilliseconds',
    ];
    for (const field of numericFields) {
      if (typeof metadata[field] === 'number' && Number.isFinite(metadata[field])) {
        normalized[field] = metadata[field] as number;
      }
    }
    if (typeof metadata.resetAt === 'string') {
      normalized.resetAt = metadata.resetAt;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  /**
   * Verify client profile and connection to Wallet MCP.
   */
  public async verifyClientProfile(): Promise<unknown> {
    return await this.callMcpTool('get_client_profile');
  }

  /**
   * Retrieve all bank accounts and wallets.
   */
  public async fetchAccounts(forceRefresh: boolean = false): Promise<WalletAccountItem[]> {
    const isCacheExpired = Date.now() - this.cacheLastUpdatedTimestamp > this.cacheDurationMilliseconds;

    if (!forceRefresh && this.cachedAccountList.length > 0 && !isCacheExpired) {
      return this.cachedAccountList;
    }

    const fetchedAccountData = await this.callMcpTool<any>('get_accounts');

    const rawAccountArray: any[] = Array.isArray(fetchedAccountData)
      ? fetchedAccountData
      : (fetchedAccountData?.accounts || fetchedAccountData?.items || []);

    this.cachedAccountList = rawAccountArray.map(item => {
      let resolvedBalance: number | undefined = undefined;
      let resolvedCurrency: string | undefined = item.currency || item.currencyCode;

      if (typeof item.balance === 'number') {
        resolvedBalance = item.balance;
      } else if (typeof item.balance === 'object' && item.balance !== null) {
        resolvedBalance =
          item.balance.currentBalance ??
          item.balance.rawCurrentBalance ??
          item.balance.amount ??
          item.balance.value ??
          item.balance.current;
        resolvedCurrency = item.balance.currencyCode ?? item.balance.currency ?? resolvedCurrency;
      }

      return {
        id: item.id || item.accountId,
        name: item.name || item.accountName || 'Unnamed Account',
        currency: resolvedCurrency || 'IDR',
        balance: resolvedBalance,
        accountType: item.accountType || item.type,
        bankAccountNumber: item.bankAccountNumber || item.accountNumber || item.number || undefined,
      };
    });

    this.cacheLastUpdatedTimestamp = Date.now();
    return this.cachedAccountList;
  }

  /**
   * Retrieve all expense and income categories.
   */
  public async fetchCategories(forceRefresh: boolean = false): Promise<WalletCategoryItem[]> {
    const isCacheExpired = Date.now() - this.cacheLastUpdatedTimestamp > this.cacheDurationMilliseconds;

    if (!forceRefresh && this.cachedCategoryList.length > 0 && !isCacheExpired) {
      return this.cachedCategoryList;
    }

    const fetchedCategoryData = await this.callMcpTool<any>('get_categories');

    const rawCategoryArray: any[] = Array.isArray(fetchedCategoryData)
      ? fetchedCategoryData
      : (fetchedCategoryData?.categories || fetchedCategoryData?.items || []);

    this.cachedCategoryList = rawCategoryArray.map(item => ({
      id: item.id || item.categoryId,
      name: item.name || item.categoryName || 'Unnamed Category',
      parentCategoryId: item.parentId || item.parentCategoryId,
      parentCategoryName: item.parentName || item.parentCategoryName,
      group: item.group && typeof item.group === 'object'
        ? { id: String(item.group.id), name: String(item.group.name) }
        : undefined,
      systemId: item.systemId,
      cardinality: item.cardinality,
      customCategory: item.customCategory,
      archived: item.archived,
      enabled: item.enabled,
      isAssignable: typeof item.isAssignable === 'boolean'
        ? item.isAssignable
        : typeof item.assignable === 'boolean'
          ? item.assignable
          : item.enabled !== false && item.archived !== true && item.group?.id !== 'system_categories',
    }));

    return this.cachedCategoryList;
  }

  /**
   * Retrieve all user-defined labels/tags.
   */
  public async fetchLabels(forceRefresh: boolean = false): Promise<WalletLabelItem[]> {
    const isCacheExpired = Date.now() - this.cacheLastUpdatedTimestamp > this.cacheDurationMilliseconds;

    if (!forceRefresh && this.cachedLabelList.length > 0 && !isCacheExpired) {
      return this.cachedLabelList;
    }

    try {
      const fetchedLabelData = await this.callMcpTool<any>('get_labels');

      const rawLabelArray: any[] = Array.isArray(fetchedLabelData)
        ? fetchedLabelData
        : (fetchedLabelData?.labels || fetchedLabelData?.items || []);

      this.cachedLabelList = rawLabelArray.map(item => ({
        id: String(item.id || item.labelId || ''),
        name: String(item.name || item.labelName || item.title || '').trim(),
        color: item.color,
        icon: item.icon,
      })).filter(item => item.id.length > 0 && item.name.length > 0);

      this.cacheLastUpdatedTimestamp = Date.now();
      return this.cachedLabelList;
    } catch (error) {
      applicationLogger.fileDetail('warn', 'Failed to fetch labels from Wallet MCP', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Creates a new label in Wallet if the MCP server supports it.
   */
  public async createLabel(labelName: string): Promise<WalletLabelItem | null> {
    const sanitizedLabelName = labelName.replace(/^#/, '').trim();
    if (!sanitizedLabelName) {
      return null;
    }

    try {
      const toolCallResult = await this.callMcpTool<any>('create_label', {
        name: sanitizedLabelName,
      });

      const labelPayload = toolCallResult?.label || toolCallResult;
      if (labelPayload && (labelPayload.id || labelPayload.labelId)) {
        const createdLabel: WalletLabelItem = {
          id: String(labelPayload.id || labelPayload.labelId),
          name: String(labelPayload.name || sanitizedLabelName),
          color: labelPayload.color,
          icon: labelPayload.icon,
        };

        const existingLabelIndex = this.cachedLabelList.findIndex(item => item.id === createdLabel.id);
        if (existingLabelIndex >= 0) {
          this.cachedLabelList[existingLabelIndex] = createdLabel;
        } else {
          this.cachedLabelList.push(createdLabel);
        }

        return createdLabel;
      }
      return null;
    } catch (error) {
      applicationLogger.fileDetail('warn', `Wallet MCP label creation not available or failed for "${sanitizedLabelName}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Retrieve all budgets.
   * @param includeClosed If false (default), archived or closed budgets are filtered out
   */
  public async fetchBudgets(includeClosed: boolean = false): Promise<WalletBudgetItem[]> {
    const fetchedBudgetData = await this.callMcpTool<any>('get_budgets');

    const rawBudgetArray: any[] = Array.isArray(fetchedBudgetData)
      ? fetchedBudgetData
      : (fetchedBudgetData?.budgets || fetchedBudgetData?.items || []);

    const targetBudgetArray = includeClosed
      ? rawBudgetArray
      : rawBudgetArray.filter(item => !item.closed);

    return targetBudgetArray.map(item => {
      const currentSpending = item.spending?.current;

      const spentAmount = Number(
        currentSpending?.spent ??
        currentSpending?.totalExpenses ??
        item.spent ??
        item.currentSpent ??
        0
      );

      const limitAmount = Number(
        currentSpending?.effectiveLimit ??
        item.limit ??
        item.amount ??
        0
      );

      const remainingAmount = currentSpending?.remaining !== undefined
        ? Number(currentSpending.remaining)
        : (limitAmount - spentAmount);

      const isOverspent = Boolean(
        (currentSpending?.overspent !== undefined && Number(currentSpending.overspent) > 0) ||
        remainingAmount < 0
      );

      const resolvedCurrency = item.currencyCode || item.currency || 'IDR';

      return {
        id: item.id,
        name: item.name,
        spentAmount,
        limitAmount,
        remainingAmount,
        currency: resolvedCurrency,
        isClosed: Boolean(item.closed),
        period: currentSpending?.period,
        periodType: item.periodType,
        isOverspent,
      };
    });
  }

  /**
   * Retrieve transaction records with pagination and deterministic sorting.
   * Search pagination incrementally verifies upstream candidates and reuses a short-lived
   * per-query scan cache so later pages resume instead of rescanning from offset zero.
   */
  public async fetchRecords(queryOptions?: TransactionHistoryQueryOptions): Promise<TransactionHistoryPage> {
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

    if (queryOptions?.categoryGroup) {
      mcpCallPayload.categoryGroup = queryOptions.categoryGroup;
    }

    if (queryOptions?.recordType) {
      mcpCallPayload.recordType = queryOptions.recordType;
    }

    if (Array.isArray(queryOptions?.dateRange)) {
      mcpCallPayload.recordDate = queryOptions.dateRange;
    }

    if (queryOptions?.searchQuery) {
      mcpCallPayload.query = queryOptions.searchQuery;
    }

    const normalizeRawRecords = (rawRecordArray: any[]): WalletRecordItem[] => rawRecordArray.map(item => {
      let resolvedAmount = 0;
      let resolvedCurrency = 'IDR';

      if (typeof item.amount === 'number') {
        resolvedAmount = item.amount;
      } else if (typeof item.amount === 'object' && item.amount !== null) {
        resolvedAmount = typeof item.amount.value === 'number' ? item.amount.value : 0;
        resolvedCurrency = item.amount.currencyCode || resolvedCurrency;
      }

      resolvedCurrency = item.currencyCode || item.currency || resolvedCurrency;

      let categoryObject: WalletRecordItem['category'] = undefined;
      if (item.category && typeof item.category === 'object') {
        categoryObject = {
          id: String(item.category.id || item.categoryId || ''),
          name: String(item.category.name || item.categoryName || ''),
          color: item.category.color,
          group: item.category.group,
        };
      } else if (item.categoryId || item.categoryName) {
        categoryObject = {
          id: String(item.categoryId || ''),
          name: String(item.categoryName || ''),
        };
      }

      let labelsArray: WalletRecordItem['labels'] = undefined;
      if (Array.isArray(item.labels) && item.labels.length > 0) {
        labelsArray = item.labels.map((labelEntry: any) => ({
          id: String(labelEntry.id || labelEntry.labelId || ''),
          name: String(labelEntry.name || labelEntry.labelName || labelEntry.title || '').trim(),
          color: labelEntry.color,
          icon: labelEntry.icon,
        })).filter((labelEntry: any) => labelEntry.name.length > 0);
      }

      const rawRecordType = item.recordType;
      let resolvedRecordType: 'expense' | 'income';
      if (rawRecordType === 'expense' || rawRecordType === 'income') {
        resolvedRecordType = rawRecordType;
      } else if (resolvedAmount < 0) {
        resolvedRecordType = 'expense';
      } else {
        resolvedRecordType = 'income';
      }

      return {
        id: String(item.id || item.recordId || ''),
        accountId: String(item.accountId || ''),
        accountName: item.accountName || undefined,
        amount: resolvedAmount,
        currency: resolvedCurrency,
        recordDate: item.recordDate || item.createdAt || new Date().toISOString(),
        recordType: resolvedRecordType,
        category: categoryObject,
        note: item.note || undefined,
        counterParty: item.counterParty || item.payee || undefined,
        labels: labelsArray,
        recordState: item.recordState || undefined,
        transfer: item.transfer && typeof item.transfer === 'object'
          ? {
              type: String(item.transfer.type || ''),
              transferId: item.transfer.transferId ? String(item.transfer.transferId) : undefined,
              mirrorRecord: item.transfer.mirrorRecord,
            }
          : null,
      };
    });

    const callGetRecords = async (payload: Record<string, unknown>): Promise<any> => {
      applicationLogger.fileDetail('mcp', 'Dispatching fetchRecords to Wallet MCP', {
        limit: payload.limit,
        offset: payload.offset,
        sort: resolvedSort,
        sortBy: upstreamSortBy,
        filters: {
          accountId: payload.accountId,
          categoryId: payload.categoryId,
          categoryGroup: payload.categoryGroup,
          recordType: payload.recordType,
          recordDate: payload.recordDate,
          query: payload.query,
        },
      });

      return await this.callMcpTool<any>('get_records', payload);
    };

    if (queryOptions?.searchQuery) {
      const searchCacheKey = JSON.stringify({
        query: mcpCallPayload.query,
        accountId: mcpCallPayload.accountId,
        categoryId: mcpCallPayload.categoryId,
        categoryGroup: mcpCallPayload.categoryGroup,
        recordType: mcpCallPayload.recordType,
        recordDate: mcpCallPayload.recordDate,
        sortBy: upstreamSortBy,
      });
      const currentTimestamp = Date.now();

      for (const [cacheKey, cacheEntry] of this.transactionSearchScanCache.entries()) {
        if (currentTimestamp - cacheEntry.updatedAt > this.transactionSearchScanCacheTtlMilliseconds) {
          this.transactionSearchScanCache.delete(cacheKey);
        }
      }

      let searchCacheEntry = this.transactionSearchScanCache.get(searchCacheKey);
      if (!searchCacheEntry) {
        if (this.transactionSearchScanCache.size >= this.maxTransactionSearchScanCacheEntries) {
          const oldestCacheKey = this.transactionSearchScanCache.keys().next().value as string | undefined;
          if (oldestCacheKey) {
            this.transactionSearchScanCache.delete(oldestCacheKey);
          }
        }

        searchCacheEntry = {
          matchedRecords: [],
          seenMatchedRecordIds: new Set<string>(),
          nextOffset: 0,
          exhausted: false,
          updatedAt: currentTimestamp,
        };
        this.transactionSearchScanCache.set(searchCacheKey, searchCacheEntry);
      }

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
        const scanPayload: Record<string, unknown> = {
          ...mcpCallPayload,
          limit: scanLimit,
          offset: scanOffset,
        };

        scanCallCount += 1;
        const rawResponse = await callGetRecords(scanPayload);
        const rawRecordArray: any[] = Array.isArray(rawResponse)
          ? rawResponse
          : (rawResponse?.records || rawResponse?.items || []);

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

        const hasExplicitTotal = typeof rawResponse?.total === 'number' && Number.isFinite(rawResponse.total);
        const upstreamTotal = hasExplicitTotal ? Math.max(0, rawResponse.total) : undefined;
        const hasExplicitNextOffset = typeof rawResponse?.nextOffset === 'number' && Number.isFinite(rawResponse.nextOffset);

        let nextScanOffset: number | null = null;
        if (hasExplicitNextOffset) {
          nextScanOffset = rawResponse.nextOffset;
        } else if (rawResponse?.nextOffset === null) {
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
          this.transactionSearchScanCache.delete(searchCacheKey);
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

    const rawResponse = await callGetRecords(mcpCallPayload);
    const rawRecordArray: any[] = Array.isArray(rawResponse)
      ? rawResponse
      : (rawResponse?.records || rawResponse?.items || []);
    const normalizedRecords = normalizeRawRecords(rawRecordArray);

    const hasExplicitTotal = typeof rawResponse?.total === 'number' && Number.isFinite(rawResponse.total);
    const resolvedTotalCount = hasExplicitTotal ? Math.max(0, rawResponse.total) : undefined;

    const hasExplicitNextOffset = typeof rawResponse?.nextOffset === 'number' && Number.isFinite(rawResponse.nextOffset);
    let hasMore = false;
    let nextOffset: number | null = null;

    if (hasExplicitNextOffset) {
      hasMore = true;
      nextOffset = rawResponse.nextOffset;
    } else if (rawResponse?.nextOffset === null) {
      hasMore = false;
      nextOffset = null;
    } else if (typeof resolvedTotalCount === 'number') {
      hasMore = (resolvedOffset + rawRecordArray.length) < resolvedTotalCount;
      nextOffset = hasMore ? (resolvedOffset + rawRecordArray.length) : null;
    }

    const pageNumber = Math.floor(resolvedOffset / resolvedLimit) + 1;
    const totalPagesCount = typeof resolvedTotalCount === 'number'
      ? Math.max(1, Math.ceil(resolvedTotalCount / resolvedLimit))
      : undefined;

    return {
      records: normalizedRecords,
      total: resolvedTotalCount,
      limit: resolvedLimit,
      offset: resolvedOffset,
      page: pageNumber,
      totalPages: totalPagesCount,
      nextOffset,
      hasMore,
      sort: resolvedSort,
    };
  }

  /**
   * Normalizes recordDate using the canonical normalizeTransactionRecordDate helper.
   * Treating pre-normalized canonical UTC timestamps as authoritative prevents corrupting
   * legitimate midnight UTC records (such as 07:00:00 WIB in Asia/Jakarta) with the dispatch clock.
   */
  private normalizeRecordDate(recordDateString?: string): string {
    return normalizeTransactionRecordDate(recordDateString);
  }

  /**
   * Create one or more transaction records in Wallet.
   * A write is successful only when the MCP response contains positive, internally consistent
   * evidence that every submitted record was committed. Unverifiable responses are UNKNOWN.
   */
  public async createRecords(recordsPayload: CreateRecordInputPayload[]): Promise<WalletCreateRecordsResponse> {
    const sanitizedRecordPayloadList = recordsPayload.map(recordItem => {
      const sanitizedRecordItem: Record<string, unknown> = {
        accountId: recordItem.accountId,
        amount: recordItem.amount,
        recordDate: this.normalizeRecordDate(recordItem.recordDate),
      };

      if (recordItem.categoryId) {
        sanitizedRecordItem.categoryId = recordItem.categoryId;
      }
      if (recordItem.note) {
        sanitizedRecordItem.note = recordItem.note;
      }
      if (recordItem.counterParty) {
        sanitizedRecordItem.counterParty = recordItem.counterParty;
      }
      if (Array.isArray(recordItem.labelIds) && recordItem.labelIds.length > 0) {
        sanitizedRecordItem.labelIds = recordItem.labelIds;
      }
      if (recordItem.transfer) {
        const transfer: Record<string, unknown> = {
          pairingMode: recordItem.transfer.pairingMode,
        };
        if (recordItem.transfer.accountId) {
          transfer.accountId = recordItem.transfer.accountId;
        }
        if (recordItem.transfer.recordId) {
          transfer.recordId = recordItem.transfer.recordId;
        }
        if (recordItem.transfer.counterAmount) {
          transfer.counterAmount = recordItem.transfer.counterAmount;
        }
        sanitizedRecordItem.transfer = transfer;
      }

      return sanitizedRecordItem;
    });

    applicationLogger.fileDetail('mcp', `Prepared ${sanitizedRecordPayloadList.length} Record(s) for MCP Dispatch`, {
      originalRecords: recordsPayload,
      sanitizedRecords: sanitizedRecordPayloadList,
    });

    let createRecordsResult: unknown;
    try {
      createRecordsResult = await this.callMcpTool<unknown>('create_records', {
        records: sanitizedRecordPayloadList,
      });
    } catch (error) {
      if (error instanceof WalletMcpRequestError) {
        throw error;
      }

      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an unclassified result-processing failure`,
        'UNKNOWN'
      );
    }

    const validatedResult = this.validateCreateRecordsResponse(createRecordsResult, sanitizedRecordPayloadList.length);
    this.transactionSearchScanCache.clear();
    return validatedResult;
  }

  public validateCreateRecordsResponse(
    createRecordsResult: unknown,
    expectedRecordCount: number
  ): WalletCreateRecordsResponse {
    if (!createRecordsResult || typeof createRecordsResult !== 'object' || Array.isArray(createRecordsResult)) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned an unverifiable response`,
        'UNKNOWN'
      );
    }

    const typedResult = createRecordsResult as WalletCreateRecordsResponse;
    const summary = typedResult.summary;
    const results = typedResult.results;
    const hasSummary = summary !== undefined;
    const hasResults = Array.isArray(results);

    if (!hasSummary && !hasResults) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned no recognized success evidence`,
        'UNKNOWN'
      );
    }

    let summaryResolvedErrors: number | undefined;

    if (hasSummary) {
      const totalValid =
        typeof summary?.total === 'number' && Number.isInteger(summary.total) && summary.total >= 0;
      const succeededValid =
        typeof summary?.succeeded === 'number' && Number.isInteger(summary.succeeded) && summary.succeeded >= 0;

      const expectedSummaryTotal = hasResults ? results.length : expectedRecordCount;
      if (!totalValid || !succeededValid || summary?.total !== expectedSummaryTotal) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }

      const optionalFields = [
        summary?.failed,
        summary?.clientErrors,
        summary?.serverErrors,
        summary?.documentsWritten,
      ];
      for (const field of optionalFields) {
        if (field !== undefined && (typeof field !== 'number' || !Number.isInteger(field) || field < 0)) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
            'UNKNOWN'
          );
        }
      }

      const hasClientErrors = summary?.clientErrors !== undefined;
      const hasServerErrors = summary?.serverErrors !== undefined;
      const hasFailed = summary?.failed !== undefined;

      if (hasClientErrors !== hasServerErrors) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }

      if (hasClientErrors && hasServerErrors) {
        summaryResolvedErrors = (summary?.clientErrors ?? 0) + (summary?.serverErrors ?? 0);
        if (hasFailed && summary?.failed !== summaryResolvedErrors) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
            'UNKNOWN'
          );
        }
      } else if (hasFailed) {
        summaryResolvedErrors = summary?.failed;
      }

      if (summaryResolvedErrors !== undefined) {
        if ((summary?.succeeded ?? 0) + summaryResolvedErrors !== expectedRecordCount) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
            'UNKNOWN'
          );
        }
      }

      // Native transfers can write a root plus a mirror for one successful input.
      // documentsWritten therefore counts documents, not successful input rows.
      if (
        summary?.documentsWritten !== undefined &&
        summary.documentsWritten < summary.succeeded
      ) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }
      if (
        summary?.documentsWritten !== undefined &&
        summary.documentsWritten > summary.succeeded &&
        !hasResults
      ) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned unexplained document-write evidence`,
          'UNKNOWN'
        );
      }
    }

    let resultSuccessCount = 0;
    let resultFailureCount = 0;
    let rootResults: NonNullable<WalletCreateRecordsResponse['results']> = [];
    let mirrorResults: NonNullable<WalletCreateRecordsResponse['results']> = [];

    if (hasResults) {
      if (results.length < expectedRecordCount) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an unexpected number of per-record results`,
          'UNKNOWN'
        );
      }

      const invalidResultShape = results.some(result => !result || typeof result.success !== 'boolean');
      if (invalidResultShape) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned invalid per-record results`,
          'UNKNOWN'
        );
      }

      const rootResultsByInputIndex = new Map<number, (typeof results)[number]>();
      for (const result of results) {
        if (
          !Number.isInteger(result.inputIndex) ||
          (result.inputIndex as number) < 0 ||
          (result.inputIndex as number) >= expectedRecordCount
        ) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned uncorrelated per-record results`,
            'UNKNOWN'
          );
        }
        const isMirrorResult = result.isMirror === true || result.resultType === 'mirror';
        if (isMirrorResult) {
          mirrorResults.push(result);
          continue;
        }
        if (rootResultsByInputIndex.has(result.inputIndex as number)) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned duplicate root results`,
            'UNKNOWN'
          );
        }
        rootResultsByInputIndex.set(result.inputIndex as number, result);
      }

      if (rootResultsByInputIndex.size !== expectedRecordCount) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned missing root results`,
          'UNKNOWN'
        );
      }

      rootResults = [...rootResultsByInputIndex.values()];
      const mirrorInputIndexes = new Set<number>();
      for (const mirrorResult of mirrorResults) {
        if (mirrorInputIndexes.has(mirrorResult.inputIndex as number)) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned duplicate mirror results`,
            'UNKNOWN'
          );
        }
        mirrorInputIndexes.add(mirrorResult.inputIndex as number);
        const rootResult = rootResultsByInputIndex.get(mirrorResult.inputIndex as number)!;
        const mirrorIdMatches =
          typeof mirrorResult.id === 'string' &&
          rootResult.createdMirrorRecordId === mirrorResult.id;
        const rootIdMatches =
          typeof mirrorResult.mirrorOfRecordId === 'string' &&
          rootResult.id === mirrorResult.mirrorOfRecordId;
        if (!mirrorIdMatches && !rootIdMatches) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned an uncorrelated mirror result`,
            'UNKNOWN'
          );
        }
        if (mirrorResult.success !== true || rootResult.success !== true) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'create_records' returned contradictory mirror evidence`,
            'UNKNOWN'
          );
        }
      }

      resultSuccessCount = rootResults.filter(result => result.success === true).length;
      resultFailureCount = rootResults.length - resultSuccessCount;
    }

    if (hasSummary && hasResults) {
      if (summary?.succeeded !== resultSuccessCount) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned inconsistent summary and per-record results`,
          'UNKNOWN'
        );
      }

      const confirmedSecondaryDocumentIds = new Set<string>();
      for (const result of rootResults) {
        if (result.success === true && typeof result.createdMirrorRecordId === 'string') {
          confirmedSecondaryDocumentIds.add(result.createdMirrorRecordId);
        }
      }
      for (const result of mirrorResults) {
        if (result.success === true && typeof result.id === 'string') {
          confirmedSecondaryDocumentIds.add(result.id);
        }
      }
      const confirmedExistingWrites = rootResults.filter(result =>
        result.success === true && (
          result.pairingMode === 'existing'
        )
      ).length;
      const minimumDocumentsWritten = summary?.succeeded ?? 0;
      const maximumExplainedDocumentsWritten =
        minimumDocumentsWritten + confirmedSecondaryDocumentIds.size + confirmedExistingWrites;
      if (
        summary?.documentsWritten !== undefined &&
        (summary.documentsWritten < minimumDocumentsWritten ||
          summary.documentsWritten > maximumExplainedDocumentsWritten)
      ) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned unexplained document-write evidence`,
          'UNKNOWN'
        );
      }
    }

    const totalFailureCount = summaryResolvedErrors !== undefined
      ? summaryResolvedErrors
      : resultFailureCount;

    if (totalFailureCount > 0 || (hasResults && resultFailureCount > 0)) {
      const failureCount = Math.max(totalFailureCount, resultFailureCount);
      const firstFailureItem = hasResults
        ? rootResults.find(result => result.success === false)
        : undefined;
      const firstFailureDetail = firstFailureItem?.error;

      const hasServerErrors = (summary?.serverErrors !== undefined && summary.serverErrors > 0) ||
        (hasResults && rootResults.some(r => r.success === false && r.errorType === 'server_error'));

      const hasPartialSuccess = (summary?.succeeded !== undefined && summary.succeeded > 0) ||
        (hasResults && resultSuccessCount > 0);

      const dispatchOutcome: WalletMcpDispatchOutcome = (hasServerErrors || hasPartialSuccess)
        ? 'UNKNOWN'
        : 'DEFINITIVE_FAILURE';

      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' rejected ${failureCount} record(s)` +
          (firstFailureDetail ? `: ${firstFailureDetail}` : ''),
        dispatchOutcome
      );
    }

    const summaryConfirmsFullSuccess = Boolean(
      hasSummary &&
      summary?.succeeded === expectedRecordCount &&
      (summaryResolvedErrors === 0 || (summaryResolvedErrors === undefined && summary?.documentsWritten === expectedRecordCount))
    );
    const resultsConfirmFullSuccess = Boolean(
      hasResults &&
      resultSuccessCount === expectedRecordCount &&
      resultFailureCount === 0
    );

    if (!summaryConfirmsFullSuccess && !resultsConfirmFullSuccess) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' did not provide positive evidence for all ${expectedRecordCount} submitted record(s)`,
        'UNKNOWN'
      );
    }

    return typedResult;
  }
}
