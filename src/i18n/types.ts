import type { TransactionSortOrder, UnresolvedFilterIssue, ClearableRecordField } from '../wallet/index.js';

export type SupportedLanguage = 'id' | 'en';
export type { TransactionSortOrder, UnresolvedFilterIssue, ClearableRecordField };

export interface SystemStartupNotificationParams {
  telegramStatus: string;
  gmailStatus: string;
  timeDisplay: string;
}

export interface RecordMessageParams {
  transactionTitle: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  transactionTypeIcon: string;
  labels?: string[];
}

export interface RecordEditSuccessParams {
  transactionTitle: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  transactionTypeIcon: string;
  labels?: string[];
  movedFromAccountName?: string;
  clearedFields?: ClearableRecordField[];
  clearedFieldLabels?: string[];
  isTransfer?: boolean;
  destinationAccountName?: string;
}

export interface RecordDeleteSuccessParams {
  transactionTitle: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  transactionTypeIcon: string;
  labels?: string[];
  isTransfer?: boolean;
  destinationAccountName?: string;
}

export interface RecordDeleteConfirmPromptParams {
  transactionTitle: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  transactionTypeIcon: string;
  labels?: string[];
  isTransfer?: boolean;
  destinationAccountName?: string;
}

export interface MultipleRecordsItemParams {
  itemIndex: number;
  transactionTypeIcon: string;
  transactionDescription: string;
  formattedAmount: string;
  accountName: string;
  categoryName: string;
  recordTimestampDisplay: string;
  labels?: string[];
}

export interface PendingEmailNotificationParams {
  ticketId: number;
  bankDisplayName: string;
  typeIcon: string;
  sourceIcon?: string;
  formattedAmount: string;
  typeLabel: string;
  formattedTime: string;
  destinationAccountNameHint?: string;
  counterParty?: string;
  matchedCategoryName?: string;
  accountNameHint?: string;
  note?: string;
  referenceNumber?: string;
  isBankSyncedAccount?: boolean;
  totalPendingCount: number;
}

export interface PendingConfirmationPromptParams {
  ticketId: number;
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
  labels?: string[];
  note?: string;
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

export interface TelegramMenuDictionary {
  buttonBalance: string;
  buttonBudget: string;
  buttonHistory: string;
  buttonGuide: string;

  commandBalanceDescription: string;
  commandBudgetDescription: string;
  commandHistoryDescription: string;
  commandSummaryDescription: string;
  commandMenuDescription: string;
  commandSettingsDescription: string;
  commandRescanDescription: string;
  commandReconciliationDescription: string;

  topicRecord: string;
  topicTransfer: string;
  topicEditDelete: string;
  topicReceipt: string;
  topicSummaryFilter: string;
  topicFastCommands: string;
  buttonBack: string;

  guideHomeTitle: string;
  guideHomeSubtitle: string;
  guideRecordContent: string;
  guideTransferContent: string;
  guideEditDeleteContent: string;
  guideReceiptContent: string;
  guideSummaryFilterContent: string;
  guideFastCommandsContent: string;
}

export interface TelegramSettingsDictionary {
  title: string;
  subtitle: string;
  activeSummaryHeader: string;
  savedAlert: string;
  resetAlert: string;
  unauthorizedAlert: string;

  buttonCategoryMode: string;
  buttonAiModel: string;
  buttonLanguage: string;
  buttonCurrency: string;
  buttonAdvanced: string;
  buttonBackToMain: string;
  buttonBackToAdvanced: string;
  buttonClose: string;

  categoryTitle: string;
  categoryInfo: string;
  categoryOptionAsk: string;
  categoryOptionAuto: string;

  aiModelTitle: string;
  aiModelInfo: string;
  aiModelOptionFlashLite: string;
  aiModelOptionFlash: string;
  aiModelOptionFallbackChain: string;

  languageTitle: string;
  languageInfo: string;
  languageOptionId: string;
  languageOptionEn: string;

  currencyTitle: string;
  currencyInfo: string;

  advancedTitle: string;
  advancedInfo: string;
  advancedButtonTimezone: string;
  advancedButtonAiTimeout: string;
  advancedButtonEmailLookback: string;
  advancedButtonQueueInterval: string;
  advancedButtonLogRetention: string;
  advancedButtonReset: string;

  timezoneTitle: string;
  timezoneInfo: string;

  aiTimeoutTitle: string;
  aiTimeoutInfo: string;

  emailLookbackTitle: string;
  emailLookbackInfo: string;

  queueIntervalTitle: string;
  queueIntervalInfo: string;

  logRetentionTitle: string;
  logRetentionInfo: string;

  resetConfirmTitle: string;
  resetConfirmInfo: string;
  resetConfirmPrompt: string;
  resetConfirmButton: string;
  resetCancelButton: string;

  autoRecordEnrichedToggleLabel(enabled: boolean): string;
  debugToggleLabel(enabled: boolean): string;
  debugTitle: string;
  debugInfo: string;
  debugOptionOn: string;
  debugOptionOff: string;
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
    transferSuccess: string;
  };

  records: {
    singleSuccess(params: RecordMessageParams): string;
    multipleSuccessHeader(totalRecordsCount: number, currentTimestamp: string): string;
    multipleRecordItem(params: MultipleRecordsItemParams): string;
    editSuccess(params: RecordEditSuccessParams): string;
    deleteSuccess(params: RecordDeleteSuccessParams): string;
    deleteConfirmPrompt(params: RecordDeleteConfirmPromptParams): string;
    deleteConfirmButton: string;
    deleteCancelButton: string;
    deleteCancelledText: string;
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

  history: {
    header(
      page: number,
      totalPages?: number,
      displayedCount?: number,
      totalCount?: number,
      sortOrderLabel?: string,
      filterSummary?: string
    ): string;
    emptyState: string;
    emptyFilteredState(filterSummary: string): string;
    unresolvedFilters(issues: UnresolvedFilterIssue[]): string;
    outOfBounds(totalCount: number): string;
    navigationHint(
      nextPage: number,
      options?: {
        limit?: number;
        sort?: TransactionSortOrder;
        filterTokens?: string[];
      }
    ): string;
    sortNewest: string;
    sortOldest: string;
    typeExpense: string;
    typeIncome: string;
    searchBadge(keyword: string): string;
    convertToBadge(currencyCode: string): string;
  };

  emailPending: {
    formatNotification(params: PendingEmailNotificationParams): string;
    formatConfirmationPrompt(params: PendingConfirmationPromptParams): string;
  };

  status: {
    header: string;
    emptyAttention: string;
    needsCheckHeader(count: number): string;
    waitingConfirmationHeader(count: number): string;
    waitingAccountHeader(count: number): string;
    waitingCategoryHeader(count: number): string;
    noOtherTransactionsWaiting: string;
    queueItemHeadline(ticketId: number): string;
    queueItemPrompt: string;
    remainingQueueNotice(count: number): string;
    queueConfirmButton: string;
    queueCancelButton: string;
  };

  uncertain: {
    title: string;
    riskWarning: string;
    actionPromptSingle: string;
    actionPromptMultiple(tickets: number[]): string;
  };

  reconciliation: {
    recordedWithTicket(ticketId: number): string;
    recordedSingle: string;
    absentWithTicket(ticketId: number): string;
    absentSingle: string;
    notFoundWithTicket(ticketId: number): string;
    notFoundNone: string;
    ambiguous(ticketIds: number[]): string;
  };

  confirmation: {
    singleSuccess(params: PendingConfirmationSuccessParams): string;
    bulkSuccess(items: PendingBulkItemParams[], currentTimestamp: string): string;
    cancellation(params: PendingCancellationParams): string;
    itemProcessing(ticketId: number): string;
    itemAlreadyResolved(ticketId: number): string;
    itemNotFound(ticketId?: number): string;
    noPendingItems: string;
    itemProcessingCannotCancel(ticketId: number): string;
    cancellationNotFound(ticketId?: number): string;
  };

  help: {
    welcomeGuidance: string;
  };

  system: {
    startupNotification(params: SystemStartupNotificationParams): string;
  };

  aiFallbackStatus: {
    initial(modelName?: string): string;
    cycling(modelName: string): string;
  };

  telegramMenu: TelegramMenuDictionary;
  telegramSettings: TelegramSettingsDictionary;

  errors: {
    aiBusy(timestampString: string): string;
    schemaValidation(timestampString: string): string;
    networkConnection(timestampString: string): string;
    generic(timestampString: string): string;
    receiptExtractionFailed(timestampString: string): string;
    validationRejected(errorMessage: string): string;
    accountResolutionUnresolved(recordNumber: number, accountHint: string): string;
    accountResolutionAmbiguous(recordNumber: number, accountHint: string, candidateNames: string[]): string;
    accountResolutionFallback: string;
    mediaTooLarge(maxMegabytes: number): string;
    mediaDownloadFailed(channelDisplayName: string): string;
    recordEditAccountNotFound(accountHint: string): string;
    recordEditAccountAmbiguous(accountHint: string, candidates: string[]): string;
    recordEditSourceBankSynced(accountName: string): string;
    recordEditTargetBankSynced(accountName: string): string;
    recordEditCurrencyMismatch(
      sourceAccount: string,
      sourceCurrency: string,
      targetAccount: string,
      targetCurrency: string
    ): string;
    recordEditZeroAmount: string;
    recordEditCategoryNotFound(categoryHint: string): string;
    recordEditCategoryAutoNotFound(hint?: string): string;
    recordEditNotFound: string;
    recordEditFailed(reason: string): string;
    recordDeleteNotFound: string;
    recordDeleteFailed(reason: string): string;
  };
}
