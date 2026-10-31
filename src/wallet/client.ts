import {
  type CallToolResult,
} from '@modelcontextprotocol/client';
import {
  WALLET_MCP_ALLOWED_TOOL_NAMES,
  WALLET_MCP_TOOL_NAMES,
  MAX_DISCOVERED_WALLET_MCP_TOOLS,
  DEFAULT_SEARCH_SCAN_CACHE_TTL_MS,
  DEFAULT_MAX_SEARCH_SCAN_CACHE_ENTRIES,
} from './constants.js';
import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
  WalletBudgetItem,
  WalletClientProfile,
  WalletMcpToolCapability,
  WalletMcpResponseMetadata,
  WalletMcpOperationName,
  TransactionHistoryQueryOptions,
  TransactionHistoryPage,
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
} from './types.js';
import {
  WalletMcpTransport,
  type WalletMcpTransportDependencies,
} from './transport.js';
import {
  WalletMcpRequestError,
  classifyMcpFailure,
  sanitizeMcpErrorMessage,
} from './errors.js';
import { normalizeWalletClientProfile } from './profileNormalizer.js';
import {
  normalizeResponseMetadata,
  normalizeToolCapability,
} from './metadataNormalizer.js';
import {
  fetchAccounts,
  fetchCategories,
  fetchLabels,
  createLabel,
  fetchBudgets,
  type EntityCacheStore,
} from './entities.js';
import { fetchRecords } from './history.js';
import { createRecords } from './records.js';
import { validateCreateRecordsResponse } from './recordValidation.js';
import {
  fetchRecordsAggregation,
  validateRecordAggregationResponse,
} from './aggregation.js';
import {
  TransactionSearchScanStore,
  type TransactionSearchScanCacheEntry,
} from './searchScan.js';
import { normalizeTransactionRecordDate } from './recordDateNormalizer.js';
import { applicationLogger } from '../lib/logger.js';
import {
  type RawWalletClientProfileResponse,
  type RawAccountsResponse,
  type RawCategoriesResponse,
  type RawLabelsResponse,
  type CreateLabelToolArgs,
  type RawCreateLabelResponse,
  type RawBudgetsResponse,
  type GetRecordsToolArgs,
  type RawRecordsResponse,
  type CreateRecordsToolArgs,
  type RawCreateRecordsResponse,
  type RawRecordAggregationResponse,
  callGetClientProfile,
  callGetAccounts,
  callGetCategories,
  callGetLabels,
  callCreateLabel,
  callGetBudgets,
  callGetRecords,
  callCreateRecords,
  callGetRecordsAggregation,
} from './toolWrappers.js';

export interface WalletMcpClientOptions {
  readonly transportDependencies?: WalletMcpTransportDependencies;
  readonly cacheDurationMilliseconds?: number;
  readonly profileCacheDurationMilliseconds?: number;
}

/**
 * Official MCP client facade managing streamable transport lifecycle, application allowlists,
 * tool invocation, and authoritative entity access for BudgetBakers Wallet.
 */
export class WalletMcpClient {
  private readonly mcpTransport: WalletMcpTransport;
  private readonly cacheStore: EntityCacheStore;
  private readonly profileCacheDurationMilliseconds: number;
  private readonly responseMetadataByOperation = new Map<WalletMcpOperationName, WalletMcpResponseMetadata>();
  private cachedClientProfile: WalletClientProfile | undefined;
  private profileCacheTimestamp: number = 0;
  public readonly transactionSearchScanCacheTtlMilliseconds: number = DEFAULT_SEARCH_SCAN_CACHE_TTL_MS;
  public readonly maxTransactionSearchScanCacheEntries: number = DEFAULT_MAX_SEARCH_SCAN_CACHE_ENTRIES;
  public readonly searchScanStore = new TransactionSearchScanStore();

  public get transactionSearchScanCache(): Map<string, TransactionSearchScanCacheEntry> {
    return this.searchScanStore.cache;
  }

  constructor(
    baseUrl: string,
    private readonly accessToken: string,
    optionsOrDependencies: WalletMcpTransportDependencies | WalletMcpClientOptions = {},
    legacyOptions: { cacheDurationMilliseconds?: number; profileCacheDurationMilliseconds?: number } = {}
  ) {
    let transportDependencies: WalletMcpTransportDependencies | undefined;
    let cacheDurationMilliseconds: number | undefined;
    let profileCacheDurationMilliseconds: number | undefined;

    if ('createClient' in optionsOrDependencies || 'createTransport' in optionsOrDependencies) {
      transportDependencies = optionsOrDependencies;
      cacheDurationMilliseconds = legacyOptions.cacheDurationMilliseconds;
      profileCacheDurationMilliseconds = legacyOptions.profileCacheDurationMilliseconds;
    } else {
      const opts = optionsOrDependencies as WalletMcpClientOptions;
      transportDependencies = opts.transportDependencies;
      cacheDurationMilliseconds = opts.cacheDurationMilliseconds;
      profileCacheDurationMilliseconds = opts.profileCacheDurationMilliseconds;
    }

    this.mcpTransport = new WalletMcpTransport(baseUrl, accessToken, transportDependencies);
    this.cacheStore = {
      cachedAccountList: [],
      cachedCategoryList: [],
      cachedLabelList: [],
      cacheLastUpdatedTimestamp: 0,
      cacheDurationMilliseconds: cacheDurationMilliseconds ?? 60 * 60 * 1000,
    };
    this.profileCacheDurationMilliseconds = profileCacheDurationMilliseconds ?? 10 * 60 * 1000;
  }

  public async close(): Promise<void> {
    await this.mcpTransport.close();
  }

  public getLastResponseMetadata(operationName: WalletMcpOperationName): WalletMcpResponseMetadata | undefined {
    const metadata = this.responseMetadataByOperation.get(operationName);
    return metadata ? structuredClone(metadata) : undefined;
  }

  public async callMcpTool<TToolOutput = unknown>(
    toolName: string,
    toolArguments: Record<string, unknown> = {}
  ): Promise<TToolOutput> {
    if (!(WALLET_MCP_ALLOWED_TOOL_NAMES as readonly string[]).includes(toolName)) {
      throw new WalletMcpRequestError(
        '[error] Wallet MCP tool is not allowed by the application adapter',
        'DEFINITIVE_FAILURE',
        'TOOL_UNAVAILABLE'
      );
    }

    applicationLogger.fileDetail('mcp', `Dispatched Wallet MCP Tool [${toolName}]`, {
      tool: toolName,
      arguments: toolArguments,
    });

    let toolCallResult: CallToolResult;
    try {
      toolCallResult = await this.mcpTransport.callTool(toolName, toolArguments);
    } catch (error) {
      throw classifyMcpFailure(error, toolName, this.accessToken);
    }

    const responseMetadata = this.retainResponseMetadata(toolName as WalletMcpOperationName, toolCallResult);

    applicationLogger.fileDetail('mcp', `Received Wallet MCP Tool Response [${toolName}]`, {
      tool: toolName,
      isError: toolCallResult.isError === true,
      metadata: responseMetadata,
    });

    if (toolCallResult.isError) {
      const errorMessage = toolCallResult.content
        .filter(contentItem => contentItem.type === 'text')
        .map(contentItem => contentItem.text)
        .join('\n') || 'Unknown tool error';
      const sanitized = sanitizeMcpErrorMessage(errorMessage, this.accessToken);
      const lowerMessage = errorMessage.toLowerCase();
      const isPermissionError =
        lowerMessage.includes('permission') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('scope') ||
        lowerMessage.includes('401') ||
        lowerMessage.includes('403');

      throw new WalletMcpRequestError(
        `[error] MCP Tool '${toolName}' failed: ${sanitized}`,
        'DEFINITIVE_FAILURE',
        isPermissionError ? 'AUTHORIZATION' : 'REQUEST_INVALID'
      );
    }

    if (toolCallResult.structuredContent !== undefined) {
      return toolCallResult.structuredContent as TToolOutput;
    }

    const primaryTextContent = toolCallResult.content.find(
      contentItem => contentItem.type === 'text'
    );
    if (primaryTextContent?.type === 'text') {
      try {
        return JSON.parse(primaryTextContent.text) as TToolOutput;
      } catch {
        return primaryTextContent.text as unknown as TToolOutput;
      }
    }

    return toolCallResult as unknown as TToolOutput;
  }

  public async listTools(): Promise<WalletMcpToolCapability[]> {
    try {
      const listResult = await this.mcpTransport.listTools();
      this.retainResponseMetadata('tools/list', listResult);
      const rawTools = (listResult.tools || []).slice(0, MAX_DISCOVERED_WALLET_MCP_TOOLS);
      return rawTools.map(tool => normalizeToolCapability(tool));
    } catch (error) {
      throw classifyMcpFailure(error, 'tools/list', this.accessToken);
    }
  }

  public async getClientProfile(forceRefresh: boolean = false): Promise<WalletClientProfile> {
    const isCacheExpired = Date.now() - this.profileCacheTimestamp > this.profileCacheDurationMilliseconds;
    if (!forceRefresh && this.cachedClientProfile !== undefined && !isCacheExpired) {
      return this.cachedClientProfile;
    }
    const rawProfile = await this.verifyClientProfile();
    return this.cachedClientProfile ?? normalizeWalletClientProfile(rawProfile);
  }

  public async verifyClientProfile(): Promise<unknown> {
    const rawProfile = await callGetClientProfile(this);
    const normalizedProfile = normalizeWalletClientProfile(rawProfile);
    this.cachedClientProfile = normalizedProfile;
    this.profileCacheTimestamp = normalizedProfile.fetchedAt;
    return rawProfile;
  }

  public callGetClientProfile(): Promise<RawWalletClientProfileResponse> {
    return callGetClientProfile(this);
  }

  public callGetAccounts(): Promise<RawAccountsResponse> {
    return callGetAccounts(this);
  }

  public callGetCategories(): Promise<RawCategoriesResponse> {
    return callGetCategories(this);
  }

  public callGetLabels(): Promise<RawLabelsResponse> {
    return callGetLabels(this);
  }

  public callCreateLabel(args: CreateLabelToolArgs): Promise<RawCreateLabelResponse> {
    return callCreateLabel(this, args);
  }

  public callGetBudgets(): Promise<RawBudgetsResponse> {
    return callGetBudgets(this);
  }

  public callGetRecords(args: GetRecordsToolArgs): Promise<RawRecordsResponse> {
    return callGetRecords(this, args);
  }

  public callCreateRecords(args: CreateRecordsToolArgs): Promise<RawCreateRecordsResponse> {
    return callCreateRecords(this, args);
  }

  public callGetRecordsAggregation(
    args: WalletRecordAggregationQueryPayload
  ): Promise<RawRecordAggregationResponse> {
    return callGetRecordsAggregation(this, args);
  }

  public fetchAccounts(forceRefresh: boolean = false): Promise<WalletAccountItem[]> {
    return fetchAccounts(this, this.cacheStore, forceRefresh);
  }

  public fetchCategories(forceRefresh: boolean = false): Promise<WalletCategoryItem[]> {
    return fetchCategories(this, this.cacheStore, forceRefresh);
  }

  public fetchLabels(forceRefresh: boolean = false): Promise<WalletLabelItem[]> {
    return fetchLabels(this, this.cacheStore, forceRefresh);
  }

  public createLabel(labelName: string): Promise<WalletLabelItem | null> {
    return createLabel(this, labelName, this.cacheStore);
  }

  public fetchBudgets(includeClosed: boolean = false): Promise<WalletBudgetItem[]> {
    return fetchBudgets(this, includeClosed);
  }

  private normalizeRecordDate(recordDateString?: string): string {
    return normalizeTransactionRecordDate(recordDateString);
  }

  public fetchRecords(queryOptions?: TransactionHistoryQueryOptions): Promise<TransactionHistoryPage> {
    return fetchRecords(this, queryOptions, this.searchScanStore);
  }

  public createRecords(recordsPayload: CreateRecordInputPayload[]): Promise<WalletCreateRecordsResponse> {
    return createRecords(this, recordsPayload);
  }

  public fetchRecordsAggregation(
    queryPayload: WalletRecordAggregationQueryPayload
  ): Promise<WalletRecordAggregationResponse> {
    return fetchRecordsAggregation(this, queryPayload);
  }

  public validateCreateRecordsResponse(
    createRecordsResult: unknown,
    expectedRecordCount: number
  ): WalletCreateRecordsResponse {
    return validateCreateRecordsResponse(createRecordsResult, expectedRecordCount);
  }

  public validateRecordAggregationResponse(
    rawResponse: unknown,
    queryPayload: WalletRecordAggregationQueryPayload
  ): WalletRecordAggregationResponse {
    return validateRecordAggregationResponse(rawResponse, queryPayload);
  }

  private retainResponseMetadata(
    operationName: WalletMcpOperationName,
    response: unknown
  ): WalletMcpResponseMetadata | undefined {
    const metadata = normalizeResponseMetadata(response);
    if (metadata) {
      this.responseMetadataByOperation.set(operationName, metadata);
    } else {
      this.responseMetadataByOperation.delete(operationName);
    }
    return metadata;
  }
}

export const WalletMcpClientService = WalletMcpClient;
export type WalletMcpClientService = WalletMcpClient;
