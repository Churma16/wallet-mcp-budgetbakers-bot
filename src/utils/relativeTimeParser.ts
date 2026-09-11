import { SupportedLanguage } from '../i18n/types.js';

export interface TimezoneOffsetDetails {
  timeZone: string;
  formattedOffset: string;
  offsetHours: number;
}

export type RelativeTimePeriodName = 'subuh' | 'pagi' | 'siang' | 'sore' | 'malam';

export interface RepresentativeTimeConfiguration {
  readonly hour: number;
  readonly minute: number;
}

/**
 * Documented representative local times when no explicit clock hour is specified.
 */
export const PERIOD_REPRESENTATIVE_HOURS: Readonly<Record<RelativeTimePeriodName, RepresentativeTimeConfiguration>> = {
  subuh: { hour: 5, minute: 0 },
  pagi: { hour: 8, minute: 0 },
  siang: { hour: 12, minute: 30 },
  sore: { hour: 16, minute: 30 },
  malam: { hour: 20, minute: 0 },
};

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

export interface ParsedRelativeTimeResult {
  readonly resolvedUtcIso: string;
  readonly matchedExpression: string;
  readonly hasExplicitTime: boolean;
  readonly targetDateString: string;
  readonly targetHour: number;
  readonly targetMinute: number;
  readonly periodName?: RelativeTimePeriodName;
  readonly dayReference: 'today' | 'yesterday';
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
 * Handles month rollovers, leap years, and year transitions cleanly.
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
 * Generates grounded local time anchor context for AI system instructions and prompts.
 */
export function formatLocalTimeAnchor(
  referenceDate: Date = new Date(),
  targetTimezoneIdentifier: string = 'Asia/Jakarta',
  languageCode: SupportedLanguage = 'id'
): string {
  const localTimeParts = getLocalTimeParts(referenceDate, targetTimezoneIdentifier);
  const previousLocalDate = getPreviousLocalDateString(localTimeParts.dateString);
  const shortTimeString = `${String(localTimeParts.hour).padStart(2, '0')}:${String(localTimeParts.minute).padStart(2, '0')}`;

  if (languageCode === 'en') {
    return `Local Date: ${localTimeParts.dateString}, Local Time: ${shortTimeString} (Timezone: ${localTimeParts.formattedOffset} ${targetTimezoneIdentifier}) | Yesterday: ${previousLocalDate}`;
  }

  return `Waktu Lokal: ${localTimeParts.dateString} ${shortTimeString} (Timezone: ${localTimeParts.formattedOffset} ${targetTimezoneIdentifier}) | Kemarin: ${previousLocalDate}`;
}

/**
 * Resolves a local date and time in a given timezone to a UTC ISO 8601 string.
 * Accurately evaluates the IANA timezone offset at the target instant to prevent
 * offset errors across Daylight Saving Time (DST) transitions (e.g., fall back or spring forward).
 */
export function resolveTargetLocalToUtcIso(
  targetDateString: string,
  targetHour: number,
  targetMinute: number,
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): string {
  const paddedHour = String(targetHour).padStart(2, '0');
  const paddedMinute = String(targetMinute).padStart(2, '0');

  // Estimate the target instant using midday UTC to get the approximate local date offset
  const middayEstimate = new Date(`${targetDateString}T12:00:00.000Z`);
  const initialOffsetDetails = getTimezoneOffsetDetails(targetTimezoneIdentifier, middayEstimate);
  const candidateIso = `${targetDateString}T${paddedHour}:${paddedMinute}:00.000${initialOffsetDetails.formattedOffset}`;
  const candidateTimestamp = Date.parse(candidateIso);

  if (Number.isNaN(candidateTimestamp)) {
    throw new Error(`Invalid local date conversion payload: ${candidateIso}`);
  }

  // Refine the offset using the candidate instant to capture DST transitions at the exact hour
  const candidateDate = new Date(candidateTimestamp);
  const refinedOffsetDetails = getTimezoneOffsetDetails(targetTimezoneIdentifier, candidateDate);

  if (refinedOffsetDetails.formattedOffset === initialOffsetDetails.formattedOffset) {
    return candidateDate.toISOString();
  }

  const refinedIso = `${targetDateString}T${paddedHour}:${paddedMinute}:00.000${refinedOffsetDetails.formattedOffset}`;
  const refinedTimestamp = Date.parse(refinedIso);
  if (Number.isNaN(refinedTimestamp)) {
    return candidateDate.toISOString();
  }
  return new Date(refinedTimestamp).toISOString();
}

/**
 * Extracts explicit hour and minute from text if specified by the user.
 * Supports 12-hour AM/PM formats, 24-hour formats, bare bounded HH:mm / HH.mm clocks,
 * and Indonesian colloquial times (e.g. jam 3 sore, pukul 15.30).
 */
function extractExplicitClockTime(
  inputText: string,
  inferredPeriod?: RelativeTimePeriodName
): { hour: number; minute: number; matchedClockSubstring: string } | null {
  // Pattern 1: Indonesian "jam 14:30", "jam 14.30", "pukul 07:15", "jam 3 sore", "jam 8 malam", "jam 2 siang"
  const indonesianClockRegex = /(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*(subuh|pagi|siang|sore|malam|malem))?/i;
  const indonesianMatch = inputText.match(indonesianClockRegex);

  if (indonesianMatch) {
    let rawHour = Number.parseInt(indonesianMatch[1], 10);
    const rawMinute = indonesianMatch[2] ? Number.parseInt(indonesianMatch[2], 10) : 0;
    const explicitPeriodString = (indonesianMatch[3] || inferredPeriod || '').toLowerCase();

    if (rawHour >= 0 && rawHour <= 24 && rawMinute >= 0 && rawMinute < 60) {
      if (explicitPeriodString === 'siang') {
        if (rawHour >= 1 && rawHour <= 4) {
          rawHour += 12;
        }
      } else if (explicitPeriodString === 'sore') {
        if (rawHour >= 1 && rawHour <= 6) {
          rawHour += 12;
        }
      } else if (explicitPeriodString === 'malam' || explicitPeriodString === 'malem') {
        if (rawHour >= 1 && rawHour <= 11) {
          rawHour += 12;
        } else if (rawHour === 12) {
          rawHour = 0;
        }
      } else if (explicitPeriodString === 'pagi' || explicitPeriodString === 'subuh') {
        if (rawHour === 12) {
          rawHour = 0;
        }
      }

      return {
        hour: rawHour % 24,
        minute: rawMinute,
        matchedClockSubstring: indonesianMatch[0],
      };
    }
  }

  // Pattern 2: English "at 3pm", "3:30 pm", "7 am", "at 14:00"
  const english12HourRegex = /(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
  const english12HourMatch = inputText.match(english12HourRegex);

  if (english12HourMatch) {
    let rawHour = Number.parseInt(english12HourMatch[1], 10);
    const rawMinute = english12HourMatch[2] ? Number.parseInt(english12HourMatch[2], 10) : 0;
    const meridiem = english12HourMatch[3].toLowerCase();

    if (rawHour >= 1 && rawHour <= 12 && rawMinute >= 0 && rawMinute < 60) {
      if (meridiem === 'pm' && rawHour < 12) {
        rawHour += 12;
      } else if (meridiem === 'am' && rawHour === 12) {
        rawHour = 0;
      }

      return {
        hour: rawHour,
        minute: rawMinute,
        matchedClockSubstring: english12HourMatch[0],
      };
    }
  }

  // Pattern 3: Bare or prefixed 24-hour clock e.g. "at 14:30", "15.30", "15:30", "07:30"
  // Negative lookahead (?!\d|[.,]\d|[a-zA-Z%]) and lookbehind (?<![A-Za-z0-9$€£¥]) ensure
  // currency and monetary numbers (e.g. 50.000, 20.000, $15.30, 15.30k) are not falsely matched as times.
  const bare24HourRegex = /(?:at\s+)?(?<![A-Za-z0-9$€£¥])([01]?\d|2[0-3])[.:]([0-5]\d)(?!\d|[.,]\d|[a-zA-Z%])/i;
  const bareMatch = inputText.match(bare24HourRegex);
  if (bareMatch) {
    let rawHour = Number.parseInt(bareMatch[1], 10);
    const rawMinute = Number.parseInt(bareMatch[2], 10);
    const explicitPeriodString = (inferredPeriod || '').toLowerCase();

    if (rawHour >= 0 && rawHour < 24 && rawMinute >= 0 && rawMinute < 60) {
      if (explicitPeriodString === 'siang') {
        if (rawHour >= 1 && rawHour <= 4) {
          rawHour += 12;
        }
      } else if (explicitPeriodString === 'sore') {
        if (rawHour >= 1 && rawHour <= 6) {
          rawHour += 12;
        }
      } else if (explicitPeriodString === 'malam' || explicitPeriodString === 'malem') {
        if (rawHour >= 1 && rawHour <= 11) {
          rawHour += 12;
        } else if (rawHour === 12) {
          rawHour = 0;
        }
      } else if (explicitPeriodString === 'pagi' || explicitPeriodString === 'subuh') {
        if (rawHour === 12) {
          rawHour = 0;
        }
      }

      return {
        hour: rawHour % 24,
        minute: rawMinute,
        matchedClockSubstring: bareMatch[0],
      };
    }
  }

  return null;
}

/**
 * Normalizes period name string to canonical RelativeTimePeriodName.
 */
function normalizePeriodName(rawPeriod: string): RelativeTimePeriodName | undefined {
  const lower = rawPeriod.toLowerCase().trim();
  if (lower === 'subuh' || lower === 'dawn' || lower === 'early morning') {
    return 'subuh';
  }
  if (lower === 'pagi' || lower === 'morning') {
    return 'pagi';
  }
  if (lower === 'siang' || lower === 'noon' || lower === 'afternoon') {
    return 'siang';
  }
  if (lower === 'sore' || lower === 'evening') {
    return 'sore';
  }
  if (lower === 'malam' || lower === 'malem' || lower === 'night') {
    return 'malam';
  }
  return undefined;
}

/**
 * Parses natural language relative-time expressions (Indonesian and English).
 * Converts expressions like 'tadi pagi', 'kemarin malam', 'semalam', 'this morning', 'last night'
 * into deterministic UTC ISO 8601 timestamps using the configured application timezone.
 */
export function parseRelativeTime(
  inputText: string,
  referenceDate: Date = new Date(),
  targetTimezoneIdentifier: string = 'Asia/Jakarta'
): ParsedRelativeTimeResult | null {
  if (!inputText || typeof inputText !== 'string' || inputText.trim().length === 0) {
    return null;
  }

  const normalizedInput = inputText.toLowerCase();
  const localTimeParts = getLocalTimeParts(referenceDate, targetTimezoneIdentifier);
  const todayDateString = localTimeParts.dateString;
  const yesterdayDateString = getPreviousLocalDateString(todayDateString);

  // Group 1: Semalam / Semalem (Indonesian last night -> yesterday at malam 20:00)
  const semalamRegex = /\b(semalam|semalem)\b/i;
  const semalamMatch = normalizedInput.match(semalamRegex);
  if (semalamMatch) {
    const explicitClock = extractExplicitClockTime(inputText, 'malam');
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS.malam.hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS.malam.minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${semalamMatch[0]} ${explicitClock.matchedClockSubstring}` : semalamMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      periodName: 'malam',
      dayReference: 'yesterday',
    };
  }

  // Group 2: Last Night (English last night -> yesterday at night 20:00)
  const lastNightRegex = /\blast\s+night\b/i;
  const lastNightMatch = normalizedInput.match(lastNightRegex);
  if (lastNightMatch) {
    const explicitClock = extractExplicitClockTime(inputText, 'malam');
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS.malam.hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS.malam.minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${lastNightMatch[0]} ${explicitClock.matchedClockSubstring}` : lastNightMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      periodName: 'malam',
      dayReference: 'yesterday',
    };
  }

  // Group 3: Tadi malam / Tadi malem (Indonesian last night -> yesterday at malam 20:00)
  const tadiMalamRegex = /\btadi\s+(malam|malem)\b/i;
  const tadiMalamMatch = normalizedInput.match(tadiMalamRegex);
  if (tadiMalamMatch) {
    const explicitClock = extractExplicitClockTime(inputText, 'malam');
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS.malam.hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS.malam.minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${tadiMalamMatch[0]} ${explicitClock.matchedClockSubstring}` : tadiMalamMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      periodName: 'malam',
      dayReference: 'yesterday',
    };
  }

  // Group 4: Kemarin / Kemaren + Period (e.g. kemarin pagi, kemaren sore, kemarin siang, kemarin subuh, kemarin malam)
  const kemarinPeriodRegex = /\b(kemarin|kemaren)\s+(subuh|pagi|siang|sore|malam|malem)\b/i;
  const kemarinPeriodMatch = normalizedInput.match(kemarinPeriodRegex);
  if (kemarinPeriodMatch) {
    const periodName = normalizePeriodName(kemarinPeriodMatch[2]) || 'pagi';
    const explicitClock = extractExplicitClockTime(inputText, periodName);
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS[periodName].hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS[periodName].minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${kemarinPeriodMatch[0]} ${explicitClock.matchedClockSubstring}` : kemarinPeriodMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      periodName,
      dayReference: 'yesterday',
    };
  }

  // Group 5: Yesterday + Period (English: yesterday morning, yesterday afternoon, yesterday evening, yesterday night)
  const yesterdayPeriodRegex = /\byesterday\s+(morning|afternoon|evening|night|dawn)\b/i;
  const yesterdayPeriodMatch = normalizedInput.match(yesterdayPeriodRegex);
  if (yesterdayPeriodMatch) {
    const periodName = normalizePeriodName(yesterdayPeriodMatch[1]) || 'pagi';
    const explicitClock = extractExplicitClockTime(inputText, periodName);
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS[periodName].hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS[periodName].minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${yesterdayPeriodMatch[0]} ${explicitClock.matchedClockSubstring}` : yesterdayPeriodMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      periodName,
      dayReference: 'yesterday',
    };
  }

  // Group 6: Tadi + Period (Indonesian: tadi subuh, tadi pagi, tadi siang, tadi sore)
  const tadiPeriodRegex = /\btadi\s+(subuh|pagi|siang|sore)\b/i;
  const tadiPeriodMatch = normalizedInput.match(tadiPeriodRegex);
  if (tadiPeriodMatch) {
    const periodName = normalizePeriodName(tadiPeriodMatch[1]) || 'pagi';
    const explicitClock = extractExplicitClockTime(inputText, periodName);
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS[periodName].hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS[periodName].minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      todayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${tadiPeriodMatch[0]} ${explicitClock.matchedClockSubstring}` : tadiPeriodMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: todayDateString,
      targetHour,
      targetMinute,
      periodName,
      dayReference: 'today',
    };
  }

  // Group 7: Period + Ini (Indonesian: pagi ini, siang ini, sore ini, malam ini, subuh ini)
  const periodIniRegex = /\b(subuh|pagi|siang|sore|malam|malem)\s+ini\b/i;
  const periodIniMatch = normalizedInput.match(periodIniRegex);
  if (periodIniMatch) {
    const periodName = normalizePeriodName(periodIniMatch[1]) || 'pagi';
    const explicitClock = extractExplicitClockTime(inputText, periodName);
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS[periodName].hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS[periodName].minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      todayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${periodIniMatch[0]} ${explicitClock.matchedClockSubstring}` : periodIniMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: todayDateString,
      targetHour,
      targetMinute,
      periodName,
      dayReference: 'today',
    };
  }

  // Group 8: This + Period (English: this morning, this afternoon, this evening, tonight)
  const thisPeriodRegex = /\b(?:this\s+(morning|afternoon|evening|dawn)|tonight)\b/i;
  const thisPeriodMatch = normalizedInput.match(thisPeriodRegex);
  if (thisPeriodMatch) {
    const matchedToken = thisPeriodMatch[1] ? thisPeriodMatch[1] : 'night';
    const periodName = normalizePeriodName(matchedToken) || 'pagi';
    const explicitClock = extractExplicitClockTime(inputText, periodName);
    const targetHour = explicitClock ? explicitClock.hour : PERIOD_REPRESENTATIVE_HOURS[periodName].hour;
    const targetMinute = explicitClock ? explicitClock.minute : PERIOD_REPRESENTATIVE_HOURS[periodName].minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      todayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${thisPeriodMatch[0]} ${explicitClock.matchedClockSubstring}` : thisPeriodMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: todayDateString,
      targetHour,
      targetMinute,
      periodName,
      dayReference: 'today',
    };
  }

  // Group 9: Kemarin / Kemaren / Yesterday alone (without period, but check if explicit clock exists)
  const bareYesterdayRegex = /\b(kemarin|kemaren|yesterday)\b/i;
  const bareYesterdayMatch = normalizedInput.match(bareYesterdayRegex);
  if (bareYesterdayMatch) {
    const explicitClock = extractExplicitClockTime(inputText);
    const targetHour = explicitClock ? explicitClock.hour : localTimeParts.hour;
    const targetMinute = explicitClock ? explicitClock.minute : localTimeParts.minute;
    const resolvedUtcIso = resolveTargetLocalToUtcIso(
      yesterdayDateString,
      targetHour,
      targetMinute,
      targetTimezoneIdentifier
    );

    return {
      resolvedUtcIso,
      matchedExpression: explicitClock ? `${bareYesterdayMatch[0]} ${explicitClock.matchedClockSubstring}` : bareYesterdayMatch[0],
      hasExplicitTime: Boolean(explicitClock),
      targetDateString: yesterdayDateString,
      targetHour,
      targetMinute,
      dayReference: 'yesterday',
    };
  }

  // Group 10: Tadi / Earlier today alone (with or without explicit clock)
  const bareTadiRegex = /\b(tadi|earlier\s+today)\b/i;
  const bareTadiMatch = normalizedInput.match(bareTadiRegex);
  if (bareTadiMatch) {
    const explicitClock = extractExplicitClockTime(inputText);
    if (explicitClock) {
      const resolvedUtcIso = resolveTargetLocalToUtcIso(
        todayDateString,
        explicitClock.hour,
        explicitClock.minute,
        targetTimezoneIdentifier
      );

      return {
        resolvedUtcIso,
        matchedExpression: `${bareTadiMatch[0]} ${explicitClock.matchedClockSubstring}`,
        hasExplicitTime: true,
        targetDateString: todayDateString,
        targetHour: explicitClock.hour,
        targetMinute: explicitClock.minute,
        dayReference: 'today',
      };
    }
  }

  return null;
}
