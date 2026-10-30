import {
  CreateRecordInputPayload,
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
  WalletAccountItem,
  WalletCategoryItem,
  InternalTransactionTypeValue,
} from '../wallet/index.js';
import { GateEvaluationResult } from '../utils/emailGateEvaluator.js';
import { FinancialActionTypeValue, FINANCIAL_ACTION_TYPES } from './constants.js';

export interface TokenUsageStatistics {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  cachedContentTokens?: number;
  thoughtsTokens?: number;
}

export interface ExtractedFinancialRecordItem {
  accountId?: string;
  accountHint?: string;
  categoryId?: string;
  categoryHint?: string;
  amount: number;
  recordDate?: string;
  note: string;
  counterParty?: string;
  labels?: string[];
  currency?: string;
  transfer?: {
    pairingMode: 'new';
    accountHint?: string;
    accountId?: string;
    counterAmount?: {
      value: number;
      currencyCode: string;
    };
  };
}

export interface ExtractedFinancialIntent {
  action: FinancialActionTypeValue | 'GENERAL_REPLY' | 'RECORD_EXPENSE' | 'RECORD_INCOME' | 'RECORD_TRANSFER';
  records?: ExtractedFinancialRecordItem[];
  queryOptions?: TransactionHistoryQueryOptions;
  explanation?: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface ExtractedEmailTransactionData {
  isTransaction: boolean;
  transactionType: InternalTransactionTypeValue;
  amount: number;
  counterParty: string;
  accountNameHint: string;
  matchedAccountId?: string;
  destinationAccountNameHint?: string;
  matchedDestinationAccountId?: string;
  matchedCategoryId?: string;
  matchedCategoryName?: string;
  note: string;
  recordDate: string;
  referenceNumber?: string;
  explanation: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface AccountClarificationQuestionContext {
  ticketId: number;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  accountHint?: string;
  candidateAccounts?: UnifiedClarificationCandidate[];
  formattedAmount: string;
  categoryName: string;
  description: string;
  invalidSelection?: string;
  languageCode: string;
}

export interface CategoryClarificationQuestionContext {
  ticketId: number;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  categoryHint?: string;
  candidateCategories?: UnifiedClarificationCandidate[];
  formattedAmount: string;
  invalidSelection?: string;
  languageCode: string;
}

export interface AccountClarificationProposal {
  selectedCandidateIndex: number | null;
  reasoning: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface UnifiedClarificationCandidate {
  id: string;
  name: string;
  currency?: string;
  bankAccountNumber?: string;
  isAssignable?: boolean;
}

export type ClarificationKind = 'account' | 'category';

export interface UnifiedClarificationDraft {
  ticketId: number;
  kind: ClarificationKind;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  hint?: string;
  candidateList: UnifiedClarificationCandidate[];
  promptSent: boolean;
  invalidSelectionCount: number;
}

export interface FinancialAiProvider {
  readonly providerName: string;

  processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date
  ): Promise<ExtractedFinancialIntent>;

  processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date
  ): Promise<ExtractedFinancialIntent>;

  processEmailTransactionMessage(
    gateResult: GateEvaluationResult,
    emailSubject: string,
    emailSender: string,
    emailBodyText: string,
    emailDate: Date,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedEmailTransactionData>;

  generateAccountClarificationQuestion?(
    context: AccountClarificationQuestionContext
  ): Promise<{ question: string; tokenUsage?: TokenUsageStatistics }>;

  interpretAccountClarificationReply?(
    userReplyText: string,
    candidates: UnifiedClarificationCandidate[],
    context?: Partial<AccountClarificationQuestionContext>
  ): Promise<AccountClarificationProposal>;
}

export interface AiExecutionResult {
  responseText: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface PreparedTextMessagePrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

export interface PreparedReceiptPrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

export interface PreparedEmailPrompt {
  promptText: string;
  systemInstruction: string;
  requestContextDescription: string;
}

export interface FastPathTransactionHistoryAction {
  type: typeof FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY;
  options: TransactionHistoryQueryOptions;
}

export interface FastPathTransactionSummaryAction {
  type: typeof FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY;
  options: TransactionSummaryQueryOptions;
}

export type FastPathAction =
  | typeof FINANCIAL_ACTION_TYPES.CHECK_BALANCE
  | typeof FINANCIAL_ACTION_TYPES.CHECK_BUDGET
  | typeof FINANCIAL_ACTION_TYPES.HELP_MENU
  | typeof FINANCIAL_ACTION_TYPES.CHECK_QUEUE
  | FastPathTransactionHistoryAction
  | FastPathTransactionSummaryAction
  | null;

export interface PendingConfirmationIntent {
  actionType: 'CONFIRM' | 'REJECT';
  targetScope: 'LATEST' | 'ALL' | number;
  customNote?: string;
  customCategoryHint?: string;
  customTags?: string[];
  rawCustomInput?: string;
}

export interface ReconciliationIntent {
  actionType: 'CONFIRM_RECORDED' | 'CONFIRM_ABSENT';
  targetTicketId?: number;
}
