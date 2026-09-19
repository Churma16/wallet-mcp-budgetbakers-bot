import { PendingAccountSelectionDraft } from '../services/pendingTransactionService.js';
import { WalletCategoryItem } from '../types/walletTypes.js';
import { getDictionary } from '../i18n/index.js';
import { formatCurrencyAmount } from './humanResponseFormatter.js';
import { applicationLogger } from './logger.js';

export function resolveCategoryName(
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

export function formatDraftAmount(draft: PendingAccountSelectionDraft): string {
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

export function formatDeterministicCandidateSection(
  draft: PendingAccountSelectionDraft
): string {
  const dictionary = getDictionary();
  const candidateLines = draft.candidateAccounts.map((candidate, index) => {
    const currencySuffix = candidate.currency
      ? ` (${candidate.currency.trim().toUpperCase()})`
      : '';
    return `${index + 1}. ${candidate.name}${currencySuffix}`;
  });

  const header = dictionary.languageCode === 'id'
    ? '*Pilih akun yang digunakan:*'
    : '*Choose the account to use:*';

  const footer = dictionary.languageCode === 'id'
    ? `Balas dengan nomor atau nama akun, atau ketik *batal #${draft.ticketId}* untuk membatalkan.`
    : `Reply with the account number or name, or type *cancel #${draft.ticketId}* to cancel.`;

  return [header, ...candidateLines, '', footer].join('\n');
}

function isCandidateHeaderLine(line: string): boolean {
  const normalized = line.trim().toLowerCase().replace(/^\*|\*$/g, '');
  return (
    normalized === 'pilih akun yang digunakan:' ||
    normalized === 'pilih akun yang digunakan' ||
    normalized === 'pilih salah satu akun:' ||
    normalized === 'pilih salah satu akun' ||
    normalized === 'pilih akun:' ||
    normalized === 'pilih akun' ||
    normalized === 'choose the account to use:' ||
    normalized === 'choose the account to use' ||
    normalized === 'choose the account:' ||
    normalized === 'choose the account' ||
    normalized === 'choose an account:' ||
    normalized === 'choose an account'
  );
}

function isReplyOrCancelLine(line: string): boolean {
  const lower = line.trim().toLowerCase();
  return (
    lower.startsWith('balas dengan nomor') ||
    lower.startsWith('reply with the account') ||
    lower.startsWith('reply with account') ||
    lower.startsWith('ketik *batal') ||
    lower.startsWith('ketik batal') ||
    lower.startsWith('type *cancel') ||
    lower.startsWith('type cancel')
  );
}

function parseCandidateListLine(line: string): { index: number; text: string } | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^(\d+)[\.\)]\s+(.*)$/);
  if (!match) {
    return null;
  }
  return {
    index: Number.parseInt(match[1], 10),
    text: match[2].trim(),
  };
}

export function composeClarificationMessage(
  rawGeneratedQuestion: string,
  draft: PendingAccountSelectionDraft,
  categories: WalletCategoryItem[],
  invalidSelection?: string
): string {
  const dictionary = getDictionary();
  const fallbackTemplate = formatAccountSelectionPrompt(draft, categories, invalidSelection);

  if (!rawGeneratedQuestion || rawGeneratedQuestion.trim().length === 0) {
    return fallbackTemplate;
  }

  const lines = rawGeneratedQuestion.split('\n');
  const foundListItems: Array<{ index: number; text: string }> = [];

  for (const line of lines) {
    const parsedLine = parseCandidateListLine(line);
    if (parsedLine) {
      foundListItems.push(parsedLine);
    }
  }

  // 1. Detect conflicting, swapped, or hallucinated candidate list rendered by the LLM
  if (foundListItems.length > 0) {
    let hasContradictionOrHallucination = false;
    if (foundListItems.length !== draft.candidateAccounts.length) {
      hasContradictionOrHallucination = true;
    } else {
      for (let i = 0; i < foundListItems.length; i++) {
        const item = foundListItems[i];
        const expectedCandidate = draft.candidateAccounts[i];
        if (item.index !== i + 1) {
          hasContradictionOrHallucination = true;
          break;
        }
        if (!item.text.toLowerCase().includes(expectedCandidate.name.toLowerCase())) {
          hasContradictionOrHallucination = true;
          break;
        }
      }
    }

    if (hasContradictionOrHallucination) {
      applicationLogger.warn(
        `[Account Clarification] LLM question output for draft #${draft.ticketId} contained conflicting or hallucinated candidate list; falling back to deterministic template.`
      );
      return fallbackTemplate;
    }
  }

  // 2. Detect swapped inline candidate numbering in raw text (e.g. "1. BCA Bisnis" when #1 is BCA Tahapan)
  for (let candidateIdx = 0; candidateIdx < draft.candidateAccounts.length; candidateIdx++) {
    const candidate = draft.candidateAccounts[candidateIdx];
    const escapedName = candidate.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = rawGeneratedQuestion.match(new RegExp(`\\b(\\d+)[\\.\\)]\\s*${escapedName}\\b`, 'i'));
    if (match) {
      const explicitNumber = Number.parseInt(match[1], 10);
      if (explicitNumber !== candidateIdx + 1) {
        applicationLogger.warn(
          `[Account Clarification] LLM question output for draft #${draft.ticketId} contained swapped inline candidate numbering (${explicitNumber} vs ${candidateIdx + 1}); falling back to deterministic template.`
        );
        return fallbackTemplate;
      }
    }
  }

  // 3. Filter out any candidate list lines, candidate headers, or boilerplate reply/cancel lines to isolate clean preamble
  const cleanPreambleLines = lines.filter(line => {
    if (parseCandidateListLine(line)) return false;
    if (isCandidateHeaderLine(line)) return false;
    if (isReplyOrCancelLine(line)) return false;
    return true;
  });

  let cleanPreamble = cleanPreambleLines.join('\n').trim();

  // Strip trailing reply/cancel instructions if present in prose (e.g. "Balas 1/2 atau batal #1.")
  cleanPreamble = cleanPreamble
    .replace(/\b(?:balas\s+[\d/]+\s+atau\s+)?batal\s+#\d+\.?\s*$/i, '')
    .replace(/\b(?:reply\s+[\d/]+\s+or\s+)?cancel\s+#\d+\.?\s*$/i, '')
    .trim();

  // If the clean preamble is empty after stripping, fall back to the deterministic template
  if (cleanPreamble.length === 0) {
    return fallbackTemplate;
  }

  // 4. Compose the final prompt using application-owned candidate list and cancellation instructions
  const candidateSection = formatDeterministicCandidateSection(draft);
  const invalidNotice = invalidSelection && !cleanPreamble.toLowerCase().includes(invalidSelection.toLowerCase())
    ? (dictionary.languageCode === 'id'
        ? `⚠️ Pilihan akun "${invalidSelection.slice(0, 80)}" belum valid atau masih ambigu.`
        : `⚠️ Account choice "${invalidSelection.slice(0, 80)}" is invalid or still ambiguous.`)
    : undefined;

  const parts = [
    invalidNotice,
    cleanPreamble,
    '',
    candidateSection,
  ].filter(Boolean);

  return parts.join('\n');
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
  const batchLine = draft.records.length > 1
    ? dictionary.languageCode === 'id'
      ? `Item ${draft.pendingRecordIndex + 1} dari ${draft.records.length}`
      : `Item ${draft.pendingRecordIndex + 1} of ${draft.records.length}`
    : undefined;

  const headerLines = dictionary.languageCode === 'id'
    ? [
        invalidSelection ? `⚠️ Pilihan akun "${invalidSelection.slice(0, 80)}" belum valid atau masih ambigu.` : undefined,
        `📝 *Pilih Akun Transaksi (#${draft.ticketId})*`,
        `_(Transaksi disiapkan sebagai draft)_`,
        batchLine,
        `💰 *Nominal:* ${formattedAmount}`,
        `🗒️ *Catatan:* ${description}`,
        `📂 *Kategori:* ${categoryName}`,
      ]
    : [
        invalidSelection ? `⚠️ Account choice "${invalidSelection.slice(0, 80)}" is invalid or still ambiguous.` : undefined,
        `📝 *Choose Transaction Account (#${draft.ticketId})*`,
        `_(Transaction prepared as draft)_`,
        batchLine,
        `💰 *Amount:* ${formattedAmount}`,
        `🗒️ *Note:* ${description}`,
        `📂 *Category:* ${categoryName}`,
      ];

  const candidateSection = formatDeterministicCandidateSection(draft);

  return [...headerLines.filter(line => line !== undefined), '', candidateSection].join('\n');
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

/**
 * Compatibility formatter for callers that still reference the removed UNKNOWN dismissal action.
 * UNKNOWN drafts remain open for reconciliation because the Wallet write may already have committed.
 */
export function formatAccountSelectionUnknownDismissal(
  draft: PendingAccountSelectionDraft
): string {
  const dictionary = getDictionary();
  return dictionary.languageCode === 'id'
    ? `⚠️ Status transaksi #${draft.ticketId} tidak ditutup karena hasil Wallet belum pasti. Cek Wallet lalu balas *Sudah ada #${draft.ticketId}* atau *Belum ada #${draft.ticketId}*.`
    : `⚠️ Transaction #${draft.ticketId} cannot have its status closed while the Wallet outcome is uncertain. Check Wallet, then reply *Already exists #${draft.ticketId}* or *Not there #${draft.ticketId}*.`;
}
