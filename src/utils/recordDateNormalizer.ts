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
 * 3. Timezone-less AI outputs matching the UTC reference instant provided in the prompt are detected as echoes
 *    and preserve the reference instant rather than suffering an unintended backward timezone offset shift.
 * 4. Timezone-less local datetimes (printed on receipts) are interpreted in applicationTimezone exactly once,
 *    preserving explicit seconds and milliseconds.
 * 5. Date-only values (YYYY-MM-DD) preserve today's reference instant or resolve to midday in applicationTimezone,
 *    preventing accidental midnight shifts and date rollovers across container environments.
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

    const referenceUtcDateString = referenceInstant.toISOString().slice(0, 10);
    const referenceUtcHour = referenceInstant.getUTCHours();
    const referenceUtcMinute = referenceInstant.getUTCMinutes();
    const referenceUtcSecond = referenceInstant.getUTCSeconds();

    const referenceLocalParts = getLocalTimeParts(referenceInstant, applicationTimezoneIdentifier);

    // Prompt Echo Detection:
    // If the vision provider returned numeric clock components that match the UTC reference instant provided
    // in the prompt (and differ from the local application wall-clock time), the AI echoed the UTC prompt timestamp
    // without the trailing 'Z'. Treating this as local wall-clock time would subtract the timezone offset a second time.
    const matchesUtcReferenceInstant =
      datePart === referenceUtcDateString &&
      parsedHour === referenceUtcHour &&
      parsedMinute === referenceUtcMinute &&
      (secondPart === undefined || Math.abs(parsedSecond - referenceUtcSecond) <= 5);

    const differsFromLocalWallClock =
      referenceUtcHour !== referenceLocalParts.hour ||
      referenceUtcDateString !== referenceLocalParts.dateString;

    if (matchesUtcReferenceInstant && differsFromLocalWallClock) {
      return referenceInstant.toISOString();
    }

    // Otherwise, treat as receipt-local wall-clock time in applicationTimezoneIdentifier
    return resolveTargetLocalToUtcIso(
      datePart,
      parsedHour,
      parsedMinute,
      applicationTimezoneIdentifier,
      parsedSecond,
      parsedMillisecond
    );
  }

  // Case 4: General fallback for any remaining parseable format
  const fallbackParsedTimestamp = Date.parse(trimmedRecordDate);
  if (!Number.isNaN(fallbackParsedTimestamp)) {
    return new Date(fallbackParsedTimestamp).toISOString();
  }

  return referenceInstant.toISOString();
}
