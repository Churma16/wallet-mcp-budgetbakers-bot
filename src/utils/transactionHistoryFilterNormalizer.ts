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
import { MAX_SEARCH_QUERY_LENGTH } from './transactionSearchMatcher.js';

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
  upstreamSearchQuery?: string;
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
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})$/i
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

export interface NormalizedBoundaryResult {
  recordDateToken: string;
  isoInstant: string;
  isDateOnly: boolean;
  operator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
}

export function normalizeDateBoundary(
  rawDate: string,
  boundaryType: 'start' | 'end',
  operator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq',
  timezoneIdentifier: string
): NormalizedBoundaryResult {
  const trimmed = rawDate.trim();
  const dateOnly = isDateOnlyString(trimmed);

  if (dateOnly) {
    if (boundaryType === 'start') {
      if (operator === 'gt') {
        const nextDayString = getNextLocalDateString(trimmed);
        const [gteNextDay] = resolveLocalCalendarDayRange(nextDayString, timezoneIdentifier);
        return {
          recordDateToken: gteNextDay,
          isoInstant: gteNextDay.replace('gte.', ''),
          isDateOnly: true,
          operator,
        };
      }
      const [gteDay] = resolveLocalCalendarDayRange(trimmed, timezoneIdentifier);
      return {
        recordDateToken: gteDay,
        isoInstant: gteDay.replace('gte.', ''),
        isDateOnly: true,
        operator,
      };
    } else {
      if (operator === 'lt') {
        const [gteDay] = resolveLocalCalendarDayRange(trimmed, timezoneIdentifier);
        const ltBoundary = gteDay.replace('gte.', 'lt.');
        return {
          recordDateToken: ltBoundary,
          isoInstant: ltBoundary.replace('lt.', ''),
          isDateOnly: true,
          operator,
        };
      }
      const [, ltNextDay] = resolveLocalCalendarDayRange(trimmed, timezoneIdentifier);
      return {
        recordDateToken: ltNextDay,
        isoInstant: ltNextDay.replace('lt.', ''),
        isDateOnly: true,
        operator,
      };
    }
  }

  // Datetime instant
  const parsedDate = new Date(trimmed);
  const utcIso = parsedDate.toISOString();
  const effectiveOp = operator === 'eq' ? (boundaryType === 'start' ? 'gte' : 'lte') : operator;
  return {
    recordDateToken: `${effectiveOp}.${utcIso}`,
    isoInstant: utcIso,
    isDateOnly: false,
    operator,
  };
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
          subType: 'name',
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
          const candidateNames = substringMatches.map(account => account.name).sort((a, b) => a.localeCompare(b));
          unresolvedFilterIssues.push({
            filterKey: 'account',
            rawValue: trimmedAccountHint,
            reason: 'UNRESOLVED',
            candidates: candidateNames,
            subType: 'name',
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
            const candidateNames = bankAccountMatches.map(account => account.name).sort((a, b) => a.localeCompare(b));
            unresolvedFilterIssues.push({
              filterKey: 'account',
              rawValue: trimmedAccountHint,
              reason: 'UNRESOLVED',
              candidates: candidateNames,
              subType: 'bank_account',
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

        if (exactNameMatches.length === 1) {
          upstreamCategoryId = [exactNameMatches[0].id];
          appliedFilters.category = {
            id: exactNameMatches[0].id,
            name: exactNameMatches[0].name,
            selector: categorySelector,
          };
        } else if (exactNameMatches.length > 1) {
          const candidateNames = exactNameMatches.map(category => category.name).sort((a, b) => a.localeCompare(b));
          unresolvedFilterIssues.push({
            filterKey: 'category',
            rawValue: trimmedCategoryHint,
            reason: 'UNRESOLVED',
            candidates: candidateNames,
            subType: 'name',
            message: `Kategori "${trimmedCategoryHint}" ambigu. Ditemukan beberapa kategori dengan nama yang sama: ${candidateNames.join(', ')}.`,
          });
        } else {
          // Strategy D: Substring match on category name
          const substringMatches = availableCategoryList.filter(
            category =>
              category.name.toLowerCase().includes(normalizedCategoryHint) ||
              normalizedCategoryHint.includes(category.name.toLowerCase())
          );

          if (substringMatches.length === 1) {
            upstreamCategoryId = [substringMatches[0].id];
            appliedFilters.category = {
              id: substringMatches[0].id,
              name: substringMatches[0].name,
              selector: categorySelector,
            };
          } else if (substringMatches.length > 1) {
            const candidateNames = substringMatches.map(category => category.name).sort((a, b) => a.localeCompare(b));
            unresolvedFilterIssues.push({
              filterKey: 'category',
              rawValue: trimmedCategoryHint,
              reason: 'UNRESOLVED',
              candidates: candidateNames,
              subType: 'name',
              message: `Kategori "${trimmedCategoryHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
            });
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
    const validatedTokens: Array<{ token: string; operator: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; rawDate: string }> = [];

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
          subType: 'operator_prefix',
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
          subType: 'calendar_date',
          message: `Tanggal "${rawDatePortion}" tidak valid atau bukan tanggal kalender yang valid.`,
        });
        break;
      }

      const operatorName = matchedOperatorPrefix.replace('.', '') as 'eq' | 'gt' | 'gte' | 'lt' | 'lte';
      validatedTokens.push({
        token,
        operator: operatorName,
        rawDate: rawDatePortion,
      });
    }

    if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange') && validatedTokens.length > 0) {
      interface BoundaryConstraint {
        timestamp: number;
        isInclusive: boolean;
        recordDateToken: string;
        isoInstant: string;
        rawDate: string;
        isDateOnly: boolean;
        operator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
        isFromEq?: boolean;
      }

      const lowerConstraintList: BoundaryConstraint[] = [];
      const upperConstraintList: BoundaryConstraint[] = [];

      for (const validatedTokenItem of validatedTokens) {
        if (validatedTokenItem.operator === 'eq') {
          if (isDateOnlyString(validatedTokenItem.rawDate)) {
            const lowerBoundaryResult = normalizeDateBoundary(validatedTokenItem.rawDate, 'start', 'gte', timezoneIdentifier);
            const upperBoundaryResult = normalizeDateBoundary(validatedTokenItem.rawDate, 'end', 'lte', timezoneIdentifier);
            lowerConstraintList.push({
              timestamp: Date.parse(lowerBoundaryResult.isoInstant),
              isInclusive: true,
              recordDateToken: lowerBoundaryResult.recordDateToken,
              isoInstant: lowerBoundaryResult.isoInstant,
              rawDate: validatedTokenItem.rawDate,
              isDateOnly: true,
              operator: 'eq',
              isFromEq: true,
            });
            upperConstraintList.push({
              timestamp: Date.parse(upperBoundaryResult.isoInstant),
              isInclusive: false,
              recordDateToken: upperBoundaryResult.recordDateToken,
              isoInstant: upperBoundaryResult.isoInstant,
              rawDate: validatedTokenItem.rawDate,
              isDateOnly: true,
              operator: 'eq',
              isFromEq: true,
            });
          } else {
            const exactUtcIsoString = new Date(validatedTokenItem.rawDate).toISOString();
            const exactInstantTimestamp = Date.parse(exactUtcIsoString);
            lowerConstraintList.push({
              timestamp: exactInstantTimestamp,
              isInclusive: true,
              recordDateToken: `gte.${exactUtcIsoString}`,
              isoInstant: exactUtcIsoString,
              rawDate: exactUtcIsoString,
              isDateOnly: false,
              operator: 'eq',
              isFromEq: true,
            });
            upperConstraintList.push({
              timestamp: exactInstantTimestamp,
              isInclusive: true,
              recordDateToken: `lte.${exactUtcIsoString}`,
              isoInstant: exactUtcIsoString,
              rawDate: exactUtcIsoString,
              isDateOnly: false,
              operator: 'eq',
              isFromEq: true,
            });
          }
        } else if (validatedTokenItem.operator === 'gte' || validatedTokenItem.operator === 'gt') {
          const lowerBoundaryResult = normalizeDateBoundary(validatedTokenItem.rawDate, 'start', validatedTokenItem.operator, timezoneIdentifier);
          const isInclusive = lowerBoundaryResult.isDateOnly ? true : validatedTokenItem.operator === 'gte';
          lowerConstraintList.push({
            timestamp: Date.parse(lowerBoundaryResult.isoInstant),
            isInclusive,
            recordDateToken: lowerBoundaryResult.recordDateToken,
            isoInstant: lowerBoundaryResult.isoInstant,
            rawDate: validatedTokenItem.rawDate,
            isDateOnly: lowerBoundaryResult.isDateOnly,
            operator: validatedTokenItem.operator,
          });
        } else if (validatedTokenItem.operator === 'lte' || validatedTokenItem.operator === 'lt') {
          const upperBoundaryResult = normalizeDateBoundary(validatedTokenItem.rawDate, 'end', validatedTokenItem.operator, timezoneIdentifier);
          const isInclusive = upperBoundaryResult.isDateOnly ? false : validatedTokenItem.operator === 'lte';
          upperConstraintList.push({
            timestamp: Date.parse(upperBoundaryResult.isoInstant),
            isInclusive,
            recordDateToken: upperBoundaryResult.recordDateToken,
            isoInstant: upperBoundaryResult.isoInstant,
            rawDate: validatedTokenItem.rawDate,
            isDateOnly: upperBoundaryResult.isDateOnly,
            operator: validatedTokenItem.operator,
          });
        }
      }

      let effectiveLowerConstraint: BoundaryConstraint | undefined = undefined;
      for (const candidateLower of lowerConstraintList) {
        if (!effectiveLowerConstraint) {
          effectiveLowerConstraint = candidateLower;
        } else if (candidateLower.timestamp > effectiveLowerConstraint.timestamp) {
          effectiveLowerConstraint = candidateLower;
        } else if (candidateLower.timestamp === effectiveLowerConstraint.timestamp) {
          if (!candidateLower.isInclusive && effectiveLowerConstraint.isInclusive) {
            effectiveLowerConstraint = candidateLower;
          }
        }
      }

      let effectiveUpperConstraint: BoundaryConstraint | undefined = undefined;
      for (const candidateUpper of upperConstraintList) {
        if (!effectiveUpperConstraint) {
          effectiveUpperConstraint = candidateUpper;
        } else if (candidateUpper.timestamp < effectiveUpperConstraint.timestamp) {
          effectiveUpperConstraint = candidateUpper;
        } else if (candidateUpper.timestamp === effectiveUpperConstraint.timestamp) {
          if (!candidateUpper.isInclusive && effectiveUpperConstraint.isInclusive) {
            effectiveUpperConstraint = candidateUpper;
          }
        }
      }

      let isContradictoryInterval = false;
      if (effectiveLowerConstraint && effectiveUpperConstraint) {
        if (effectiveLowerConstraint.timestamp > effectiveUpperConstraint.timestamp) {
          isContradictoryInterval = true;
        } else if (effectiveLowerConstraint.timestamp === effectiveUpperConstraint.timestamp) {
          isContradictoryInterval = !(effectiveLowerConstraint.isInclusive && effectiveUpperConstraint.isInclusive);
        }
      }

      if (isContradictoryInterval) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: rawArray.join(' '),
          reason: 'INVALID_RANGE',
          subType: 'start_after_end',
          message: `Rentang tanggal tidak valid: batas awal tidak boleh lebih besar dari batas akhir.`,
        });
      } else if (effectiveLowerConstraint && effectiveUpperConstraint) {
        const isStandardRange =
          (effectiveLowerConstraint.operator === 'gte' || effectiveLowerConstraint.operator === 'eq') &&
          (effectiveUpperConstraint.operator === 'lte' || effectiveUpperConstraint.operator === 'eq');
        const lowerSymbol = effectiveLowerConstraint.operator === 'gt' ? '>' : '>=';
        const upperSymbol = effectiveUpperConstraint.operator === 'lt' ? '<' : '<=';

        const canonicalFrom = effectiveLowerConstraint.isDateOnly ? effectiveLowerConstraint.rawDate : effectiveLowerConstraint.isoInstant;
        const canonicalTo = effectiveUpperConstraint.isDateOnly ? effectiveUpperConstraint.rawDate : effectiveUpperConstraint.isoInstant;

        if (
          effectiveLowerConstraint.isDateOnly &&
          effectiveUpperConstraint.isDateOnly &&
          effectiveLowerConstraint.rawDate === effectiveUpperConstraint.rawDate &&
          isStandardRange
        ) {
          upstreamRecordDate = resolveLocalCalendarDayRange(effectiveLowerConstraint.rawDate, timezoneIdentifier);
          appliedFilters.dateRange = {
            from: canonicalFrom,
            to: canonicalTo,
            selector: canonicalFrom,
            label: canonicalFrom,
            rawRange: upstreamRecordDate,
          };
        } else if (
          !effectiveLowerConstraint.isDateOnly &&
          !effectiveUpperConstraint.isDateOnly &&
          effectiveLowerConstraint.timestamp === effectiveUpperConstraint.timestamp &&
          effectiveLowerConstraint.isInclusive &&
          effectiveUpperConstraint.isInclusive
        ) {
          const exactUtcIso = effectiveLowerConstraint.isoInstant;
          upstreamRecordDate = [`gte.${exactUtcIso}`, `lte.${exactUtcIso}`];
          appliedFilters.dateRange = {
            from: exactUtcIso,
            to: exactUtcIso,
            selector: `${exactUtcIso} ${exactUtcIso}`,
            label: exactUtcIso,
            rawRange: upstreamRecordDate,
          };
        } else {
          upstreamRecordDate = [effectiveLowerConstraint.recordDateToken, effectiveUpperConstraint.recordDateToken];
          appliedFilters.dateRange = {
            from: canonicalFrom,
            to: canonicalTo,
            selector: isStandardRange
              ? `${canonicalFrom} ${canonicalTo}`
              : `${lowerSymbol} ${canonicalFrom} ${upperSymbol} ${canonicalTo}`,
            label: isStandardRange
              ? `${canonicalFrom} - ${canonicalTo}`
              : `${lowerSymbol} ${canonicalFrom} - ${upperSymbol} ${canonicalTo}`,
            rawRange: upstreamRecordDate,
          };
        }
      } else if (effectiveLowerConstraint) {
        upstreamRecordDate = [effectiveLowerConstraint.recordDateToken];
        const lowerSymbol = effectiveLowerConstraint.operator === 'gt' ? '>' : '>=';
        const canonicalFrom = effectiveLowerConstraint.isDateOnly ? effectiveLowerConstraint.rawDate : effectiveLowerConstraint.isoInstant;
        appliedFilters.dateRange = {
          from: canonicalFrom,
          selector: `${lowerSymbol} ${canonicalFrom}`,
          label: `${lowerSymbol} ${canonicalFrom}`,
          rawRange: upstreamRecordDate,
        };
      } else if (effectiveUpperConstraint) {
        upstreamRecordDate = [effectiveUpperConstraint.recordDateToken];
        const upperSymbol = effectiveUpperConstraint.operator === 'lt' ? '<' : '<=';
        const canonicalTo = effectiveUpperConstraint.isDateOnly ? effectiveUpperConstraint.rawDate : effectiveUpperConstraint.isoInstant;
        appliedFilters.dateRange = {
          to: canonicalTo,
          selector: `${upperSymbol} ${canonicalTo}`,
          label: `${upperSymbol} ${canonicalTo}`,
          rawRange: upstreamRecordDate,
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
      const trimmedFrom = rawFrom?.trim();
      const trimmedTo = rawTo?.trim();

      if (trimmedFrom && !isValidCalendarDateString(trimmedFrom)) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: trimmedFrom,
          reason: 'INVALID_FORMAT',
          subType: 'calendar_date',
          message: `Tanggal mulai "${trimmedFrom}" tidak valid atau bukan tanggal kalender yang valid.`,
        });
      }

      if (trimmedTo && !isValidCalendarDateString(trimmedTo)) {
        unresolvedFilterIssues.push({
          filterKey: 'dateRange',
          rawValue: trimmedTo,
          reason: 'INVALID_FORMAT',
          subType: 'calendar_date',
          message: `Tanggal akhir "${trimmedTo}" tidak valid atau bukan tanggal kalender yang valid.`,
        });
      }

      if (unresolvedFilterIssues.every(issue => issue.filterKey !== 'dateRange')) {
        let lowerResult: NormalizedBoundaryResult | undefined = undefined;
        let upperResult: NormalizedBoundaryResult | undefined = undefined;

        if (trimmedFrom) {
          lowerResult = normalizeDateBoundary(trimmedFrom, 'start', 'gte', timezoneIdentifier);
        }
        if (trimmedTo) {
          upperResult = normalizeDateBoundary(trimmedTo, 'end', 'lte', timezoneIdentifier);
        }

        if (lowerResult && upperResult && trimmedFrom && trimmedTo) {
          const lowerTimestamp = Date.parse(lowerResult.isoInstant);
          const upperTimestamp = Date.parse(upperResult.isoInstant);
          const isLowerInclusive = true;
          const isUpperInclusive = upperResult.isDateOnly ? false : true;

          const isContradictory =
            lowerTimestamp > upperTimestamp ||
            (lowerTimestamp === upperTimestamp && !(isLowerInclusive && isUpperInclusive));

          if (isContradictory) {
            unresolvedFilterIssues.push({
              filterKey: 'dateRange',
              rawValue: `${trimmedFrom} - ${trimmedTo}`,
              reason: 'INVALID_RANGE',
              subType: 'start_after_end',
              message: `Rentang tanggal tidak valid: tanggal mulai (${trimmedFrom}) tidak boleh lebih besar dari tanggal akhir (${trimmedTo}).`,
            });
          } else {
            upstreamRecordDate = [lowerResult.recordDateToken, upperResult.recordDateToken];
            const canonicalFrom = lowerResult.isDateOnly ? trimmedFrom : lowerResult.isoInstant;
            const canonicalTo = upperResult.isDateOnly ? trimmedTo : upperResult.isoInstant;

            if (lowerResult.isDateOnly && upperResult.isDateOnly && trimmedFrom === trimmedTo) {
              appliedFilters.dateRange = {
                from: canonicalFrom,
                to: canonicalTo,
                selector: canonicalFrom,
                label: canonicalFrom,
                rawRange: upstreamRecordDate,
              };
            } else {
              appliedFilters.dateRange = {
                from: canonicalFrom,
                to: canonicalTo,
                selector: `${canonicalFrom} ${canonicalTo}`,
                label: `${canonicalFrom} - ${canonicalTo}`,
                rawRange: upstreamRecordDate,
              };
            }
          }
        } else if (lowerResult && trimmedFrom) {
          const canonicalFrom = lowerResult.isDateOnly ? trimmedFrom : lowerResult.isoInstant;
          upstreamRecordDate = [lowerResult.recordDateToken];
          appliedFilters.dateRange = {
            from: canonicalFrom,
            selector: `>= ${canonicalFrom}`,
            label: `>= ${canonicalFrom}`,
            rawRange: upstreamRecordDate,
          };
        } else if (upperResult && trimmedTo) {
          const canonicalTo = upperResult.isDateOnly ? trimmedTo : upperResult.isoInstant;
          upstreamRecordDate = [upperResult.recordDateToken];
          appliedFilters.dateRange = {
            to: canonicalTo,
            selector: `<= ${canonicalTo}`,
            label: `<= ${canonicalTo}`,
            rawRange: upstreamRecordDate,
          };
        }
      }
    }
  }

  // 5. Free-text search keyword validation and normalization
  let upstreamSearchQuery: string | undefined = undefined;
  if (queryOptions?.searchQuery !== undefined) {
    if (typeof queryOptions.searchQuery !== 'string') {
      unresolvedFilterIssues.push({
        filterKey: 'searchQuery',
        rawValue: String(queryOptions.searchQuery),
        reason: 'INVALID_FORMAT',
        message: 'Kata kunci pencarian harus berupa teks.',
      });
    } else {
      const trimmedSearchQuery = queryOptions.searchQuery.trim();
      if (trimmedSearchQuery.length === 0) {
        unresolvedFilterIssues.push({
          filterKey: 'searchQuery',
          rawValue: queryOptions.searchQuery,
          reason: 'INVALID_FORMAT',
          message: 'Kata kunci pencarian tidak boleh kosong.',
        });
      } else if (trimmedSearchQuery.length > MAX_SEARCH_QUERY_LENGTH) {
        unresolvedFilterIssues.push({
          filterKey: 'searchQuery',
          rawValue: queryOptions.searchQuery,
          reason: 'INVALID_FORMAT',
          message: `Kata kunci pencarian terlalu panjang (maksimal ${MAX_SEARCH_QUERY_LENGTH} karakter).`,
        });
      } else {
        upstreamSearchQuery = trimmedSearchQuery;
        appliedFilters.searchQuery = trimmedSearchQuery;
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
    if (appliedFilters.searchQuery) {
      navigationTokens.push(`cari "${appliedFilters.searchQuery}"`);
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
    searchQuery: upstreamSearchQuery,
  };

  return {
    isValid,
    normalizedOptions,
    upstreamRecordDate,
    upstreamAccountId,
    upstreamCategoryId,
    upstreamCategoryGroup,
    upstreamRecordType,
    upstreamSearchQuery,
    appliedFilters,
    unresolvedFilters: unresolvedFilterIssues,
  };
}
