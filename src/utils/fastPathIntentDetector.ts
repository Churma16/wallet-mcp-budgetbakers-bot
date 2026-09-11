import { TransactionHistoryQueryOptions } from '../types/walletTypes.js';

export interface FastPathTransactionHistoryAction {
  type: 'TRANSACTION_HISTORY';
  options: TransactionHistoryQueryOptions;
}

export type FastPathAction =
  | 'CHECK_BALANCE'
  | 'CHECK_BUDGET'
  | 'HELP_MENU'
  | FastPathTransactionHistoryAction
  | null;

function parseTransactionHistoryIntent(userMessageText: string): FastPathTransactionHistoryAction | null {
  const trimmedLowerText = userMessageText.toLowerCase().trim();

  // Price indicator check: if text has price units (rb, k, jt, ribu, juta) or currency words (rp),
  // it is almost certainly a transaction recording, not a history query.
  if (/(?:^|\s)(?:rb|k|jt|ribu|juta|rp)(?:$|\s|\d)/i.test(trimmedLowerText)) {
    return null;
  }

  // Common recording verbs: if text starts with explicit transaction recording keywords
  if (/^(?:beli|bayar|catat|transfer|topup|top\s*up)\b/i.test(trimmedLowerText)) {
    return null;
  }

  // 1. Pattern matching "X transaksi terakhir" or "X last/recent transactions"
  const leadingCountMatch = trimmedLowerText.match(
    /^(?:cek|lihat|show|view)?\s*(\d+)\s+(?:transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?)(?:\s+(terlama|oldest|terbaru|newest))?$/i
  );
  if (leadingCountMatch) {
    const parsedLimit = Number.parseInt(leadingCountMatch[1], 10);
    const sortKeyword = leadingCountMatch[2]?.toLowerCase();
    const resolvedSort = (sortKeyword === 'terlama' || sortKeyword === 'oldest') ? 'oldest' : 'newest';
    return {
      type: 'TRANSACTION_HISTORY',
      options: {
        limit: Number.isNaN(parsedLimit) ? undefined : parsedLimit,
        sort: resolvedSort,
      },
    };
  }

  // 2. Pattern matching history commands with optional parameters:
  // e.g. "riwayat", "cek riwayat", "history", "transaksi terakhir", "daftar transaksi", "recent transactions", "last transactions"
  const historyCommandPattern =
    /^(?:cek|lihat|info|daftar|show|view|check|get|my)?\s*(?:riwayat\s+transaksi|transaction\s+history|daftar\s+transaksi|transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?|riwayat|history)(?:\s+(.*))?$/i;
  const historyMatch = trimmedLowerText.match(historyCommandPattern);
  if (!historyMatch) {
    return null;
  }

  const remainderString = (historyMatch[1] || '').trim();
  let resolvedLimit: number | undefined = undefined;
  let resolvedPage: number | undefined = undefined;
  let resolvedSort: 'newest' | 'oldest' = 'newest';

  if (remainderString) {
    if (/\b(?:terlama|oldest)\b/i.test(remainderString)) {
      resolvedSort = 'oldest';
    } else if (/\b(?:terbaru|newest)\b/i.test(remainderString)) {
      resolvedSort = 'newest';
    }

    const pageMatch = remainderString.match(/\b(?:hal(?:aman)?|page|p)\s*(\d+)\b/i);
    if (pageMatch && pageMatch[1]) {
      const parsedPage = Number.parseInt(pageMatch[1], 10);
      if (!Number.isNaN(parsedPage) && parsedPage > 0) {
        resolvedPage = parsedPage;
      }
    }

    const remainderWithoutPage = remainderString.replace(/\b(?:hal(?:aman)?|page|p)\s*\d+\b/i, '').trim();
    const limitMatch = remainderWithoutPage.match(/\b(\d+)\b/);
    if (limitMatch && limitMatch[1]) {
      const parsedLimit = Number.parseInt(limitMatch[1], 10);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        resolvedLimit = parsedLimit;
      }
    }
  }

  return {
    type: 'TRANSACTION_HISTORY',
    options: {
      limit: resolvedLimit,
      page: resolvedPage,
      sort: resolvedSort,
    },
  };
}

/**
 * Fast-path deterministic classifier that intercepts common repetitive commands
 * (e.g. balance check, budget check, transaction history, help menu) directly in code to save 100% of AI tokens.
 * Supports both Indonesian and English keywords.
 */
export function detectFastPathAction(userMessageText: string): FastPathAction {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  // 0. Transaction history checks (supports parameterized limits, pages, and sorting)
  const transactionHistoryIntent = parseTransactionHistoryIntent(userMessageText);
  if (transactionHistoryIntent) {
    return transactionHistoryIntent;
  }

  const trimmedLowerText = userMessageText.toLowerCase().trim();

  // If the message contains numeric digits or common price indicators (e.g. 50k, 25rb, 10000),
  // it is almost certainly a transaction recording (e.g. "tambah saldo 50rb" or "beli bensin 25k").
  // Do NOT intercept as fast-path to prevent suppressing transaction recordings.
  const hasNumericOrPricePattern = /\d|(?:^|\s)(?:rb|k|jt|ribu|juta)(?:$|\s)/i.test(trimmedLowerText);
  if (hasNumericOrPricePattern) {
    return null;
  }

  // 1. Balance Checks (Indonesian: "saldo", "cek saldo", "rekening"; English: "balance", "check balance", "balances", "my balance")
  const balancePattern = /^(?:cek|lihat|info|total|check|view|show|my)?\s*(?:saldo|balance|balances|rekening|total\s+saldo|account\s+balance|account\s+balances)(?:\s+(?:saya|rekening|accounts))?$/i;
  if (balancePattern.test(trimmedLowerText)) {
    return 'CHECK_BALANCE';
  }

  // 2. Budget Checks (Indonesian: "budget", "cek budget", "anggaran"; English: "budget", "check budget", "budget status", "budgets")
  const budgetPattern = /^(?:cek|lihat|info|status|check|view|show|my)?\s*(?:budget|budgets|anggaran|sisa\s+budget|status\s+budget|status\s+anggaran|budget\s+status)(?:\s+(?:saya|aktif|active))?$/i;
  if (budgetPattern.test(trimmedLowerText)) {
    return 'CHECK_BUDGET';
  }

  // 3. Help / Greetings / Menu (Indonesian: "halo", "bantuan", "panduan"; English: "hello", "hi", "help", "menu", "guide", "start")
  const helpPattern = /^(?:halo|hello|hi|hai|menu|help|bantuan|ping|p|panduan|guide|mulai|start|commands)$/i;
  if (helpPattern.test(trimmedLowerText)) {
    return 'HELP_MENU';
  }

  return null;
}

export interface PendingConfirmationIntent {
  actionType: 'CONFIRM' | 'REJECT';
  targetScope: 'LATEST' | 'ALL' | number;
}

/**
 * Detects confirmation/cancellation replies for pending transaction tickets.
 * Supports Indonesian ("ya", "catat", "batal", "ya semua", "batal semua")
 * and English ("yes", "record", "confirm", "cancel", "reject", "yes all", "cancel all").
 */
export function detectPendingConfirmationAction(userMessageText: string): PendingConfirmationIntent | null {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedText = userMessageText.toLowerCase().trim();

  // 1. Confirm All (e.g. "ya semua", "catat semua", "ok semua", "yes all", "confirm all")
  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'ALL' };
  }

  // 2. Reject All (e.g. "batal semua", "abaikan semua", "cancel all", "reject all")
  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'ALL' };
  }

  // 3. Confirm Specific Ticket (e.g. "ya 1", "catat #2", "yes 3", "record 1")
  const confirmSpecificMatch = trimmedText.match(/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+#?(\d+)$/i);
  if (confirmSpecificMatch && confirmSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(confirmSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'CONFIRM', targetScope: ticketNumber };
    }
  }

  // 4. Reject Specific Ticket (e.g. "batal 1", "cancel 2", "reject 3")
  const rejectSpecificMatch = trimmedText.match(/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+#?(\d+)$/i);
  if (rejectSpecificMatch && rejectSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(rejectSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'REJECT', targetScope: ticketNumber };
    }
  }

  // 5. Confirm Latest Single (e.g. "ya", "catat", "ok", "oke", "y", "yes", "confirm", "record")
  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'LATEST' };
  }

  // 6. Reject Latest Single (e.g. "batal", "abaikan", "gak", "ga", "gajadi", "cancel", "tolak", "reject")
  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'LATEST' };
  }

  return null;
}
