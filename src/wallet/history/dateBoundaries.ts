/**
 * Date Boundary Calculations and Relative Calendar Range Helpers.
 * Provides pure stateless calendar date validation, boundary normalization,
 * and relative time range computations for transaction history queries.
 */

import { RelativeDatePeriod } from '../types.js';
import {
  getLocalTimeParts,
  getNextLocalDateString,
  getPreviousLocalDateString,
  resolveLocalCalendarDayRange,
  resolveLocalCalendarRange,
} from '../../brain/index.js';

export interface NormalizedBoundaryResult {
  recordDateToken: string;
  isoInstant: string;
  isDateOnly: boolean;
  operator: 'gte' | 'gt' | 'lte' | 'lt' | 'eq';
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

export function formatIsoDateParts(year: number, month: number, day: number): string {
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
