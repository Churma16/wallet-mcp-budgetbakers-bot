export interface TimezoneOffsetDetails {
  timeZone: string;
  formattedOffset: string;
  offsetHours: number;
}

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateString: string;
  timeString: string;
  formattedOffset: string;
  offsetHours: number;
}

/**
 * Calculates the current UTC offset details for any standard IANA timezone.
 */
export function getTimezoneOffsetDetails(
  targetTimezoneIdentifier: string,
  referenceDate: Date = new Date()
): TimezoneOffsetDetails {
  try {
    const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: targetTimezoneIdentifier,
      timeZoneName: 'longOffset',
    });
    const formattedParts = dateTimeFormatter.formatToParts(referenceDate);
    const timezonePart = formattedParts.find(part => part.type === 'timeZoneName')?.value || 'GMT';
    const offsetRegexMatch = timezonePart.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);

    if (offsetRegexMatch) {
      const offsetSign = offsetRegexMatch[1];
      const offsetHoursString = offsetRegexMatch[2].padStart(2, '0');
      const offsetMinutesString = (offsetRegexMatch[3] || '00').padStart(2, '0');
      const numericOffsetHours = (offsetSign === '-' ? -1 : 1) * (
        Number.parseInt(offsetHoursString, 10) + Number.parseInt(offsetMinutesString, 10) / 60
      );

      return {
        timeZone: targetTimezoneIdentifier,
        formattedOffset: `${offsetSign}${offsetHoursString}:${offsetMinutesString}`,
        offsetHours: numericOffsetHours,
      };
    }

    return {
      timeZone: targetTimezoneIdentifier,
      formattedOffset: '+00:00',
      offsetHours: 0,
    };
  } catch {
    return {
      timeZone: 'Asia/Jakarta',
      formattedOffset: '+07:00',
      offsetHours: 7,
    };
  }
}

/**
 * Deconstructs a given reference date into local date parts based on the target timezone.
 */
export function getLocalTimeParts(
  referenceDate: Date = new Date(),
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): LocalTimeParts {
  const timezoneOffsetDetails = getTimezoneOffsetDetails(targetTimezoneIdentifier, referenceDate);
  const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezoneOffsetDetails.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const formattedParts = dateTimeFormatter.formatToParts(referenceDate);
  const partMap: Record<string, string> = {};
  for (const part of formattedParts) {
    partMap[part.type] = part.value;
  }

  const year = Number.parseInt(partMap.year, 10);
  const month = Number.parseInt(partMap.month, 10);
  const day = Number.parseInt(partMap.day, 10);
  const hour = Number.parseInt(partMap.hour, 10);
  const minute = Number.parseInt(partMap.minute, 10);
  const second = Number.parseInt(partMap.second, 10);

  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  const paddedHour = String(hour).padStart(2, '0');
  const paddedMinute = String(minute).padStart(2, '0');
  const paddedSecond = String(second).padStart(2, '0');

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    dateString: `${year}-${paddedMonth}-${paddedDay}`,
    timeString: `${paddedHour}:${paddedMinute}:${paddedSecond}`,
    formattedOffset: timezoneOffsetDetails.formattedOffset,
    offsetHours: timezoneOffsetDetails.offsetHours,
  };
}

/**
 * Computes the previous calendar date string (YYYY-MM-DD) from a given local date string.
 */
export function getPreviousLocalDateString(currentLocalDateString: string): string {
  const [yearString, monthString, dayString] = currentLocalDateString.split('-');
  const currentYear = Number.parseInt(yearString, 10);
  const currentMonth = Number.parseInt(monthString, 10);
  const currentDay = Number.parseInt(dayString, 10);

  const previousDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay - 1));
  const previousYear = previousDate.getUTCFullYear();
  const previousMonth = String(previousDate.getUTCMonth() + 1).padStart(2, '0');
  const previousDay = String(previousDate.getUTCDate()).padStart(2, '0');

  return `${previousYear}-${previousMonth}-${previousDay}`;
}

/**
 * Computes the next calendar date string (YYYY-MM-DD) from a given local date string.
 */
export function getNextLocalDateString(currentLocalDateString: string): string {
  const [yearString, monthString, dayString] = currentLocalDateString.split('-');
  const currentYear = Number.parseInt(yearString, 10);
  const currentMonth = Number.parseInt(monthString, 10);
  const currentDay = Number.parseInt(dayString, 10);

  const nextDate = new Date(Date.UTC(currentYear, currentMonth - 1, currentDay + 1));
  const nextYear = nextDate.getUTCFullYear();
  const nextMonth = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(nextDate.getUTCDate()).padStart(2, '0');

  return `${nextYear}-${nextMonth}-${nextDay}`;
}

/**
 * Normalizes a Date object or YYYY-MM-DD string into a local calendar date string (YYYY-MM-DD).
 */
function normalizeToLocalDateString(
  dateInput: Date | string,
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): string {
  if (typeof dateInput === 'string') {
    const trimmedInput = dateInput.trim();
    if (trimmedInput.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(trimmedInput)) {
      return trimmedInput.slice(0, 10);
    }
    const parsedDate = new Date(trimmedInput);
    if (!Number.isNaN(parsedDate.getTime())) {
      return getLocalTimeParts(parsedDate, targetTimezoneIdentifier).dateString;
    }
    return trimmedInput;
  }
  return getLocalTimeParts(dateInput, targetTimezoneIdentifier).dateString;
}

/**
 * Resolves an explicit or reference calendar date to half-open UTC boundaries [gte.<startUtcIso>, lt.<nextBoundaryUtcIso>]
 * covering the full 24-hour day in the target local timezone.
 */
export function resolveLocalCalendarDayRange(
  dateInput: Date | string,
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): [string, string] {
  const localDateString = normalizeToLocalDateString(dateInput, targetTimezoneIdentifier);
  const nextDayDateString = getNextLocalDateString(localDateString);

  const startUtcIso = resolveTargetLocalToUtcIso(localDateString, 0, 0, targetTimezoneIdentifier);
  const nextBoundaryUtcIso = resolveTargetLocalToUtcIso(nextDayDateString, 0, 0, targetTimezoneIdentifier);

  return [`gte.${startUtcIso}`, `lt.${nextBoundaryUtcIso}`];
}

/**
 * Resolves a local calendar date range [fromDate, toDate] (inclusive of toDate in local time)
 * to half-open UTC boundaries [gte.<startUtcIso>, lt.<nextBoundaryUtcIso>]
 */
export function resolveLocalCalendarRange(
  fromDateInput: Date | string,
  toDateInput: Date | string,
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): [string, string] {
  const fromDateString = normalizeToLocalDateString(fromDateInput, targetTimezoneIdentifier);
  const toDateString = normalizeToLocalDateString(toDateInput, targetTimezoneIdentifier);
  const dayAfterToDateString = getNextLocalDateString(toDateString);

  const startUtcIso = resolveTargetLocalToUtcIso(fromDateString, 0, 0, targetTimezoneIdentifier);
  const nextBoundaryUtcIso = resolveTargetLocalToUtcIso(dayAfterToDateString, 0, 0, targetTimezoneIdentifier);

  return [`gte.${startUtcIso}`, `lt.${nextBoundaryUtcIso}`];
}

/**
 * Formats a local date and time in the specified timezone into a valid ISO 8601 UTC timestamp.
 */
export function formatLocalToUtcIso(
  targetDateString: string,
  targetHour: number,
  targetMinute: number,
  formattedTimezoneOffset: string
): string {
  const paddedHour = String(targetHour).padStart(2, '0');
  const paddedMinute = String(targetMinute).padStart(2, '0');
  const isoWithOffset = `${targetDateString}T${paddedHour}:${paddedMinute}:00.000${formattedTimezoneOffset}`;
  const parsedTimestamp = Date.parse(isoWithOffset);
  if (Number.isNaN(parsedTimestamp)) {
    throw new Error(`Invalid local date conversion payload: ${isoWithOffset}`);
  }
  return new Date(parsedTimestamp).toISOString();
}

/**
 * Resolves a local date and time in a given timezone to a UTC ISO 8601 string.
 */
export function resolveTargetLocalToUtcIso(
  targetDateString: string,
  targetHour: number,
  targetMinute: number,
  targetTimezoneIdentifier: string = 'Asia/Jakarta',
  targetSecond: number = 0,
  targetMillisecond: number = 0
): string {
  const paddedHour = String(targetHour).padStart(2, '0');
  const paddedMinute = String(targetMinute).padStart(2, '0');
  const paddedSecond = String(targetSecond).padStart(2, '0');
  const paddedMillisecond = String(targetMillisecond).padStart(3, '0');

  const middayEstimate = new Date(`${targetDateString}T12:00:00.000Z`);
  const initialOffsetDetails = getTimezoneOffsetDetails(targetTimezoneIdentifier, middayEstimate);
  const candidateIso = `${targetDateString}T${paddedHour}:${paddedMinute}:${paddedSecond}.${paddedMillisecond}${initialOffsetDetails.formattedOffset}`;
  const candidateTimestamp = Date.parse(candidateIso);

  if (Number.isNaN(candidateTimestamp)) {
    throw new Error(`Invalid local date conversion payload: ${candidateIso}`);
  }

  const candidateDate = new Date(candidateTimestamp);
  const refinedOffsetDetails = getTimezoneOffsetDetails(targetTimezoneIdentifier, candidateDate);

  let resolvedUtcIso: string;
  if (refinedOffsetDetails.formattedOffset === initialOffsetDetails.formattedOffset) {
    resolvedUtcIso = candidateDate.toISOString();
  } else {
    const refinedIso = `${targetDateString}T${paddedHour}:${paddedMinute}:${paddedSecond}.${paddedMillisecond}${refinedOffsetDetails.formattedOffset}`;
    const refinedTimestamp = Date.parse(refinedIso);
    resolvedUtcIso = Number.isNaN(refinedTimestamp)
      ? candidateDate.toISOString()
      : new Date(refinedTimestamp).toISOString();
  }

  const roundTripLocalParts = getLocalTimeParts(new Date(resolvedUtcIso), targetTimezoneIdentifier);
  const matchesRequestedWallClock =
    roundTripLocalParts.dateString === targetDateString &&
    roundTripLocalParts.hour === targetHour &&
    roundTripLocalParts.minute === targetMinute &&
    (targetSecond === 0 || roundTripLocalParts.second === targetSecond);

  if (!matchesRequestedWallClock) {
    throw new RangeError(
      `Nonexistent local wall-clock time '${targetDateString} ${paddedHour}:${paddedMinute}:${paddedSecond}' in timezone '${targetTimezoneIdentifier}' (e.g. DST spring-forward gap).`
    );
  }

  return resolvedUtcIso;
}

/**
 * Retrieves the current calendar date string (YYYY-MM-DD) in the specified or application timezone.
 */
export function getCurrentLocalDateString(
  referenceDate: Date = new Date(),
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): string {
  return getLocalTimeParts(referenceDate, targetTimezoneIdentifier).dateString;
}
