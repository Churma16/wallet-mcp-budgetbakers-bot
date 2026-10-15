import type { PendingTransactionItem } from '../services/pendingTransactionService.js';
import type { WalletRecordItem } from './walletTypes.js';

export type TransactionEvidenceSource =
  | 'EMAIL_BANK'
  | 'EMAIL_PAYMENT'
  | 'RECEIPT'
  | 'USER'
  | 'WALLET_RECORD'
  | 'OTHER';

export type CorrelationConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type CorrelationSuggestedAction =
  | 'MERGE_PENDING'
  | 'ATTACH_WALLET_RECORD'
  | 'CLARIFY'
  | 'CREATE_INDEPENDENT';

export interface TransactionEvidence {
  sourceType: TransactionEvidenceSource;
  sourceId?: string;
  walletRecordId?: string;
  walletRecordSource?: string;
  amount: number; // Signed: negative for expense, positive for income
  currency: string;
  occurredAt: string; // ISO 8601 string
  merchant?: string; // counterParty
  accountHint?: string;
  accountId?: string;
  destinationAccountHint?: string;
  destinationAccountId?: string;
  referenceNumbers?: string[];
  note?: string;
  categoryId?: string;
  categoryName?: string;
  transactionType?: 'EXPENSE' | 'INCOME' | 'TRANSFER';
  isBankSyncedAccount?: boolean;
  rawPayload?: Record<string, unknown>;
}

export type CorrelationMatchTarget =
  | { type: 'PENDING_TRANSACTION'; pendingItem: PendingTransactionItem }
  | { type: 'WALLET_RECORD'; record: WalletRecordItem }
  | { type: 'NONE' };

export interface CorrelationResult {
  confidence: CorrelationConfidence;
  matchTarget: CorrelationMatchTarget;
  reasons: string[];
  suggestedAction: CorrelationSuggestedAction;
  fusedPendingItem?: Partial<PendingTransactionItem>;
  clarificationPrompt?: string;
}
