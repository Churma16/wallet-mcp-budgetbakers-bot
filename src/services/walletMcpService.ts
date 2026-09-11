import axios, { AxiosInstance } from 'axios';
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
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';
import { matchesTransactionRecordSearch } from '../utils/transactionSearchMatcher.js';

export const DEFAULT_TRANSACTION_HISTORY_LIMIT = 10;
export const MAX_TRANSACTION_HISTORY_LIMIT = 50;

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
  private readonly httpClient: AxiosInstance;
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private cacheLastUpdatedTimestamp: number = 0;
  private readonly cacheDurationMilliseconds: number = 1000 * 60 * 30; // 30 minutes

  constructor(private readonly baseUrl: string, private readonly accessToken: string) {
    this.httpClient = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        'Accept': 'application/json, text/event-stream',
      },
      timeout: 15000,
    });
  }

  /**
   * Send a generic JSON-RPC 2.0 request to the Wallet MCP Server.
   * Transport failures where the server may already have received/committed the request
   * are marked UNKNOWN so callers do not blindly retry writes.
   */
  private async executeJsonRpcRequest<TResult>(methodName: string, requestParameters: Record<string, unknown> = {}): Promise<TResult> {
    const jsonRpcPayload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: methodName,
      params: requestParameters,
    };

    applicationLogger.fileDetail('mcp', `Dispatched Wallet MCP Request [${methodName}]`, {
      method: methodName,
      params: requestParameters,
    });

    try {
      const httpResponse = await this.httpClient.post('', jsonRpcPayload);
      const responseBody = httpResponse.data;

      if (responseBody.error) {
        applicationLogger.fileDetail('error', `Wallet MCP Server Returned Error [${methodName}]`, {
          error: responseBody.error,
          payloadSent: jsonRpcPayload,
        });
        throw new WalletMcpRequestError(
          `[error] MCP JSON-RPC Error: ${responseBody.error.message || JSON.stringify(responseBody.error)}`,
          'DEFINITIVE_FAILURE'
        );
      }

      applicationLogger.fileDetail('mcp', `Received Wallet MCP Response [${methodName}]`, {
        method: methodName,
        resultSummary: responseBody.result,
      });

      return responseBody.result as TResult;
    } catch (error: unknown) {
      applicationLogger.fileDetail('error', `Wallet MCP HTTP/Network Failure [${methodName}]`, {
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        payloadSent: jsonRpcPayload,
      });

      if (error instanceof WalletMcpRequestError) {
        throw error;
      }

      if (axios.isAxiosError(error)) {
        if (error.response) {
          const errorDataString = typeof error.response.data === 'object'
            ? JSON.stringify(error.response.data)
            : String(error.response.data);
          const statusCode = error.response.status;
          const dispatchOutcome: WalletMcpDispatchOutcome =
            statusCode === 408 || statusCode >= 500 ? 'UNKNOWN' : 'DEFINITIVE_FAILURE';

          throw new WalletMcpRequestError(
            `[error] Wallet MCP HTTP ${statusCode}: ${errorDataString}`,
            dispatchOutcome
          );
        }

        throw new WalletMcpRequestError(
          `[error] Wallet MCP transport failure: ${error.message}`,
          'UNKNOWN'
        );
      }

      throw error;
    }
  }

  /**
   * Helper to execute a tool call via tools/call and unpack text content.
   */
  public async callMcpTool<TToolOutput>(toolName: string, toolArguments: Record<string, unknown> = {}): Promise<TToolOutput> {
    const toolCallResult = await this.executeJsonRpcRequest<{
      content?: Array<{ type: string; text: string }>;
      structuredContent?: any;
      isError?: boolean;
    }>('tools/call', {
      name: toolName,
      arguments: toolArguments,
    });

    if (toolCallResult.isError) {
      const errorMessage = toolCallResult.content?.map(contentItem => contentItem.text).join('\n') || 'Unknown tool error';
      throw new WalletMcpRequestError(
        `[error] MCP Tool '${toolName}' failed: ${errorMessage}`,
        'DEFINITIVE_FAILURE'
      );
    }

    if (toolCallResult.structuredContent !== undefined) {
      return toolCallResult.structuredContent as TToolOutput;
    }

    if (toolCallResult.content && toolCallResult.content.length > 0) {
      const primaryTextContent = toolCallResult.content[0].text;
      try {
        return JSON.parse(primaryTextContent) as TToolOutput;
      } catch {
        return primaryTextContent as unknown as TToolOutput;
      }
    }

    return toolCallResult as unknown as TToolOutput;
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
   * Capped at safe upper bound (MAX_TRANSACTION_HISTORY_LIMIT = 50).
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

    applicationLogger.fileDetail('mcp', 'Dispatching fetchRecords to Wallet MCP', {
      limit: resolvedLimit,
      offset: resolvedOffset,
      sort: resolvedSort,
      sortBy: upstreamSortBy,
      filters: {
        accountId: mcpCallPayload.accountId,
        categoryId: mcpCallPayload.categoryId,
        categoryGroup: mcpCallPayload.categoryGroup,
        recordType: mcpCallPayload.recordType,
        recordDate: mcpCallPayload.recordDate,
        query: mcpCallPayload.query,
      },
    });

    const rawResponse = await this.callMcpTool<any>('get_records', mcpCallPayload);

    const rawRecordArray: any[] = Array.isArray(rawResponse)
      ? rawResponse
      : (rawResponse?.records || rawResponse?.items || []);

    const normalizedRecords: WalletRecordItem[] = rawRecordArray.map(item => {
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

    const filteredRecords = queryOptions?.searchQuery
      ? normalizedRecords.filter(recordItem =>
          matchesTransactionRecordSearch(recordItem, queryOptions.searchQuery!)
        )
      : normalizedRecords;

    const hasExplicitTotal = typeof rawResponse?.total === 'number' && Number.isFinite(rawResponse.total);
    const resolvedTotalCount = (hasExplicitTotal && (!queryOptions?.searchQuery || filteredRecords.length === normalizedRecords.length))
      ? Math.max(0, rawResponse.total)
      : (queryOptions?.searchQuery ? filteredRecords.length : undefined);

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
      hasMore = (resolvedOffset + filteredRecords.length) < resolvedTotalCount;
      nextOffset = hasMore ? (resolvedOffset + filteredRecords.length) : null;
    }

    const pageNumber = Math.floor(resolvedOffset / resolvedLimit) + 1;
    const totalPagesCount = typeof resolvedTotalCount === 'number'
      ? Math.max(1, Math.ceil(resolvedTotalCount / resolvedLimit))
      : undefined;

    return {
      records: filteredRecords,
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
   * Normalizes recordDate: if given timestamp has midnight UTC (00:00:00.000Z),
   * injects current UTC hours/minutes/seconds so that Wallet timezone rendering (e.g. WIB / UTC+7)
   * does not show 07:00 AM instead of the actual transaction time.
   */
  private normalizeRecordDate(recordDateString?: string): string {
    const currentTimestamp = new Date();
    if (!recordDateString) {
      return currentTimestamp.toISOString();
    }

    const parsedDate = new Date(recordDateString);
    if (Number.isNaN(parsedDate.getTime())) {
      return currentTimestamp.toISOString();
    }

    const isMidnightUtc =
      parsedDate.getUTCHours() === 0 &&
      parsedDate.getUTCMinutes() === 0 &&
      parsedDate.getUTCSeconds() === 0;

    if (isMidnightUtc) {
      parsedDate.setUTCHours(currentTimestamp.getUTCHours());
      parsedDate.setUTCMinutes(currentTimestamp.getUTCMinutes());
      parsedDate.setUTCSeconds(currentTimestamp.getUTCSeconds());
      parsedDate.setUTCMilliseconds(currentTimestamp.getUTCMilliseconds());
    }

    return parsedDate.toISOString();
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

    return this.validateCreateRecordsResponse(createRecordsResult, sanitizedRecordPayloadList.length);
  }

  private validateCreateRecordsResponse(
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

    if (hasSummary) {
      const summaryNumbers = [summary?.total, summary?.succeeded, summary?.failed];
      const summaryIsValid = summaryNumbers.every(
        value => typeof value === 'number' && Number.isInteger(value) && value >= 0
      );

      if (
        !summaryIsValid ||
        summary?.total !== expectedRecordCount ||
        (summary?.succeeded ?? 0) + (summary?.failed ?? 0) !== summary?.total
      ) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'create_records' returned an invalid or mismatched summary`,
          'UNKNOWN'
        );
      }
    }

    let resultSuccessCount = 0;
    let resultFailureCount = 0;

    if (hasResults) {
      if (results.length !== expectedRecordCount) {
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

      resultSuccessCount = results.filter(result => result.success === true).length;
      resultFailureCount = results.length - resultSuccessCount;
    }

    if (
      hasSummary &&
      hasResults &&
      (
        summary?.succeeded !== resultSuccessCount ||
        summary?.failed !== resultFailureCount
      )
    ) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' returned inconsistent summary and per-record results`,
        'UNKNOWN'
      );
    }

    const definitiveFailureCount = hasSummary
      ? summary?.failed ?? 0
      : resultFailureCount;

    if (definitiveFailureCount > 0) {
      const firstFailureDetail = hasResults
        ? results.find(result => result.success === false)?.error
        : undefined;
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'create_records' rejected ${definitiveFailureCount} record(s)` +
          (firstFailureDetail ? `: ${firstFailureDetail}` : ''),
        'DEFINITIVE_FAILURE'
      );
    }

    const summaryConfirmsFullSuccess = Boolean(
      hasSummary &&
      summary?.succeeded === expectedRecordCount &&
      summary?.failed === 0
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
