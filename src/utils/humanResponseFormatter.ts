import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload, WalletBudgetItem } from '../types/walletTypes.js';
import { PendingTransactionItem } from '../services/pendingTransactionManager.js';
import { getDictionary, SupportedLanguage } from '../i18n/index.js';

/**
 * Generates human readable time format, e.g. "15:05 WIB" (id) or "15:05 WIB" (en)
 */
export function getHumanReadableTimestamp(date: Date = new Date(), languageCode?: SupportedLanguage): string {
  const dictionary = getDictionary(languageCode);
  const timeZone = 'Asia/Jakarta';
  const timeFormatter = new Intl.DateTimeFormat(dictionary.localeIdentifier, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formattedTime = timeFormatter.format(date).replace('.', ':');
  return `${formattedTime} ${dictionary.timeZoneLabel}`;
}

/**
 * Formats a transaction timestamp for human display in WIB.
 * If the transaction occurred today, shows time (e.g. "17:15 WIB").
 * If the transaction occurred on a different date, shows date and time (e.g. "3 Sep 2026, 17:15 WIB").
 */
export function formatTransactionDate(dateInput?: string | Date, languageCode?: SupportedLanguage): string {
  const dictionary = getDictionary(languageCode);
  if (!dateInput) {
    return getHumanReadableTimestamp(new Date(), languageCode);
  }

  const transactionDate = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(transactionDate.getTime())) {
    return getHumanReadableTimestamp(new Date(), languageCode);
  }

  const timeZone = 'Asia/Jakarta';

  const timeFormatter = new Intl.DateTimeFormat(dictionary.localeIdentifier, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const dateFormatter = new Intl.DateTimeFormat(dictionary.localeIdentifier, {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const dateComparisonFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const now = new Date();
  const transactionDateKey = dateComparisonFormatter.format(transactionDate);
  const nowDateKey = dateComparisonFormatter.format(now);

  const formattedTime = timeFormatter.format(transactionDate).replace('.', ':');
  const timeString = `${formattedTime} ${dictionary.timeZoneLabel}`;

  if (transactionDateKey === nowDateKey) {
    return timeString;
  }

  const formattedDate = dateFormatter.format(transactionDate);
  return `${formattedDate}, ${timeString}`;
}

/**
 * Formats numeric currency to clean string (e.g. "Rp 35.000")
 */
export function formatCurrencyAmount(
  amount: number,
  currencyCode: string = 'IDR',
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const absoluteAmount = Math.abs(amount);
  const formattedNumber = new Intl.NumberFormat(dictionary.localeIdentifier, {
    maximumFractionDigits: 0,
  }).format(absoluteAmount);

  if (currencyCode.toUpperCase() === 'IDR') {
    return `Rp ${formattedNumber}`;
  }
  return `${currencyCode.toUpperCase()} ${formattedNumber}`;
}

/**
 * Formats a single transaction record using Context-First psychological hierarchy
 */
function formatSingleRecordSuccess(
  recordItem: CreateRecordInputPayload,
  accountName: string,
  categoryName: string,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const isExpense = recordItem.amount < 0;
  const transactionTypeIcon = isExpense ? '💸' : '💰';
  const formattedAmount = formatCurrencyAmount(recordItem.amount, 'IDR', languageCode);
  const defaultTitle = isExpense ? dictionary.labels.expense : dictionary.labels.income;
  const transactionTitle = recordItem.note || recordItem.counterParty || defaultTitle;
  const recordTimestampDisplay = formatTransactionDate(recordItem.recordDate, languageCode);

  return dictionary.records.singleSuccess({
    transactionTitle,
    formattedAmount,
    accountName,
    categoryName,
    recordTimestampDisplay,
    transactionTypeIcon,
  });
}

/**
 * Formats multiple transaction records into modern numbered list layout
 */
function formatMultipleRecordsSuccess(
  recordList: CreateRecordInputPayload[],
  availableAccounts: WalletAccountItem[],
  availableCategories: WalletCategoryItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const totalRecordsCount = recordList.length;
  const currentTimestamp = getHumanReadableTimestamp(new Date(), languageCode);
  const headerMessage = dictionary.records.multipleSuccessHeader(totalRecordsCount, currentTimestamp);

  const recordEntries = recordList.map((recordItem, recordIndex) => {
    const isExpense = recordItem.amount < 0;
    const transactionTypeIcon = isExpense ? '💸' : '💰';
    const formattedAmount = formatCurrencyAmount(recordItem.amount, 'IDR', languageCode);
    const accountName = availableAccounts.find(account => account.id === recordItem.accountId)?.name || dictionary.labels.defaultAccount;
    const categoryName = availableCategories.find(category => category.id === recordItem.categoryId)?.name || dictionary.labels.defaultCategory;
    const defaultDescription = isExpense ? dictionary.labels.expense : dictionary.labels.income;
    const transactionDescription = recordItem.note || recordItem.counterParty || defaultDescription;
    const recordTimestampDisplay = formatTransactionDate(recordItem.recordDate, languageCode);

    return dictionary.records.multipleRecordItem({
      itemIndex: recordIndex,
      transactionTypeIcon,
      transactionDescription,
      formattedAmount,
      accountName,
      categoryName,
      recordTimestampDisplay,
    });
  });

  return [
    headerMessage,
    '',
    recordEntries.join('\n\n'),
  ].join('\n');
}

/**
 * Main formatter for successful record creation (single or multiple)
 */
export function formatRecordSuccessMessage(
  recordList: CreateRecordInputPayload[],
  availableAccounts: WalletAccountItem[],
  availableCategories: WalletCategoryItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  if (recordList.length === 1) {
    const singleRecord = recordList[0];
    const accountName = availableAccounts.find(account => account.id === singleRecord.accountId)?.name || dictionary.labels.defaultAccount;
    const categoryName = availableCategories.find(category => category.id === singleRecord.categoryId)?.name || dictionary.labels.defaultCategory;
    return formatSingleRecordSuccess(singleRecord, accountName, categoryName, languageCode);
  }

  return formatMultipleRecordsSuccess(recordList, availableAccounts, availableCategories, languageCode);
}

/**
 * Formats account balances into a clean, mobile-friendly list with bold labels and a grand total
 */
export function formatBalanceSummaryMessage(
  accountList: WalletAccountItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const currentTimestamp = getHumanReadableTimestamp(new Date(), languageCode);

  if (!accountList || accountList.length === 0) {
    return `${dictionary.balance.header(currentTimestamp)}\n\n${dictionary.balance.emptyState}`;
  }

  let totalBalanceAccumulator = 0;
  let hasValidNumericBalance = false;

  const accountLines = accountList.map(accountItem => {
    if (accountItem.balance !== undefined && accountItem.balance !== null) {
      hasValidNumericBalance = true;
      totalBalanceAccumulator += accountItem.balance;
      const formattedBalance = formatCurrencyAmount(accountItem.balance, accountItem.currency || 'IDR', languageCode);
      return `• *${accountItem.name}*: ${formattedBalance}`;
    }
    return `• *${accountItem.name}*: ${dictionary.balance.notAvailable}`;
  });

  const messageParts = [
    dictionary.balance.header(currentTimestamp),
    '',
    accountLines.join('\n'),
  ];

  if (hasValidNumericBalance) {
    const formattedGrandTotal = formatCurrencyAmount(totalBalanceAccumulator, 'IDR', languageCode);
    messageParts.push('', dictionary.balance.grandTotal(formattedGrandTotal));
  }

  return messageParts.join('\n');
}

/**
 * Formats budget status into a clean list showing spent, limit, and remaining amounts
 */
export function formatBudgetSummaryMessage(
  budgetList: WalletBudgetItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const currentTimestamp = getHumanReadableTimestamp(new Date(), languageCode);

  if (!budgetList || budgetList.length === 0) {
    return `${dictionary.budget.header(currentTimestamp)}\n\n${dictionary.budget.emptyState}`;
  }

  const budgetLines = budgetList.map(budgetItem => {
    const spentAmount = budgetItem.spentAmount || 0;
    const limitAmount = budgetItem.limitAmount || 0;
    const remainingAmount = limitAmount - spentAmount;
    const formattedSpent = formatCurrencyAmount(spentAmount, budgetItem.currency || 'IDR', languageCode);
    const formattedLimit = formatCurrencyAmount(limitAmount, budgetItem.currency || 'IDR', languageCode);
    const formattedRemaining = formatCurrencyAmount(Math.max(0, remainingAmount), budgetItem.currency || 'IDR', languageCode);

    return dictionary.budget.budgetItem(budgetItem.name, formattedSpent, formattedLimit, formattedRemaining);
  });

  return [
    dictionary.budget.header(currentTimestamp),
    '',
    budgetLines.join('\n'),
  ].join('\n');
}

/**
 * Analyzes error causes and generates an empathetic, casual, and actionable human message
 */
export function formatErrorMessageForHuman(
  encounteredError: unknown,
  timestampString?: string,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const resolvedTimestamp = timestampString || getHumanReadableTimestamp(new Date(), languageCode);

  const rawErrorMessage = encounteredError instanceof Error 
    ? encounteredError.message 
    : String(encounteredError);

  const lowerCaseErrorMessage = rawErrorMessage.toLowerCase();

  // 1. AI Service Busy / Rate Limit / Overloaded
  if (
    lowerCaseErrorMessage.includes('503') ||
    lowerCaseErrorMessage.includes('429') ||
    lowerCaseErrorMessage.includes('high demand') ||
    lowerCaseErrorMessage.includes('unavailable') ||
    lowerCaseErrorMessage.includes('resource_exhausted') ||
    lowerCaseErrorMessage.includes('overloaded')
  ) {
    return dictionary.errors.aiBusy(resolvedTimestamp);
  }

  // 2. Schema validation / MCP argument format failure
  if (
    lowerCaseErrorMessage.includes('schema validation') ||
    lowerCaseErrorMessage.includes('unexpected additional properties') ||
    lowerCaseErrorMessage.includes('failed to parse') ||
    lowerCaseErrorMessage.includes('create_records')
  ) {
    return dictionary.errors.schemaValidation(resolvedTimestamp);
  }

  // 3. Network connection / Timeout failure
  if (
    lowerCaseErrorMessage.includes('econnrefused') ||
    lowerCaseErrorMessage.includes('etimedout') ||
    lowerCaseErrorMessage.includes('enotfound') ||
    lowerCaseErrorMessage.includes('timeout') ||
    lowerCaseErrorMessage.includes('504') ||
    lowerCaseErrorMessage.includes('network')
  ) {
    return dictionary.errors.networkConnection(resolvedTimestamp);
  }

  // 4. Default generic unexpected error
  return dictionary.errors.generic(resolvedTimestamp);
}

/**
 * Formats a notification prompt for an incoming email transaction requiring confirmation
 */
export function formatPendingEmailTransactionNotification(
  pendingItem: PendingTransactionItem,
  totalPendingCount: number = 1,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const isTransfer = pendingItem.transactionType === 'TRANSFER';
  const isExpense = pendingItem.amount < 0 || pendingItem.transactionType === 'EXPENSE';
  const typeLabel = isTransfer ? dictionary.labels.transfer : isExpense ? dictionary.labels.expense : dictionary.labels.income;
  const typeIcon = isTransfer ? '🔄' : isExpense ? '💸' : '💰';
  const formattedAmount = formatCurrencyAmount(pendingItem.amount, 'IDR', languageCode);
  const formattedTime = formatTransactionDate(pendingItem.recordDate, languageCode);

  return dictionary.emailPending.formatNotification({
    ticketId: pendingItem.ticketId,
    bankDisplayName: pendingItem.bankDisplayName,
    typeIcon,
    formattedAmount,
    typeLabel,
    formattedTime,
    destinationAccountNameHint: pendingItem.destinationAccountNameHint,
    counterParty: pendingItem.counterParty,
    matchedCategoryName: pendingItem.matchedCategoryName,
    accountNameHint: pendingItem.accountNameHint,
    referenceNumber: pendingItem.referenceNumber,
    totalPendingCount,
  });
}

/**
 * Formats success message after user confirms a single pending transaction
 */
export function formatPendingConfirmationSuccess(
  item: PendingTransactionItem,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const isTransfer = item.transactionType === 'TRANSFER';
  const formattedAmount = formatCurrencyAmount(item.amount, 'IDR', languageCode);
  const formattedTime = formatTransactionDate(item.recordDate, languageCode);

  if (isTransfer) {
    return dictionary.confirmation.singleSuccess({
      ticketId: item.ticketId,
      isTransfer: true,
      formattedAmount,
      formattedTime,
      accountNameHint: item.accountNameHint,
      destinationAccountNameHint: item.destinationAccountNameHint,
    });
  }

  const isExpense = item.amount < 0 || item.transactionType === 'EXPENSE';
  const icon = isExpense ? '💸' : '💰';
  const defaultNote = isExpense ? dictionary.labels.expense : dictionary.labels.income;
  const merchantOrNote = item.counterParty || item.note || defaultNote;

  return dictionary.confirmation.singleSuccess({
    ticketId: item.ticketId,
    isTransfer: false,
    formattedAmount,
    formattedTime,
    accountNameHint: item.accountNameHint,
    matchedCategoryName: item.matchedCategoryName,
    icon,
    merchantOrNote,
  });
}

/**
 * Formats success message after user confirms multiple pending transactions at once
 */
export function formatBulkPendingConfirmationSuccess(
  items: PendingTransactionItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const currentTimestamp = getHumanReadableTimestamp(new Date(), languageCode);

  const bulkItemParams = items.map(item => ({
    ticketId: item.ticketId,
    title: item.counterParty || item.note || item.bankDisplayName,
    formattedAmount: formatCurrencyAmount(item.amount, 'IDR', languageCode),
    accountNameHint: item.accountNameHint || dictionary.labels.defaultAccount,
  }));

  return dictionary.confirmation.bulkSuccess(bulkItemParams, currentTimestamp);
}

/**
 * Formats cancellation message when user rejects a pending transaction
 */
export function formatPendingCancellationMessage(
  item: PendingTransactionItem | PendingTransactionItem[],
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  if (Array.isArray(item)) {
    return dictionary.confirmation.cancellation({
      isBulk: true,
      count: item.length,
    });
  }
  const formattedAmount = formatCurrencyAmount(item.amount, 'IDR', languageCode);
  const title = item.counterParty || item.note || item.bankDisplayName;
  return dictionary.confirmation.cancellation({
    isBulk: false,
    ticketId: item.ticketId,
    title,
    formattedAmount,
  });
}
