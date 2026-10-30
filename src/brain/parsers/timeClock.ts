import {
  RelativeTimePeriodName,
  PERIOD_REPRESENTATIVE_HOURS,
} from './timeParserTypes.js';

const CURRENCY_PREFIX_REGEX =
  /(?:[\$€£¥₹₩฿₫₱]|\b(?:USD|EUR|GBP|IDR|SGD|AUD|CAD|CHF|JPY|CNY|MYR|THB|PHP|KRW|INR|NZD|HKD|Rp\.?|dollars?|dolar|euros?|pounds?|rupiah))\s*$/i;
const CURRENCY_SUFFIX_REGEX =
  /^\s*(?:[\$€£¥₹₩฿₫₱]|(?:USD|EUR|GBP|IDR|SGD|AUD|CAD|CHF|JPY|CNY|MYR|THB|PHP|KRW|INR|NZD|HKD|dollars?|dolar|euros?|pounds?|rupiah|bucks|cents?|yen|yuan|ringgit|pesos?|rupees?)\b)/i;

export const SUPPORTED_RELATIVE_DAY_TOKENS = [
  'yesterday', 'kemarin', 'kemaren', 'today', 'tadi',
  'semalam', 'semalem', 'tonight', 'hari\\s+ini', 'last\\s+night',
] as const;

export const SUPPORTED_PERIOD_TOKENS = [
  'subuh', 'dawn', 'early\\s+morning', 'pagi', 'morning',
  'siang', 'noon', 'afternoon', 'sore', 'evening', 'malam', 'malem', 'night',
] as const;

export const SUPPORTED_TIMEZONE_TOKENS = ['wib', 'wita', 'wit', 'gmt', 'utc'] as const;
export const SUPPORTED_TEMPORAL_PREFIX_TOKENS = ['at', 'jam', 'pukul', 'this', 'ini'] as const;

const ALL_TEMPORAL_PRECEDING_TOKENS = [
  ...SUPPORTED_RELATIVE_DAY_TOKENS,
  ...SUPPORTED_PERIOD_TOKENS,
  ...SUPPORTED_TEMPORAL_PREFIX_TOKENS,
];

const ALL_TEMPORAL_FOLLOWING_TOKENS = [
  ...SUPPORTED_TIMEZONE_TOKENS,
  ...SUPPORTED_RELATIVE_DAY_TOKENS,
  ...SUPPORTED_PERIOD_TOKENS,
  'ini',
];

const TEMPORAL_PRECEDING_TOKEN_REGEX = new RegExp(
  `(?:\\b(?:${ALL_TEMPORAL_PRECEDING_TOKENS.join('|')}))\\s*$`,
  'i'
);

const TEMPORAL_FOLLOWING_TOKEN_REGEX = new RegExp(
  `^\\s*(?:\\b(?:${ALL_TEMPORAL_FOLLOWING_TOKENS.join('|')})\\b)`,
  'i'
);

/**
 * Adjusts an hour (1-12) based on an explicit or inferred period (siang, sore, malam, subuh).
 */
export function adjustHourForPeriod(rawHour: number, periodString?: string): number {
  const normalizedPeriod = (periodString || '').toLowerCase();
  if (normalizedPeriod === 'siang') {
    if (rawHour >= 1 && rawHour <= 4) return rawHour + 12;
  } else if (normalizedPeriod === 'sore') {
    if (rawHour >= 1 && rawHour <= 6) return rawHour + 12;
  } else if (normalizedPeriod === 'malam' || normalizedPeriod === 'malem') {
    if (rawHour >= 1 && rawHour <= 11) return rawHour + 12;
    if (rawHour === 12) return 0;
  } else if (normalizedPeriod === 'pagi' || normalizedPeriod === 'subuh') {
    if (rawHour === 12) return 0;
  }
  return rawHour;
}

/**
 * Extracts explicit hour and minute from text if specified by the user.
 */
export function extractExplicitClockTime(
  inputText: string,
  inferredPeriod?: RelativeTimePeriodName
): { hour: number; minute: number; matchedClockSubstring: string } | null {
  const indonesianClockRegex = /(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*(subuh|pagi|siang|sore|malam|malem))?/i;
  const indonesianMatch = inputText.match(indonesianClockRegex);

  if (indonesianMatch) {
    const rawHour = Number.parseInt(indonesianMatch[1], 10);
    const rawMinute = indonesianMatch[2] ? Number.parseInt(indonesianMatch[2], 10) : 0;
    const explicitPeriodString = indonesianMatch[3] || inferredPeriod;

    if (rawHour >= 0 && rawHour <= 24 && rawMinute >= 0 && rawMinute < 60) {
      const adjustedHour = adjustHourForPeriod(rawHour, explicitPeriodString);
      return {
        hour: adjustedHour % 24,
        minute: rawMinute,
        matchedClockSubstring: indonesianMatch[0],
      };
    }
  }

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

  const bare24HourRegex = /(?:at\s+)?(?<![A-Za-z0-9$€£¥])([01]?\d|2[0-3])([.:])([0-5]\d)(?!\d|[.,]\d|[a-zA-Z%])/gi;
  let bareMatch: RegExpExecArray | null;
  while ((bareMatch = bare24HourRegex.exec(inputText)) !== null) {
    const fullMatch = bareMatch[0];
    const rawHour = Number.parseInt(bareMatch[1], 10);
    const separator = bareMatch[2];
    const rawMinute = Number.parseInt(bareMatch[3], 10);
    const startIndex = bareMatch.index;
    const endIndex = startIndex + fullMatch.length;
    const textBefore = inputText.slice(0, startIndex);
    const textAfter = inputText.slice(endIndex);
    const hasAtPrefix = /^at\s+/i.test(fullMatch);

    if (CURRENCY_PREFIX_REGEX.test(textBefore) || CURRENCY_SUFFIX_REGEX.test(textAfter)) {
      continue;
    }

    if (separator === '.') {
      const hasPositiveTemporalContext =
        hasAtPrefix ||
        TEMPORAL_PRECEDING_TOKEN_REGEX.test(textBefore) ||
        TEMPORAL_FOLLOWING_TOKEN_REGEX.test(textAfter);

      if (!hasPositiveTemporalContext) {
        continue;
      }
    }

    if (rawHour >= 0 && rawHour < 24 && rawMinute >= 0 && rawMinute < 60) {
      const adjustedHour = adjustHourForPeriod(rawHour, inferredPeriod);
      return {
        hour: adjustedHour % 24,
        minute: rawMinute,
        matchedClockSubstring: fullMatch,
      };
    }
  }

  return null;
}
