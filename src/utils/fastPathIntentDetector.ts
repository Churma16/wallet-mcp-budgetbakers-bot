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

const KNOWN_ACCOUNT_KEYWORDS = new Set([
  'bca',
  'mandiri',
  'bri',
  'bni',
  'jago',
  'cimb',
  'jenius',
  'permata',
  'bsi',
  'seabank',
  'blu',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
  'linkaja',
  'cash',
  'tunai',
  'dompet',
  'bank',
  'rekening',
  'wallet',
]);

const KNOWN_CATEGORY_KEYWORDS = new Set([
  'makanan',
  'minuman',
  'food',
  'drink',
  'drinks',
  'makan',
  'minum',
  'transport',
  'transportasi',
  'belanja',
  'shopping',
  'hiburan',
  'entertainment',
  'tagihan',
  'bills',
  'investasi',
  'investment',
  'gaji',
  'salary',
  'kesehatan',
  'health',
  'pulsa',
  'listrik',
  'kendaraan',
  'rumah',
  'housing',
  'pendidikan',
  'education',
]);

function extractHistoryQueryOptionsFromTokens(
  rawTokens: string,
  baseOptions: Partial<TransactionHistoryQueryOptions> = {}
): TransactionHistoryQueryOptions | null {
  let remainingTokens = rawTokens.trim();
  let resolvedLimit: number | undefined = baseOptions.limit;
  let resolvedPage: number | undefined = baseOptions.page;
  let resolvedSort: 'newest' | 'oldest' = baseOptions.sort || 'newest';
  let resolvedRecordType: 'expense' | 'income' | undefined = undefined;
  let resolvedDatePeriod: TransactionHistoryQueryOptions['datePeriod'] = undefined;
  let resolvedDateRange: string[] | undefined = undefined;
  let resolvedAccountName: string | undefined = undefined;
  let resolvedCategoryName: string | undefined = undefined;

  // 1. Extract sort token
  const sortMatch = remainingTokens.match(/\b(terlama|oldest|terbaru|newest)\b/i);
  if (sortMatch) {
    const matchedSortWord = sortMatch[1].toLowerCase();
    resolvedSort = (matchedSortWord === 'terlama' || matchedSortWord === 'oldest') ? 'oldest' : 'newest';
    remainingTokens = remainingTokens.replace(sortMatch[0], ' ').trim();
  }

  // 2. Extract page token (e.g. "hal 2", "halaman 3", "page 4", "p 5")
  const pageMatch = remainingTokens.match(/\b(?:hal(?:aman)?|page|p)\s*(\d+)\b/i);
  if (pageMatch) {
    const parsedPage = Number.parseInt(pageMatch[1], 10);
    if (Number.isNaN(parsedPage) || parsedPage <= 0) {
      return null;
    }
    resolvedPage = parsedPage;
    remainingTokens = remainingTokens.replace(pageMatch[0], ' ').trim();
  }

  // 3. Extract explicit ISO dates (e.g. 2024-01-01) before standalone limit numbers
  const isoDateMatches = remainingTokens.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
  if (isoDateMatches) {
    if (isoDateMatches.length === 1) {
      resolvedDateRange = [`eq.${isoDateMatches[0]}`];
      remainingTokens = remainingTokens.replace(isoDateMatches[0], ' ').trim();
    } else if (isoDateMatches.length >= 2) {
      resolvedDateRange = [`gte.${isoDateMatches[0]}`, `lte.${isoDateMatches[1]}`];
      remainingTokens = remainingTokens.replace(isoDateMatches[0], ' ').replace(isoDateMatches[1], ' ').trim();
    }
  }

  // 4. Extract limit token (standalone positive integer) if not already set
  if (!resolvedLimit) {
    const limitMatch = remainingTokens.match(/\b(\d+)\b/);
    if (limitMatch) {
      const parsedLimit = Number.parseInt(limitMatch[1], 10);
      if (Number.isNaN(parsedLimit) || parsedLimit <= 0 || parsedLimit > 100) {
        return null;
      }
      resolvedLimit = parsedLimit;
      remainingTokens = remainingTokens.replace(limitMatch[0], ' ').trim();
    }
  }

  // 5. Extract record type (expense / income)
  const expenseMatch = remainingTokens.match(/\b(pengeluaran|keluar|expenses?|spending)\b/i);
  if (expenseMatch) {
    resolvedRecordType = 'expense';
    remainingTokens = remainingTokens.replace(expenseMatch[0], ' ').trim();
  } else {
    const incomeMatch = remainingTokens.match(/\b(pemasukan|masuk|income)\b/i);
    if (incomeMatch) {
      resolvedRecordType = 'income';
      remainingTokens = remainingTokens.replace(incomeMatch[0], ' ').trim();
    }
  }

  // 6. Extract relative date period
  const todayMatch = remainingTokens.match(/\b(hari\s+ini|today)\b/i);
  if (todayMatch) {
    resolvedDatePeriod = 'today';
    remainingTokens = remainingTokens.replace(todayMatch[0], ' ').trim();
  } else {
    const yesterdayMatch = remainingTokens.match(/\b(kemarin|yesterday|semalam)\b/i);
    if (yesterdayMatch) {
      resolvedDatePeriod = 'yesterday';
      remainingTokens = remainingTokens.replace(yesterdayMatch[0], ' ').trim();
    } else {
      const thisWeekMatch = remainingTokens.match(/\b(minggu\s+ini|this\s+week)\b/i);
      if (thisWeekMatch) {
        resolvedDatePeriod = 'this_week';
        remainingTokens = remainingTokens.replace(thisWeekMatch[0], ' ').trim();
      } else {
        const lastWeekMatch = remainingTokens.match(/\b(minggu\s+lalu|last\s+week)\b/i);
        if (lastWeekMatch) {
          resolvedDatePeriod = 'last_week';
          remainingTokens = remainingTokens.replace(lastWeekMatch[0], ' ').trim();
        } else {
          const thisMonthMatch = remainingTokens.match(/\b(bulan\s+ini|this\s+month)\b/i);
          if (thisMonthMatch) {
            resolvedDatePeriod = 'this_month';
            remainingTokens = remainingTokens.replace(thisMonthMatch[0], ' ').trim();
          } else {
            const lastMonthMatch = remainingTokens.match(/\b(bulan\s+lalu|last\s+month)\b/i);
            if (lastMonthMatch) {
              resolvedDatePeriod = 'last_month';
              remainingTokens = remainingTokens.replace(lastMonthMatch[0], ' ').trim();
            } else {
              const thisYearMatch = remainingTokens.match(/\b(tahun\s+ini|this\s+year)\b/i);
              if (thisYearMatch) {
                resolvedDatePeriod = 'this_year';
                remainingTokens = remainingTokens.replace(thisYearMatch[0], ' ').trim();
              }
            }
          }
        }
      }
    }
  }

  // 7. Extract explicit account and category prefixes (supports unquoted or quoted strings)
  const explicitAccountMatch = remainingTokens.match(/\b(?:akun|account|rekening)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+))\b/i);
  if (explicitAccountMatch) {
    resolvedAccountName = explicitAccountMatch[1] || explicitAccountMatch[2] || explicitAccountMatch[3];
    remainingTokens = remainingTokens.replace(explicitAccountMatch[0], ' ').trim();
  }

  const explicitCategoryMatch = remainingTokens.match(/\b(?:kategori|category)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+))\b/i);
  if (explicitCategoryMatch) {
    resolvedCategoryName = explicitCategoryMatch[1] || explicitCategoryMatch[2] || explicitCategoryMatch[3];
    remainingTokens = remainingTokens.replace(explicitCategoryMatch[0], ' ').trim();
  }

  // 8. Remove grammatical connectors
  remainingTokens = remainingTokens.replace(/\b(dari|di|untuk|for|in|on|pada)\b/gi, ' ').trim();

  // 9. Inspect leftover tokens
  if (remainingTokens.length > 0) {
    const leftoverWords = remainingTokens.split(/\s+/).filter(word => word.length > 0);

    for (const rawWord of leftoverWords) {
      const cleanWord = rawWord.toLowerCase();
      if (KNOWN_ACCOUNT_KEYWORDS.has(cleanWord) && !resolvedAccountName) {
        resolvedAccountName = cleanWord;
      } else if (KNOWN_CATEGORY_KEYWORDS.has(cleanWord) && !resolvedCategoryName) {
        resolvedCategoryName = cleanWord;
      } else {
        // Unknown token; fail safe to LLM intent analysis
        return null;
      }
    }
  }

  const resultOptions: TransactionHistoryQueryOptions = {
    limit: resolvedLimit,
    page: resolvedPage,
    sort: resolvedSort,
  };

  if (resolvedRecordType !== undefined) {
    resultOptions.recordType = resolvedRecordType;
  }
  if (resolvedDatePeriod !== undefined) {
    resultOptions.datePeriod = resolvedDatePeriod;
  }
  if (resolvedDateRange !== undefined) {
    resultOptions.dateRange = resolvedDateRange;
  }
  if (resolvedAccountName !== undefined) {
    resultOptions.accountName = resolvedAccountName;
  }
  if (resolvedCategoryName !== undefined) {
    resultOptions.categoryName = resolvedCategoryName;
  }

  return resultOptions;
}

function parseTransactionHistoryIntent(userMessageText: string): FastPathTransactionHistoryAction | null {
  const trimmedLowerText = userMessageText.toLowerCase().trim();

  // Price indicator check: if text contains transaction amounts (e.g. 25rb, 50k, 100 ribu, 1jt, 50000rp, rp 50000)
  // or currency words, it is almost certainly a transaction recording, not a history query.
  const hasTransactionAmountPattern =
    /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      trimmedLowerText
    );
  if (hasTransactionAmountPattern) {
    return null;
  }

  // Common recording verbs: if text starts with explicit transaction recording keywords
  if (/^(?:beli|bayar|catat|transfer|topup|top\s*up)\b/i.test(trimmedLowerText)) {
    return null;
  }

  // 1. Pattern matching "X transaksi terakhir" or "X last/recent transactions"
  const leadingCountMatch = trimmedLowerText.match(
    /^(?:cek|lihat|show|view)?\s*(\d+)\s+(?:transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?)(?:\s+(.*))?$/i
  );
  if (leadingCountMatch) {
    const parsedLimit = Number.parseInt(leadingCountMatch[1], 10);
    if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
      return null;
    }

    let trailingTokens = (leadingCountMatch[2] || '').trim();
    let resolvedSort: 'newest' | 'oldest' = 'newest';
    let resolvedPage: number | undefined = undefined;

    if (trailingTokens) {
      const sortMatch = trailingTokens.match(/\b(terlama|oldest|terbaru|newest)\b/i);
      if (sortMatch) {
        const matchedSortWord = sortMatch[1].toLowerCase();
        resolvedSort = (matchedSortWord === 'terlama' || matchedSortWord === 'oldest') ? 'oldest' : 'newest';
        trailingTokens = trailingTokens.replace(sortMatch[0], ' ').trim();
      }

      const pageMatch = trailingTokens.match(/\b(?:hal(?:aman)?|page|p)\s*(\d+)\b/i);
      if (pageMatch) {
        const parsedPage = Number.parseInt(pageMatch[1], 10);
        if (Number.isNaN(parsedPage) || parsedPage <= 0) {
          return null;
        }
        resolvedPage = parsedPage;
        trailingTokens = trailingTokens.replace(pageMatch[0], ' ').trim();
      }

      // If unknown trailing tokens remain, reject
      if (trailingTokens.length > 0) {
        return null;
      }
    }

    return {
      type: 'TRANSACTION_HISTORY',
      options: {
        limit: parsedLimit,
        page: resolvedPage,
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

  const rawRemainder = historyMatch[1];
  if (!rawRemainder || !rawRemainder.trim()) {
    return {
      type: 'TRANSACTION_HISTORY',
      options: {
        sort: 'newest',
      },
    };
  }

  const parsedOptions = extractHistoryQueryOptionsFromTokens(rawRemainder, {
    sort: 'newest',
  });

  if (!parsedOptions) {
    return null;
  }

  return {
    type: 'TRANSACTION_HISTORY',
    options: parsedOptions,
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
  const hasNumericOrPricePattern =
    /\d|\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      trimmedLowerText
    );
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
