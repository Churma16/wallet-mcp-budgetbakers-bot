import type { PendingTransactionItem } from '../services/pendingTransactionService.js';
import type { WalletRecordItem } from './walletTypes.js';
import {
  CorrelationConfidence,
  CorrelationSuggestedAction,
  type InternalTransactionTypeValue,
} from '../constants/index.js';

export type { CorrelationConfidence, CorrelationSuggestedAction };

export type TransactionEvidenceSource =
  | 'EMAIL_BANK'
  | 'EMAIL_PAYMENT'
  | 'RECEIPT'
  | 'USER'
  | 'WALLET_RECORD'
  | 'OTHER';









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
  transactionType?: InternalTransactionTypeValue;
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
