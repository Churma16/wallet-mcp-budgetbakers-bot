import { SupportedLanguage } from '../../i18n/types.js';
import {
  getLocalTimeParts,
  getPreviousLocalDateString,
  resolveTargetLocalToUtcIso,
} from './timeBoundaries.js';
import {
  RelativeTimePeriodName,
  PERIOD_REPRESENTATIVE_HOURS,
  ParsedRelativeTimeResult,
} from './timeParserTypes.js';
import {
  extractExplicitClockTime,
} from './timeClock.js';

export * from './timeParserTypes.js';
export * from './timeClock.js';

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

function normalizePeriodName(rawPeriod: string): RelativeTimePeriodName | undefined {
  const lower = rawPeriod.toLowerCase().trim();
  if (lower === 'subuh' || lower === 'dawn' || lower === 'early morning') return 'subuh';
  if (lower === 'pagi' || lower === 'morning') return 'pagi';
  if (lower === 'siang' || lower === 'noon' || lower === 'afternoon') return 'siang';
  if (lower === 'sore' || lower === 'evening') return 'sore';
  if (lower === 'malam' || lower === 'malem' || lower === 'night') return 'malam';
  return undefined;
}

function createParsedRelativeTimeResult(
  inputText: string,
  matchedKeyword: string,
  targetDateString: string,
  dayReference: 'today' | 'yesterday',
  targetTimezoneIdentifier: string,
  periodName?: RelativeTimePeriodName,
  fallbackHour?: number,
  fallbackMinute?: number
): ParsedRelativeTimeResult | null {
  const explicitClock = extractExplicitClockTime(inputText, periodName);
  const defaultHour = periodName ? PERIOD_REPRESENTATIVE_HOURS[periodName].hour : (fallbackHour ?? 0);
  const defaultMinute = periodName ? PERIOD_REPRESENTATIVE_HOURS[periodName].minute : (fallbackMinute ?? 0);
  const targetHour = explicitClock ? explicitClock.hour : defaultHour;
  const targetMinute = explicitClock ? explicitClock.minute : defaultMinute;

  const resolvedUtcIso = resolveTargetLocalToUtcIso(
    targetDateString,
    targetHour,
    targetMinute,
    targetTimezoneIdentifier
  );

  return {
    resolvedUtcIso,
    matchedExpression: explicitClock ? `${matchedKeyword} ${explicitClock.matchedClockSubstring}` : matchedKeyword,
    hasExplicitTime: Boolean(explicitClock),
    targetDateString,
    targetHour,
    targetMinute,
    periodName,
    dayReference,
  };
}

/**
 * Parses natural language relative-time expressions (Indonesian and English).
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

  const semalamMatch = normalizedInput.match(/\b(semalam|semalem)\b/i);
  if (semalamMatch) {
    return createParsedRelativeTimeResult(
      inputText,
      semalamMatch[0],
      yesterdayDateString,
      'yesterday',
      targetTimezoneIdentifier,
      'malam'
    );
  }

  const lastNightMatch = normalizedInput.match(/\blast\s+night\b/i);
  if (lastNightMatch) {
    return createParsedRelativeTimeResult(
      inputText,
      lastNightMatch[0],
      yesterdayDateString,
      'yesterday',
      targetTimezoneIdentifier,
      'malam'
    );
  }

  const kemarinPeriodMatch = normalizedInput.match(/\b(kemarin|kemaren)\s+(subuh|pagi|siang|sore|malam|malem)\b/i);
  if (kemarinPeriodMatch) {
    const periodName = normalizePeriodName(kemarinPeriodMatch[2]) || 'pagi';
    return createParsedRelativeTimeResult(
      inputText,
      kemarinPeriodMatch[0],
      yesterdayDateString,
      'yesterday',
      targetTimezoneIdentifier,
      periodName
    );
  }

  const yesterdayPeriodMatch = normalizedInput.match(/\byesterday\s+(morning|afternoon|evening|night|dawn)\b/i);
  if (yesterdayPeriodMatch) {
    const periodName = normalizePeriodName(yesterdayPeriodMatch[1]) || 'pagi';
    return createParsedRelativeTimeResult(
      inputText,
      yesterdayPeriodMatch[0],
      yesterdayDateString,
      'yesterday',
      targetTimezoneIdentifier,
      periodName
    );
  }

  const tadiPeriodMatch = normalizedInput.match(/\btadi\s+(subuh|pagi|siang|sore|malam|malem)\b/i);
  if (tadiPeriodMatch) {
    const periodName = normalizePeriodName(tadiPeriodMatch[1]) || 'pagi';
    return createParsedRelativeTimeResult(
      inputText,
      tadiPeriodMatch[0],
      todayDateString,
      'today',
      targetTimezoneIdentifier,
      periodName
    );
  }

  const periodIniMatch = normalizedInput.match(/\b(subuh|pagi|siang|sore|malam|malem)\s+ini\b/i);
  if (periodIniMatch) {
    const periodName = normalizePeriodName(periodIniMatch[1]) || 'pagi';
    return createParsedRelativeTimeResult(
      inputText,
      periodIniMatch[0],
      todayDateString,
      'today',
      targetTimezoneIdentifier,
      periodName
    );
  }

  const thisPeriodMatch = normalizedInput.match(/\b(?:this\s+(morning|afternoon|evening|dawn)|tonight)\b/i);
  if (thisPeriodMatch) {
    const matchedToken = thisPeriodMatch[1] ? thisPeriodMatch[1] : 'night';
    const periodName = normalizePeriodName(matchedToken) || 'pagi';
    return createParsedRelativeTimeResult(
      inputText,
      thisPeriodMatch[0],
      todayDateString,
      'today',
      targetTimezoneIdentifier,
      periodName
    );
  }

  const bareYesterdayMatch = normalizedInput.match(/\b(kemarin|kemaren|yesterday)\b/i);
  if (bareYesterdayMatch) {
    return createParsedRelativeTimeResult(
      inputText,
      bareYesterdayMatch[0],
      yesterdayDateString,
      'yesterday',
      targetTimezoneIdentifier,
      undefined,
      localTimeParts.hour,
      localTimeParts.minute
    );
  }

  const bareTadiMatch = normalizedInput.match(/\b(tadi|earlier\s+today)\b/i);
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
