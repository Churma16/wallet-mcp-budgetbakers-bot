export type SupportedLanguage = 'id' | 'en';

export interface RecordMessageParams {
  transactionTitle: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  transactionTypeIcon: string;
}

export interface MultipleRecordsItemParams {
  itemIndex: number;
  transactionTypeIcon: string;
  transactionDescription: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
}

export interface PendingEmailNotificationParams {
  ticketId: number;
  bankDisplayName: string;
  typeIcon: string;
  formattedAmount: string;
  typeLabel: string;
  formattedTime: string;
  destinationAccountNameHint?: string;
  counterParty?: string;
  matchedCategoryName?: string;
  accountNameHint?: string;
  referenceNumber?: string;
  totalPendingCount: number;
}

export interface PendingConfirmationSuccessParams {
  ticketId: number;
  isTransfer: boolean;
  formattedAmount: string;
  formattedTime: string;
  accountNameHint?: string;
  destinationAccountNameHint?: string;
  icon?: string;
  merchantOrNote?: string;
  matchedCategoryName?: string;
}

export interface PendingBulkItemParams {
  ticketId: number;
  title: string;
  formattedAmount: string;
  accountNameHint?: string;
}

export interface PendingCancellationParams {
  isBulk: boolean;
  count?: number;
  ticketId?: number;
  title?: string;
  formattedAmount?: string;
}

export interface ResponseDictionary {
  languageCode: SupportedLanguage;
  localeIdentifier: string;
  timeZoneLabel: string;

  labels: {
    expense: string;
    income: string;
    transfer: string;
    defaultAccount: string;
    defaultCategory: string;
    total: string;
    remaining: string;
    from: string;
    to: string;
  };

  records: {
    singleSuccess(params: RecordMessageParams): string;
    multipleSuccessHeader(totalRecordsCount: number, currentTimestamp: string): string;
    multipleRecordItem(params: MultipleRecordsItemParams): string;
  };

  balance: {
    header(currentTimestamp: string): string;
    emptyState: string;
    grandTotal(formattedTotal: string): string;
    notAvailable: string;
  };

  budget: {
    header(currentTimestamp: string): string;
    emptyState: string;
    budgetItem(name: string, spent: string, limit: string, remaining: string): string;
    budgetOverspentItem(name: string, spent: string, limit: string, overspent: string): string;
  };

  emailPending: {
    formatNotification(params: PendingEmailNotificationParams): string;
  };

  confirmation: {
    singleSuccess(params: PendingConfirmationSuccessParams): string;
    bulkSuccess(items: PendingBulkItemParams[], currentTimestamp: string): string;
    cancellation(params: PendingCancellationParams): string;
  };

  help: {
    welcomeGuidance: string;
    quickCommandsTitle: string;
    commandBalance: string;
    commandBudget: string;
    commandMenu: string;
  };

  errors: {
    aiBusy(timestampString: string): string;
    schemaValidation(timestampString: string): string;
    networkConnection(timestampString: string): string;
    generic(timestampString: string): string;
    validationRejected(errorMessage: string): string;
  };
}
