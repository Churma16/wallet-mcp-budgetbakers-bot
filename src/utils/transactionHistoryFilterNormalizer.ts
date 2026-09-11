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
import {
  getLocalTimeParts,
  getNextLocalDateString,
  getPreviousLocalDateString,
  resolveLocalCalendarDayRange,
  resolveLocalCalendarRange,
} from './relativeTimeParser.js';

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

/**
 * Strict calendar date validator. Verifies that a given string is a valid YYYY-MM-DD or ISO datetime,
 * and round-trips calendar parts to reject impossible calendar dates like 2024-02-30 or 2026-04-31.
 */
export function isValidCalendarDateString(dateString: string): boolean {
  if (typeof dateString !== 'string') {
    return false;
  }
  const trimmed = dateString.trim();

  // 1. Date-only format YYYY-MM-DD
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number.parseInt(dateOnlyMatch[1], 10);
    const month = Number.parseInt(dateOnlyMatch[2], 10);
    const day = Number.parseInt(dateOnlyMatch[3], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return false;
    }

    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return (
      utcDate.getUTCFullYear() === year &&
      utcDate.getUTCMonth() === month - 1 &&
      utcDate.getUTCDate() === day
    );
  }

  // 2. Full ISO 8601 datetime format
  const isoDateTimeMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/
  );
  if (isoDateTimeMatch) {
    const year = Number.parseInt(isoDateTimeMatch[1], 10);
    const month = Number.parseInt(isoDateTimeMatch[2], 10);
    const day = Number.parseInt(isoDateTimeMatch[3], 10);
    const hour = Number.parseInt(isoDateTimeMatch[4], 10);
    const minute = Number.parseInt(isoDateTimeMatch[5], 10);
    const second = Number.parseInt(isoDateTimeMatch[6], 10);

    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return false;
    }

    const parsedTimestamp = Date.parse(trimmed);
    if (Number.isNaN(parsedTimestamp)) {
      return false;
    }

    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return (
      utcDate.getUTCFullYear() === year &&
      utcDate.getUTCMonth() === month - 1 &&
      utcDate.getUTCDate() === day
    );
  }

  return false;
}

export function parseTimestampForDateToken(dateString: string): number {
  const trimmed = dateString.trim();
  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const year = Number.parseInt(dateOnlyMatch[1], 10);
    const month = Number.parseInt(dateOnlyMatch[2], 10);
    const day = Number.parseInt(dateOnlyMatch[3], 10);
    return Date.UTC(year, month - 1, day);
  }
  return Date.parse(trimmed);
}

function formatIsoDateParts(year: number, month: number, day: number): string {
  const paddedYear = String(year).padStart(4, '0');
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  return `${paddedYear}-${paddedMonth}-${paddedDay}`;
}

export function isDateOnlyString(dateString: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateString.trim());
}

export function getNextCalendarDayString(dateOnlyString: string): string {
  return getNextLocalDateString(dateOnlyString);
}

const CANONICAL_SIMPLE_KEYWORD_REGEX = /^[a-zA-Z0-9_-]+$/;

const KNOWN_CANONICAL_ACCOUNT_KEYWORDS = new Set([
  'bca',
  'mandiri',
  'bri',
  'bni',
  'cimb',
  'jago',
  'jenius',
  'dana',
  'gopay',
  'ovo',
  'shopeepay',
  'linkaja',
  'cash',
  'tunai',
  'dompet',
  'bank',
  'rekening',
  'wallet',
]);

const KNOWN_CANONICAL_CATEGORY_KEYWORDS = new Set([
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

export function buildCanonicalAccountSelector(accountName: string): string {
  const trimmed = accountName.trim();
  const lower = trimmed.toLowerCase();
  if (KNOWN_CANONICAL_ACCOUNT_KEYWORDS.has(lower) && CANONICAL_SIMPLE_KEYWORD_REGEX.test(lower)) {
    return lower;
  }
  return `akun "${trimmed.replace(/"/g, '')}"`;
}

export function buildCanonicalCategorySelector(categoryNameOrGroup: string): string {
  const trimmed = categoryNameOrGroup.trim();
  const lower = trimmed.toLowerCase();
  if (KNOWN_CANONICAL_CATEGORY_KEYWORDS.has(lower) && CANONICAL_SIMPLE_KEYWORD_REGEX.test(lower)) {
    return lower;
  }
  return `kategori "${trimmed.replace(/"/g, '')}"`;
}

export function calculateRelativeDateRange(
  period: RelativeDatePeriod,
  referenceDate: Date = new Date(),
  timezoneIdentifier: string = 'Asia/Jakarta'
): { recordDate: string[]; from: string; to: string; label: string; selector: string } {
  const localTimeParts = getLocalTimeParts(referenceDate, timezoneIdentifier);
  const currentYear = localTimeParts.year;
  const currentMonth = localTimeParts.month; // 1-indexed (1..12)
  const currentDay = localTimeParts.day;

  switch (period) {
    case 'today': {
      const todayDateString = formatIsoDateParts(currentYear, currentMonth, currentDay);
      return {
        recordDate: resolveLocalCalendarDayRange(todayDateString, timezoneIdentifier),
        from: todayDateString,
        to: todayDateString,
        label: 'Hari ini',
        selector: 'hari ini',
      };
    }

    case 'yesterday': {
      const todayDateString = formatIsoDateParts(currentYear, currentMonth, currentDay);
      const yesterdayDateString = getPreviousLocalDateString(todayDateString);
      return {
        recordDate: resolveLocalCalendarDayRange(yesterdayDateString, timezoneIdentifier),
        from: yesterdayDateString,
        to: yesterdayDateString,
        label: 'Kemarin',
        selector: 'kemarin',
      };
    }

    case 'this_week': {
      const localDateAtMidnightUtc = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay));
      const dayOfWeek = localDateAtMidnightUtc.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
      const daysSinceMonday = (dayOfWeek + 6) % 7;

      const mondayDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay - daysSinceMonday));
      const sundayDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay - daysSinceMonday + 6));

      const mondayDateString = formatIsoDateParts(
        mondayDate.getUTCFullYear(),
        mondayDate.getUTCMonth() + 1,
        mondayDate.getUTCDate()
      );
      const sundayDateString = formatIsoDateParts(
        sundayDate.getUTCFullYear(),
        sundayDate.getUTCMonth() + 1,
        sundayDate.getUTCDate()
      );

      return {
        recordDate: resolveLocalCalendarRange(mondayDateString, sundayDateString, timezoneIdentifier),
        from: mondayDateString,
        to: sundayDateString,
        label: 'Minggu ini',
        selector: 'minggu ini',
      };
    }

    case 'last_week': {
      const localDateAtMidnightUtc = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay));
      const dayOfWeek = localDateAtMidnightUtc.getUTCDay();
      const daysSinceMonday = (dayOfWeek + 6) % 7;

      const previousMondayDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay - daysSinceMonday - 7));
      const previousSundayDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay - daysSinceMonday - 1));

      const previousMondayDateString = formatIsoDateParts(
        previousMondayDate.getUTCFullYear(),
        previousMondayDate.getUTCMonth() + 1,
        previousMondayDate.getUTCDate()
      );
      const previousSundayDateString = formatIsoDateParts(
        previousSundayDate.getUTCFullYear(),
        previousSundayDate.getUTCMonth() + 1,
        previousSundayDate.getUTCDate()
      );

      return {
        recordDate: resolveLocalCalendarRange(previousMondayDateString, previousSundayDateString, timezoneIdentifier),
        from: previousMondayDateString,
        to: previousSundayDateString,
        label: 'Minggu lalu',
        selector: 'minggu lalu',
      };
    }

    case 'this_month': {
      const firstDayOfMonthDate = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
      const lastDayOfMonthDate = new Date(Date.UTC(currentYear, currentMonth, 0));

      const firstDayOfMonthString = formatIsoDateParts(
        firstDayOfMonthDate.getUTCFullYear(),
        firstDayOfMonthDate.getUTCMonth() + 1,
        firstDayOfMonthDate.getUTCDate()
      );
      const lastDayOfMonthString = formatIsoDateParts(
        lastDayOfMonthDate.getUTCFullYear(),
        lastDayOfMonthDate.getUTCMonth() + 1,
        lastDayOfMonthDate.getUTCDate()
      );

      return {
        recordDate: resolveLocalCalendarRange(firstDayOfMonthString, lastDayOfMonthString, timezoneIdentifier),
        from: firstDayOfMonthString,
        to: lastDayOfMonthString,
        label: 'Bulan ini',
        selector: 'bulan ini',
      };
    }

    case 'last_month': {
      const firstDayOfLastMonthDate = new Date(Date.UTC(currentYear, currentMonth - 2, 1));
      const lastDayOfLastMonthDate = new Date(Date.UTC(currentYear, currentMonth - 1, 0));

      const firstDayOfLastMonthString = formatIsoDateParts(
        firstDayOfLastMonthDate.getUTCFullYear(),
        firstDayOfLastMonthDate.getUTCMonth() + 1,
        firstDayOfLastMonthDate.getUTCDate()
      );
      const lastDayOfLastMonthString = formatIsoDateParts(
        lastDayOfLastMonthDate.getUTCFullYear(),
        lastDayOfLastMonthDate.getUTCMonth() + 1,
        lastDayOfLastMonthDate.getUTCDate()
      );

      return {
        recordDate: resolveLocalCalendarRange(firstDayOfLastMonthString, lastDayOfLastMonthString, timezoneIdentifier),
        from: firstDayOfLastMonthString,
        to: lastDayOfLastMonthString,
        label: 'Bulan lalu',
        selector: 'bulan lalu',
      };
    }

    case 'this_year': {
      const firstDayOfYearString = formatIsoDateParts(currentYear, 1, 1);
      const lastDayOfYearString = formatIsoDateParts(currentYear, 12, 31);

      return {
        recordDate: resolveLocalCalendarRange(firstDayOfYearString, lastDayOfYearString, timezoneIdentifier),
        from: firstDayOfYearString,
        to: lastDayOfYearString,
        label: 'Tahun ini',
        selector: 'tahun ini',
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
      const accountSelector = matchedAccount ? buildCanonicalAccountSelector(matchedAccount.name) : undefined;
      appliedFilters.account = {
        id: rawAccountId,
        name: matchedAccount ? matchedAccount.name : rawAccountId,
        ...(accountSelector ? { selector: accountSelector } : {}),
      };
    }
  } else if (rawAccountName && rawAccountName.trim().length > 0) {
    const trimmedAccountHint = rawAccountName.trim();
    const normalizedAccountHint = trimmedAccountHint.toLowerCase();
    const accountSelector = buildCanonicalAccountSelector(trimmedAccountHint);

    // Strategy A: Exact ID match
    const exactIdMatch = availableAccountList.find(account => account.id === trimmedAccountHint);
    if (exactIdMatch) {
      upstreamAccountId = exactIdMatch.id;
      appliedFilters.account = {
        id: exactIdMatch.id,
        name: exactIdMatch.name,
        selector: buildCanonicalAccountSelector(exactIdMatch.name),
      };
    } else {
      // Strategy B: Exact Name match (case-insensitive)
      const exactNameMatches = availableAccountList.filter(
        account => account.name.toLowerCase() === normalizedAccountHint
      );

      if (exactNameMatches.length === 1) {
        upstreamAccountId = exactNameMatches[0].id;
        appliedFilters.account = {
          id: exactNameMatches[0].id,
          name: exactNameMatches[0].name,
          selector: accountSelector,
        };
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
          appliedFilters.account = {
            id: substringMatches[0].id,
            name: substringMatches[0].name,
            selector: accountSelector,
          };
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
            appliedFilters.account = {
              id: bankAccountMatches[0].id,
              name: bankAccountMatches[0].name,
              selector: buildCanonicalAccountSelector(bankAccountMatches[0].name),
            };
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
      appliedFilters.category = {
        id: normalizedGroup,
        name: normalizedGroup,
        selector: buildCanonicalCategorySelector(normalizedGroup),
      };
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
      const categorySelector = matchedCategory
        ? buildCanonicalCategorySelector(matchedCategory.name)
        : undefined;
      appliedFilters.category = {
        id: rawCategoryId,
        name: matchedCategory ? matchedCategory.name : rawCategoryId,
        ...(categorySelector ? { selector: categorySelector } : {}),
      };
    }
  } else if (rawCategoryName && rawCategoryName.trim().length > 0) {
    const trimmedCategoryHint = rawCategoryName.trim();
    const normalizedCategoryHint = trimmedCategoryHint.toLowerCase();
    const categorySelector = buildCanonicalCategorySelector(trimmedCategoryHint);

    // Strategy A: Check 'unknown' / uncategorized
    if (normalizedCategoryHint === 'unknown' || normalizedCategoryHint === 'uncategorized' || normalizedCategoryHint === 'tanpa kategori') {
      upstreamCategoryId = ['unknown'];
      appliedFilters.category = { id: 'unknown', name: 'Tanpa Kategori', selector: categorySelector };
    } else {
      // Strategy B: Exact ID match
      const exactIdMatch = availableCategoryList.find(category => category.id === trimmedCategoryHint);
      if (exactIdMatch) {
        upstreamCategoryId = [exactIdMatch.id];
        appliedFilters.category = {
          id: exactIdMatch.id,
          name: exactIdMatch.name,
          selector: buildCanonicalCategorySelector(exactIdMatch.name),
        };
      } else {
        // Strategy C: Exact Name match (case-insensitive)
        const exactNameMatches = availableCategoryList.filter(
          category => category.name.toLowerCase() === normalizedCategoryHint
        );

        if (exactNameMatches.length > 0) {
          upstreamCategoryId = [exactNameMatches[0].id];
          appliedFilters.category = {
            id: exactNameMatches[0].id,
            name: exactNameMatches[0].name,
            selector: categorySelector,
          };
        } else {
          // Strategy D: Substring match on category name
          const substringMatches = availableCategoryList.filter(
            category =>
              category.name.toLowerCase().includes(normalizedCategoryHint) ||
              normalizedCategoryHint.includes(category.name.toLowerCase())
          );

          if (substringMatches.length > 0) {
            upstreamCategoryId = [substringMatches[0].id];
            appliedFilters.category = {
              id: substringMatches[0].id,
              name: substringMatches[0].name,
              selector: categorySelector,
            };
          } else {
            // Strategy E: Known category group slug or alias
            const aliasGroupSlug = CATEGORY_GROUP_ALIASES[normalizedCategoryHint];
            if (aliasGroupSlug && SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(aliasGroupSlug)) {
              upstreamCategoryGroup = aliasGroupSlug;
              appliedFilters.categoryGroup = aliasGroupSlug;
              appliedFilters.category = {
                id: aliasGroupSlug,
                name: aliasGroupSlug,
                selector: buildCanonicalCategorySelector(aliasGroupSlug),
              };
            } else if (SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(normalizedCategoryHint)) {
              upstreamCategoryGroup = normalizedCategoryHint;
              appliedFilters.categoryGroup = normalizedCategoryHint;
              appliedFilters.category = {
                id: normalizedCategoryHint,
                name: normalizedCategoryHint,
                selector: buildCanonicalCategorySelector(normalizedCategoryHint),
              };
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
      selector: relativeRangeResult.selector,
    };
  } else if (Array.isArray(queryOptions.dateRange)) {
    const rawArray = queryOptions.dateRange.slice(0, 2);
    const validOperators = ['eq.', 'gt.', 'gte.', 'lt.', 'lte.'];
    const validatedTokens: string[] = [];
    let lowerBoundTimestamp: number | undefined = undefined;
    let upperBoundTimestamp: number | undefined = undefined;
    let lowerBoundIsStrict = false;
    let upperBoundIsStrict = false;

    for (const token of rawArray) {
      if (typeof token !== 'string') {
        continue;
      }
      const matchedOperatorPrefix = validOperators.find(op => token.startsWith(op));
      if (!matchedOperatorPrefix) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: token,
          reason: 'INVALID_FORMAT',
          message: `Format filter tanggal "${token}" tidak valid. Gunakan prefix operator: eq., gt., gte., lt., atau lte.`,
        });
        break;
      }
      const rawDatePortion = token.slice(matchedOperatorPrefix.length);
      if (!isValidCalendarDateString(rawDatePortion)) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: token,
          reason: 'INVALID_FORMAT',
          message: `Tanggal "${rawDatePortion}" tidak valid atau bukan tanggal kalender yang valid.`,
        });
        break;
      }

      const parsedTimestamp = parseTimestampForDateToken(rawDatePortion);
      const operatorName = matchedOperatorPrefix.replace('.', '');

      if (operatorName === 'gte' || operatorName === 'gt') {
        lowerBoundTimestamp = parsedTimestamp;
        lowerBoundIsStrict = operatorName === 'gt';
      } else if (operatorName === 'lte' || operatorName === 'lt') {
        upperBoundTimestamp = parsedTimestamp;
        upperBoundIsStrict = operatorName === 'lt';
      }

      validatedTokens.push(token);
    }

    if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange')) {
      if (lowerBoundTimestamp !== undefined && upperBoundTimestamp !== undefined) {
        const isReversed = lowerBoundTimestamp > upperBoundTimestamp;
        const isEmptyStrictRange = lowerBoundTimestamp === upperBoundTimestamp && (lowerBoundIsStrict || upperBoundIsStrict);

        if (isReversed || isEmptyStrictRange) {
          unresolvedFilterIssues.push({
            filterKey: 'dateRange',
            rawValue: rawArray.join(' '),
            reason: 'INVALID_RANGE',
            message: `Rentang tanggal tidak valid: batas awal tidak boleh lebih besar dari batas akhir.`,
          });
        }
      }
    }

    if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange') && validatedTokens.length > 0) {
      let fromDateString: string | undefined = undefined;
      let toDateString: string | undefined = undefined;
      let isAllDateOnly = true;

      for (const token of validatedTokens) {
        const matchedOp = validOperators.find(op => token.startsWith(op))!;
        const rawPart = token.slice(matchedOp.length);
        if (!isDateOnlyString(rawPart)) {
          isAllDateOnly = false;
          break;
        }
        const opName = matchedOp.replace('.', '');
        if (opName === 'eq') {
          fromDateString = rawPart;
          toDateString = rawPart;
        } else if (opName === 'gte' || opName === 'gt') {
          fromDateString = rawPart;
        } else if (opName === 'lte' || opName === 'lt') {
          toDateString = rawPart;
        }
      }

      if (isAllDateOnly && (fromDateString || toDateString)) {
        if (fromDateString && toDateString && fromDateString === toDateString) {
          upstreamRecordDate = resolveLocalCalendarDayRange(fromDateString, timezoneIdentifier);
          appliedFilters.dateRange = {
            from: fromDateString,
            to: toDateString,
            selector: fromDateString,
            label: fromDateString,
            rawRange: upstreamRecordDate,
          };
        } else if (fromDateString && toDateString) {
          upstreamRecordDate = resolveLocalCalendarRange(fromDateString, toDateString, timezoneIdentifier);
          appliedFilters.dateRange = {
            from: fromDateString,
            to: toDateString,
            selector: `${fromDateString} ${toDateString}`,
            label: `${fromDateString} - ${toDateString}`,
            rawRange: upstreamRecordDate,
          };
        } else if (fromDateString) {
          const [gteStartBoundary] = resolveLocalCalendarDayRange(fromDateString, timezoneIdentifier);
          upstreamRecordDate = [gteStartBoundary];
          appliedFilters.dateRange = {
            from: fromDateString,
            selector: fromDateString,
            label: `>= ${fromDateString}`,
            rawRange: upstreamRecordDate,
          };
        } else if (toDateString) {
          const [, ltEndBoundary] = resolveLocalCalendarDayRange(toDateString, timezoneIdentifier);
          upstreamRecordDate = [ltEndBoundary];
          appliedFilters.dateRange = {
            to: toDateString,
            selector: toDateString,
            label: `<= ${toDateString}`,
            rawRange: upstreamRecordDate,
          };
        }
      } else {
        upstreamRecordDate = validatedTokens;
        appliedFilters.dateRange = {
          rawRange: validatedTokens,
        };
      }
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
      let parsedFromTimestamp: number | undefined = undefined;
      let parsedToTimestamp: number | undefined = undefined;

      if (rawFrom) {
        if (!isValidCalendarDateString(rawFrom)) {
          unresolvedFilterIssues.push({
            filterKey: 'dateRange',
            rawValue: rawFrom,
            reason: 'INVALID_FORMAT',
            message: `Tanggal mulai "${rawFrom}" tidak valid atau bukan tanggal kalender yang valid.`,
          });
        } else {
          parsedFromTimestamp = parseTimestampForDateToken(rawFrom);
        }
      }

      if (rawTo) {
        if (!isValidCalendarDateString(rawTo)) {
          unresolvedFilterIssues.push({
            filterKey: 'dateRange',
            rawValue: rawTo,
            reason: 'INVALID_FORMAT',
            message: `Tanggal akhir "${rawTo}" tidak valid atau bukan tanggal kalender yang valid.`,
          });
        } else {
          parsedToTimestamp = parseTimestampForDateToken(rawTo);
        }
      }

      if (
        parsedFromTimestamp !== undefined &&
        parsedToTimestamp !== undefined &&
        parsedFromTimestamp > parsedToTimestamp
      ) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: `${rawFrom} - ${rawTo}`,
          reason: 'INVALID_RANGE',
          message: `Rentang tanggal tidak valid: tanggal mulai (${rawFrom}) tidak boleh lebih besar dari tanggal akhir (${rawTo}).`,
        });
      } else if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange')) {
        const fromDateString = rawFrom ? rawFrom.trim().slice(0, 10) : undefined;
        const toDateString = rawTo ? rawTo.trim().slice(0, 10) : undefined;

        if (fromDateString && toDateString && fromDateString === toDateString && isDateOnlyString(fromDateString)) {
          upstreamRecordDate = resolveLocalCalendarDayRange(fromDateString, timezoneIdentifier);
          appliedFilters.dateRange = {
            from: fromDateString,
            to: toDateString,
            selector: fromDateString,
            label: fromDateString,
            rawRange: upstreamRecordDate,
          };
        } else if (fromDateString && toDateString && isDateOnlyString(fromDateString) && isDateOnlyString(toDateString)) {
          upstreamRecordDate = resolveLocalCalendarRange(fromDateString, toDateString, timezoneIdentifier);
          appliedFilters.dateRange = {
            from: fromDateString,
            to: toDateString,
            selector: `${fromDateString} ${toDateString}`,
            label: `${fromDateString} - ${toDateString}`,
            rawRange: upstreamRecordDate,
          };
        } else if (fromDateString && isDateOnlyString(fromDateString)) {
          const [gteStartBoundary] = resolveLocalCalendarDayRange(fromDateString, timezoneIdentifier);
          upstreamRecordDate = [gteStartBoundary];
          appliedFilters.dateRange = {
            from: fromDateString,
            selector: fromDateString,
            label: `>= ${fromDateString}`,
            rawRange: upstreamRecordDate,
          };
        } else if (toDateString && isDateOnlyString(toDateString)) {
          const [, ltEndBoundary] = resolveLocalCalendarDayRange(toDateString, timezoneIdentifier);
          upstreamRecordDate = [ltEndBoundary];
          appliedFilters.dateRange = {
            to: toDateString,
            selector: toDateString,
            label: `<= ${toDateString}`,
            rawRange: upstreamRecordDate,
          };
        } else {
          const tokens: string[] = [];
          if (rawFrom) {
            tokens.push(`gte.${rawFrom}`);
          }
          if (rawTo) {
            tokens.push(`lte.${rawTo}`);
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
  }

  const isValid = unresolvedFilterIssues.length === 0;

  if (isValid) {
    const navigationTokens: string[] = [];
    if (appliedFilters.account?.selector) {
      navigationTokens.push(appliedFilters.account.selector);
    }
    if (appliedFilters.category?.selector) {
      navigationTokens.push(appliedFilters.category.selector);
    } else if (appliedFilters.categoryGroup) {
      navigationTokens.push(buildCanonicalCategorySelector(appliedFilters.categoryGroup));
    }
    if (appliedFilters.recordType) {
      navigationTokens.push(appliedFilters.recordType === 'expense' ? 'pengeluaran' : 'pemasukan');
    }
    if (appliedFilters.dateRange?.selector) {
      navigationTokens.push(appliedFilters.dateRange.selector);
    }
    if (navigationTokens.length > 0) {
      appliedFilters.navigationTokens = navigationTokens;
    }
  }

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
