import type {
  MatchedMutationPair,
  MissingMutationItem,
  ReconciliationComparisonResult,
  WrongAccountMutationPair,
} from './types.js';
import {
  FormattedTicketReference,
  reconciliationSessionStore,
} from './reconciliationSessionStore.js';

export { FormattedTicketReference };

export const PAGE_SIZE_MATCHED = 5;
export const PAGE_SIZE_WRONG_ACCOUNT = 5;
export const PAGE_SIZE_MISSING = 10;

export interface InlineKeyboardButton {
  readonly text: string;
  readonly callback_data: string;
}

export interface InlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly InlineKeyboardButton[])[];
}

export interface ReconciliationCardFormatterOptions {
  readonly ticketReferences?: readonly FormattedTicketReference[];
}

export interface FormattedReconciliationCards {
  readonly overview: string;
  readonly matched?: { readonly text: string; readonly replyMarkup?: InlineKeyboardMarkup };
  readonly wrongAccount?: { readonly text: string; readonly replyMarkup?: InlineKeyboardMarkup };
  readonly missing?: { readonly text: string; readonly replyMarkup?: InlineKeyboardMarkup };
}

export function formatAmountIDR(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString('id-ID')}`;
}

export function formatDateShort(isoDate: string): string {
  const parts = isoDate.slice(0, 10).split('-');
  if (parts.length === 3) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    const monthIndex = Number.parseInt(parts[1], 10) - 1;
    const day = Number.parseInt(parts[2], 10);
    return `${day} ${months[monthIndex] || parts[1]}`;
  }
  return isoDate;
}

export function buildPaginationInlineKeyboard(
  sessionId: string,
  type: 'm' | 'w' | 'x',
  page: number,
  totalPages: number
): InlineKeyboardMarkup | undefined {
  if (totalPages <= 1) {
    return undefined;
  }

  const row: InlineKeyboardButton[] = [];
  if (page > 1) {
    row.push({ text: '⬅️ Prev', callback_data: `recon:${sessionId}:${type}:${page - 1}` });
  }

  row.push({ text: `${page}/${totalPages}`, callback_data: 'recon:noop' });

  if (page < totalPages) {
    row.push({ text: 'Next ➡️', callback_data: `recon:${sessionId}:${type}:${page + 1}` });
  }

  return { inline_keyboard: [row] };
}

export function buildOverviewCard(result: ReconciliationComparisonResult): string {
  const lines: string[] = [
    `📋 *Hasil Rekonsiliasi: ${result.targetAccountName}*`,
    `_Periode: ${formatDateShort(result.dateRange.startDate)} – ${formatDateShort(result.dateRange.endDate)} (${result.totalMutations} transaksi)_\n`,
    `• 🟢 Sudah Sesuai: *${result.matched.length} transaksi*`,
    `• 🟡 Salah Akun / Wallet: *${result.wrongAccount.length} transaksi*`,
    `• 🔴 Belum Tercatat: *${result.missing.length} transaksi*`,
  ];

  if (result.matched.length > 0 && result.wrongAccount.length === 0 && result.missing.length === 0) {
    lines.push('\n🎉 *Semua transaksi mutasi tercatat lengkap di Wallet!*');
  }

  return lines.join('\n');
}

export function buildMatchedCard(
  matched: readonly MatchedMutationPair[],
  page: number = 1,
  pageSize: number = PAGE_SIZE_MATCHED
): string {
  const total = matched.length;
  if (total === 0) {
    return '';
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = matched.slice(startIndex, startIndex + pageSize);

  const header = totalPages > 1
    ? `🟢 *Sudah Sesuai (Hal ${currentPage}/${totalPages} - Total ${total})*`
    : `🟢 *Sudah Sesuai (Total ${total})*`;

  const lines: string[] = [header, ''];

  for (let i = 0; i < pageItems.length; i++) {
    const pair = pageItems[i];
    const itemNumber = startIndex + i + 1;
    const formattedAmount = formatAmountIDR(pair.mutation.amount);
    const dateStr = formatDateShort(pair.mutation.date);
    lines.push(`${itemNumber}. *${pair.mutation.counterParty}*`);
    lines.push(`   ${formattedAmount} • _${dateStr}_\n`);
  }

  return lines.join('\n').trim();
}

export function buildWrongAccountCard(
  wrongAccount: readonly WrongAccountMutationPair[],
  targetAccountName: string,
  page: number = 1,
  pageSize: number = PAGE_SIZE_WRONG_ACCOUNT
): string {
  const total = wrongAccount.length;
  if (total === 0) {
    return '';
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = wrongAccount.slice(startIndex, startIndex + pageSize);

  const header = totalPages > 1
    ? `🟡 *Salah Wallet / Akun (Hal ${currentPage}/${totalPages} - Total ${total})*`
    : `🟡 *Salah Wallet / Akun (Total ${total})*`;

  const lines: string[] = [header, ''];

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i];
    const itemNumber = startIndex + i + 1;
    const formattedAmount = formatAmountIDR(item.mutation.amount);
    const dateStr = formatDateShort(item.mutation.date);
    lines.push(`${itemNumber}. *${item.mutation.counterParty}*`);
    lines.push(`   *${formattedAmount}* • _${dateStr}_`);
    lines.push(`   ↳ Tercatat di: *${item.actualAccountName}* (seharusnya ${targetAccountName})\n`);
  }

  return lines.join('\n').trim();
}

export function buildMissingCard(
  missing: readonly MissingMutationItem[],
  ticketMap: ReadonlyMap<string, number>,
  page: number = 1,
  pageSize: number = PAGE_SIZE_MISSING
): string {
  const total = missing.length;
  if (total === 0) {
    return '';
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * pageSize;
  const pageItems = missing.slice(startIndex, startIndex + pageSize);

  const header = totalPages > 1
    ? `🔴 *Terlewat / Belum Tercatat (Hal ${currentPage}/${totalPages} - Total ${total})*`
    : `🔴 *Terlewat / Belum Tercatat (Total ${total})*`;

  const lines: string[] = [header, ''];
  const ticketIds: number[] = [];

  for (let i = 0; i < pageItems.length; i++) {
    const item = pageItems[i];
    const itemNumber = startIndex + i + 1;
    const ticketId = ticketMap.get(item.mutation.id);
    const ticketPrefix = ticketId ? `[Tiket #${ticketId}] ` : '';
    if (ticketId) {
      ticketIds.push(ticketId);
    }

    const formattedAmount = formatAmountIDR(item.mutation.amount);
    const dateStr = formatDateShort(item.mutation.date);
    lines.push(`${itemNumber}. *${item.mutation.counterParty}*`);
    lines.push(`   *${ticketPrefix}${formattedAmount}* • _${dateStr}_\n`);
  }

  if (ticketIds.length > 0) {
    const ticketRangeStr = ticketIds.length === 1 ? `${ticketIds[0]}` : ticketIds.join(',');
    lines.push(`💡 _Balas *Ya ${ticketRangeStr}* untuk konfirmasi catat ke Wallet, atau *Batal*._`);
  }

  return lines.join('\n').trim();
}

/**
 * Formats all individual reconciliation cards and their pagination markups.
 */
export function formatReconciliationCards(
  sessionId: string,
  result: ReconciliationComparisonResult,
  options?: ReconciliationCardFormatterOptions
): FormattedReconciliationCards {
  const ticketMap = new Map<string, number>();
  if (options?.ticketReferences) {
    for (const ref of options.ticketReferences) {
      ticketMap.set(ref.mutationId, ref.ticketId);
    }
  }

  const overview = buildOverviewCard(result);

  let matched: { text: string; replyMarkup?: InlineKeyboardMarkup } | undefined;
  if (result.matched.length > 0) {
    const text = buildMatchedCard(result.matched, 1, PAGE_SIZE_MATCHED);
    const totalPages = Math.ceil(result.matched.length / PAGE_SIZE_MATCHED);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'm', 1, totalPages);
    matched = { text, replyMarkup };
  }

  let wrongAccount: { text: string; replyMarkup?: InlineKeyboardMarkup } | undefined;
  if (result.wrongAccount.length > 0) {
    const text = buildWrongAccountCard(result.wrongAccount, result.targetAccountName, 1, PAGE_SIZE_WRONG_ACCOUNT);
    const totalPages = Math.ceil(result.wrongAccount.length / PAGE_SIZE_WRONG_ACCOUNT);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'w', 1, totalPages);
    wrongAccount = { text, replyMarkup };
  }

  let missing: { text: string; replyMarkup?: InlineKeyboardMarkup } | undefined;
  if (result.missing.length > 0) {
    const text = buildMissingCard(result.missing, ticketMap, 1, PAGE_SIZE_MISSING);
    const totalPages = Math.ceil(result.missing.length / PAGE_SIZE_MISSING);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'x', 1, totalPages);
    missing = { text, replyMarkup };
  }

  return { overview, matched, wrongAccount, missing };
}

/**
 * Handles interactive pagination callback queries (e.g. recon:<sessionId>:<type>:<page>)
 */
export function handleReconciliationPagination(
  callbackData: string
): { text: string; replyMarkup?: InlineKeyboardMarkup } | null {
  if (!callbackData.startsWith('recon:') || callbackData === 'recon:noop') {
    return null;
  }

  const parts = callbackData.split(':');
  if (parts.length !== 4) {
    return null;
  }

  const [, sessionId, type, pageStr] = parts;
  const page = Number.parseInt(pageStr, 10);
  if (!Number.isFinite(page) || page < 1) {
    return null;
  }

  const session = reconciliationSessionStore.getSession(sessionId);
  if (!session) {
    return null;
  }

  const { result, targetAccountName, ticketReferences } = session;

  if (type === 'm') {
    const totalPages = Math.ceil(result.matched.length / PAGE_SIZE_MATCHED);
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const text = buildMatchedCard(result.matched, clampedPage, PAGE_SIZE_MATCHED);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'm', clampedPage, totalPages);
    return { text, replyMarkup };
  }

  if (type === 'w') {
    const totalPages = Math.ceil(result.wrongAccount.length / PAGE_SIZE_WRONG_ACCOUNT);
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const text = buildWrongAccountCard(result.wrongAccount, targetAccountName, clampedPage, PAGE_SIZE_WRONG_ACCOUNT);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'w', clampedPage, totalPages);
    return { text, replyMarkup };
  }

  if (type === 'x') {
    const ticketMap = new Map<string, number>();
    for (const ref of ticketReferences) {
      ticketMap.set(ref.mutationId, ref.ticketId);
    }
    const totalPages = Math.ceil(result.missing.length / PAGE_SIZE_MISSING);
    const clampedPage = Math.max(1, Math.min(page, totalPages));
    const text = buildMissingCard(result.missing, ticketMap, clampedPage, PAGE_SIZE_MISSING);
    const replyMarkup = buildPaginationInlineKeyboard(sessionId, 'x', clampedPage, totalPages);
    return { text, replyMarkup };
  }

  return null;
}

/**
 * Backward compatible single-card formatter.
 */
export function formatReconciliationCard(
  result: ReconciliationComparisonResult,
  options?: ReconciliationCardFormatterOptions
): string {
  const cards = formatReconciliationCards('legacy', result, options);
  const parts: string[] = [cards.overview];
  if (cards.matched) parts.push(cards.matched.text);
  if (cards.wrongAccount) parts.push(cards.wrongAccount.text);
  if (cards.missing) parts.push(cards.missing.text);
  return parts.join('\n\n');
}
