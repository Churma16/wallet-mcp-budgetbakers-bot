import type { PendingTransactionItem } from '../services/pendingTransactionService.js';
import type { WalletRecordItem } from '../wallet/types.js';
import type {
  CorrelationConfidence,
  CorrelationSuggestedAction,
  InternalTransactionTypeValue,
} from '../constants/index.js';
import type { CommercePlatformRegistry } from '../config/commercePlatforms.js';

export type { CorrelationConfidence, CorrelationSuggestedAction };

export type BankEmailRuleCategory =
  | 'BANK'
  | 'E_WALLET'
  | 'MERCHANT_RECEIPT'
  | 'PAYMENT_GATEWAY';

export interface BankEmailRuleDefinition {
  bankKey: string;
  displayName: string;
  accountNameHint: string;
  senderDomains: string[];
  subjectKeywords: string[];
  blacklistKeywords: string[];
  bodyRequiredPatterns: RegExp[];
  amountPriorityPatterns: RegExp[];
  referencePatterns: RegExp[];
  transferOrTopupKeywords: string[];
  ruleCategory?: BankEmailRuleCategory;
  defaultCategoryName?: string;
}

export interface GateEvaluationResult {
  passed: boolean;
  matchedBankRule?: BankEmailRuleDefinition;
  candidateAmount?: number;
  referenceNumber?: string;
  isTransferCandidate?: boolean;
  originalDate?: Date;
  reason?: string;
}

export interface EmailTransactionDetectedEvent {
  gateResult: GateEvaluationResult;
  emailSubject: string;
  emailSender: string;
  emailDate: Date;
  cleanedBodyText: string;
  rawMessageId: string;
}

export type EmailTransactionCallback = (
  event: EmailTransactionDetectedEvent
) => Promise<void>;

export interface DeadLetterQueueItem {
  messageId: string;
  subject: string;
  sender: string;
  date: string;
  attempts: number;
  lastError: string;
  failedAt: string;
}

export type DeadLetterCallback = (
  deadLetterItem: DeadLetterQueueItem
) => Promise<void> | void;

export interface PersistentTransactionCacheStructure {
  processedMessageIds: string[];
  processedReferenceNumbers: string[];
  deadLetterQueue?: DeadLetterQueueItem[];
}

export type TransactionEvidenceSource =
  | 'EMAIL_BANK'
  | 'EMAIL_PAYMENT'
  | 'RECEIPT'
  | 'USER'
  | 'WALLET_RECORD'
  | 'PUSH_NOTIFICATION'
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

export interface BankSourceCandidate {
  evidenceSources?: string[];
  bankDisplayName?: string | null;
  accountNameHint?: string | null;
}

export interface PaymentSourceCandidate {
  evidenceSources?: string[];
  bankDisplayName?: string | null;
  counterParty?: string | null;
}

export interface ResolvedAccountDetails {
  matchedAccountId?: string;
  accountNameHint?: string;
  bankDisplayName?: string;
}

export interface ResolvedCategoryDetails {
  matchedCategoryId?: string;
  matchedCategoryName?: string;
}

export interface ComplementaryEvaluationOptions {
  platformRegistry: CommercePlatformRegistry;
  tightWindowMilliseconds: number;
}

export interface ComplementaryEvaluationResult {
  isHighConfidence: boolean;
  reasons: string[];
}

export interface TransactionCorrelationOptions {
  /**
   * Maximum time difference in milliseconds to consider two sources as matching.
   * Default: 120 minutes (7,200,000 ms) to support ride-hailing/delivery completion latency.
   */
  maxCorrelationWindowMilliseconds?: number;
  /**
   * Tight time window in milliseconds for complementary QRIS / merchant matching.
   * Default: 15 minutes (900,000 ms).
   */
  tightWindowMilliseconds?: number;
  /**
   * Optional platform registry instance (defaults to singleton).
   */
  platformRegistry?: CommercePlatformRegistry;
}
