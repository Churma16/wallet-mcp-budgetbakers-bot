import { PendingAccountSelectionDraft } from '../services/pendingTransactionService.js';
import { WalletCategoryItem } from '../types/walletTypes.js';
import { getDictionary } from '../i18n/index.js';
import { formatCurrencyAmount } from './humanResponseFormatter.js';

function resolveCategoryName(
  rawCategoryId: string | undefined,
  categories: WalletCategoryItem[]
): string {
  const dictionary = getDictionary();
  if (!rawCategoryId) {
    return dictionary.labels.defaultCategory;
  }

  const normalizedCategoryId = String(rawCategoryId).trim();
  const exactIdMatch = categories.find(category => category.id === normalizedCategoryId);
  if (exactIdMatch) {
    return exactIdMatch.name;
  }

  if (/^\d+$/.test(normalizedCategoryId)) {
    const categoryIndex = Number.parseInt(normalizedCategoryId, 10) - 1;
    if (categoryIndex >= 0 && categoryIndex < categories.length) {
      return categories[categoryIndex].name;
    }
  }

  const exactNameMatch = categories.find(
    category => category.name.toLowerCase() === normalizedCategoryId.toLowerCase()
  );
  return exactNameMatch?.name || normalizedCategoryId;
}

function resolveDraftCurrency(draft: PendingAccountSelectionDraft): string | undefined {
  if (draft.candidateAccounts.length === 0) {
    return undefined;
  }

  const candidateCurrencies = draft.candidateAccounts.map(candidate =>
    candidate.currency?.trim().toUpperCase() || undefined
  );

  if (candidateCurrencies.some(currency => !currency)) {
    return undefined;
  }

  const uniqueCurrencies = new Set(candidateCurrencies as string[]);
  return uniqueCurrencies.size === 1
    ? Array.from(uniqueCurrencies)[0]
    : undefined;
}

function formatDraftAmount(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  const record = draft.records[draft.pendingRecordIndex];
  const resolvedCurrency = record.currency || resolveDraftCurrency(draft);

  if (resolvedCurrency) {
    return formatCurrencyAmount(record.amount, resolvedCurrency);
  }

  const numericAmount = Number(record.amount);
  const formattedNumber = new Intl.NumberFormat(dictionary.localeIdentifier, {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(numericAmount) ? Math.abs(numericAmount) : 0);

  return dictionary.languageCode === 'id'
    ? `${formattedNumber} _(mata uang mengikuti akun yang dipilih)_`
    : `${formattedNumber} _(currency follows the selected account)_`;
}

export function formatAccountSelectionPrompt(
  draft: PendingAccountSelectionDraft,
  categories: WalletCategoryItem[],
  invalidSelection?: string
): string {
  const dictionary = getDictionary();
  const record = draft.records[draft.pendingRecordIndex];
  const formattedAmount = formatDraftAmount(draft);
  const categoryName = resolveCategoryName(record.categoryId, categories);
  const description = record.note || record.counterParty ||
    (dictionary.languageCode === 'id' ? 'Transaksi' : 'Transaction');
  const candidateLines = draft.candidateAccounts.map((candidate, index) => {
    const currencySuffix = candidate.currency
      ? ` (${candidate.currency.trim().toUpperCase()})`
      : '';
    return `${index + 1}. ${candidate.name}${currencySuffix}`;
  });
  const batchLine = draft.records.length > 1
    ? dictionary.languageCode === 'id'
      ? `Item ${draft.pendingRecordIndex + 1} dari ${draft.records.length}`
      : `Item ${draft.pendingRecordIndex + 1} of ${draft.records.length}`
    : undefined;

  if (dictionary.languageCode === 'id') {
    return [
      invalidSelection ? `⚠️ Pilihan akun "${invalidSelection.slice(0, 80)}" belum valid atau masih ambigu.` : undefined,
      `📝 *Pilih Akun Transaksi (#${draft.ticketId})*`,
      `_(Transaksi disiapkan sebagai draft)_`,
      batchLine,
      `💰 *Nominal:* ${formattedAmount}`,
      `🗒️ *Catatan:* ${description}`,
      `📂 *Kategori:* ${categoryName}`,
      '',
      '*Pilih akun yang digunakan:*',
      ...candidateLines,
      '',
      `Balas dengan nomor atau nama akun, atau ketik *batal #${draft.ticketId}* untuk membatalkan.`,
    ].filter(line => line !== undefined).join('\n');
  }

  return [
    invalidSelection ? `⚠️ Account choice "${invalidSelection.slice(0, 80)}" is invalid or still ambiguous.` : undefined,
    `📝 *Choose Transaction Account (#${draft.ticketId})*`,
    `_(Transaction prepared as draft)_`,
    batchLine,
    `💰 *Amount:* ${formattedAmount}`,
    `🗒️ *Note:* ${description}`,
    `📂 *Category:* ${categoryName}`,
    '',
    '*Choose the account to use:*',
    ...candidateLines,
    '',
    `Reply with the account number or name, or type *cancel #${draft.ticketId}* to cancel.`,
  ].filter(line => line !== undefined).join('\n');
}

export function formatAccountSelectionCancellation(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `❌ *Transaksi #${draft.ticketId} dibatalkan.*\nTransaksi tidak dicatat ke Wallet.`
    : `❌ *Transaction #${draft.ticketId} cancelled.*\nThe transaction was not recorded to Wallet.`;
}

export function formatAccountSelectionProcessing(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⏳ Transaksi #${draft.ticketId} sedang diproses. Tunggu hasil transaksi ini sebelum memilih akun lagi.`
    : `⏳ Transaction #${draft.ticketId} is being processed. Wait for this transaction result before choosing an account again.`;
}

export function formatAccountSelectionRetry(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⚠️ Transaksi #${draft.ticketId} belum berhasil dicatat. Transaksi tetap tersimpan dan aman untuk dicoba lagi dengan membalas pilihan akun yang sama.`
    : `⚠️ Transaction #${draft.ticketId} was not recorded. The transaction is still saved and can be retried safely by replying with the same account choice.`;
}

export function formatAccountSelectionUnknownOutcome(
  draft: PendingAccountSelectionDraft,
  totalUncertainCount?: number
): string {
  const dictionary = getDictionary();
  const formattedAmount = formatDraftAmount(draft);
  const record = draft.records[draft.pendingRecordIndex] || draft.records[0];
  const description =
    record?.note || record?.counterParty || (dictionary.languageCode === 'id' ? 'Transaksi' : 'Transaction');
  const accountName =
    draft.accountHint || draft.candidateAccounts[0]?.name || (dictionary.languageCode === 'id' ? 'Akun' : 'Account');
  // Isolated draft formatters do not have enough context to prove the command is globally
  // unambiguous. Default to the safe ticket-qualified protocol unless the caller explicitly
  // confirms that this is the only UNKNOWN item.
  const mustQualifyTicket = totalUncertainCount === undefined || totalUncertainCount > 1;

  if (dictionary.languageCode === 'id') {
    return [
      '⚠️ *Belum bisa memastikan transaksi sudah tercatat*',
      '',
      `*${formattedAmount}* • ${description} (#${draft.ticketId})`,
      `Akun: ${accountName}`,
      '',
      'Jangan kirim ulang transaksi ini dulu agar tidak tercatat dua kali. Transaksi ini tidak akan dikirim ulang otomatis.',
      '',
      'Cek Wallet, lalu balas:',
      mustQualifyTicket ? `• *Sudah ada #${draft.ticketId}*` : '• *Sudah ada*',
      mustQualifyTicket ? `• *Belum ada #${draft.ticketId}*` : '• *Belum ada*',
    ].join('\n');
  }

  return [
    '⚠️ *Cannot confirm whether transaction was recorded*',
    '',
    `*${formattedAmount}* • ${description} (#${draft.ticketId})`,
    `Account: ${accountName}`,
    '',
    'Do not retry this transaction yet to avoid duplicate records. This transaction will not be retried automatically.',
    '',
    'Check Wallet, then reply:',
    mustQualifyTicket ? `• *Already exists #${draft.ticketId}*` : '• *Already exists*',
    mustQualifyTicket ? `• *Not there #${draft.ticketId}*` : '• *Not there*',
  ].join('\n');
}
