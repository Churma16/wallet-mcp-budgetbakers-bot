import { TransactionHistoryQueryOptions } from '../wallet/index.js';

export const KNOWN_ACCOUNT_KEYWORDS = new Set([
  'bca', 'mandiri', 'bri', 'bni', 'jago', 'cimb', 'jenius', 'permata',
  'bsi', 'seabank', 'blu', 'gopay', 'ovo', 'dana', 'shopeepay', 'linkaja',
  'cash', 'tunai', 'dompet', 'bank', 'rekening', 'wallet',
]);

export const KNOWN_CATEGORY_KEYWORDS = new Set([
  'makanan', 'minuman', 'food', 'drink', 'drinks', 'makan', 'minum',
  'transport', 'transportasi', 'belanja', 'shopping', 'hiburan', 'entertainment',
  'tagihan', 'bills', 'investasi', 'investment', 'gaji', 'salary',
  'kesehatan', 'health', 'pulsa', 'listrik', 'kendaraan', 'rumah', 'housing',
  'pendidikan', 'education', 'communication_pc', 'financial_expenses',
  'food_and_drinks', 'income', 'investments', 'life_entertainment',
  'others', 'shopping', 'system_categories', 'transportation', 'unknown_records', 'vehicle',
]);

/**
 * Extracts and normalizes transaction history options from unstructured natural language query tokens.
 */
export function extractHistoryQueryOptionsFromTokens(
  rawTokens: string,
  baseOptions: Partial<TransactionHistoryQueryOptions> = {},
  isDedicatedSearchCommand: boolean = false,
  allowNaturalCategoryPhrase: boolean = false,
  hasLeadingScopeWord: boolean = false
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
    const connectorAccountMatch = remainingTokens.match(
      /\b(?:dari|di|for|in|pada)\s+([a-zA-Z0-9_-]+(?:\s+(?:debit\s+card|credit\s+card|kartu\s+debit|kartu\s+kredit|debit|card))?)\b/i
    );
    if (connectorAccountMatch) {
      const leadingAccountWord = connectorAccountMatch[1].split(/\s+/)[0].toLowerCase();
      if (KNOWN_ACCOUNT_KEYWORDS.has(leadingAccountWord)) {
        resolvedAccountName = connectorAccountMatch[1].toLowerCase();
        remainingTokens = remainingTokens.replace(connectorAccountMatch[0], ' ').trim();
      }
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

  const scopeMatches = remainingTokens.match(/\b(?:all|semua|semuanya)\b/gi);
  if (scopeMatches) {
    remainingTokens = remainingTokens.replace(/\b(?:all|semua|semuanya)\b/gi, ' ').trim();
  }
  const isGroupScope = Boolean(scopeMatches || hasLeadingScopeWord);

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
    const categoryPhraseWords: string[] = [];
    const canConsumeNaturalCategoryPhrase =
      allowNaturalCategoryPhrase && !isDedicatedSearchCommand && !resolvedSearchQuery;

    for (const rawWord of leftoverWords) {
      const cleanWord = rawWord.toLowerCase();
      if (KNOWN_ACCOUNT_KEYWORDS.has(cleanWord) && !resolvedAccountName) {
        resolvedAccountName = cleanWord;
      } else if (
        canConsumeNaturalCategoryPhrase &&
        (/[A-Za-z]/.test(rawWord) || (/^[&/+\-_]+$/.test(rawWord) && categoryPhraseWords.length > 0))
      ) {
        categoryPhraseWords.push(rawWord);
      } else if (!isDedicatedSearchCommand && KNOWN_CATEGORY_KEYWORDS.has(cleanWord) && !resolvedCategoryName) {
        resolvedCategoryName = cleanWord;
      } else {
        searchWords.push(rawWord);
      }
    }

    if (categoryPhraseWords.length > 0) {
      const categoryPhrase = categoryPhraseWords
        .join(' ')
        .replace(/^[&/+\-_\s]+|[&/+\-_\s]+$/g, '')
        .toLowerCase();
      if (categoryPhrase) {
        resolvedCategoryName = resolvedCategoryName
          ? `${resolvedCategoryName} ${categoryPhrase}`.trim()
          : categoryPhrase;
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
  if (isGroupScope) resultOptions.isGroupQuery = true;
  if (resolvedSearchQuery !== undefined) resultOptions.searchQuery = resolvedSearchQuery;

  return resultOptions;
}
