import axios, { AxiosInstance } from 'axios';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  WalletBudgetItem,
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';

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
