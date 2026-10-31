import { WALLET_MCP_TOOL_NAMES } from './constants.js';
import type { WalletRecordAggregationQueryPayload } from './types.js';

/**
 * Minimal tool caller interface required by the typed MCP wrappers.
 */
export interface WalletToolCaller {
  callMcpTool<TToolOutput = unknown>(
    toolName: string,
    toolArguments?: Record<string, unknown>
  ): Promise<TToolOutput>;
}

// ---------------------------------------------------------------------------
// 1. get_client_profile types
// ---------------------------------------------------------------------------

export interface RawWalletClientProfileResponse {
  readonly grantedScopes?: readonly string[];
  readonly syncState?: string;
  readonly syncError?: string;
  readonly sync?: {
    readonly state?: string;
    readonly error?: string;
  };
  readonly baseCurrency?: string;
  readonly currency?: string;
  readonly profile?: {
    readonly baseCurrency?: string;
    readonly currency?: string;
  };
  readonly usedCurrencies?: readonly string[];
  readonly currencies?: readonly string[];
  readonly system?: string;
  readonly platform?: string;
  readonly toolCount?: number;
  readonly mcpTools?: readonly string[];
  readonly budgetSettings?: {
    readonly defaultPeriod?: string;
    readonly rolloverEnabled?: boolean;
    readonly alertThresholdRatio?: number;
  };
  readonly agentHints?: readonly unknown[];
  readonly rateLimit?: unknown;
  readonly _meta?: unknown;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// 2. get_accounts types
// ---------------------------------------------------------------------------

export interface RawAccountBalanceObject {
  readonly currentBalance?: number;
  readonly rawCurrentBalance?: number;
  readonly amount?: number;
  readonly value?: number;
  readonly current?: number;
  readonly currencyCode?: string;
  readonly currency?: string;
}

export interface RawAccountItem {
  readonly id?: string;
  readonly accountId?: string;
  readonly name?: string;
  readonly accountName?: string;
  readonly currency?: string;
  readonly currencyCode?: string;
  readonly balance?: number | RawAccountBalanceObject;
  readonly accountType?: string;
  readonly type?: string;
  readonly bankAccountNumber?: string;
  readonly accountNumber?: string;
  readonly number?: string;
  readonly isBankSynced?: boolean;
  readonly bankSync?: boolean;
  readonly syncState?: string;
  readonly bankId?: string;
  readonly connectedBank?: string;
}

export interface RawAccountsEnvelope {
  readonly accounts?: readonly RawAccountItem[];
  readonly items?: readonly RawAccountItem[];
}

export type RawAccountsResponse = readonly RawAccountItem[] | RawAccountsEnvelope;

// ---------------------------------------------------------------------------
// 3. get_categories types
// ---------------------------------------------------------------------------

export interface RawCategoryGroupObject {
  readonly id?: string;
  readonly name?: string;
}

export interface RawCategoryItem {
  readonly id?: string;
  readonly categoryId?: string;
  readonly name?: string;
  readonly categoryName?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly parentId?: string;
  readonly parentCategoryId?: string;
  readonly parentName?: string;
  readonly parentCategoryName?: string;
  readonly categoryGroup?: string;
  readonly group?: string | RawCategoryGroupObject;
  readonly systemId?: string;
  readonly cardinality?: string;
  readonly customCategory?: boolean;
  readonly archived?: boolean;
  readonly enabled?: boolean;
  readonly isAssignable?: boolean;
  readonly assignable?: boolean;
  readonly isTransfer?: boolean;
  readonly transfer?: boolean;
}

export interface RawCategoriesEnvelope {
  readonly categories?: readonly RawCategoryItem[];
  readonly items?: readonly RawCategoryItem[];
}

export type RawCategoriesResponse = readonly RawCategoryItem[] | RawCategoriesEnvelope;

// ---------------------------------------------------------------------------
// 4. get_labels types
// ---------------------------------------------------------------------------

export interface RawLabelItem {
  readonly id?: string;
  readonly labelId?: string;
  readonly name?: string;
  readonly labelName?: string;
  readonly title?: string;
  readonly color?: string;
  readonly icon?: string;
}

export interface RawLabelsEnvelope {
  readonly labels?: readonly RawLabelItem[];
  readonly items?: readonly RawLabelItem[];
}

export type RawLabelsResponse = readonly RawLabelItem[] | RawLabelsEnvelope;

// ---------------------------------------------------------------------------
// 5. create_label types
// ---------------------------------------------------------------------------

export interface CreateLabelToolArgs {
  readonly name: string;
}

export type RawCreateLabelResponse =
  | RawLabelItem
  | {
      readonly label?: RawLabelItem;
    };

// ---------------------------------------------------------------------------
// 6. get_budgets types
// ---------------------------------------------------------------------------

export interface RawBudgetSpendingCurrent {
  readonly spent?: number | string;
  readonly totalExpenses?: number | string;
  readonly effectiveLimit?: number | string;
  readonly remaining?: number | string;
  readonly overspent?: number | string;
  readonly period?: string;
}

export interface RawBudgetItem {
  readonly id?: string;
  readonly budgetId?: string;
  readonly name?: string;
  readonly budgetName?: string;
  readonly spending?: {
    readonly current?: RawBudgetSpendingCurrent;
  };
  readonly spent?: number | string;
  readonly currentSpent?: number | string;
  readonly limit?: number | string;
  readonly amount?: number | string;
  readonly currencyCode?: string;
  readonly currency?: string;
  readonly closed?: boolean;
  readonly isClosed?: boolean;
  readonly period?: string;
  readonly recurrence?: string;
  readonly frequency?: string;
  readonly periodType?: string;
}

export interface RawBudgetsEnvelope {
  readonly budgets?: readonly RawBudgetItem[];
  readonly items?: readonly RawBudgetItem[];
}

export type RawBudgetsResponse = readonly RawBudgetItem[] | RawBudgetsEnvelope;

// ---------------------------------------------------------------------------
// 7. get_records types
// ---------------------------------------------------------------------------

export interface RawRecordTransfer {
  readonly type?: string;
  readonly pairingMode?: string;
  readonly transferId?: string;
  readonly recordId?: string;
  readonly mirrorRecord?: unknown;
}

export interface RawRecordItem {
  readonly id?: string;
  readonly recordId?: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly amount?: number | { readonly value?: number; readonly currencyCode?: string };
  readonly currency?: string;
  readonly currencyCode?: string;
  readonly recordDate?: string;
  readonly recordType?: string;
  readonly type?: string;
  readonly category?: {
    readonly id?: string;
    readonly categoryId?: string;
    readonly name?: string;
    readonly categoryName?: string;
    readonly color?: string;
    readonly group?: string;
  };
  readonly categoryId?: string;
  readonly categoryName?: string;
  readonly labels?: readonly {
    readonly id?: string;
    readonly labelId?: string;
    readonly name?: string;
    readonly title?: string;
    readonly color?: string;
    readonly icon?: string;
  }[];
  readonly labelIds?: readonly string[];
  readonly transfer?: RawRecordTransfer;
  readonly note?: string;
  readonly counterParty?: string;
  readonly payee?: string;
  readonly paymentType?: string;
  readonly recordState?: string;
  readonly source?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface RawRecordsEnvelope {
  readonly records?: readonly RawRecordItem[];
  readonly items?: readonly RawRecordItem[];
  readonly total?: number;
  readonly hasMore?: boolean;
  readonly nextOffset?: number | null;
}

export type RawRecordsResponse = readonly RawRecordItem[] | RawRecordsEnvelope;

export interface GetRecordsToolArgs {
  readonly limit?: number;
  readonly offset?: number;
  readonly sortBy?: readonly string[];
  readonly accountId?: string;
  readonly categoryId?: readonly string[];
  readonly categoryGroup?: string;
  readonly recordType?: string;
  readonly recordDate?: readonly [string, string] | readonly string[];
  readonly counterParty?: string;
  readonly note?: string;
  readonly query?: string;
}

// ---------------------------------------------------------------------------
// 8. create_records types
// ---------------------------------------------------------------------------

export interface SanitizedRecordTransferPayload {
  readonly pairingMode: string;
  readonly accountId?: string;
  readonly recordId?: string;
  readonly counterAmount?: {
    readonly value: number;
    readonly currencyCode: string;
  } | number;
}

export interface SanitizedRecordPayloadItem {
  readonly accountId: string;
  readonly amount: number;
  readonly recordDate: string;
  readonly categoryId?: string;
  readonly note?: string;
  readonly counterParty?: string;
  readonly labelIds?: readonly string[];
  readonly transfer?: SanitizedRecordTransferPayload;
}

export interface CreateRecordsToolArgs {
  readonly records: readonly SanitizedRecordPayloadItem[];
}

export type RawCreateRecordsResponse = unknown;

// ---------------------------------------------------------------------------
// 9. get_records_aggregation types
// ---------------------------------------------------------------------------

export interface RawRecordAggregationResultItem {
  readonly count?: number;
  readonly currency?: string;
  readonly recordType?: 'expense' | 'income' | string;
  readonly 'amount:sum'?: number;
  readonly 'amount:absSum'?: number;
  readonly 'category:id'?: string;
  readonly 'category:name'?: string;
  readonly 'category:parentId'?: string | null;
  readonly 'category:customCategory'?: boolean;
  readonly accountId?: string;
  readonly [key: string]: unknown;
}

export interface RawRecordAggregationResponse {
  readonly results?: readonly RawRecordAggregationResultItem[];
  readonly limit?: number;
  readonly offset?: number;
  readonly isTransfer?: boolean | null;
  readonly baseCurrency?: string;
  readonly agentHints?: readonly unknown[];
  readonly _meta?: unknown;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal Helper & Array Extractor
// ---------------------------------------------------------------------------

function serializeToolArguments<TArgs extends object>(args: TArgs): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Safely extracts a typed item array from either a raw array or an envelope object.
 */
export function extractRawArray<TItem>(
  response: unknown,
  ...keys: string[]
): readonly TItem[] {
  if (Array.isArray(response)) {
    return response as readonly TItem[];
  }
  if (response && typeof response === 'object') {
    const record = response as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (Array.isArray(candidate)) {
        return candidate as readonly TItem[];
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Strongly Typed Wrapper Functions
// ---------------------------------------------------------------------------

/**
 * Dispatches get_client_profile to the Wallet MCP server.
 */
export async function callGetClientProfile(
  client: WalletToolCaller
): Promise<RawWalletClientProfileResponse> {
  return client.callMcpTool<RawWalletClientProfileResponse>(
    WALLET_MCP_TOOL_NAMES.GET_CLIENT_PROFILE
  );
}

/**
 * Dispatches get_accounts to the Wallet MCP server.
 */
export async function callGetAccounts(
  client: WalletToolCaller
): Promise<RawAccountsResponse> {
  return client.callMcpTool<RawAccountsResponse>(
    WALLET_MCP_TOOL_NAMES.GET_ACCOUNTS
  );
}

/**
 * Dispatches get_categories to the Wallet MCP server.
 */
export async function callGetCategories(
  client: WalletToolCaller
): Promise<RawCategoriesResponse> {
  return client.callMcpTool<RawCategoriesResponse>(
    WALLET_MCP_TOOL_NAMES.GET_CATEGORIES
  );
}

/**
 * Dispatches get_labels to the Wallet MCP server.
 */
export async function callGetLabels(
  client: WalletToolCaller
): Promise<RawLabelsResponse> {
  return client.callMcpTool<RawLabelsResponse>(
    WALLET_MCP_TOOL_NAMES.GET_LABELS
  );
}

/**
 * Dispatches create_label to the Wallet MCP server with typed label name payload.
 */
export async function callCreateLabel(
  client: WalletToolCaller,
  args: CreateLabelToolArgs
): Promise<RawCreateLabelResponse> {
  return client.callMcpTool<RawCreateLabelResponse>(
    WALLET_MCP_TOOL_NAMES.CREATE_LABEL,
    serializeToolArguments(args)
  );
}

/**
 * Dispatches get_budgets to the Wallet MCP server.
 */
export async function callGetBudgets(
  client: WalletToolCaller
): Promise<RawBudgetsResponse> {
  return client.callMcpTool<RawBudgetsResponse>(
    WALLET_MCP_TOOL_NAMES.GET_BUDGETS
  );
}

/**
 * Dispatches get_records to the Wallet MCP server with strictly typed query parameters.
 */
export async function callGetRecords(
  client: WalletToolCaller,
  args: GetRecordsToolArgs
): Promise<RawRecordsResponse> {
  return client.callMcpTool<RawRecordsResponse>(
    WALLET_MCP_TOOL_NAMES.GET_RECORDS,
    serializeToolArguments(args)
  );
}

/**
 * Dispatches create_records to the Wallet MCP server with strictly typed records payload.
 */
export async function callCreateRecords(
  client: WalletToolCaller,
  args: CreateRecordsToolArgs
): Promise<RawCreateRecordsResponse> {
  return client.callMcpTool<RawCreateRecordsResponse>(
    WALLET_MCP_TOOL_NAMES.CREATE_RECORDS,
    serializeToolArguments(args)
  );
}

/**
 * Dispatches get_records_aggregation to the Wallet MCP server with strictly typed query options.
 */
export async function callGetRecordsAggregation(
  client: WalletToolCaller,
  args: WalletRecordAggregationQueryPayload
): Promise<RawRecordAggregationResponse> {
  return client.callMcpTool<RawRecordAggregationResponse>(
    WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION,
    serializeToolArguments(args)
  );
}
