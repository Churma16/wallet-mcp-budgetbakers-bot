import {
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../types/walletTypes.js';

export interface FastPathTransactionHistoryAction {
  type: 'TRANSACTION_HISTORY';
  options: TransactionHistoryQueryOptions;
}

export interface FastPathTransactionSummaryAction {
  type: 'TRANSACTION_SUMMARY';
  options: TransactionSummaryQueryOptions;
}

export type FastPathAction =
  | 'CHECK_BALANCE'
  | 'CHECK_BUDGET'
  | 'HELP_MENU'
  | FastPathTransactionHistoryAction
  | FastPathTransactionSummaryAction
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

  const isWholeRemainderQuotedLiteral = /^(?:"[^"]*"|'[^']*')$/.test(remainingTokens);
  if (
    isDedicatedSearchCommand &&
    remainingTokens.length > 0 &&
    !/\s/.test(remainingTokens) &&
    !isWholeRemainderQuotedLiteral
  ) {
    return {
      limit: resolvedLimit,
      page: resolvedPage,
      sort: resolvedSort,
      searchQuery: remainingTokens,
    };
  }

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

  const sortMatch = remainingTokens.match(/\b(terlama|oldest|terbaru|newest)\b/i);
  if (sortMatch) {
    const matchedSortWord = sortMatch[1].toLowerCase();
    resolvedSort = (matchedSortWord === 'terlama' || matchedSortWord === 'oldest') ? 'oldest' : 'newest';
    remainingTokens = remainingTokens.replace(sortMatch[0], ' ').trim();
  }

  const pageMatch = remainingTokens.match(/\b(?:hal(?:aman)?|page|p)\s*(\d+)\b/i);
  if (pageMatch) {
    const parsedPage = Number.parseInt(pageMatch[1], 10);
    if (Number.isNaN(parsedPage) || parsedPage <= 0) {
      return null;
    }
    resolvedPage = parsedPage;
    remainingTokens = remainingTokens.replace(pageMatch[0], ' ').trim();
  }

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

  const explicitAccountMatch = remainingTokens.match(/\b(?:dari|di|for|in|pada)?\s*(?:akun|account|rekening)\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+)\b)/i);
  if (explicitAccountMatch) {
    resolvedAccountName = (explicitAccountMatch[1] || explicitAccountMatch[2] || explicitAccountMatch[3]).toLowerCase();
    remainingTokens = remainingTokens.replace(explicitAccountMatch[0], ' ').trim();
  } else {
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
    const connectorCategoryMatch = remainingTokens.match(/\b(?:untuk|for|pada)\s+([a-zA-Z0-9_-]+)\b/i);
    if (connectorCategoryMatch && KNOWN_CATEGORY_KEYWORDS.has(connectorCategoryMatch[1].toLowerCase())) {
      resolvedCategoryName = connectorCategoryMatch[1].toLowerCase();
      remainingTokens = remainingTokens.replace(connectorCategoryMatch[0], ' ').trim();
    }
  }

  const explicitSearchMatch = remainingTokens.match(
    /\b(?:cari|search|find|keyword|q)(?::\s*|=\s*|\s+)(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+)\b)/i
  );
  if (explicitSearchMatch) {
    resolvedSearchQuery = explicitSearchMatch[1] || explicitSearchMatch[2] || explicitSearchMatch[3];
    remainingTokens = remainingTokens.replace(explicitSearchMatch[0], ' ').trim();
  }

  if (!resolvedSearchQuery) {
    const standaloneQuotedMatch = remainingTokens.match(/(?:"([^"]+)"|'([^']+)')/);
    if (standaloneQuotedMatch) {
      resolvedSearchQuery = standaloneQuotedMatch[1] || standaloneQuotedMatch[2];
      remainingTokens = remainingTokens.replace(standaloneQuotedMatch[0], ' ').trim();
    }
  }

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
          return null;
        }
      } else {
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

  if (resolvedRecordType !== undefined) resultOptions.recordType = resolvedRecordType;
  if (resolvedDatePeriod !== undefined) resultOptions.datePeriod = resolvedDatePeriod;
  if (resolvedDateRange !== undefined) resultOptions.dateRange = resolvedDateRange;
  if (resolvedAccountName !== undefined) resultOptions.accountName = resolvedAccountName;
  if (resolvedCategoryName !== undefined) resultOptions.categoryName = resolvedCategoryName;
  if (resolvedSearchQuery !== undefined) resultOptions.searchQuery = resolvedSearchQuery;

  return resultOptions;
}

function parseTransactionHistoryIntent(userMessageText: string): FastPathTransactionHistoryAction | null {
  const trimmedText = userMessageText.trim();
  const trimmedLowerText = trimmedText.toLowerCase();

  const hasTransactionAmountPattern =
    /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      trimmedLowerText
    );
  if (hasTransactionAmountPattern) return null;

  if (/^(?:beli|bayar|catat|transfer|topup|top\s*up)\b/i.test(trimmedLowerText)) {
    return null;
  }

  const leadingCountMatch = trimmedLowerText.match(
    /^(?:cek|lihat|show|view)?\s*(\d+)\s+(?:transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?)(?:\s+(.*))?$/i
  );
  if (leadingCountMatch) {
    const parsedLimit = Number.parseInt(leadingCountMatch[1], 10);
    if (Number.isNaN(parsedLimit) || parsedLimit <= 0) return null;

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
        if (Number.isNaN(parsedPage) || parsedPage <= 0) return null;
        resolvedPage = parsedPage;
        trailingTokens = trailingTokens.replace(pageMatch[0], ' ').trim();
      }

      if (trailingTokens.length > 0) return null;
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

  const historyCommandPattern =
    /^(?:cek|lihat|info|daftar|show|view|check|get|my)?\s*(?:riwayat\s+transaksi|transaction\s+history|daftar\s+transaksi|transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?|riwayat|history)(?:\s+(.*))?$/i;
  const historyMatch = trimmedLowerText.match(historyCommandPattern);
  if (historyMatch) {
    const rawRemainderLower = historyMatch[1];
    if (!rawRemainderLower || !rawRemainderLower.trim()) {
      return { type: 'TRANSACTION_HISTORY', options: { sort: 'newest' } };
    }

    const matchPrefixLength = trimmedText.length - rawRemainderLower.length;
    const rawRemainder = trimmedText.slice(matchPrefixLength);
    const parsedOptions = extractHistoryQueryOptionsFromTokens(rawRemainder, { sort: 'newest' }, false);
    if (parsedOptions) {
      return { type: 'TRANSACTION_HISTORY', options: parsedOptions };
    }
  }

  const searchPrefixPattern =
    /^(?:cari\s+(?:transaksi|riwayat)|search\s+(?:transactions?|history)|cari|search|find)\s+/i;
  const searchPrefixMatch = trimmedLowerText.match(searchPrefixPattern);
  if (searchPrefixMatch) {
    const rawSearchRemainder = trimmedText.slice(searchPrefixMatch[0].length).trim();
    if (rawSearchRemainder) {
      const parsedSearchOptions = extractHistoryQueryOptionsFromTokens(
        rawSearchRemainder,
        { sort: 'newest' },
        true
      );
      if (parsedSearchOptions) {
        return { type: 'TRANSACTION_HISTORY', options: parsedSearchOptions };
      }
    }
  }

  return null;
}

function normalizeSummaryRecordType(rawValue: string | undefined): 'expense' | 'income' | undefined {
  if (!rawValue) return undefined;
  return /^(?:pengeluaran|expenses?|spending|spend|spent)$/i.test(rawValue) ? 'expense' : 'income';
}

function parseTransactionSummaryIntent(userMessageText: string): FastPathTransactionSummaryAction | null {
  const trimmedText = userMessageText.trim().replace(/[?!.]+$/g, '').trim();
  const trimmedLowerText = trimmedText.toLowerCase();

  const hasTransactionAmountPattern =
    /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(trimmedLowerText);
  if (hasTransactionAmountPattern) return null;
  if (/^(?:beli|bayar|catat|transfer|topup|top\s*up)\b/i.test(trimmedLowerText)) return null;

  let remainder = trimmedText;
  let explicitRecordType: 'expense' | 'income' | undefined;
  let matchedPrefix = false;

  const slashCommandMatch = remainder.match(/^\/(?:summary|ringkasan|rekap)\b/i);
  if (slashCommandMatch) {
    matchedPrefix = true;
    remainder = remainder.slice(slashCommandMatch[0].length).trim();
  }

  if (!matchedPrefix) {
    const genericSummaryMatch = remainder.match(
      /^(?:cek|lihat|info|show|view|check|get|my)?\s*(?:ringkasan|summary|rekap)(?:\s+transaksi|\s+transactions?)?\b/i
    );
    if (genericSummaryMatch) {
      matchedPrefix = true;
      remainder = remainder.slice(genericSummaryMatch[0].length).trim();
    }
  }

  if (!matchedPrefix) {
    const totalTypeMatch = remainder.match(
      /^(?:cek|lihat|info|show|view|check|get|my)?\s*(?:total|jumlah)\s+(pengeluaran|pemasukan|expenses?|income|spending)\b/i
    );
    if (totalTypeMatch) {
      matchedPrefix = true;
      explicitRecordType = normalizeSummaryRecordType(totalTypeMatch[1]);
      remainder = remainder.slice(totalTypeMatch[0].length).trim();
    }
  }

  if (!matchedPrefix) {
    const typeSummaryMatch = remainder.match(
      /^(pengeluaran|pemasukan|expenses?|income|spending)\s+(?:total|summary|ringkasan)\b/i
    );
    if (typeSummaryMatch) {
      matchedPrefix = true;
      explicitRecordType = normalizeSummaryRecordType(typeSummaryMatch[1]);
      remainder = remainder.slice(typeSummaryMatch[0].length).trim();
    }
  }

  if (!matchedPrefix) {
    const groupedTypeMatch = remainder.match(
      /^(pengeluaran|pemasukan|expenses?|income|spending)\s+(?=(?:per\s+(?:kategori|akun|rekening)|by\s+(?:category|account))\b)/i
    );
    if (groupedTypeMatch) {
      matchedPrefix = true;
      explicitRecordType = normalizeSummaryRecordType(groupedTypeMatch[1]);
      remainder = remainder.slice(groupedTypeMatch[0].length).trim();
    }
  }

  if (!matchedPrefix) {
    const englishQuestionMatch = remainder.match(
      /^(?:how\s+much\s+(?:did\s+i|do\s+i|have\s+i)\s+(spend|spent|earn|earned|make|made)|what(?:'s|\s+is)\s+(?:my\s+)?(?:total\s+)?(spending|expenses?|income|earnings?))\b/i
    );
    if (englishQuestionMatch) {
      matchedPrefix = true;
      explicitRecordType = normalizeSummaryRecordType(englishQuestionMatch[1] || englishQuestionMatch[2]);
      remainder = remainder.slice(englishQuestionMatch[0].length).trim();
      remainder = remainder.replace(/^(?:on|for|from)\s+/i, '').trim();
    }
  }

  if (!matchedPrefix) {
    const indonesianQuestionMatch = remainder.match(
      /^(?:berapa\s+(?:total|jumlah)\s+(pengeluaran|pemasukan)|berapa\s+(pengeluaran|pemasukan))\b/i
    );
    if (indonesianQuestionMatch) {
      matchedPrefix = true;
      explicitRecordType = normalizeSummaryRecordType(
        indonesianQuestionMatch[1] || indonesianQuestionMatch[2]
      );
      remainder = remainder.slice(indonesianQuestionMatch[0].length).trim();
    }
  }

  if (!matchedPrefix) return null;

  let groupBy: TransactionSummaryQueryOptions['groupBy'] = 'none';
  const categoryBreakdownPattern = /\b(?:per\s+kategori|berdasarkan\s+kategori|by\s+category|category\s+breakdown|breakdown\s+(?:per\s+)?kategori)\b/i;
  const accountBreakdownPattern = /\b(?:per\s+(?:akun|rekening)|berdasarkan\s+(?:akun|rekening)|by\s+account|account\s+breakdown|breakdown\s+(?:per\s+)?(?:akun|rekening))\b/i;
  const hasCategoryBreakdown = categoryBreakdownPattern.test(remainder);
  const hasAccountBreakdown = accountBreakdownPattern.test(remainder);
  if (hasCategoryBreakdown && hasAccountBreakdown) return null;
  if (hasCategoryBreakdown) {
    groupBy = 'category';
    remainder = remainder.replace(categoryBreakdownPattern, ' ').trim();
  } else if (hasAccountBreakdown) {
    groupBy = 'account';
    remainder = remainder.replace(accountBreakdownPattern, ' ').trim();
  } else {
    const leadingGroupMatch = remainder.match(/^(kategori|category|akun|account|rekening)\b/i);
    if (leadingGroupMatch) {
      groupBy = /^(?:kategori|category)$/i.test(leadingGroupMatch[1]) ? 'category' : 'account';
      remainder = remainder.slice(leadingGroupMatch[0].length).trim();
    }
  }

  remainder = remainder.replace(/^(?:transaksi|transactions?)\b/i, ' ').trim();

  const parsedHistoryOptions = remainder
    ? extractHistoryQueryOptionsFromTokens(remainder, { sort: 'newest' }, false)
    : { sort: 'newest' as const };
  if (!parsedHistoryOptions) return null;

  const {
    limit: _limit,
    offset: _offset,
    page: _page,
    sort: _sort,
    ...summaryFilters
  } = parsedHistoryOptions;

  if (explicitRecordType) {
    summaryFilters.recordType = explicitRecordType;
  }

  return {
    type: 'TRANSACTION_SUMMARY',
    options: {
      ...summaryFilters,
      groupBy,
    },
  };
}

export function detectFastPathAction(userMessageText: string): FastPathAction {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const transactionSummaryIntent = parseTransactionSummaryIntent(userMessageText);
  if (transactionSummaryIntent) {
    return transactionSummaryIntent;
  }

  const transactionHistoryIntent = parseTransactionHistoryIntent(userMessageText);
  if (transactionHistoryIntent) {
    return transactionHistoryIntent;
  }

  const trimmedLowerText = userMessageText.toLowerCase().trim();

  const hasNumericOrPricePattern =
    /\d|\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(
      trimmedLowerText
    );
  if (hasNumericOrPricePattern) {
    return null;
  }

  const balancePattern = /^(?:cek|lihat|info|total|check|view|show|my)?\s*(?:saldo|balance|balances|rekening|total\s+saldo|account\s+balance|account\s+balances)(?:\s+(?:saya|rekening|accounts))?$/i;
  if (balancePattern.test(trimmedLowerText)) {
    return 'CHECK_BALANCE';
  }

  const budgetPattern = /^(?:cek|lihat|info|status|check|view|show|my)?\s*(?:budget|budgets|anggaran|sisa\s+budget|status\s+budget|status\s+anggaran|budget\s+status)(?:\s+(?:saya|aktif|active))?$/i;
  if (budgetPattern.test(trimmedLowerText)) {
    return 'CHECK_BUDGET';
  }

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

export function detectPendingConfirmationAction(userMessageText: string): PendingConfirmationIntent | null {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedText = userMessageText.toLowerCase().trim();

  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'ALL' };
  }

  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'ALL' };
  }

  const confirmSpecificMatch = trimmedText.match(/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+#?(\d+)$/i);
  if (confirmSpecificMatch && confirmSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(confirmSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'CONFIRM', targetScope: ticketNumber };
    }
  }

  const rejectSpecificMatch = trimmedText.match(/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+#?(\d+)$/i);
  if (rejectSpecificMatch && rejectSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(rejectSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'REJECT', targetScope: ticketNumber };
    }
  }

  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'LATEST' };
  }

  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'LATEST' };
  }

  return null;
}
