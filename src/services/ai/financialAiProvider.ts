import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { GateEvaluationResult } from '../../utils/emailLogicGate.js';

export interface TokenUsageStatistics {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  cachedContentTokens?: number;
  thoughtsTokens?: number;
}

export interface ExtractedFinancialRecordItem {
  accountId: string;
  categoryId?: string;
  amount: number;
  recordDate: string;
  note: string;
  counterParty?: string;
}

export interface ExtractedFinancialIntent {
  action: 'CREATE_RECORD' | 'CHECK_BUDGET' | 'CHECK_BALANCE' | 'GENERAL_REPLY';
  records?: ExtractedFinancialRecordItem[];
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
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent>;

  /**
   * Processes an image message such as a receipt or invoice photo
   */
  processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
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
}
