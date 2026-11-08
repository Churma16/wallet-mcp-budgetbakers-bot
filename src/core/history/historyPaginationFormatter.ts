import type { SupportedLanguage } from '../../i18n/index.js';
import type { TransactionHistoryService, TransactionHistoryQueryOptions } from '../../wallet/index.js';
import { formatTransactionHistoryMessage } from '../../wallet/formatters/humanResponseFormatter.js';
import { historySessionStore } from './historySessionStore.js';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * Builds standard 3-segment Telegram inline pagination keyboard:
 * [ ⬅️ Prev ] [ <page>/<totalPages> ] [ Next ➡️ ]
 * - Prev omitted on page 1
 * - Next omitted on last page
 * - Center counter is a no-op (hist:noop)
 * - Returns undefined if totalPages <= 1
 */
export function buildHistoryPaginationInlineKeyboard(
  sessionId: string,
  page: number,
  totalPages: number
): InlineKeyboardMarkup | undefined {
  if (totalPages <= 1) {
    return undefined;
  }

  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const row: InlineKeyboardButton[] = [];

  if (clampedPage > 1) {
    row.push({ text: '⬅️ Prev', callback_data: `hist:${sessionId}:${clampedPage - 1}` });
  }

  row.push({ text: `${clampedPage}/${totalPages}`, callback_data: 'hist:noop' });

  if (clampedPage < totalPages) {
    row.push({ text: 'Next ➡️', callback_data: `hist:${sessionId}:${clampedPage + 1}` });
  }

  return { inline_keyboard: [row] };
}

export interface HistoryPaginationResult {
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
}

/**
 * Handles interactive transaction history pagination callback queries (e.g. hist:<sessionId>:<page>).
 * Fetches the requested page, formats the response omitting manual hints, and rebuilds the keyboard.
 */
export async function handleHistoryPagination(
  callbackData: string,
  historyService?: TransactionHistoryService,
  languageCode?: SupportedLanguage
): Promise<HistoryPaginationResult | null> {
  if (!callbackData.startsWith('hist:') || callbackData === 'hist:noop' || callbackData.endsWith(':noop')) {
    return null;
  }

  const parts = callbackData.split(':');
  if (parts.length !== 3) {
    return null;
  }

  const [, sessionId, pageStr] = parts;
  const page = Number.parseInt(pageStr, 10);
  if (!Number.isFinite(page) || page < 1) {
    return null;
  }

  const session = historySessionStore.getSession(sessionId);
  if (!session || !historyService) {
    return null;
  }

  const { offset: _ignoredOffset, ...baseOptions } = session.queryOptions || {};
  const queryOptions: TransactionHistoryQueryOptions = {
    ...baseOptions,
    page,
  };

  const historyPage = await historyService.getTransactionHistory(queryOptions);
  const totalPages = historyPage.totalPages ?? session.totalPages;
  const text = formatTransactionHistoryMessage(historyPage, {
    languageCode,
    omitNavigationHint: true,
  });

  const replyMarkup = buildHistoryPaginationInlineKeyboard(sessionId, historyPage.page, totalPages);

  return { text, replyMarkup };
}
