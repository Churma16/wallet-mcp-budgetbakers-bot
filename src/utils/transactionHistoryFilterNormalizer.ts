import {
  TransactionHistoryQueryOptions,
  TransactionRecordTypeFilter,
  RelativeDatePeriod,
  AppliedTransactionHistoryFilters,
  UnresolvedFilterIssue,
  WalletAccountItem,
  WalletCategoryItem,
} from '../types/walletTypes.js';
import { getApplicationTimezone } from '../config/applicationConfig.js';
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

export const MAX_GROUP_CATEGORIES_LIMIT = 50;

export interface DynamicCategoryGroupInfo {
  id: string;
  name: string;
  categoryIds: string[];
  categories: WalletCategoryItem[];
}

export const CATEGORY_GROUP_ALIASES: Readonly<Record<string, string>> = {
  food: 'food_and_drinks',
  makan: 'food_and_drinks',
  makanan: 'food_and_drinks',
  minuman: 'food_and_drinks',
  minum: 'food_and_drinks',
  drink: 'food_and_drinks',
  drinks: 'food_and_drinks',
  'food & drink': 'food_and_drinks',
  'food and drink': 'food_and_drinks',
  'food & drinks': 'food_and_drinks',
  'food and drinks': 'food_and_drinks',
  'makan & minum': 'food_and_drinks',
  'makan dan minum': 'food_and_drinks',
  'makanan & minuman': 'food_and_drinks',
  'makanan dan minuman': 'food_and_drinks',
  transport: 'transportation',
  transportasi: 'transportation',
  belanja: 'shopping',
  shop: 'shopping',
  shopping: 'shopping',
  hiburan: 'life_entertainment',
  entertainment: 'life_entertainment',
  'life & entertainment': 'life_entertainment',
  'life and entertainment': 'life_entertainment',
  'hiburan & gaya hidup': 'life_entertainment',
  'hiburan dan gaya hidup': 'life_entertainment',
  'gaya hidup & hiburan': 'life_entertainment',
  'gaya hidup dan hiburan': 'life_entertainment',
  tagihan: 'financial_expenses',
  bills: 'financial_expenses',
  'financial expense': 'financial_expenses',
  'financial expenses': 'financial_expenses',
  'biaya keuangan': 'financial_expenses',
  investasi: 'investments',
  investment: 'investments',
  rumah: 'housing',
  housing: 'housing',
  kendaraan: 'vehicle',
  vehicle: 'vehicle',
  komunikasi: 'communication_pc',
  communication: 'communication_pc',
  'communication & pc': 'communication_pc',
  'communication and pc': 'communication_pc',
  'komunikasi & pc': 'communication_pc',
  'komunikasi dan pc': 'communication_pc',
};

export function normalizeGroupMatchingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[_]+/g, ' ')
    .replace(/\b(?:dan|and)\b/gi, '&')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/[\s+-]+/g, ' ')
    .trim();
}

export function matchesCategorySubstring(categoryName: string, normalizedHint: string): boolean {
  const normalizedCategoryName = categoryName.toLowerCase().trim();
  const cleanHint = normalizedHint.toLowerCase().trim();
  if (!normalizedCategoryName || !cleanHint) {
    return false;
  }
  if (normalizedCategoryName.includes(cleanHint)) {
    return true;
  }
  const standardizedCategory = normalizeGroupMatchingText(normalizedCategoryName);
  const standardizedHint = normalizeGroupMatchingText(cleanHint);
  if (standardizedCategory.includes(standardizedHint)) {
    return true;
  }
  return false;
}

export function extractDynamicCategoryGroups(
  availableCategoryList: WalletCategoryItem[]
): Map<string, DynamicCategoryGroupInfo> {
  const dynamicGroupMap = new Map<string, DynamicCategoryGroupInfo>();

  for (const categoryItem of availableCategoryList) {
    if (!categoryItem.group) {
      continue;
    }
    const rawGroupId = (
      typeof categoryItem.group === 'string'
        ? categoryItem.group
        : String(categoryItem.group.id || categoryItem.group.name || '')
    ).trim();
    const rawGroupName = (
      typeof categoryItem.group === 'string'
        ? categoryItem.group
        : String(categoryItem.group.name || categoryItem.group.id || '')
    ).trim();

    if (!rawGroupId && !rawGroupName) {
      continue;
    }

    const normalizedGroupId = (rawGroupId || rawGroupName).toLowerCase();
    let existingGroup = dynamicGroupMap.get(normalizedGroupId);
    if (!existingGroup) {
      existingGroup = {
        id: rawGroupId || rawGroupName,
        name: rawGroupName || rawGroupId,
        categoryIds: [],
        categories: [],
      };
      dynamicGroupMap.set(normalizedGroupId, existingGroup);
    }

    if (!existingGroup.categoryIds.includes(categoryItem.id)) {
      existingGroup.categoryIds.push(categoryItem.id);
      existingGroup.categories.push(categoryItem);
    }
  }

  return dynamicGroupMap;
}

export interface DynamicCategoryGroupMatchResult {
  status: 'EXACT_MATCH' | 'FUZZY_MATCH' | 'AMBIGUOUS' | 'NO_MATCH';
  group?: DynamicCategoryGroupInfo;
  candidates?: DynamicCategoryGroupInfo[];
}

export function matchDynamicCategoryGroup(
  groupHint: string,
  dynamicGroupMap: Map<string, DynamicCategoryGroupInfo>
): DynamicCategoryGroupMatchResult {
  const normalizedHint = groupHint.toLowerCase().trim();
  const standardizedHint = normalizeGroupMatchingText(normalizedHint);

  // 1. Direct match on group id
  const directIdMatch = dynamicGroupMap.get(normalizedHint);
  if (directIdMatch) {
    return { status: 'EXACT_MATCH', group: directIdMatch };
  }

  // 2. Direct match on group name (case-insensitive)
  for (const groupEntry of dynamicGroupMap.values()) {
    if (groupEntry.name.toLowerCase() === normalizedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
  }

  // 3. Match via alias
  const aliasedGroupId = CATEGORY_GROUP_ALIASES[normalizedHint] || CATEGORY_GROUP_ALIASES[standardizedHint];
  if (aliasedGroupId) {
    const aliasedIdMatch = dynamicGroupMap.get(aliasedGroupId.toLowerCase());
    if (aliasedIdMatch) {
      return { status: 'EXACT_MATCH', group: aliasedIdMatch };
    }
    for (const groupEntry of dynamicGroupMap.values()) {
      if (
        groupEntry.id.toLowerCase() === aliasedGroupId.toLowerCase() ||
        groupEntry.name.toLowerCase() === aliasedGroupId.toLowerCase()
      ) {
        return { status: 'EXACT_MATCH', group: groupEntry };
      }
    }
  }

  // 4. Standardized text match (handles "Food and Drinks" vs "Food & Drinks", "Kebugaran dan Kesehatan" vs "Kebugaran & Kesehatan")
  for (const groupEntry of dynamicGroupMap.values()) {
    const standardizedGroupName = normalizeGroupMatchingText(groupEntry.name);
    const standardizedGroupId = normalizeGroupMatchingText(groupEntry.id);
    if (standardizedGroupName === standardizedHint || standardizedGroupId === standardizedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
    if (aliasedGroupId) {
      const standardizedAliasedId = normalizeGroupMatchingText(aliasedGroupId);
      if (standardizedGroupName === standardizedAliasedId || standardizedGroupId === standardizedAliasedId) {
        return { status: 'EXACT_MATCH', group: groupEntry };
      }
    }
  }

  // 5. Slugified name match (e.g. "food_and_drinks" or "food & drinks")
  const slugifiedHint = normalizedHint.replace(/[\s&_-]+/g, '_');
  for (const groupEntry of dynamicGroupMap.values()) {
    const slugifiedGroupName = groupEntry.name.toLowerCase().replace(/[\s&_-]+/g, '_');
    const slugifiedGroupId = groupEntry.id.toLowerCase().replace(/[\s&_-]+/g, '_');
    if (slugifiedGroupName === slugifiedHint || slugifiedGroupId === slugifiedHint) {
      return { status: 'EXACT_MATCH', group: groupEntry };
    }
  }

  // 6. Fuzzy token or substring match against group name or group id.
  // Collect all matching candidate groups to avoid iteration-order dependence and fail closed on ambiguity!
  const fuzzyCandidateMap = new Map<string, DynamicCategoryGroupInfo>();
  for (const groupEntry of dynamicGroupMap.values()) {
    const groupWords = groupEntry.name
      .toLowerCase()
      .split(/[\s&_,./-]+/)
      .filter(w => w.length > 2);
    const groupNameLower = groupEntry.name.toLowerCase();
    const groupIdLower = groupEntry.id.toLowerCase();

    let matched = false;
    if (groupWords.includes(normalizedHint)) {
      matched = true;
    } else if (
      normalizedHint.length >= 3 &&
      (groupNameLower.includes(normalizedHint) || groupIdLower.includes(normalizedHint))
    ) {
      matched = true;
    }

    if (matched) {
      fuzzyCandidateMap.set(groupEntry.id, groupEntry);
    }
  }

  if (fuzzyCandidateMap.size === 1) {
    const singleGroup = Array.from(fuzzyCandidateMap.values())[0];
    return { status: 'FUZZY_MATCH', group: singleGroup };
  } else if (fuzzyCandidateMap.size > 1) {
    const sortedCandidates = Array.from(fuzzyCandidateMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return { status: 'AMBIGUOUS', candidates: sortedCandidates };
  }

  return { status: 'NO_MATCH' };
}

export function findMatchingDynamicCategoryGroup(
  groupHint: string,
  dynamicGroupMap: Map<string, DynamicCategoryGroupInfo>
): DynamicCategoryGroupInfo | undefined {
  const matchResult = matchDynamicCategoryGroup(groupHint, dynamicGroupMap);
  if (matchResult.status === 'EXACT_MATCH' || matchResult.status === 'FUZZY_MATCH') {
    return matchResult.group;
  }
  return undefined;
}

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

function resolveCategoryGroupFilter(
  rawCategoryHint: string,
  dynamicGroupMap: Map<string, DynamicCategoryGroupInfo>,
  availableCategoryList: WalletCategoryItem[],
  unresolvedFilterIssues: UnresolvedFilterIssue[],
  appliedFilters: AppliedTransactionHistoryFilters,
  categorySelector?: string,
  isExplicitGroup: boolean = false
): { upstreamCategoryId?: string[]; upstreamCategoryGroup?: string } {
  const normalizedHint = rawCategoryHint.toLowerCase().trim();
  const matchResult = matchDynamicCategoryGroup(normalizedHint, dynamicGroupMap);

  if (matchResult.status === 'EXACT_MATCH' || matchResult.status === 'FUZZY_MATCH') {
    const matchedGroup = matchResult.group!;
    if (matchedGroup.categoryIds.length > MAX_GROUP_CATEGORIES_LIMIT) {
      unresolvedFilterIssues.push({
        filterKey: 'category',
        rawValue: rawCategoryHint,
        reason: 'UNSUPPORTED',
        message: `Grup kategori "${matchedGroup.name}" memiliki ${matchedGroup.categoryIds.length} kategori, melebihi batas maksimal ${MAX_GROUP_CATEGORIES_LIMIT} kategori per permintaan.`,
      });
      return {};
    }

    const categoryIds = [...matchedGroup.categoryIds];
    appliedFilters.categoryGroup = matchedGroup.id;
    appliedFilters.category = {
      id: categoryIds.join(','),
      name: matchedGroup.name,
      selector: categorySelector ?? buildCanonicalCategorySelector(matchedGroup.id),
    };
    return {
      upstreamCategoryId: categoryIds,
      upstreamCategoryGroup: matchedGroup.id,
    };
  }

  if (matchResult.status === 'AMBIGUOUS') {
    const candidateNames = matchResult.candidates!.map(group => group.name).sort((a, b) => a.localeCompare(b));
    unresolvedFilterIssues.push({
      filterKey: 'category',
      rawValue: rawCategoryHint,
      reason: 'UNRESOLVED',
      candidates: candidateNames,
      subType: 'name',
      message: `Grup kategori "${rawCategoryHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
    });
    return {};
  }

  if (dynamicGroupMap.size === 0) {
    const aliasGroupSlug = CATEGORY_GROUP_ALIASES[normalizedHint];
    if (aliasGroupSlug && SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(aliasGroupSlug)) {
      appliedFilters.categoryGroup = aliasGroupSlug;
      appliedFilters.category = {
        id: aliasGroupSlug,
        name: aliasGroupSlug,
        selector: categorySelector ?? buildCanonicalCategorySelector(aliasGroupSlug),
      };
      return { upstreamCategoryGroup: aliasGroupSlug };
    }
    if (SUPPORTED_BUDGETBAKERS_CATEGORY_GROUPS.includes(normalizedHint)) {
      appliedFilters.categoryGroup = normalizedHint;
      appliedFilters.category = {
        id: normalizedHint,
        name: normalizedHint,
        selector: categorySelector ?? buildCanonicalCategorySelector(normalizedHint),
      };
      return { upstreamCategoryGroup: normalizedHint };
    }
  }

  if (!isExplicitGroup) {
    const substringMatches = availableCategoryList.filter(
      category => matchesCategorySubstring(category.name, normalizedHint)
    );
    if (substringMatches.length > 0) {
      if (substringMatches.length > MAX_GROUP_CATEGORIES_LIMIT) {
        unresolvedFilterIssues.push({
          filterKey: 'category',
          rawValue: rawCategoryHint,
          reason: 'UNSUPPORTED',
          message: `Kategori yang cocok melebihi batas maksimal ${MAX_GROUP_CATEGORIES_LIMIT} kategori per permintaan.`,
        });
        return {};
      }

      const matchedCategoryIds = substringMatches.map(category => category.id);
      appliedFilters.category = {
        id: matchedCategoryIds.join(','),
        name: `${matchedCategoryIds.length} kategori`,
        selector: categorySelector,
      };
      return { upstreamCategoryId: matchedCategoryIds };
    }
  }

  unresolvedFilterIssues.push({
    filterKey: 'category',
    rawValue: rawCategoryHint,
    reason: 'NOT_FOUND',
    message: isExplicitGroup
      ? `Grup kategori "${rawCategoryHint}" tidak ditemukan dalam daftar kategori Wallet Anda.`
      : `Kategori "${rawCategoryHint}" tidak ditemukan dalam daftar kategori Wallet Anda.`,
  });
  return {};
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

  const dynamicGroupMap = extractDynamicCategoryGroups(availableCategoryList);

  if (rawCategoryGroup) {
    const groupResult = resolveCategoryGroupFilter(
      rawCategoryGroup,
      dynamicGroupMap,
      availableCategoryList,
      unresolvedFilterIssues,
      appliedFilters,
      undefined,
      true
    );
    upstreamCategoryId = groupResult.upstreamCategoryId;
    upstreamCategoryGroup = groupResult.upstreamCategoryGroup;
  } else if (rawCategoryId) {
    if (Array.isArray(rawCategoryId)) {
      if (rawCategoryId.length > MAX_GROUP_CATEGORIES_LIMIT) {
        unresolvedFilterIssues.push({
          filterKey: 'category',
          rawValue: `${rawCategoryId.length} kategori`,
          reason: 'UNSUPPORTED',
          message: `Daftar kategori melebihi batas maksimal ${MAX_GROUP_CATEGORIES_LIMIT} kategori.`,
        });
      } else {
        upstreamCategoryId = [...rawCategoryId];
        appliedFilters.category = {
          id: upstreamCategoryId.join(','),
          name: `${upstreamCategoryId.length} kategori`,
        };
      }
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
    let isGroupQuery = Boolean(queryOptions.isGroupQuery);
    let trimmedCategoryHint = rawCategoryName.trim();
    const groupScopePattern = /\b(?:semua|all|semuanya)\b/i;
    if (groupScopePattern.test(trimmedCategoryHint)) {
      isGroupQuery = true;
      trimmedCategoryHint = trimmedCategoryHint.replace(groupScopePattern, ' ').replace(/\s+/g, ' ').trim();
    }
    const normalizedCategoryHint = trimmedCategoryHint.toLowerCase();
    const categorySelector = buildCanonicalCategorySelector(trimmedCategoryHint);

    // Strategy A: Check 'unknown' / uncategorized
    if (
      normalizedCategoryHint === 'unknown' ||
      normalizedCategoryHint === 'uncategorized' ||
      normalizedCategoryHint === 'tanpa kategori'
    ) {
      upstreamCategoryId = ['unknown'];
      appliedFilters.category = { id: 'unknown', name: 'Tanpa Kategori', selector: categorySelector };
    } else {
      // Strategy B: Exact ID match
      const exactIdMatch = availableCategoryList.find(category => category.id === trimmedCategoryHint);
      if (exactIdMatch && !isGroupQuery) {
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

        if (!isGroupQuery && exactNameMatches.length === 1) {
          upstreamCategoryId = [exactNameMatches[0].id];
          appliedFilters.category = {
            id: exactNameMatches[0].id,
            name: exactNameMatches[0].name,
            selector: categorySelector,
          };
        } else if (!isGroupQuery && exactNameMatches.length > 1) {
          const candidateNames = exactNameMatches.map(category => category.name).sort((a, b) => a.localeCompare(b));
          unresolvedFilterIssues.push({
            filterKey: 'category',
            rawValue: trimmedCategoryHint,
            reason: 'UNRESOLVED',
            candidates: candidateNames,
            subType: 'name',
            message: `Kategori "${trimmedCategoryHint}" ambigu. Ditemukan beberapa kategori dengan nama yang sama: ${candidateNames.join(', ')}.`,
          });
        } else if (isGroupQuery) {
          // Explicit category group query (e.g. "riwayat makan semua", "semua riwayat makan bulan ini")
          const groupResult = resolveCategoryGroupFilter(
            trimmedCategoryHint,
            dynamicGroupMap,
            availableCategoryList,
            unresolvedFilterIssues,
            appliedFilters,
            categorySelector,
            false
          );
          upstreamCategoryId = groupResult.upstreamCategoryId;
          upstreamCategoryGroup = groupResult.upstreamCategoryGroup;
        } else {
          // Single-category query without group scope (isGroupQuery is false)
          const substringMatches = availableCategoryList.filter(
            category => matchesCategorySubstring(category.name, normalizedCategoryHint)
          );

          if (substringMatches.length === 1) {
            upstreamCategoryId = [substringMatches[0].id];
            appliedFilters.category = {
              id: substringMatches[0].id,
              name: substringMatches[0].name,
              selector: categorySelector,
            };
          } else if (substringMatches.length > 1) {
            // Unclear query with multiple candidate categories -> fail closed and clarify!
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
            // No substring matches. Check if hint maps to a dynamic group or group alias
            const matchResult = matchDynamicCategoryGroup(trimmedCategoryHint, dynamicGroupMap);

            if (matchResult.status === 'EXACT_MATCH' || matchResult.status === 'FUZZY_MATCH') {
              const matchedGroup = matchResult.group!;
              if (matchedGroup.categoryIds.length === 1) {
                // Exactly one category in the group -> unambiguous single category
                upstreamCategoryId = [matchedGroup.categoryIds[0]];
                appliedFilters.category = {
                  id: matchedGroup.categoryIds[0],
                  name: matchedGroup.categories[0].name,
                  selector: categorySelector,
                };
              } else {
                // Multiple categories exist in the group, but user did not specify "all" / "semua".
                // Fails closed toward clarification rather than silently broadening.
                const candidateNames = matchedGroup.categories.map(category => category.name).sort((a, b) => a.localeCompare(b));
                unresolvedFilterIssues.push({
                  filterKey: 'category',
                  rawValue: trimmedCategoryHint,
                  reason: 'UNRESOLVED',
                  candidates: candidateNames,
                  subType: 'name',
                  message: `Kategori "${trimmedCategoryHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
                });
              }
            } else if (matchResult.status === 'AMBIGUOUS') {
              const candidateNames = matchResult.candidates!.map(group => group.name).sort((a, b) => a.localeCompare(b));
              unresolvedFilterIssues.push({
                filterKey: 'category',
                rawValue: trimmedCategoryHint,
                reason: 'UNRESOLVED',
                candidates: candidateNames,
                subType: 'name',
                message: `Grup kategori "${trimmedCategoryHint}" ambigu. Kandidat: ${candidateNames.join(', ')}.`,
              });
            } else if (dynamicGroupMap.size === 0) {
              // Backward-compatibility fallback when availableCategoryList contains no group metadata
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
