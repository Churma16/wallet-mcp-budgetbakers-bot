import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload, WalletBudgetItem } from '../types/walletTypes.js';

/**
 * Generates human readable Indonesian time format, e.g. "15:05 WIB"
 */
export function getHumanReadableTimestamp(date: Date = new Date()): string {
  const jakartaTimeZone = 'Asia/Jakarta';
  const timeFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: jakartaTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const formattedTime = timeFormatter.format(date).replace('.', ':');
  return `${formattedTime} WIB`;
}

/**
 * Formats a transaction timestamp for Indonesian human display in WIB.
 * If the transaction occurred today, shows time (e.g. "17:15 WIB").
 * If the transaction occurred on a different date (e.g. past transaction),
 * shows date and time (e.g. "3 Sep 2026, 17:15 WIB").
 */
export function formatTransactionDate(dateInput?: string | Date): string {
  if (!dateInput) {
    return getHumanReadableTimestamp();
  }

  const transactionDate = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (isNaN(transactionDate.getTime())) {
    return getHumanReadableTimestamp();
  }

  const jakartaTimeZone = 'Asia/Jakarta';

  const timeFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: jakartaTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const dateFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: jakartaTimeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

  const dateComparisonFormatter = new Intl.DateTimeFormat('id-ID', {
    timeZone: jakartaTimeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  const now = new Date();
  const transactionDateKey = dateComparisonFormatter.format(transactionDate);
  const nowDateKey = dateComparisonFormatter.format(now);

  const formattedTime = timeFormatter.format(transactionDate).replace('.', ':');
  const timeString = `${formattedTime} WIB`;

  if (transactionDateKey === nowDateKey) {
    return timeString;
  }

  const formattedDate = dateFormatter.format(transactionDate);
  return `${formattedDate}, ${timeString}`;
}

/**
 * Formats numeric currency to clean Indonesian Rupiah string (e.g. "Rp 35.000")
 */
export function formatCurrencyAmount(amount: number, currencyCode: string = 'IDR'): string {
  const absoluteAmount = Math.abs(amount);
  const formattedNumber = new Intl.NumberFormat('id-ID', {
    maximumFractionDigits: 0,
  }).format(absoluteAmount);

  if (currencyCode.toUpperCase() === 'IDR') {
    return `Rp ${formattedNumber}`;
  }
  return `${currencyCode.toUpperCase()} ${formattedNumber}`;
}

/**
 * Formats a single transaction record using Context-First psychological hierarchy:
 * Title answers "What?", followed by "How much & from where?", then "Category & Time".
 */
function formatSingleRecordSuccess(
  recordItem: CreateRecordInputPayload,
  accountName: string,
  categoryName: string
): string {
  const isExpense = recordItem.amount < 0;
  const transactionTypeIcon = isExpense ? '💸' : '💰';
  const formattedAmount = formatCurrencyAmount(recordItem.amount);
  const transactionTitle = recordItem.note || recordItem.counterParty || (isExpense ? 'Pengeluaran' : 'Pemasukan');
  const recordTimestampDisplay = formatTransactionDate(recordItem.recordDate);

  return [
    `✅ *${transactionTitle}* berhasil dicatat!`,
    '',
    `${transactionTypeIcon} ${formattedAmount}  •  ${accountName}`,
    `🏷️ ${categoryName}  •  ${recordTimestampDisplay}`,
  ].join('\n');
}

/**
 * Formats multiple transaction records into modern numbered list layout
 */
function formatMultipleRecordsSuccess(
  recordList: CreateRecordInputPayload[],
  availableAccounts: WalletAccountItem[],
  availableCategories: WalletCategoryItem[]
): string {
  const totalRecordsCount = recordList.length;
  const currentTimestamp = getHumanReadableTimestamp();
  const headerMessage = `✅ *${totalRecordsCount} transaksi* berhasil dicatat! (${currentTimestamp})`;

  const recordEntries = recordList.map((recordItem, recordIndex) => {
    const isExpense = recordItem.amount < 0;
    const transactionTypeIcon = isExpense ? '💸' : '💰';
    const formattedAmount = formatCurrencyAmount(recordItem.amount);
    const accountName = availableAccounts.find(account => account.id === recordItem.accountId)?.name || 'Akun';
    const categoryName = availableCategories.find(category => category.id === recordItem.categoryId)?.name || 'Umum';
    const transactionDescription = recordItem.note || recordItem.counterParty || (isExpense ? 'Pengeluaran' : 'Pemasukan');
    const recordTimestampDisplay = formatTransactionDate(recordItem.recordDate);

    return [
      `${recordIndex + 1}. ${transactionTypeIcon} ${transactionDescription} — *${formattedAmount}* dari ${accountName}`,
      `   🏷️ ${categoryName}  •  ${recordTimestampDisplay}`,
    ].join('\n');
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
  availableCategories: WalletCategoryItem[]
): string {
  if (recordList.length === 1) {
    const singleRecord = recordList[0];
    const accountName = availableAccounts.find(account => account.id === singleRecord.accountId)?.name || 'Akun';
    const categoryName = availableCategories.find(category => category.id === singleRecord.categoryId)?.name || 'Umum';
    return formatSingleRecordSuccess(singleRecord, accountName, categoryName);
  }

  return formatMultipleRecordsSuccess(recordList, availableAccounts, availableCategories);
}

/**
 * Formats account balances into a clean, mobile-friendly list with bold labels and a grand total
 */
export function formatBalanceSummaryMessage(accountList: WalletAccountItem[]): string {
  const currentTimestamp = getHumanReadableTimestamp();

  if (!accountList || accountList.length === 0) {
    return `📊 *Saldo Rekening* (${currentTimestamp})\n\nBelum ada data rekening yang terhubung.`;
  }

  let totalBalanceAccumulator = 0;
  let hasValidNumericBalance = false;

  const accountLines = accountList.map(accountItem => {
    if (accountItem.balance !== undefined && accountItem.balance !== null) {
      hasValidNumericBalance = true;
      totalBalanceAccumulator += accountItem.balance;
      const formattedBalance = formatCurrencyAmount(accountItem.balance, accountItem.currency || 'IDR');
      return `• *${accountItem.name}*: ${formattedBalance}`;
    }
    return `• *${accountItem.name}*: N/A`;
  });

  const messageParts = [
    `📊 *Saldo Rekening* (${currentTimestamp})`,
    '',
    accountLines.join('\n'),
  ];

  if (hasValidNumericBalance) {
    const formattedGrandTotal = formatCurrencyAmount(totalBalanceAccumulator, 'IDR');
    messageParts.push('', `*Total: ${formattedGrandTotal}*`);
  }

  return messageParts.join('\n');
}

/**
 * Formats budget status into a clean list showing spent, limit, and remaining amounts
 */
export function formatBudgetSummaryMessage(budgetList: WalletBudgetItem[]): string {
  const currentTimestamp = getHumanReadableTimestamp();

  if (!budgetList || budgetList.length === 0) {
    return `📈 *Status Anggaran* (${currentTimestamp})\n\nBelum ada anggaran aktif yang ditemukan.`;
  }

  const budgetLines = budgetList.map(budgetItem => {
    const spentAmount = budgetItem.spentAmount || 0;
    const limitAmount = budgetItem.limitAmount || 0;
    const remainingAmount = limitAmount - spentAmount;
    const formattedSpent = formatCurrencyAmount(spentAmount, budgetItem.currency || 'IDR');
    const formattedLimit = formatCurrencyAmount(limitAmount, budgetItem.currency || 'IDR');
    const formattedRemaining = formatCurrencyAmount(Math.max(0, remainingAmount), budgetItem.currency || 'IDR');

    return `• *${budgetItem.name}*: ${formattedSpent} / ${formattedLimit} _(sisa ${formattedRemaining})_`;
  });

  return [
    `📈 *Status Anggaran* (${currentTimestamp})`,
    '',
    budgetLines.join('\n'),
  ].join('\n');
}

/**
 * Analyzes error causes and generates an empathetic, casual, and actionable human message
 */
export function formatErrorMessageForHuman(
  encounteredError: unknown,
  timestampString: string = getHumanReadableTimestamp()
): string {
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
    return [
      '⚠️ Layanan AI lagi ramai, coba lagi ya dalam beberapa detik!',
      `_(${timestampString})_`,
    ].join('\n');
  }

  // 2. Schema validation / MCP argument format failure
  if (
    lowerCaseErrorMessage.includes('schema validation') ||
    lowerCaseErrorMessage.includes('unexpected additional properties') ||
    lowerCaseErrorMessage.includes('failed to parse') ||
    lowerCaseErrorMessage.includes('create_records')
  ) {
    return [
      '⚠️ Transaksi belum tersimpan nih, format datanya kurang pas.',
      'Coba kirim ulang dengan lebih jelas ya, contoh: _"Makan siang 35rb pakai Gopay"_',
      `_(${timestampString})_`,
    ].join('\n');
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
    return [
      '⚠️ Koneksi ke server lagi gangguan sebentar, coba lagi ya!',
      `_(${timestampString})_`,
    ].join('\n');
  }

  // 4. Default generic unexpected error
  return [
    '⚠️ Ada kendala saat memproses pesanmu.',
    'Detail sudah dicatat di log sistem untuk diperiksa.',
    `_(${timestampString})_`,
  ].join('\n');
}
