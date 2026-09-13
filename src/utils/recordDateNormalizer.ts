import {
  getLocalTimeParts,
  resolveTargetLocalToUtcIso,
} from './relativeTimeParser.js';

const EXPLICIT_OFFSET_REGEX =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;

const DATE_ONLY_REGEX = /^(\d{4}-\d{2}-\d{2})$/;

const TIMEZONE_LESS_DATETIME_REGEX =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

/**
 * Normalizes a raw recordDate string into a canonical UTC ISO 8601 string (e.g. YYYY-MM-DDTHH:mm:ss.sssZ).
 *
 * Guarantees:
 * 1. Missing or empty timestamps fall back deterministically to referenceInstant.toISOString().
 * 2. Full timestamps with an explicit offset (+HH:MM, -HH:MM) or 'Z' are parsed to UTC without host TZ dependency.
 * 3. Timezone-less local datetimes (printed on receipts) are interpreted in applicationTimezone exactly once,
 *    preserving explicit seconds and milliseconds.
 * 4. Date-only values (YYYY-MM-DD) preserve today's reference instant or resolve to midday in applicationTimezone,
 *    preventing accidental midnight shifts and date rollovers across container environments.
 * 5. Timezone-less non-canonical formats avoid Date.parse() host-TZ leakage and fall back deterministically to referenceInstant.
 */
export function normalizeTransactionRecordDate(
  rawRecordDate: string | undefined | null,
  referenceInstant: Date = new Date(),
  applicationTimezoneIdentifier: string = 'Asia/Jakarta'
): string {
  if (rawRecordDate === undefined || rawRecordDate === null) {
    return referenceInstant.toISOString();
  }

  const trimmedRecordDate = rawRecordDate.trim();
  if (trimmedRecordDate.length === 0) {
    return referenceInstant.toISOString();
  }

  // Case 1: Full timestamp with explicit timezone offset or Z
  const explicitOffsetMatch = trimmedRecordDate.match(EXPLICIT_OFFSET_REGEX);
  if (explicitOffsetMatch) {
    const [, datePart, hourPart, minutePart, secondPart, millisecondPart, offsetPart] = explicitOffsetMatch;
    const paddedSecond = secondPart ? secondPart.padStart(2, '0') : '00';
    const paddedMillisecond = millisecondPart ? `.${millisecondPart.padEnd(3, '0').slice(0, 3)}` : '.000';

    let normalizedOffset = offsetPart.toUpperCase();
    if (normalizedOffset !== 'Z' && !normalizedOffset.includes(':')) {
      // Convert +0700 or -0500 to +07:00 or -05:00
      const sign = normalizedOffset.slice(0, 1);
      const hours = normalizedOffset.slice(1, 3);
      const minutes = normalizedOffset.slice(3, 5);
      normalizedOffset = `${sign}${hours}:${minutes}`;
    }

    const canonicalIsoWithOffset = `${datePart}T${hourPart}:${minutePart}:${paddedSecond}${paddedMillisecond}${normalizedOffset}`;
    const parsedTimestamp = Date.parse(canonicalIsoWithOffset);
    if (!Number.isNaN(parsedTimestamp)) {
      return new Date(parsedTimestamp).toISOString();
    }
  }

  // Case 2: Date-only format (YYYY-MM-DD)
  const dateOnlyMatch = trimmedRecordDate.match(DATE_ONLY_REGEX);
  if (dateOnlyMatch) {
    const [, datePart] = dateOnlyMatch;
    const referenceLocalParts = getLocalTimeParts(referenceInstant, applicationTimezoneIdentifier);

    // If receipt date matches today in the application timezone, use referenceInstant
    if (datePart === referenceLocalParts.dateString) {
      return referenceInstant.toISOString();
    }

    // For past or future calendar dates without a clock time, resolve to midday (12:00:00) local time
    // in the application timezone. This avoids midnight boundary shifts and ensures the date remains identical
    // in both UTC and the application timezone.
    return resolveTargetLocalToUtcIso(
      datePart,
      12,
      0,
      applicationTimezoneIdentifier,
      0,
      0
    );
  }

  // Case 3: Timezone-less datetime string (YYYY-MM-DDTHH:mm[:ss[.sss]])
  const timezoneLessMatch = trimmedRecordDate.match(TIMEZONE_LESS_DATETIME_REGEX);
  if (timezoneLessMatch) {
    const [, datePart, hourPart, minutePart, secondPart, millisecondPart] = timezoneLessMatch;
    const parsedHour = Number.parseInt(hourPart, 10);
    const parsedMinute = Number.parseInt(minutePart, 10);
    const parsedSecond = secondPart ? Number.parseInt(secondPart, 10) : 0;
    const parsedMillisecond = millisecondPart
      ? Number.parseInt(millisecondPart.padEnd(3, '0').slice(0, 3), 10)
      : 0;

    // Timezone-less datetime is always interpreted as receipt-local wall-clock time in applicationTimezoneIdentifier
    return resolveTargetLocalToUtcIso(
      datePart,
      parsedHour,
      parsedMinute,
      applicationTimezoneIdentifier,
      parsedSecond,
      parsedMillisecond
    );
  }

  // Case 4: Fallback only for formats with explicit timezone indicators (Z, [+-]HH:mm, UTC, GMT).
  // Timezone-less non-canonical formats must NEVER touch Date.parse() to guarantee host-timezone independence.
  const EXPLICIT_TIMEZONE_INDICATOR_REGEX = /(?:Z|[+-]\d{2}:?\d{2}|\b(?:UTC|GMT)\b)/i;
  if (EXPLICIT_TIMEZONE_INDICATOR_REGEX.test(trimmedRecordDate)) {
    const fallbackParsedTimestamp = Date.parse(trimmedRecordDate);
    if (!Number.isNaN(fallbackParsedTimestamp)) {
      return new Date(fallbackParsedTimestamp).toISOString();
    }
  }

  return referenceInstant.toISOString();
}
