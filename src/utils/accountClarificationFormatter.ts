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

function resolveDraftCurrency(draft: PendingAccountSelectionDraft): string {
  const candidateCurrencies = Array.from(new Set(
    draft.candidateAccounts
      .map(candidate => candidate.currency?.toUpperCase())
      .filter((currency): currency is string => Boolean(currency))
  ));

  return candidateCurrencies.length === 1
    ? candidateCurrencies[0]
    : process.env.DEFAULT_CURRENCY || 'IDR';
}

export function formatAccountSelectionPrompt(
  draft: PendingAccountSelectionDraft,
  categories: WalletCategoryItem[],
  invalidSelection?: string
): string {
  const dictionary = getDictionary();
  const record = draft.records[draft.pendingRecordIndex];
  const formattedAmount = formatCurrencyAmount(record.amount, resolveDraftCurrency(draft));
  const categoryName = resolveCategoryName(record.categoryId, categories);
  const description = record.note || record.counterParty ||
    (dictionary.languageCode === 'id' ? 'Transaksi' : 'Transaction');
  const candidateLines = draft.candidateAccounts.map(
    (candidate, index) => `${index + 1}. ${candidate.name}`
  );
  const batchLine = draft.records.length > 1
    ? dictionary.languageCode === 'id'
      ? `Item ${draft.pendingRecordIndex + 1} dari ${draft.records.length}`
      : `Item ${draft.pendingRecordIndex + 1} of ${draft.records.length}`
    : undefined;

  if (dictionary.languageCode === 'id') {
    return [
      invalidSelection ? `⚠️ Pilihan akun "${invalidSelection.slice(0, 80)}" belum valid atau masih ambigu.` : undefined,
      `📝 *Transaksi disiapkan sebagai draft (#${draft.ticketId})*`,
      batchLine,
      `💰 *Nominal:* ${formattedAmount}`,
      `🗒️ *Catatan:* ${description}`,
      `📂 *Kategori:* ${categoryName}`,
      '',
      '*Pilih akun yang digunakan:*',
      ...candidateLines,
      '',
      'Balas dengan nomor atau nama akun, atau ketik *batal*.',
    ].filter(line => line !== undefined).join('\n');
  }

  return [
    invalidSelection ? `⚠️ Account choice "${invalidSelection.slice(0, 80)}" is invalid or still ambiguous.` : undefined,
    `📝 *Transaction prepared as draft (#${draft.ticketId})*`,
    batchLine,
    `💰 *Amount:* ${formattedAmount}`,
    `🗒️ *Note:* ${description}`,
    `📂 *Category:* ${categoryName}`,
    '',
    '*Choose the account to use:*',
    ...candidateLines,
    '',
    'Reply with the account number or name, or type *cancel*.',
  ].filter(line => line !== undefined).join('\n');
}

export function formatAccountSelectionCancellation(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `❌ *Draft #${draft.ticketId} dibatalkan.*\nTransaksi tidak dicatat ke Wallet.`
    : `❌ *Draft #${draft.ticketId} cancelled.*\nThe transaction was not recorded to Wallet.`;
}

export function formatAccountSelectionProcessing(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⏳ Draft #${draft.ticketId} sedang diproses. Tunggu hasil transaksi ini sebelum memilih akun lagi.`
    : `⏳ Draft #${draft.ticketId} is being processed. Wait for this transaction result before choosing an account again.`;
}

export function formatAccountSelectionRetry(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⚠️ Draft #${draft.ticketId} belum berhasil dicatat. Draft tetap tersimpan dan aman untuk dicoba lagi dengan membalas pilihan akun yang sama.`
    : `⚠️ Draft #${draft.ticketId} was not recorded. The draft is still saved and can be retried safely by replying with the same account choice.`;
}

export function formatAccountSelectionUnknownOutcome(draft: PendingAccountSelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⚠️ Status pencatatan draft #${draft.ticketId} belum dapat dipastikan. Demi mencegah duplikasi, draft tidak akan dikirim ulang otomatis. Periksa Wallet terlebih dahulu.`
    : `⚠️ The recording status of draft #${draft.ticketId} is uncertain. To prevent duplicates, the draft will not be sent again automatically. Check Wallet first.`;
}
