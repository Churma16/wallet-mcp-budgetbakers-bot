import {
  PendingCategorySelectionDraft,
} from '../../core/pending.js';
import { WalletCategoryItem } from '../../wallet/types.js';
import { getDictionary } from '../../i18n/index.js';
import { formatCurrencyAmount } from '../../wallet/formatters/humanResponseFormatter.js';

export function formatCategoryDraftAmount(draft: PendingCategorySelectionDraft): string {
  const dictionary = getDictionary();
  const record = draft.records[draft.pendingRecordIndex];
  const resolvedCurrency = record?.currency || 'IDR';

  if (record?.amount !== undefined) {
    return formatCurrencyAmount(record.amount, resolvedCurrency);
  }

  return '';
}

export function formatDeterministicCategoryCandidateSection(
  draft: PendingCategorySelectionDraft
): string {
  const dictionary = getDictionary();
  const candidateLines = draft.candidateCategories.map((candidate, index) => {
    return `${index + 1}. ${candidate.name}`;
  });

  const header = dictionary.languageCode === 'id'
    ? `*Pilih kategori yang sesuai untuk "${draft.categoryHint}":*`
    : `*Choose the appropriate category for "${draft.categoryHint}":*`;

  const footer = dictionary.languageCode === 'id'
    ? `Balas dengan nomor atau nama kategori, atau ketik *batal #${draft.ticketId}* untuk membatalkan.`
    : `Reply with the category number or name, or type *cancel #${draft.ticketId}* to cancel.`;

  return [header, ...candidateLines, '', footer].join('\n');
}

export function formatCategorySelectionPrompt(
  draft: PendingCategorySelectionDraft,
  categories: WalletCategoryItem[] = [],
  invalidSelection?: string
): string {
  const dictionary = getDictionary();
  const record = draft.records[draft.pendingRecordIndex];
  const formattedAmount = formatCategoryDraftAmount(draft);
  const description = record?.note || record?.counterParty || '';

  const lines: string[] = [];

  if (invalidSelection) {
    const invalidNotice = dictionary.languageCode === 'id'
      ? `_Pilihan "${invalidSelection}" tidak valid. Silakan pilih nomor atau nama dari daftar di bawah._\n`
      : `_Selection "${invalidSelection}" is invalid. Please choose a number or name from the list below._\n`;
    lines.push(invalidNotice);
  }

  const transactionSummaryParts: string[] = [];
  if (description) {
    transactionSummaryParts.push(`*${description}*`);
  }
  if (formattedAmount) {
    transactionSummaryParts.push(`(${formattedAmount})`);
  }

  if (transactionSummaryParts.length > 0) {
    const summaryPrefix = dictionary.languageCode === 'id' ? 'Transaksi:' : 'Transaction:';
    lines.push(`${summaryPrefix} ${transactionSummaryParts.join(' ')}`);
  }

  lines.push(formatDeterministicCategoryCandidateSection(draft));

  return lines.join('\n');
}

export function formatCategorySelectionCancellation(draft: PendingCategorySelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `Draft transaksi #${draft.ticketId} (pemilihan kategori) telah dibatalkan.`
    : `Transaction draft #${draft.ticketId} (category selection) has been cancelled.`;
}

export function formatCategorySelectionProcessing(draft: PendingCategorySelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `Draft transaksi #${draft.ticketId} sedang diproses. Mohon tunggu sebentar.`
    : `Transaction draft #${draft.ticketId} is currently being processed. Please wait.`;
}

export function formatCategorySelectionRetry(draft: PendingCategorySelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `Gagal menyimpan transaksi ke Wallet. Draft #${draft.ticketId} masih tersimpan. Silakan pilih kembali kategori.`
    : `Failed to save transaction to Wallet. Draft #${draft.ticketId} is preserved. Please select the category again.`;
}

export function formatCategorySelectionUnknownOutcome(draft: PendingCategorySelectionDraft): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `Hasil penyimpanan draft #${draft.ticketId} belum dapat dipastikan karena gangguan koneksi. Cek aplikasi Wallet kamu atau ketik *cek status* sebelum mencoba lagi.`
    : `The outcome of saving draft #${draft.ticketId} is uncertain due to a network interruption. Check your Wallet app or type *check status* before retrying.`;
}
