/**
 * Canonical transaction record types distinguishing internal uppercase representations
 * from upstream Wallet MCP lowercase wire protocol formats.
 */

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
