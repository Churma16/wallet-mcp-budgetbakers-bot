import {
  TransactionSummaryQueryOptions,
} from '../wallet/index.js';
import { FINANCIAL_ACTION_TYPES } from './constants.js';
import {
  FastPathTransactionHistoryAction,
  FastPathTransactionSummaryAction,
} from './types.js';
import { extractHistoryQueryOptionsFromTokens } from './fastPathTokens.js';

export function parseTransactionHistoryIntent(userMessageText: string): FastPathTransactionHistoryAction | null {
  const trimmedText = userMessageText.trim().replace(/[?!.]+\s*$/, '');
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
      type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
      options: {
        limit: parsedLimit,
        page: resolvedPage,
        sort: resolvedSort,
      },
    };
  }

  const historyCommandPattern =
    /^(?:cek|lihat|info|daftar|show|view|check|get|my|semua|all)?\s*(?:riwayat\s+transaksi|transaction\s+history|daftar\s+transaksi|transaksi\s+terakhir|last\s+transactions?|recent\s+transactions?|riwayat|history)(?:\s+(.*))?$/i;
  const historyMatch = trimmedLowerText.match(historyCommandPattern);
  if (historyMatch) {
    const rawRemainderLower = historyMatch[1];
    if (!rawRemainderLower || !rawRemainderLower.trim()) {
      return { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: { sort: 'newest' } };
    }

    const matchPrefixLength = trimmedText.length - rawRemainderLower.length;
    const rawRemainder = trimmedText.slice(matchPrefixLength);
    const hasLeadingScopeWord = /^(?:semua|all)\s+/i.test(trimmedLowerText);
    const parsedOptions = extractHistoryQueryOptionsFromTokens(
      rawRemainder,
      { sort: 'newest' },
      false,
      true,
      hasLeadingScopeWord
    );
    if (parsedOptions) {
      return { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: parsedOptions };
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
        return { type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY, options: parsedSearchOptions };
      }
    }
  }

  return null;
}

export function normalizeSummaryRecordType(rawValue: string | undefined): 'expense' | 'income' | undefined {
  if (!rawValue) return undefined;
  return /^(?:pengeluaran|expenses?|spending|spend|spent)$/i.test(rawValue) ? 'expense' : 'income';
}

export function parseTransactionSummaryIntent(userMessageText: string): FastPathTransactionSummaryAction | null {
  const trimmedText = userMessageText.trim().replace(/[?!.]+$/g, '').trim();
  const trimmedLowerText = trimmedText.toLowerCase();

  const hasTransactionAmountPattern =
    /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b|(?:^|\s)(?:rb|k|jt|ribu|juta|rp|idr)(?:$|\s)/i.test(trimmedLowerText);
  if (hasTransactionAmountPattern) return null;
  if (/^(?:beli|bayar|catat|transfer|topup|top\s*up)\b/i.test(trimmedLowerText)) return null;

  let remainder = trimmedText;
  let explicitRecordType: 'expense' | 'income' | undefined;
  let forcedGroupBy: TransactionSummaryQueryOptions['groupBy'] | undefined;
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

  if (!matchedPrefix) {
    const categoryRankingQuestionMatch = remainder.match(
      /^(?:which|what)\s+category\s+did\s+i\s+spend\s+(?:the\s+)?most\s+on(?:\s+(.*))?$/i
    );
    if (categoryRankingQuestionMatch) {
      matchedPrefix = true;
      explicitRecordType = 'expense';
      forcedGroupBy = 'category';
      remainder = (categoryRankingQuestionMatch[1] || '').trim();
    }
  }

  if (!matchedPrefix) {
    const indonesianCategoryRankingMatch = remainder.match(
      /^kategori\s+(?:mana|apa)\s+yang\s+paling\s+banyak\s+pengeluarannya(?:\s+(.*))?$/i
    );
    if (indonesianCategoryRankingMatch) {
      matchedPrefix = true;
      explicitRecordType = 'expense';
      forcedGroupBy = 'category';
      remainder = (indonesianCategoryRankingMatch[1] || '').trim();
    }
  }

  if (!matchedPrefix) return null;

  let groupBy: TransactionSummaryQueryOptions['groupBy'] = forcedGroupBy || 'none';
  const categoryBreakdownPattern = /\b(?:per\s+kategori|berdasarkan\s+kategori|by\s+category|category\s+breakdown|breakdown\s+(?:per\s+)?kategori)\b/i;
  const accountBreakdownPattern = /\b(?:per\s+(?:akun|rekening)|berdasarkan\s+(?:akun|rekening)|by\s+account|account\s+breakdown|breakdown\s+(?:per\s+)?(?:akun|rekening))\b/i;
  const hasCategoryBreakdown = categoryBreakdownPattern.test(remainder);
  const hasAccountBreakdown = accountBreakdownPattern.test(remainder);
  if (hasCategoryBreakdown && hasAccountBreakdown) return null;
  if (forcedGroupBy && (hasCategoryBreakdown || hasAccountBreakdown)) return null;
  if (hasCategoryBreakdown) {
    groupBy = 'category';
    remainder = remainder.replace(categoryBreakdownPattern, ' ').trim();
  } else if (hasAccountBreakdown) {
    groupBy = 'account';
    remainder = remainder.replace(accountBreakdownPattern, ' ').trim();
  } else if (!forcedGroupBy) {
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
    type: FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY,
    options: {
      ...summaryFilters,
      groupBy,
    },
  };
}
