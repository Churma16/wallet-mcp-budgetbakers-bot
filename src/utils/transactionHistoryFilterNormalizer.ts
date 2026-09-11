import {
  TransactionHistoryQueryOptions,
  TransactionRecordTypeFilter,
  RelativeDatePeriod,
  AppliedTransactionHistoryFilters,
  UnresolvedFilterIssue,
  WalletAccountItem,
  WalletCategoryItem,
} from '../types/walletTypes.js';
import { getApplicationTimezone } from './humanResponseFormatter.js';
import { getLocalTimeParts } from './relativeTimeParser.js';

export const SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS: readonly string[] = [
  'communication_pc',
  'financial_expenses',
  'food_and_drinks',
  'housing',
  'income',
  'investments',
  'life_entertainment',
  'others',
  'shopping',
  'system_categories',
  'transportation',
  'unknown_records',
  'vehicle',
];

const CATEGORY_GROUP_ALIASES: Readonly<Record<string, string>> = {
  food: 'food_and_drinks',
  makanan: 'food_and_drinks',
  minuman: 'food_and_drinks',
  drink: 'food_and_drinks',
  drinks: 'food_and_drinks',
  transport: 'transportation',
  transportasi: 'transportation',
  belanja: 'shopping',
  shop: 'shopping',
  hiburan: 'life_entertainment',
  entertainment: 'life_entertainment',
  tagihan: 'financial_expenses',
  investasi: 'investments',
  investment: 'investments',
  rumah: 'housing',
  kendaraan: 'vehicle',
};

export interface NormalizedTransactionHistoryFilterResult {
  isValid: boolean;
  normalizedOptions: TransactionHistoryQueryOptions;
  upstreamRecordDate?: string[];
  upstreamAccountId?: string;
  upstreamCategoryId?: string[];
  upstreamCategoryGroup?: string;
  upstreamRecordType?: TransactionRecordTypeFilter;
  appliedFilters: AppliedTransactionHistoryFilters;
  unresolvedFilters: UnresolvedFilterIssue[];
}

function formatIsoDateOnly(dateObject: Date): string {
  const yearString = String(dateObject.getFullYear());
  const monthString = String(dateObject.getMonth() + 1).padStart(2, '0');
  const dayString = String(dateObject.getDate()).padStart(2, '0');
  return `${yearString}-${monthString}-${dayString}`;
}

function calculateRelativeDateRange(
  period: RelativeDatePeriod,
  referenceDate: Date = new Date(),
  timezoneIdentifier: string = 'Asia/Jakarta'
): { recordDate: string[]; from: string; to: string; label: string } {
  const localTimeParts = getLocalTimeParts(referenceDate, timezoneIdentifier);
  const currentYear = localTimeParts.year;
  const currentMonth = localTimeParts.month; // 1-indexed
  const currentDay = localTimeParts.day;

  const localDateAtMidnight = new Date(currentYear, currentMonth - 1, currentDay);

  switch (period) {
    case 'today': {
      const todayDateString = formatIsoDateOnly(localDateAtMidnight);
      return {
        recordDate: [`eq.${todayDateString}`],
        from: todayDateString,
        to: todayDateString,
        label: 'Hari ini',
      };
    }

    case 'yesterday': {
      const yesterdayDate = new Date(localDateAtMidnight);
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterdayDateString = formatIsoDateOnly(yesterdayDate);
      return {
        recordDate: [`eq.${yesterdayDateString}`],
        from: yesterdayDateString,
        to: yesterdayDateString,
        label: 'Kemarin',
      };
    }

    case 'this_week': {
      // Monday as start of week (ISO-8601 standard)
      const dayOfWeek = localDateAtMidnight.getDay(); // 0 = Sunday, 1 = Monday, ...
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      const mondayDate = new Date(localDateAtMidnight);
      mondayDate.setDate(mondayDate.getDate() - daysSinceMonday);

      const sundayDate = new Date(mondayDate);
      sundayDate.setDate(sundayDate.getDate() + 6);

      const fromString = formatIsoDateOnly(mondayDate);
      const toString = formatIsoDateOnly(sundayDate);
      return {
        recordDate: [`gte.${fromString}`, `lte.${toString}`],
        from: fromString,
        to: toString,
        label: 'Minggu ini',
      };
    }

    case 'last_week': {
      const dayOfWeek = localDateAtMidnight.getDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;
      const previousMondayDate = new Date(localDateAtMidnight);
      previousMondayDate.setDate(previousMondayDate.getDate() - daysSinceMonday - 7);

      const previousSundayDate = new Date(previousMondayDate);
      previousSundayDate.setDate(previousSundayDate.getDate() + 6);

      const fromString = formatIsoDateOnly(previousMondayDate);
      const toString = formatIsoDateOnly(previousSundayDate);
      return {
        recordDate: [`gte.${fromString}`, `lte.${toString}`],
        from: fromString,
        to: toString,
        label: 'Minggu lalu',
      };
    }

    case 'this_month': {
      const firstDayOfMonth = new Date(currentYear, currentMonth - 1, 1);
      const lastDayOfMonth = new Date(currentYear, currentMonth, 0);

      const fromString = formatIsoDateOnly(firstDayOfMonth);
      const toString = formatIsoDateOnly(lastDayOfMonth);
      return {
        recordDate: [`gte.${fromString}`, `lte.${toString}`],
        from: fromString,
        to: toString,
        label: 'Bulan ini',
      };
    }

    case 'last_month': {
      const firstDayOfLastMonth = new Date(currentYear, currentMonth - 2, 1);
      const lastDayOfLastMonth = new Date(currentYear, currentMonth - 1, 0);

      const fromString = formatIsoDateOnly(firstDayOfLastMonth);
      const toString = formatIsoDateOnly(lastDayOfLastMonth);
      return {
        recordDate: [`gte.${fromString}`, `lte.${toString}`],
        from: fromString,
        to: toString,
        label: 'Bulan lalu',
      };
    }

    case 'this_year': {
      const firstDayOfYear = new Date(currentYear, 0, 1);
      const lastDayOfYear = new Date(currentYear, 11, 31);

      const fromString = formatIsoDateOnly(firstDayOfYear);
      const toString = formatIsoDateOnly(lastDayOfYear);
      return {
        recordDate: [`gte.${fromString}`, `lte.${toString}`],
        from: fromString,
        to: toString,
        label: 'Tahun ini',
      };
    }
  }
}

/**
 * Normalizes, validates, and resolves channel-agnostic transaction history filter options.
 * Enforces a fail-closed policy: unresolvable accounts, unresolvable categories, or invalid date boundaries
 * return isValid = false and explicit UnresolvedFilterIssue entries rather than silently returning unfiltered records.
 */
export function normalizeTransactionHistoryFilters(
  queryOptions: TransactionHistoryQueryOptions = {},
  availableAccountList: WalletAccountItem[] = [],
  availableCategoryList: WalletCategoryItem[] = [],
  referenceDate: Date = new Date()
): NormalizedTransactionHistoryFilterResult {
  const unresolvedFilterIssues: UnresolvedFilterIssue[] = [];
  const appliedFilters: AppliedTransactionHistoryFilters = {};

  let upstreamAccountId: string | undefined = undefined;
  let upstreamCategoryId: string[] | undefined = undefined;
  let upstreamCategoryGroup: string | undefined = undefined;
  let upstreamRecordType: TransactionRecordTypeFilter | undefined = undefined;
  let upstreamRecordDate: string[] | undefined = undefined;

  // ---------------------------------------------------------------------------
  // 1. Account Filter Resolution
  // ---------------------------------------------------------------------------
  const rawAccountId = queryOptions.accountId;
  const rawAccountName = queryOptions.accountName;

  if (rawAccountId) {
    if (Array.isArray(rawAccountId)) {
      upstreamAccountId = rawAccountId.join(',');
      appliedFilters.account = {
        id: upstreamAccountId,
        name: rawAccountId.join(', '),
      };
    } else {
      upstreamAccountId = rawAccountId;
      const matchedAccount = availableAccountList.find(account => account.id === rawAccountId);
      appliedFilters.account = {
        id: rawAccountId,
        name: matchedAccount ? matchedAccount.name : rawAccountId,
      };
    }
  } else if (rawAccountName && rawAccountName.trim().length > 0) {
    const trimmedAccountHint = rawAccountName.trim();
    const normalizedAccountHint = trimmedAccountHint.toLowerCase();

    // Strategy A: Exact ID match
    const exactIdMatch = availableAccountList.find(account => account.id === trimmedAccountHint);
    if (exactIdMatch) {
      upstreamAccountId = exactIdMatch.id;
      appliedFilters.account = { id: exactIdMatch.id, name: exactIdMatch.name };
    } else {
      // Strategy B: Exact Name match (case-insensitive)
      const exactNameMatches = availableAccountList.filter(
        account => account.name.toLowerCase() === normalizedAccountHint
      );

      if (exactNameMatches.length === 1) {
        upstreamAccountId = exactNameMatches[0].id;
        appliedFilters.account = { id: exactNameMatches[0].id, name: exactNameMatches[0].name };
      } else if (exactNameMatches.length > 1) {
        unresolvedFilterIssues.push({
          filterKey: 'account',
          rawValue: trimmedAccountHint,
          reason: 'UNRESOLVED',
          message: `Akun "${trimmedAccountHint}" ambigu. Ditemukan beberapa akun dengan nama yang sama.`,
        });
      } else {
        // Strategy C: Substring name match
        const substringMatches = availableAccountList.filter(
          account =>
            account.name.toLowerCase().includes(normalizedAccountHint) ||
            normalizedAccountHint.includes(account.name.toLowerCase())
        );

        if (substringMatches.length === 1) {
          upstreamAccountId = substringMatches[0].id;
          appliedFilters.account = { id: substringMatches[0].id, name: substringMatches[0].name };
        } else if (substringMatches.length > 1) {
          const candidateNames = substringMatches.map(account => account.name);
          unresolvedFilterIssues.push({
            filterKey: 'account',
            rawValue: trimmedAccountHint,
            reason: 'UNRESOLVED',
            message: `Akun "${trimmedAccountHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
          });
        } else {
          // Strategy D: Bank account digits
          const numericDigits = trimmedAccountHint.replace(/\D/g, '');
          let bankAccountMatches: WalletAccountItem[] = [];
          if (numericDigits.length >= 4) {
            bankAccountMatches = availableAccountList.filter(account => {
              if (!account.bankAccountNumber) {
                return false;
              }
              const cleanDigits = account.bankAccountNumber.replace(/\D/g, '');
              return cleanDigits.endsWith(numericDigits) || numericDigits.endsWith(cleanDigits);
            });
          }

          if (bankAccountMatches.length === 1) {
            upstreamAccountId = bankAccountMatches[0].id;
            appliedFilters.account = { id: bankAccountMatches[0].id, name: bankAccountMatches[0].name };
          } else if (bankAccountMatches.length > 1) {
            const candidateNames = bankAccountMatches.map(account => account.name);
            unresolvedFilterIssues.push({
              filterKey: 'account',
              rawValue: trimmedAccountHint,
              reason: 'UNRESOLVED',
              message: `Nomor rekening "${trimmedAccountHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
            });
          } else {
            unresolvedFilterIssues.push({
              filterKey: 'account',
              rawValue: trimmedAccountHint,
              reason: 'NOT_FOUND',
              message: `Akun "${trimmedAccountHint}" tidak ditemukan dalam daftar akun Wallet Anda.`,
            });
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Category Filter Resolution
  // ---------------------------------------------------------------------------
  const rawCategoryId = queryOptions.categoryId;
  const rawCategoryName = queryOptions.categoryName;
  const rawCategoryGroup = queryOptions.categoryGroup;

  if (rawCategoryGroup) {
    const normalizedGroup = rawCategoryGroup.toLowerCase().trim();
    if (SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(normalizedGroup)) {
      upstreamCategoryGroup = normalizedGroup;
      appliedFilters.categoryGroup = normalizedGroup;
    } else {
      unresolvedFilterIssues.push({
        filterKey: 'category',
        rawValue: rawCategoryGroup,
        reason: 'UNSUPPORTED',
        message: `Grup kategori "${rawCategoryGroup}" tidak didukung oleh Wallet.`,
      });
    }
  } else if (rawCategoryId) {
    if (Array.isArray(rawCategoryId)) {
      upstreamCategoryId = rawCategoryId.slice(0, 10);
      appliedFilters.category = {
        id: upstreamCategoryId.join(','),
        name: `${upstreamCategoryId.length} kategori`,
      };
    } else {
      upstreamCategoryId = [rawCategoryId];
      const matchedCategory = availableCategoryList.find(category => category.id === rawCategoryId);
      appliedFilters.category = {
        id: rawCategoryId,
        name: matchedCategory ? matchedCategory.name : rawCategoryId,
      };
    }
  } else if (rawCategoryName && rawCategoryName.trim().length > 0) {
    const trimmedCategoryHint = rawCategoryName.trim();
    const normalizedCategoryHint = trimmedCategoryHint.toLowerCase();

    // Strategy A: Check 'unknown' / uncategorized
    if (normalizedCategoryHint === 'unknown' || normalizedCategoryHint === 'uncategorized' || normalizedCategoryHint === 'tanpa kategori') {
      upstreamCategoryId = ['unknown'];
      appliedFilters.category = { id: 'unknown', name: 'Tanpa Kategori' };
    } else {
      // Strategy B: Exact ID match
      const exactIdMatch = availableCategoryList.find(category => category.id === trimmedCategoryHint);
      if (exactIdMatch) {
        upstreamCategoryId = [exactIdMatch.id];
        appliedFilters.category = { id: exactIdMatch.id, name: exactIdMatch.name };
      } else {
        // Strategy C: Exact Name match (case-insensitive)
        const exactNameMatches = availableCategoryList.filter(
          category => category.name.toLowerCase() === normalizedCategoryHint
        );

        if (exactNameMatches.length > 0) {
          upstreamCategoryId = [exactNameMatches[0].id];
          appliedFilters.category = { id: exactNameMatches[0].id, name: exactNameMatches[0].name };
        } else {
          // Strategy D: Substring match on category name
          const substringMatches = availableCategoryList.filter(
            category =>
              category.name.toLowerCase().includes(normalizedCategoryHint) ||
              normalizedCategoryHint.includes(category.name.toLowerCase())
          );

          if (substringMatches.length > 0) {
            upstreamCategoryId = [substringMatches[0].id];
            appliedFilters.category = { id: substringMatches[0].id, name: substringMatches[0].name };
          } else {
            // Strategy E: Known category group slug or alias
            const aliasGroupSlug = CATEGORY_GROUP_ALIASES[normalizedCategoryHint];
            if (aliasGroupSlug && SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(aliasGroupSlug)) {
              upstreamCategoryGroup = aliasGroupSlug;
              appliedFilters.categoryGroup = aliasGroupSlug;
            } else if (SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(normalizedCategoryHint)) {
              upstreamCategoryGroup = normalizedCategoryHint;
              appliedFilters.categoryGroup = normalizedCategoryHint;
            } else {
              unresolvedFilterIssues.push({
                filterKey: 'category',
                rawValue: trimmedCategoryHint,
                reason: 'NOT_FOUND',
                message: `Kategori "${trimmedCategoryHint}" tidak ditemukan dalam daftar kategori Wallet Anda.`,
              });
            }
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Record Type Filter Resolution
  // ---------------------------------------------------------------------------
  const rawRecordType = queryOptions.recordType as string | undefined;
  if (rawRecordType && rawRecordType.trim().length > 0) {
    const normalizedType = rawRecordType.toLowerCase().trim();
    if (
      normalizedType === 'expense' ||
      normalizedType === 'pengeluaran' ||
      normalizedType === 'keluar' ||
      normalizedType === 'belanja' ||
      normalizedType === 'spending' ||
      normalizedType === 'expenses'
    ) {
      upstreamRecordType = 'expense';
      appliedFilters.recordType = 'expense';
    } else if (
      normalizedType === 'income' ||
      normalizedType === 'pemasukan' ||
      normalizedType === 'masuk' ||
      normalizedType === 'gaji' ||
      normalizedType === 'pendapatan'
    ) {
      upstreamRecordType = 'income';
      appliedFilters.recordType = 'income';
    } else {
      unresolvedFilterIssues.push({
        filterKey: 'recordType',
        rawValue: rawRecordType,
        reason: 'INVALID_FORMAT',
        message: `Tipe transaksi "${rawRecordType}" tidak valid. Gunakan 'expense' (pengeluaran) atau 'income' (pemasukan).`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Date and Date Range Filter Resolution
  // ---------------------------------------------------------------------------
  const timezoneIdentifier = getApplicationTimezone();

  if (queryOptions.datePeriod) {
    const relativeRangeResult = calculateRelativeDateRange(
      queryOptions.datePeriod,
      referenceDate,
      timezoneIdentifier
    );
    upstreamRecordDate = relativeRangeResult.recordDate;
    appliedFilters.dateRange = {
      from: relativeRangeResult.from,
      to: relativeRangeResult.to,
      rawRange: relativeRangeResult.recordDate,
      label: relativeRangeResult.label,
    };
  } else if (Array.isArray(queryOptions.dateRange)) {
    const rawArray = queryOptions.dateRange.slice(0, 2);
    const validOperators = ['eq.', 'gt.', 'gte.', 'lt.', 'lte.'];
    const validatedTokens: string[] = [];

    for (const token of rawArray) {
      if (typeof token !== 'string') {
        continue;
      }
      const hasValidPrefix = validOperators.some(op => token.startsWith(op));
      if (!hasValidPrefix) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: token,
          reason: 'INVALID_FORMAT',
          message: `Format filter tanggal "${token}" tidak valid. Gunakan prefix operator: eq., gt., gte., lt., atau lte.`,
        });
        break;
      }
      const rawDatePortion = token.replace(/^(eq|gt|gte|lt|lte)\./, '');
      const parsedTimestamp = Date.parse(rawDatePortion);
      if (Number.isNaN(parsedTimestamp)) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: token,
          reason: 'INVALID_FORMAT',
          message: `Tanggal "${rawDatePortion}" tidak dapat diuraikan sebagai tanggal yang valid.`,
        });
        break;
      }
      validatedTokens.push(token);
    }

    if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange') && validatedTokens.length > 0) {
      upstreamRecordDate = validatedTokens;
      appliedFilters.dateRange = {
        rawRange: validatedTokens,
      };
    }
  } else {
    let rawFrom: string | undefined = undefined;
    let rawTo: string | undefined = undefined;

    if (queryOptions.dateRange && typeof queryOptions.dateRange === 'object' && !Array.isArray(queryOptions.dateRange)) {
      rawFrom = queryOptions.dateRange.from;
      rawTo = queryOptions.dateRange.to;
    } else {
      rawFrom = queryOptions.startDate;
      rawTo = queryOptions.endDate;
    }

    if (rawFrom || rawTo) {
      let parsedFromDate: Date | undefined = undefined;
      let parsedToDate: Date | undefined = undefined;

      if (rawFrom) {
        const fromTimestamp = Date.parse(rawFrom);
        if (Number.isNaN(fromTimestamp)) {
          unresolvedFilterIssues.push({
            filterKey: 'dateRange',
            rawValue: rawFrom,
            reason: 'INVALID_FORMAT',
            message: `Tanggal mulai "${rawFrom}" tidak valid.`,
          });
        } else {
          parsedFromDate = new Date(fromTimestamp);
        }
      }

      if (rawTo) {
        const toTimestamp = Date.parse(rawTo);
        if (Number.isNaN(toTimestamp)) {
          unresolvedFilterIssues.push({
            filterKey: 'dateRange',
            rawValue: rawTo,
            reason: 'INVALID_FORMAT',
            message: `Tanggal akhir "${rawTo}" tidak valid.`,
          });
        } else {
          parsedToDate = new Date(toTimestamp);
        }
      }

      if (parsedFromDate && parsedToDate && parsedFromDate.getTime() > parsedToDate.getTime()) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: `${rawFrom} - ${rawTo}`,
          reason: 'INVALID_RANGE',
          message: `Rentang tanggal tidak valid: tanggal mulai (${rawFrom}) tidak boleh lebih besar dari tanggal akhir (${rawTo}).`,
        });
      } else if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange')) {
        const tokens: string[] = [];
        if (parsedFromDate) {
          const fromString = formatIsoDateOnly(parsedFromDate);
          tokens.push(`gte.${fromString}`);
        }
        if (parsedToDate) {
          const toString = formatIsoDateOnly(parsedToDate);
          tokens.push(`lte.${toString}`);
        }
        upstreamRecordDate = tokens;
        appliedFilters.dateRange = {
          from: rawFrom,
          to: rawTo,
          rawRange: tokens,
        };
      }
    }
  }

  const isValid = unresolvedFilterIssues.length === 0;

  const normalizedOptions: TransactionHistoryQueryOptions = {
    ...queryOptions,
    accountId: upstreamAccountId,
    categoryId: upstreamCategoryId,
    categoryGroup: upstreamCategoryGroup,
    recordType: upstreamRecordType,
    dateRange: upstreamRecordDate,
  };

  return {
    isValid,
    normalizedOptions,
    upstreamRecordDate,
    upstreamAccountId,
    upstreamCategoryId,
    upstreamCategoryGroup,
    upstreamRecordType,
    appliedFilters,
    unresolvedFilters: unresolvedFilterIssues,
  };
}
