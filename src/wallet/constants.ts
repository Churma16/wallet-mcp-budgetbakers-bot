/**
 * Canonical constants for BudgetBakers Wallet MCP integration, records, and queries.
 */

export const WALLET_MCP_TOOL_NAMES = {
  GET_CLIENT_PROFILE: 'get_client_profile',
  GET_ACCOUNTS: 'get_accounts',
  GET_CATEGORIES: 'get_categories',
  GET_LABELS: 'get_labels',
  CREATE_LABEL: 'create_label',
  GET_BUDGETS: 'get_budgets',
  GET_RECORDS: 'get_records',
  CREATE_RECORDS: 'create_records',
  GET_RECORDS_AGGREGATION: 'get_records_aggregation',
  DELETE_RECORDS: 'delete_records',
} as const;

export type WalletMcpToolName =
  (typeof WALLET_MCP_TOOL_NAMES)[keyof typeof WALLET_MCP_TOOL_NAMES];

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

export const INTERNAL_TRANSACTION_TYPES = {
  EXPENSE: 'EXPENSE',
  INCOME: 'INCOME',
  TRANSFER: 'TRANSFER',
} as const;

export type InternalTransactionTypeValue =
  (typeof INTERNAL_TRANSACTION_TYPES)[keyof typeof INTERNAL_TRANSACTION_TYPES];

export const WALLET_MCP_RECORD_TYPES = {
  EXPENSE: 'expense',
  INCOME: 'income',
  TRANSFER: 'transfer',
} as const;

export type WalletMcpRecordTypeValue =
  (typeof WALLET_MCP_RECORD_TYPES)[keyof typeof WALLET_MCP_RECORD_TYPES];

export const FILTER_ERROR_REASONS = {
  NOT_FOUND: 'NOT_FOUND',
  INVALID_FORMAT: 'INVALID_FORMAT',
  INVALID_RANGE: 'INVALID_RANGE',
  UNSUPPORTED: 'UNSUPPORTED',
  UNRESOLVED: 'UNRESOLVED',
  AMBIGUOUS: 'AMBIGUOUS',
} as const;

export type FilterErrorReasonValue =
  (typeof FILTER_ERROR_REASONS)[keyof typeof FILTER_ERROR_REASONS];

export const DEFAULT_TRANSACTION_HISTORY_LIMIT = 10;
export const MAX_TRANSACTION_HISTORY_LIMIT = 50;
export const MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST = 5;
export const MAX_DISCOVERED_WALLET_MCP_TOOLS = 128;
export const MAX_DISCOVERED_WALLET_MCP_INPUT_FIELDS = 64;
export const MAX_WALLET_MCP_AGENT_HINTS = 20;

export const WALLET_MCP_REQUEST_TIMEOUT_MILLISECONDS = 15_000;
export const WALLET_MCP_LIST_MAX_PAGES = 8;

export const DEFAULT_WALLET_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_SEARCH_SCAN_CACHE_TTL_MS = 1000 * 60 * 2; // 2 minutes
export const DEFAULT_MAX_SEARCH_SCAN_CACHE_ENTRIES = 20;
