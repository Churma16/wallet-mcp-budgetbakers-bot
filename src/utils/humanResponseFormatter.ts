import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload, WalletBudgetItem } from '../types/walletTypes.js';
import { PendingTransactionItem } from '../services/pendingTransactionService.js';
import { getDictionary, SupportedLanguage } from '../i18n/index.js';

const ZERO_DECIMAL_CURRENCY_SET = new Set([
  'IDR', 'JPY', 'KRW', 'VND', 'CLP', 'PYG', 'RWF', 'UGX', 'BIF', 'DJF', 'GNF', 'KMF',
]);

const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  IDR: 'Rp',
  SGD: 'S$',
  AUD: 'A$',
  CAD: 'C$',
  MYR: 'RM',
  THB: '฿',
  PHP: '₱',
  CNY: '¥',
  INR: '₹',
};

/**
 * Resolves the application timezone safely from environment variables or defaults to Asia/Jakarta
 */
export function getApplicationTimezone(): string {
  const configuredTimezone = process.env.APP_TIMEZONE?.trim();
  if (!configuredTimezone) {
    return 'Asia/Jakarta';
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: configuredTimezone });
    return configuredTimezone;
  } catch {
    return 'Asia/Jakarta';
  }
}

/**
 * Resolves short timezone abbreviation or falls back to timeZone name
 */
function resolveTimezoneAbbreviation(date: Date, timeZone: string, localeIdentifier: string): string {
  try {
    const formatter = new Intl.DateTimeFormat(localeIdentifier, {
      timeZone,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(date);
    const timeZonePart = parts.find(part => part.type === 'timeZoneName');
    return timeZonePart?.value || timeZone;
  } catch {
    return timeZone;
  }
}

/**
 * Generates human readable time format, adapting to the configured application timezone
 */
export function getHumanReadableTimestamp(date: Date = new Date(), languageCode?: SupportedLanguage): string {
  const dictionary = getDictionary(languageCode);
  const timeZone = getApplicationTimezone();
  const timeFormatter = new Intl.DateTimeFormat(dictionary.localeIdentifier, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formattedTime = timeFormatter.format(date).replace('.', ':');
  const timeZoneLabel = timeZone === 'Asia/Jakarta'
    ? dictionary.timeZoneLabel
    : resolveTimezoneAbbreviation(date, timeZone, dictionary.localeIdentifier);

  return `${formattedTime} ${timeZoneLabel}`.trim();
}

/**
 * Formats a transaction timestamp for human display in the configured application timezone.
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

  const timeZone = getApplicationTimezone();

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
  const timeZoneLabel = timeZone === 'Asia/Jakarta'
    ? dictionary.timeZoneLabel
    : resolveTimezoneAbbreviation(transactionDate, timeZone, dictionary.localeIdentifier);

  const timeString = `${formattedTime} ${timeZoneLabel}`.trim();

  if (transactionDateKey === nowDateKey) {
    return timeString;
  }

  const formattedDate = dateFormatter.format(transactionDate);
  return `${formattedDate}, ${timeString}`;
}

/**
 * Formats numeric currency to clean string preserving decimals for subunits (e.g. "$5.75" or "Rp 35.000")
 */
export function formatCurrencyAmount(
  amount: number,
  currencyCode?: string,
  languageCode?: SupportedLanguage
): string {
  const dictionary = getDictionary(languageCode);
  const resolvedCurrencyCode = (
    currencyCode ||
    process.env.DEFAULT_CURRENCY ||
    'IDR'
  ).toUpperCase().trim();

  const absoluteAmount = Math.abs(amount);
  const isZeroDecimal = ZERO_DECIMAL_CURRENCY_SET.has(resolvedCurrencyCode);
  const fractionDigits = isZeroDecimal ? 0 : 2;

  const formattedNumber = new Intl.NumberFormat(dictionary.localeIdentifier, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(absoluteAmount);

  const matchedSymbol = CURRENCY_SYMBOL_MAP[resolvedCurrencyCode];
  if (matchedSymbol) {
    if (resolvedCurrencyCode === 'IDR') {
      return `Rp ${formattedNumber}`;
    }
    return `${matchedSymbol}${formattedNumber}`;
  }

  return `${resolvedCurrencyCode} ${formattedNumber}`;
}

/**
 * Formats a single transaction record using Context-First psychological hierarchy
 */
function formatSingleRecordSuccess(
  recordItem: CreateRecordInputPayload,
  accountName: string,
  categoryName: string,
  languageCode?: SupportedLanguage,
  accountCurrency?: string
): string {
  const dictionary = getDictionary(languageCode);
  const isExpense = recordItem.amount < 0;
  const transactionTypeIcon = isExpense ? '💸' : '💰';
  const resolvedCurrency = accountCurrency || process.env.DEFAULT_CURRENCY || 'IDR';
  const formattedAmount = formatCurrencyAmount(recordItem.amount, resolvedCurrency, languageCode);
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
    const targetAccount = availableAccounts.find(account => account.id === recordItem.accountId);
    const resolvedCurrency = targetAccount?.currency || process.env.DEFAULT_CURRENCY || 'IDR';
    const formattedAmount = formatCurrencyAmount(recordItem.amount, resolvedCurrency, languageCode);
    const accountName = targetAccount?.name || dictionary.labels.defaultAccount;
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
    const targetAccount = availableAccounts.find(account => account.id === singleRecord.accountId);
    const accountName = targetAccount?.name || dictionary.labels.defaultAccount;
    const categoryName = availableCategories.find(category => category.id === singleRecord.categoryId)?.name || dictionary.labels.defaultCategory;
    return formatSingleRecordSuccess(singleRecord, accountName, categoryName, languageCode, targetAccount?.currency);
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
      const resolvedCurrency = accountItem.currency || process.env.DEFAULT_CURRENCY || 'IDR';
      const formattedBalance = formatCurrencyAmount(accountItem.balance, resolvedCurrency, languageCode);
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
    const fallbackCurrency = process.env.DEFAULT_CURRENCY || 'IDR';
    const formattedGrandTotal = formatCurrencyAmount(totalBalanceAccumulator, fallbackCurrency, languageCode);
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

  const activeBudgetList = (budgetList || []).filter(budgetItem => !budgetItem.isClosed);

  if (activeBudgetList.length === 0) {
    return `${dictionary.budget.header(currentTimestamp)}\n\n${dictionary.budget.emptyState}`;
  }

  const budgetLines = activeBudgetList.map(budgetItem => {
    const spentAmount = budgetItem.spentAmount ?? 0;
    const limitAmount = budgetItem.limitAmount ?? 0;
    const remainingAmount = budgetItem.remainingAmount !== undefined
      ? budgetItem.remainingAmount
      : (limitAmount - spentAmount);
    const budgetCurrency = budgetItem.currency || process.env.DEFAULT_CURRENCY || 'IDR';
    const formattedSpent = formatCurrencyAmount(spentAmount, budgetCurrency, languageCode);
    const formattedLimit = formatCurrencyAmount(limitAmount, budgetCurrency, languageCode);

    const isOverspent = Boolean(budgetItem.isOverspent || remainingAmount < 0);

    if (isOverspent) {
      const overspentAmount = Math.abs(remainingAmount);
      const formattedOverspent = formatCurrencyAmount(overspentAmount, budgetCurrency, languageCode);
      return dictionary.budget.budgetOverspentItem(budgetItem.name, formattedSpent, formattedLimit, formattedOverspent);
    }

    const formattedRemaining = formatCurrencyAmount(Math.max(0, remainingAmount), budgetCurrency, languageCode);
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
  const itemCurrency = pendingItem.currency || process.env.DEFAULT_CURRENCY || 'IDR';
  const formattedAmount = formatCurrencyAmount(pendingItem.amount, itemCurrency, languageCode);
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
  const itemCurrency = item.currency || process.env.DEFAULT_CURRENCY || 'IDR';
  const formattedAmount = formatCurrencyAmount(item.amount, itemCurrency, languageCode);
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

  const bulkItemParams = items.map(item => {
    const itemCurrency = item.currency || process.env.DEFAULT_CURRENCY || 'IDR';
    return {
      ticketId: item.ticketId,
      title: item.counterParty || item.note || item.bankDisplayName,
      formattedAmount: formatCurrencyAmount(item.amount, itemCurrency, languageCode),
      accountNameHint: item.accountNameHint || dictionary.labels.defaultAccount,
    };
  });

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
  const itemCurrency = item.currency || process.env.DEFAULT_CURRENCY || 'IDR';
  const formattedAmount = formatCurrencyAmount(item.amount, itemCurrency, languageCode);
  const title = item.counterParty || item.note || item.bankDisplayName;
  return dictionary.confirmation.cancellation({
    isBulk: false,
    ticketId: item.ticketId,
    title,
    formattedAmount,
  });
}
