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
  'communication_pc',
  'financial_expenses',
  'food_and_drinks',
  'income',
  'investments',
  'life_entertainment',
  'others',
  'shopping',
  'system_categories',
  'transportation',
  'unknown_records',
  'vehicle',
]);

function extractHistoryQueryOptionsFromTokens(
  rawTokens: string,
  baseOptions: Partial<TransactionHistoryQueryOptions> = {},
  isDedicatedSearchCommand: boolean = false
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
  let resolvedSearchQuery: string | undefined = undefined;

  // Protect quoted search literals before structured-token parsing so reserved
  // filter words inside quotes remain part of the literal search query.
  const explicitQuotedSearchMatch = remainingTokens.match(
    /\b(?:cari|search|find|keyword|q)(?::\s*|=\s*|\s+)(?:"([^"]+)"|'([^']+)')/i
  );
  if (explicitQuotedSearchMatch) {
    resolvedSearchQuery = explicitQuotedSearchMatch[1] || explicitQuotedSearchMatch[2];
    remainingTokens = remainingTokens.replace(explicitQuotedSearchMatch[0], ' ').trim();
  } else {
    const leadingQuotedSearchMatch = remainingTokens.match(/^(?:"([^"]+)"|'([^']+)')(?:\s+|$)/);
    if (leadingQuotedSearchMatch) {
      resolvedSearchQuery = leadingQuotedSearchMatch[1] || leadingQuotedSearchMatch[2];
      remainingTokens = remainingTokens.slice(leadingQuotedSearchMatch[0].length).trim();
    }
  }

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

  // 3. Extract explicit dates or ISO datetimes with optional comparison operators (e.g. >= 2024-01-01, > 2024-01-01T12:00:00Z, gte.2024-01-01, etc.)
  const operatorDateRegex =
    /(?:(>=|>|<=|<|gte\.|gt\.|lte\.|lt\.|eq\.)\s*)?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2}))?)/gi;
  const operatorMatches: Array<{ fullMatch: string; operator?: string; dateString: string }> = [];
  let matchExec: RegExpExecArray | null = null;

  while ((matchExec = operatorDateRegex.exec(remainingTokens)) !== null) {
    operatorMatches.push({
      fullMatch: matchExec[0],
      operator: matchExec[1],
      dateString: matchExec[2],
    });
  }

  if (operatorMatches.length === 1) {
    const singleMatch = operatorMatches[0];
    let resolvedOp = 'eq';
    if (singleMatch.operator) {
      const cleanOp = singleMatch.operator.replace('.', '');
      if (cleanOp === '>' || cleanOp === 'gt') resolvedOp = 'gt';
      else if (cleanOp === '>=' || cleanOp === 'gte') resolvedOp = 'gte';
      else if (cleanOp === '<' || cleanOp === 'lt') resolvedOp = 'lt';
      else if (cleanOp === '<=' || cleanOp === 'lte') resolvedOp = 'lte';
    }
    resolvedDateRange = [`${resolvedOp}.${singleMatch.dateString}`];
    remainingTokens = remainingTokens.replace(singleMatch.fullMatch, ' ').trim();
  } else if (operatorMatches.length >= 2) {
    const firstMatch = operatorMatches[0];
    const secondMatch = operatorMatches[1];

    let firstOp = 'gte';
    if (firstMatch.operator) {
      const cleanOp = firstMatch.operator.replace('.', '');
      if (cleanOp === '>' || cleanOp === 'gt') firstOp = 'gt';
      else if (cleanOp === '>=' || cleanOp === 'gte') firstOp = 'gte';
    }

    let secondOp = 'lte';
    if (secondMatch.operator) {
      const cleanOp = secondMatch.operator.replace('.', '');
      if (cleanOp === '<' || cleanOp === 'lt') secondOp = 'lt';
      else if (cleanOp === '<=' || cleanOp === 'lte') secondOp = 'lte';
    }

    resolvedDateRange = [`${firstOp}.${firstMatch.dateString}`, `${secondOp}.${secondMatch.dateString}`];
    remainingTokens = remainingTokens
      .replace(firstMatch.fullMatch, ' ')
      .replace(secondMatch.fullMatch, ' ')
      .trim();
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

  // 6. Extract relative date period (optionally preceded by preposition: pada, di, on, in, untuk, for)
  const datePeriodPattern = /\b(?:pada|di|on|in|untuk|for)?\s*(hari\s+ini|today|kemarin|yesterday|semalam|minggu\s+ini|this\s+week|minggu\s+lalu|last\s+week|bulan\s+ini|this\s+month|bulan\s+lalu|last\s+month|tahun\s+ini|this\s+year)\b/i;
  const datePeriodMatch = remainingTokens.match(datePeriodPattern);
  if (datePeriodMatch) {
    const rawPeriod = datePeriodMatch[1].toLowerCase();
    if (rawPeriod === 'hari ini' || rawPeriod === 'today') resolvedDatePeriod = 'today';
    else if (rawPeriod === 'kemarin' || rawPeriod === 'yesterday' || rawPeriod === 'semalam') resolvedDatePeriod = 'yesterday';
    else if (rawPeriod === 'minggu ini' || rawPeriod === 'this week') resolvedDatePeriod = 'this_week';
    else if (rawPeriod === 'minggu lalu' || rawPeriod === 'last week') resolvedDatePeriod = 'last_week';
    else if (rawPeriod === 'bulan ini' || rawPeriod === 'this month') resolvedDatePeriod = 'this_month';
    else if (rawPeriod === 'bulan lalu' || rawPeriod === 'last month') resolvedDatePeriod = 'last_month';
    else if (rawPeriod === 'tahun ini' || rawPeriod === 'this year') resolvedDatePeriod = 'this_year';
    remainingTokens = remainingTokens.replace(datePeriodMatch[0], ' ').trim();
  }

  // 7. Extract explicit account and category prefixes (supports unquoted or quoted strings)
  const explicitAccountMatch = remainingTokens.match(/\b(?:dari|di|for|in|pada)?\s*(?:akun|account|rekening)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+)\b)/i);
  if (explicitAccountMatch) {
    resolvedAccountName = (explicitAccountMatch[1] || explicitAccountMatch[2] || explicitAccountMatch[3]).toLowerCase();
    remainingTokens = remainingTokens.replace(explicitAccountMatch[0], ' ').trim();
  } else {
    // Connector followed by known account keyword (e.g. "di bca", "dari mandiri", "for jago")
    const connectorAccountMatch = remainingTokens.match(/\b(?:dari|di|for|in|pada)\s+([a-zA-Z0-9_-]+)\b/i);
    if (connectorAccountMatch && KNOWN_ACCOUNT_KEYWORDS.has(connectorAccountMatch[1].toLowerCase())) {
      resolvedAccountName = connectorAccountMatch[1].toLowerCase();
      remainingTokens = remainingTokens.replace(connectorAccountMatch[0], ' ').trim();
    }
  }

  const explicitCategoryMatch = remainingTokens.match(/\b(?:untuk|for|pada)?\s*(?:kategori|category)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+)\b)/i);
  if (explicitCategoryMatch) {
    resolvedCategoryName = (explicitCategoryMatch[1] || explicitCategoryMatch[2] || explicitCategoryMatch[3]).toLowerCase();
    remainingTokens = remainingTokens.replace(explicitCategoryMatch[0], ' ').trim();
  } else {
    // Connector followed by known category keyword (e.g. "untuk makanan", "for transport")
    const connectorCategoryMatch = remainingTokens.match(/\b(?:untuk|for|pada)\s+([a-zA-Z0-9_-]+)\b/i);
    if (connectorCategoryMatch && KNOWN_CATEGORY_KEYWORDS.has(connectorCategoryMatch[1].toLowerCase())) {
      resolvedCategoryName = connectorCategoryMatch[1].toLowerCase();
      remainingTokens = remainingTokens.replace(connectorCategoryMatch[0], ' ').trim();
    }
  }

  // 7b. Extract explicit search query (e.g. cari "starbucks", search 'coffee', cari:indomaret, q:starbucks, or cari starbucks)
  const explicitSearchMatch = remainingTokens.match(
    /\b(?:cari|search|find|keyword|q)(?::\s*|=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+)\b)/i
  );
  if (explicitSearchMatch) {
    resolvedSearchQuery = explicitSearchMatch[1] || explicitSearchMatch[2] || explicitSearchMatch[3];
    remainingTokens = remainingTokens.replace(explicitSearchMatch[0], ' ').trim();
  }

  // 7c. Extract standalone quoted string if not already set (e.g. "kopi kenangan" or 'starbucks')
  if (!resolvedSearchQuery) {
    const standaloneQuotedMatch = remainingTokens.match(/(?:"([^"]+)"|'([^']+)')/);
    if (standaloneQuotedMatch) {
      resolvedSearchQuery = standaloneQuotedMatch[1] || standaloneQuotedMatch[2];
      remainingTokens = remainingTokens.replace(standaloneQuotedMatch[0], ' ').trim();
    }
  }

  // 9. Inspect leftover tokens
  if (remainingTokens.length > 0) {
    const leftoverWords = remainingTokens.split(/\s+/).filter(word => word.length > 0);
    const searchWords: string[] = [];

    for (const rawWord of leftoverWords) {
      const cleanWord = rawWord.toLowerCase();
      if (KNOWN_ACCOUNT_KEYWORDS.has(cleanWord) && !resolvedAccountName) {
        resolvedAccountName = cleanWord;
      } else if (KNOWN_CATEGORY_KEYWORDS.has(cleanWord) && !resolvedCategoryName) {
        resolvedCategoryName = cleanWord;
      } else {
        searchWords.push(rawWord);
      }
    }

    if (searchWords.length > 0) {
      if (isDedicatedSearchCommand) {
        if (!resolvedSearchQuery) {
          resolvedSearchQuery = searchWords.join(' ');
        } else {
          // Unknown token when search query is already set; fail safe to LLM intent analysis
          return null;
        }
      } else {
        // Unknown token in general history command without search prefix or quotes; fail safe to LLM intent analysis
        return null;
      }
    }
  }

  if (isDedicatedSearchCommand && !resolvedSearchQuery) {
    return null;
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
  if (resolvedSearchQuery !== undefined) {
    resultOptions.searchQuery = resolvedSearchQuery;
  }

  return resultOptions;
}

function parseTransactionHistoryIntent(userMessageText: string): FastPathTransactionHistoryAction | null {
  const trimmedText = userMessageText.trim();
  const trimmedLowerText = trimmedText.toLowerCase();

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
  if (historyMatch) {
    const rawRemainderLower = historyMatch[1];
    if (!rawRemainderLower || !rawRemainderLower.trim()) {
      return {
        type: 'TRANSACTION_HISTORY',
        options: {
          sort: 'newest',
        },
      };
    }

    const matchPrefixLength = trimmedText.length - rawRemainderLower.length;
    const rawRemainder = trimmedText.slice(matchPrefixLength);

    const parsedOptions = extractHistoryQueryOptionsFromTokens(
      rawRemainder,
      {
        sort: 'newest',
      },
      false
    );

    if (parsedOptions) {
      return {
        type: 'TRANSACTION_HISTORY',
        options: parsedOptions,
      };
    }
  }

  // 3. Pattern matching dedicated search commands:
  // e.g. "cari starbucks", "cari transaksi indomaret", "search coffee", "search transactions starbucks", "find kopi"
  const searchPrefixPattern =
    /^(?:cari\s+(?:transaksi|riwayat)|search\s+(?:transactions?|history)|cari|search|find)\s+/i;
  const searchPrefixMatch = trimmedLowerText.match(searchPrefixPattern);
  if (searchPrefixMatch) {
    const rawSearchRemainder = trimmedText.slice(searchPrefixMatch[0].length).trim();
    if (rawSearchRemainder) {
      const parsedSearchOptions = extractHistoryQueryOptionsFromTokens(
        rawSearchRemainder,
        {
          sort: 'newest',
        },
        true
      );
      if (parsedSearchOptions) {
        return {
          type: 'TRANSACTION_HISTORY',
          options: parsedSearchOptions,
        };
      }
    }
  }

  return null;
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