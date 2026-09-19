import {
  CreateRecordInputPayload,
  TransactionHistoryQueryOptions,
  WalletAccountItem,
  WalletCategoryItem,
} from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailGateEvaluator.js';
import { PendingAccountSelectionCandidate } from '../pendingTransactionService.js';

export interface AccountClarificationQuestionContext {
  ticketId: number;
  records: CreateRecordInputPayload[];
  pendingRecordIndex: number;
  accountHint?: string;
  candidateAccounts?: PendingAccountSelectionCandidate[];
  formattedAmount: string;
  categoryName: string;
  description: string;
  invalidSelection?: string;
  languageCode: string;
}

export interface AccountClarificationProposal {
  selectedCandidateIndex: number | null;
  reasoning: string;
  tokenUsage?: TokenUsageStatistics;
}

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
  action: 'CREATE_RECORD' | 'CHECK_BUDGET' | 'CHECK_BALANCE' | 'TRANSACTION_HISTORY' | 'GENERAL_REPLY' | 'RECORD_EXPENSE' | 'RECORD_INCOME' | 'RECORD_TRANSFER';
  records?: ExtractedFinancialRecordItem[];
  queryOptions?: TransactionHistoryQueryOptions;
  explanation?: string;
  tokenUsage?: TokenUsageStatistics;
}

export interface ExtractedEmailTransactionData {
  isTransaction: boolean;
  transactionType: 'EXPENSE' | 'INCOME' | 'TRANSFER';
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

export interface FinancialAiProvider {
  readonly providerName: string;

  /**
   * Processes a natural language text message from the user
   */
  processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date
  ): Promise<ExtractedFinancialIntent>;

  /**
   * Processes an image message such as a receipt or invoice photo
   */
  processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[],
    referenceInstant?: Date
  ): Promise<ExtractedFinancialIntent>;

  /**
   * Processes bank notification email content through Gate 2 classification
   */
  processEmailTransactionMessage(
    gateResult: GateEvaluationResult,
    emailSubject: string,
    emailSender: string,
    emailBodyText: string,
    emailDate: Date,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedEmailTransactionData>;

  /**
   * Generates natural language question wording for account clarification
   */
  generateAccountClarificationQuestion?(
    context: AccountClarificationQuestionContext
  ): Promise<{ question: string; tokenUsage?: TokenUsageStatistics }>;

  /**
   * Interprets free-form clarification reply to propose candidate selection
   */
  interpretAccountClarificationReply?(
    userReplyText: string,
    candidates: PendingAccountSelectionCandidate[],
    context?: Partial<AccountClarificationQuestionContext>
  ): Promise<AccountClarificationProposal>;
}
