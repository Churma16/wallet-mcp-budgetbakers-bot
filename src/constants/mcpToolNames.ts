/**
 * Canonical tool names for the upstream Wallet MCP JSON-RPC service.
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
