import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client';
import {
  WalletAccountItem,
  WalletAgentHint,
  WalletCategoryItem,
  WalletLabelItem,
  CreateRecordInputPayload,
  WalletCreateRecordsResponse,
  WalletBudgetItem,
  TransactionSortOrder,
  TransactionHistoryQueryOptions,
  WalletRecordItem,
  TransactionHistoryPage,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
  WalletRecordAggregationResultItem,
} from '../types/walletTypes.js';
import { applicationLogger, redactSensitiveData } from '../utils/logger.js';
import { matchesTransactionRecordSearch } from '../utils/transactionSearchMatcher.js';
import { normalizeTransactionRecordDate } from '../utils/recordDateNormalizer.js';
import {
  WalletMcpTransport,
  type WalletMcpTransportDependencies,
} from './walletMcpTransport.js';
import {
  type CapabilityTriState,
  type WalletClientProfile,
  type WalletMcpBoundedJsonValue,
  type WalletMcpBoundedJsonObject,
  type WalletMcpFailureClassification,
  type WalletMcpToolInputFieldCapability,
  type WalletMcpToolCapability,
  type WalletMcpRateLimitMetadata,
  type WalletMcpResponseMetadata,
} from '../types/walletCapabilityTypes.js';
import { normalizeWalletClientProfile } from './walletProfileNormalizer.js';

export const DEFAULT_TRANSACTION_HISTORY_LIMIT = 10;
export const MAX_TRANSACTION_HISTORY_LIMIT = 50;
export const MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST = 5;
export const MAX_DISCOVERED_WALLET_MCP_TOOLS = 128;
export const MAX_DISCOVERED_WALLET_MCP_INPUT_FIELDS = 64;
export const MAX_WALLET_MCP_AGENT_HINTS = 20;

export const WALLET_MCP_ALLOWED_TOOL_NAMES = [
  'get_client_profile',
  'get_accounts',
  'get_categories',
  'get_labels',
  'create_label',
  'get_budgets',
  'get_records',
  'create_records',
  'get_records_aggregation',
] as const;

export type WalletMcpToolName = typeof WALLET_MCP_ALLOWED_TOOL_NAMES[number];
export type WalletMcpOperationName = WalletMcpToolName | 'tools/list';

export type {
  CapabilityTriState,
  WalletClientProfile,
  WalletMcpBoundedJsonValue,
  WalletMcpBoundedJsonObject,
  WalletMcpFailureClassification,
  WalletMcpToolInputFieldCapability,
  WalletMcpToolCapability,
  WalletMcpRateLimitMetadata,
  WalletMcpResponseMetadata,
};

interface TransactionSearchScanCacheEntry {
  matchedRecords: WalletRecordItem[];
  seenMatchedRecordIds: Set<string>;
  nextOffset: number | null;
  exhausted: boolean;
  updatedAt: number;
}

export type WalletMcpDispatchOutcome = 'DEFINITIVE_FAILURE' | 'UNKNOWN';

export class WalletMcpRequestError extends Error {
  public readonly classification: WalletMcpFailureClassification;

  constructor(
    message: string,
    public readonly dispatchOutcome: WalletMcpDispatchOutcome,
    classification?: WalletMcpFailureClassification
  ) {
    super(message);
    this.name = 'WalletMcpRequestError';
    if (classification !== undefined) {
      this.classification = classification;
    } else {
      const lowerMessage = message.toLowerCase();
      if (
        lowerMessage.includes('permission') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('scope') ||
        lowerMessage.includes('401') ||
        lowerMessage.includes('403')
      ) {
        this.classification = 'AUTHORIZATION';
      } else if (
        lowerMessage.includes('method not found') ||
        lowerMessage.includes('tool not found') ||
        lowerMessage.includes('unknown tool') ||
        lowerMessage.includes('not supported') ||
        lowerMessage.includes('not implemented') ||
        lowerMessage.includes('-32601') ||
        lowerMessage.includes('405')
      ) {
        this.classification = 'TOOL_UNAVAILABLE';
      } else if (
        dispatchOutcome === 'UNKNOWN' ||
        lowerMessage.includes('timeout') ||
        lowerMessage.includes('network') ||
        lowerMessage.includes('econnrefused')
      ) {
        this.classification = 'TRANSIENT';
      } else {
        this.classification = 'REQUEST_INVALID';
      }
    }
  }
}

export function isWalletMcpDispatchOutcomeUnknown(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'UNKNOWN';
}

export function isWalletMcpDefinitiveFailure(error: unknown): boolean {
  return error instanceof WalletMcpRequestError && error.dispatchOutcome === 'DEFINITIVE_FAILURE';
}

/**
 * Determines whether a failure indicates that the tool or capability itself is unavailable,
 * unsupported, not found, or unauthorized (as opposed to a request-specific argument or schema validation failure).
 * Capability state is determined strictly from structured failure classification, not error message wording.
 */
export function isWalletMcpCapabilityRejection(error: unknown): boolean {
  if (error instanceof WalletMcpRequestError) {
    return error.classification === 'AUTHORIZATION' || error.classification === 'TOOL_UNAVAILABLE';
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncateText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue.slice(0, maximumLength) : undefined;
}

function normalizeFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeAgentHintData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const boundedEntries = Object.entries(value)
    .slice(0, 16)
    .filter((entry): entry is [string, string | number | boolean | null] => {
      const entryValue = entry[1];
      return entryValue === null || ['string', 'number', 'boolean'].includes(typeof entryValue);
    })
    .map(([key, entryValue]) => [key.slice(0, 80), entryValue]);

  return boundedEntries.length > 0 ? Object.fromEntries(boundedEntries) : undefined;
}

function normalizeAgentHints(value: unknown): WalletAgentHint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalizedHints = value
    .slice(0, MAX_WALLET_MCP_AGENT_HINTS)
    .reduce<WalletAgentHint[]>((result, hint) => {
      if (!isRecord(hint)) {
        return result;
      }
      const type = truncateText(hint.type, 160);
      if (!type) {
        return result;
      }
      result.push({
        type,
        severity: truncateText(hint.severity, 40),
        text: truncateText(hint.text, 500),
        data: normalizeAgentHintData(hint.data),
      });
      return result;
    }, []);

  return normalizedHints.length > 0 ? normalizedHints : undefined;
}

function normalizeRateLimitMetadata(value: unknown): WalletMcpRateLimitMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rateLimit = {
    limit: normalizeFiniteNonNegativeNumber(value.limit),
    remaining: normalizeFiniteNonNegativeNumber(value.remaining),
    resetAt: truncateText(value.resetAt ?? value.reset, 100),
    retryAfterMilliseconds: normalizeFiniteNonNegativeNumber(
      value.retryAfterMilliseconds ?? value.retryAfterMs
    ),
  } satisfies WalletMcpRateLimitMetadata;

  return Object.values(rateLimit).some(item => item !== undefined) ? rateLimit : undefined;
}

function normalizeResponseMetadata(response: unknown): WalletMcpResponseMetadata | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const resultRecord = response;
  const metadataRecord = isRecord(resultRecord._meta) ? resultRecord._meta : undefined;
  const structuredRecord = isRecord(resultRecord.structuredContent)
    ? resultRecord.structuredContent
    : undefined;
  const rateLimit = normalizeRateLimitMetadata(metadataRecord?.rateLimit);
  const agentHints = normalizeAgentHints(
    metadataRecord?.agentHints ?? structuredRecord?.agentHints ?? resultRecord.agentHints
  );

  return rateLimit || agentHints ? { rateLimit, agentHints } : undefined;
}

function normalizeBoundedJsonValue(
  value: unknown,
  remainingNodeBudget: { value: number },
  depth: number = 0
): WalletMcpBoundedJsonValue | undefined {
  if (remainingNodeBudget.value <= 0 || depth > 6) {
    return undefined;
  }
  remainingNodeBudget.value--;

  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, 1_000);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map(item => normalizeBoundedJsonValue(item, remainingNodeBudget, depth + 1))
      .filter((item): item is WalletMcpBoundedJsonValue => item !== undefined);
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const normalizedObject: Record<string, WalletMcpBoundedJsonValue> = {};
  for (const [key, item] of Object.entries(value).slice(0, 64)) {
    const normalizedItem = normalizeBoundedJsonValue(item, remainingNodeBudget, depth + 1);
    if (normalizedItem !== undefined) {
      normalizedObject[key.slice(0, 160)] = normalizedItem;
    }
  }
  return normalizedObject;
}

function normalizeBoundedJsonObject(value: unknown): WalletMcpBoundedJsonObject | undefined {
  const normalizedValue = normalizeBoundedJsonValue(value, { value: 512 });
  return isRecord(normalizedValue)
    ? normalizedValue as WalletMcpBoundedJsonObject
    : undefined;
}

function normalizeToolCapability(tool: Tool): WalletMcpToolCapability {
  const inputSchemaValue: unknown = tool.inputSchema;
  const inputSchema: Record<string, unknown> = isRecord(inputSchemaValue) ? inputSchemaValue : {};
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const requiredNames = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name): name is string => typeof name === 'string')
      : []
  );

  const inputFields = Object.entries(properties)
    .slice(0, MAX_DISCOVERED_WALLET_MCP_INPUT_FIELDS)
    .map(([name, schema]): WalletMcpToolInputFieldCapability => {
      const schemaRecord = isRecord(schema) ? schema : {};
      const rawType = schemaRecord.type;
      const types = (Array.isArray(rawType) ? rawType : [rawType])
        .filter((type): type is string => typeof type === 'string')
        .slice(0, 8);
      const enumValues = Array.isArray(schemaRecord.enum)
        ? schemaRecord.enum
            .filter((entry): entry is string | number | boolean | null => (
              entry === null || ['string', 'number', 'boolean'].includes(typeof entry)
            ))
            .slice(0, 32)
        : undefined;

      return {
        name: name.slice(0, 160),
        required: requiredNames.has(name),
        types,
        description: truncateText(schemaRecord.description, 500),
        enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
      };
    });

  return {
    name: tool.name.slice(0, 160),
    description: truncateText(tool.description, 1_000),
    inputSchema: normalizeBoundedJsonObject(tool.inputSchema),
    outputSchema: normalizeBoundedJsonObject(tool.outputSchema),
    inputFields,
    isApplicationSupported: (WALLET_MCP_ALLOWED_TOOL_NAMES as readonly string[]).includes(tool.name),
    hasOutputSchema: tool.outputSchema !== undefined,
  };
}

function sanitizeMcpErrorMessage(error: unknown, accessToken: string): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  let sanitizedMessage = redactSensitiveData(rawMessage);
  if (accessToken) {
    sanitizedMessage = sanitizedMessage.split(accessToken).join('[REDACTED]');
  }
  return sanitizedMessage.slice(0, 500);
}

export class WalletMcpClientService {
  private readonly mcpTransport: WalletMcpTransport;
  private readonly responseMetadataByOperation = new Map<WalletMcpOperationName, WalletMcpResponseMetadata>();
  private cachedAccountList: WalletAccountItem[] = [];
  private cachedCategoryList: WalletCategoryItem[] = [];
  private cachedLabelList: WalletLabelItem[] = [];
  private cacheLastUpdatedTimestamp: number = 0;
  private readonly cacheDurationMilliseconds: number = 1000 * 60 * 30; // 30 minutes
  private cachedClientProfile?: WalletClientProfile;
  private profileCacheTimestamp: number = 0;
  private readonly profileCacheDurationMilliseconds: number = 1000 * 60 * 5; // 5 minutes
  private readonly transactionSearchScanCache = new Map<string, TransactionSearchScanCacheEntry>();
  private readonly transactionSearchScanCacheTtlMilliseconds = 1000 * 60 * 2; // 2 minutes
  private readonly maxTransactionSearchScanCacheEntries = 20;

  constructor(
    baseUrl: string,
    private readonly accessToken: string = '',
    transportDependencies: WalletMcpTransportDependencies = {}
  ) {
    this.mcpTransport = new WalletMcpTransport(baseUrl, accessToken, transportDependencies);
  }

  /**
   * Lists server-advertised tools through a bounded read-only representation. Advertisement
   * never grants execution authority; callMcpTool separately enforces the application allowlist.
   */
  public async listTools(): Promise<WalletMcpToolCapability[]> {
    try {
      const result = await this.mcpTransport.listTools();
      this.retainResponseMetadata('tools/list', result);
      return result.tools
        .slice(0, MAX_DISCOVERED_WALLET_MCP_TOOLS)
        .map(normalizeToolCapability);
    } catch (error) {
      throw this.classifyMcpFailure(error, 'tools/list');
    }
  }

  /**
   * Returns the last bounded metadata observed for a known typed adapter call.
   */
  public getLastResponseMetadata(operationName: WalletMcpOperationName): WalletMcpResponseMetadata | undefined {
    const metadata = this.responseMetadataByOperation.get(operationName);
    return metadata ? structuredClone(metadata) : undefined;
  }

  public async close(): Promise<void> {
    await this.mcpTransport.close();
  }

  /**
   * Executes only application-owned Wallet tools and unpacks their typed payload.
   */
  public async callMcpTool<TToolOutput>(
    toolName: WalletMcpToolName,
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
      throw this.classifyMcpFailure(error, toolName);
    }

    const responseMetadata = this.retainResponseMetadata(toolName, toolCallResult);

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
      const classification: WalletMcpFailureClassification = isPermissionError
        ? 'AUTHORIZATION'
        : 'REQUEST_INVALID';

      throw new WalletMcpRequestError(
        `[error] MCP Tool '${toolName}' failed: ${sanitized}`,
        'DEFINITIVE_FAILURE',
        classification
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

  private classifyMcpFailure(error: unknown, operationName: string): WalletMcpRequestError {
    if (error instanceof WalletMcpRequestError) {
      return error;
    }

    const sanitizedMessage = sanitizeMcpErrorMessage(error, this.accessToken);
    let dispatchOutcome: WalletMcpDispatchOutcome = 'UNKNOWN';
    let classification: WalletMcpFailureClassification = 'UNKNOWN';
    let failureKind = 'transport failure';

    if (ProtocolError.isInstance(error)) {
      dispatchOutcome = 'DEFINITIVE_FAILURE';
      failureKind = 'protocol rejection';
      if (error.code === -32601) {
        classification = 'TOOL_UNAVAILABLE';
      } else if (error.code === -32602) {
        classification = 'REQUEST_INVALID';
      } else {
        const lowerMessage = (error.message || '').toLowerCase();
        if (
          lowerMessage.includes('permission') ||
          lowerMessage.includes('unauthorized') ||
          lowerMessage.includes('forbidden') ||
          lowerMessage.includes('scope')
        ) {
          classification = 'AUTHORIZATION';
        } else if (
          lowerMessage.includes('not found') ||
          lowerMessage.includes('not supported') ||
          lowerMessage.includes('not implemented') ||
          lowerMessage.includes('unavailable')
        ) {
          classification = 'TOOL_UNAVAILABLE';
        } else {
          classification = 'REQUEST_INVALID';
        }
      }
    } else if (SdkHttpError.isInstance(error)) {
      failureKind = `HTTP ${error.status}`;
      if (error.status === 400) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'REQUEST_INVALID';
      } else if (error.status === 401 || error.status === 403) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'AUTHORIZATION';
      } else if (error.status === 404) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'UNKNOWN';
      } else if (error.status === 405) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'TOOL_UNAVAILABLE';
      } else if (error.status === 408) {
        dispatchOutcome = 'UNKNOWN';
        classification = 'TRANSIENT';
      } else if (error.status === 429) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'TRANSIENT';
      } else if (error.status >= 500) {
        dispatchOutcome = 'UNKNOWN';
        classification = 'TRANSIENT';
      } else {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'UNKNOWN';
      }
    } else if (SdkError.isInstance(error)) {
      failureKind = `SDK ${error.code}`;
      if (
        error.code === SdkErrorCode.CapabilityNotSupported ||
        error.code === SdkErrorCode.MethodNotSupportedByProtocolVersion
      ) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'TOOL_UNAVAILABLE';
      } else if (error.code === SdkErrorCode.NotInitialized) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'UNKNOWN';
      } else if (
        error.code === SdkErrorCode.ConnectionClosed ||
        error.code === SdkErrorCode.RequestTimeout ||
        error.code === SdkErrorCode.SendFailed
      ) {
        dispatchOutcome = 'UNKNOWN';
        classification = 'TRANSIENT';
      } else {
        dispatchOutcome = 'UNKNOWN';
        classification = 'UNKNOWN';
      }
    } else if (error instanceof Error) {
      const lowerMessage = error.message.toLowerCase();
      if (
        lowerMessage.includes('econnrefused') ||
        lowerMessage.includes('etimedout') ||
        lowerMessage.includes('fetch failed') ||
        lowerMessage.includes('network') ||
        lowerMessage.includes('timeout')
      ) {
        dispatchOutcome = 'UNKNOWN';
        classification = 'TRANSIENT';
      } else if (
        lowerMessage.includes('permission') ||
        lowerMessage.includes('unauthorized') ||
        lowerMessage.includes('forbidden') ||
        lowerMessage.includes('scope')
      ) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'AUTHORIZATION';
      } else if (
        lowerMessage.includes('method not found') ||
        lowerMessage.includes('tool not found') ||
        lowerMessage.includes('unknown tool') ||
        lowerMessage.includes('not supported')
      ) {
        dispatchOutcome = 'DEFINITIVE_FAILURE';
        classification = 'TOOL_UNAVAILABLE';
      }
    }

    applicationLogger.fileDetail('error', `Wallet MCP Failure [${operationName}]`, {
      operation: operationName,
      failureKind,
      message: sanitizedMessage,
      dispatchOutcome,
      classification,
    });

    return new WalletMcpRequestError(
      `[error] Wallet MCP ${failureKind}: ${sanitizedMessage}`,
      dispatchOutcome,
      classification
    );
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

  /**
   * Retrieves and normalizes the client profile from Wallet MCP.
   * Caches the normalized profile for a bounded duration unless forceRefresh is true.
   */
  public async getClientProfile(forceRefresh: boolean = false): Promise<WalletClientProfile> {
    const isCacheExpired = Date.now() - this.profileCacheTimestamp > this.profileCacheDurationMilliseconds;

    if (!forceRefresh && this.cachedClientProfile !== undefined && !isCacheExpired) {
      return this.cachedClientProfile;
    }

    const rawProfile = await this.verifyClientProfile();
    return this.cachedClientProfile ?? normalizeWalletClientProfile(rawProfile);
  }

  /**
   * Verify client profile and connection to Wallet MCP.
   * Dispatches get_client_profile and returns the raw tool result directly for backward compatibility.
   */
  public async verifyClientProfile(): Promise<unknown> {
    const rawProfile = await this.callMcpTool<unknown>('get_client_profile');
    const normalizedProfile = normalizeWalletClientProfile(rawProfile);
    this.cachedClientProfile = normalizedProfile;
    this.profileCacheTimestamp = normalizedProfile.fetchedAt;
    return rawProfile;
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
        ? {
            id: String(item.group.id || item.group.name || '').trim(),
            name: String(item.group.name || item.group.id || '').trim(),
          }
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
   * Prefers native upstream Wallet MCP get_records(query=...) for text search,
   * while maintaining a bounded compatibility fallback shim for legacy testing.
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
        rawCounterParty.startsWith('contains-i.') ||
        rawCounterParty.startsWith('eq.') ||
        rawCounterParty.startsWith('contains.')
          ? rawCounterParty
          : `contains-i.${rawCounterParty}`;
    }

    if (queryOptions?.note) {
      const rawNote = String(queryOptions.note).trim();
      mcpCallPayload.note =
        rawNote.startsWith('contains-i.') ||
        rawNote.startsWith('eq.') ||
        rawNote.startsWith('contains.')
          ? rawNote
          : `contains-i.${rawNote}`;
    }

    if (queryOptions?.searchQuery && queryOptions?.searchScanFallback === false) {
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
          counterParty: payload.counterParty,
          note: payload.note,
          query: payload.query,
        },
      });

      return await this.callMcpTool<any>('get_records', payload);
    };

    // Upstream Wallet MCP get_records has no cross-field `query` parameter (verified via live
    // server characterization outside CI; sending `query` causes protocol validation failure).
    // Per Issue #162 Decision Rule, the application executes the bounded local scan-and-match
    // compatibility shim by default for multi-field `searchQuery`, unless `searchScanFallback === false`
    // is explicitly set to test a forward-compatible upstream server.
    if (queryOptions?.searchQuery && queryOptions?.searchScanFallback !== false) {
      return await this.executeSearchScanCompatibilityShim(
        queryOptions as TransactionHistoryQueryOptions & { searchQuery: string },
        mcpCallPayload,
        resolvedLimit,
        resolvedOffset,
        resolvedSort,
        upstreamSortBy,
        normalizeRawRecords,
        callGetRecords
      );
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
    } else if (rawRecordArray.length === resolvedLimit) {
      hasMore = true;
      nextOffset = resolvedOffset + rawRecordArray.length;
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
   * Bounded local scan-and-match compatibility shim for multi-field searchQuery.
   * Based on live Wallet MCP capability audit (Issue #162), upstream lacks a cross-field
   * text search parameter across counterParty and note. This shim provides bounded,
   * paginated local matching over upstream-filtered candidate pages.
   */
  private async executeSearchScanCompatibilityShim(
    queryOptions: TransactionHistoryQueryOptions & { searchQuery: string },
    mcpCallPayload: Record<string, unknown>,
    resolvedLimit: number,
    resolvedOffset: number,
    resolvedSort: TransactionSortOrder,
    upstreamSortBy: string[],
    normalizeRawRecords: (rawRecordArray: any[]) => WalletRecordItem[],
    callGetRecords: (payload: Record<string, unknown>) => Promise<any>
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

  /**
   * Retrieves aggregated transaction metrics natively from Wallet MCP
   * using get_records_aggregation without scanning individual records.
   */
  public async fetchRecordsAggregation(
    queryPayload: WalletRecordAggregationQueryPayload
  ): Promise<WalletRecordAggregationResponse> {
    applicationLogger.fileDetail('mcp', 'Dispatching fetchRecordsAggregation to Wallet MCP', {
      groupBy: queryPayload.groupBy,
      compute: queryPayload.compute,
      isTransfer: queryPayload.isTransfer,
      filters: {
        accountId: queryPayload.accountId,
        categoryId: queryPayload.categoryId,
        categoryGroup: queryPayload.categoryGroup,
        recordType: queryPayload.recordType,
        recordDate: queryPayload.recordDate,
      },
    });

    const rawResponse = await this.callMcpTool<unknown>(
      'get_records_aggregation',
      queryPayload as Record<string, unknown>
    );

    return this.validateRecordAggregationResponse(rawResponse, queryPayload);
  }

  /**
   * Validates and parses raw MCP aggregation responses before treating them as authoritative.
   * Enforces fail-closed validation on missing results, malformed rows, invalid counts,
   * missing record types, missing currencies, and non-numeric computed fields.
   */
  public validateRecordAggregationResponse(
    rawResponse: unknown,
    queryPayload: WalletRecordAggregationQueryPayload
  ): WalletRecordAggregationResponse {
    if (!isRecord(rawResponse)) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' returned an unverifiable non-object response`,
        'UNKNOWN'
      );
    }

    const rawResults = rawResponse.results;
    if (!Array.isArray(rawResults)) {
      throw new WalletMcpRequestError(
        `[error] MCP Tool 'get_records_aggregation' response is missing a valid results array`,
        'UNKNOWN'
      );
    }

    const expectCurrency = queryPayload.groupBy?.includes('currency') ?? false;
    const expectRecordType = queryPayload.groupBy?.includes('recordType') ?? false;
    const expectAmountSum = queryPayload.compute?.includes('amount:sum') ?? false;

    const validatedResults: WalletRecordAggregationResultItem[] = [];

    for (let rowIndex = 0; rowIndex < rawResults.length; rowIndex += 1) {
      const row = rawResults[rowIndex];
      if (!isRecord(row)) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'get_records_aggregation' returned malformed row at index ${rowIndex}`,
          'UNKNOWN'
        );
      }

      const rawCount = row.count;
      if (typeof rawCount !== 'number' || !Number.isFinite(rawCount) || rawCount < 0) {
        throw new WalletMcpRequestError(
          `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} has invalid count: ${String(rawCount)}`,
          'UNKNOWN'
        );
      }

      // Authoritative empty result signal: [{ count: 0 }] without groupings
      if (rawCount === 0 && rawResults.length === 1 && !row.currency && !row.recordType) {
        validatedResults.push({ count: 0 });
        break;
      }

      if (expectCurrency) {
        if (typeof row.currency !== 'string' || row.currency.trim().length === 0) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} is missing required currency`,
            'UNKNOWN'
          );
        }
      }

      if (expectRecordType) {
        if (row.recordType !== 'expense' && row.recordType !== 'income') {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} is missing or has invalid recordType: ${String(row.recordType)}`,
            'UNKNOWN'
          );
        }
      }

      if (expectAmountSum) {
        const amountSum = row['amount:sum'];
        if (typeof amountSum !== 'number' || !Number.isFinite(amountSum)) {
          throw new WalletMcpRequestError(
            `[error] MCP Tool 'get_records_aggregation' row at index ${rowIndex} has non-numeric 'amount:sum': ${String(amountSum)}`,
            'UNKNOWN'
          );
        }
      }

      validatedResults.push(row as WalletRecordAggregationResultItem);
    }

    const validatedResponse: WalletRecordAggregationResponse = {
      results: validatedResults,
      limit: typeof rawResponse.limit === 'number' && Number.isFinite(rawResponse.limit)
        ? rawResponse.limit
        : 1000,
      offset: typeof rawResponse.offset === 'number' && Number.isFinite(rawResponse.offset)
        ? rawResponse.offset
        : 0,
    };

    if (typeof rawResponse.isTransfer === 'boolean' || rawResponse.isTransfer === null) {
      validatedResponse.isTransfer = rawResponse.isTransfer;
    }
    if (typeof rawResponse.baseCurrency === 'string') {
      validatedResponse.baseCurrency = rawResponse.baseCurrency;
    }
    if (Array.isArray(rawResponse.agentHints)) {
      validatedResponse.agentHints = rawResponse.agentHints as WalletRecordAggregationResponse['agentHints'];
    }
    if (isRecord(rawResponse._meta)) {
      validatedResponse._meta = rawResponse._meta as WalletRecordAggregationResponse['_meta'];
    }

    return validatedResponse;
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

    return {
      ...typedResult,
      agentHints: normalizeAgentHints(typedResult.agentHints),
    };
  }
}
