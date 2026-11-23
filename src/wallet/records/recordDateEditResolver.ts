import {
  getLocalTimeParts,
  resolveTargetLocalToUtcIso,
  extractExplicitClockTime,
  parseRelativeTime,
  FinancialAiProvider,
} from '../../brain/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../../lib/logger.js';

export interface RecordDateEditResolutionResult {
  readonly resolvedUtcIso: string;
  readonly changeScope: 'TIME_ONLY' | 'DATE_ONLY' | 'BOTH';
  readonly source: 'AI' | 'DETERMINISTIC';
}

export interface RecordDateEditResolutionOptions {
  readonly aiProvider?: FinancialAiProvider;
  readonly referenceDate?: Date;
  readonly timezone?: string;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, januari: 1, january: 1,
  feb: 2, februari: 2, february: 2,
  mar: 3, maret: 3, march: 3,
  apr: 4, april: 4,
  mei: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  agu: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, september: 9,
  okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11,
  des: 12, desember: 12, dec: 12, december: 12,
};

function parseExplicitCalendarDate(
  cleanHint: string,
  referenceYear: number
): string | null {
  // ISO date: YYYY-MM-DD
  const isoMatch = cleanHint.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1], 10);
    const month = Number.parseInt(isoMatch[2], 10);
    const day = Number.parseInt(isoMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Indonesian / standard slash or dash: DD/MM/YYYY or DD/MM or DD-MM-YYYY
  const slashMatch = cleanHint.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slashMatch) {
    const day = Number.parseInt(slashMatch[1], 10);
    const month = Number.parseInt(slashMatch[2], 10);
    let rawYear = slashMatch[3] ? Number.parseInt(slashMatch[3], 10) : referenceYear;
    if (rawYear < 100) rawYear += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${rawYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  // Text month format: e.g. "21 nov", "21 november 2026", "nov 21"
  const textMonthMatch1 = cleanHint.match(/\b(\d{1,2})\s+([a-zA-Z]{3,})(?:\s+(\d{2,4}))?\b/i);
  if (textMonthMatch1) {
    const day = Number.parseInt(textMonthMatch1[1], 10);
    const monthKey = textMonthMatch1[2].toLowerCase();
    const monthNum = MONTH_NAME_MAP[monthKey];
    let rawYear = textMonthMatch1[3] ? Number.parseInt(textMonthMatch1[3], 10) : referenceYear;
    if (rawYear < 100) rawYear += 2000;
    if (monthNum && day >= 1 && day <= 31) {
      return `${rawYear}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const textMonthMatch2 = cleanHint.match(/\b([a-zA-Z]{3,})\s+(\d{1,2})(?:,?\s+(\d{2,4}))?\b/i);
  if (textMonthMatch2) {
    const monthKey = textMonthMatch2[1].toLowerCase();
    const day = Number.parseInt(textMonthMatch2[2], 10);
    const monthNum = MONTH_NAME_MAP[monthKey];
    let rawYear = textMonthMatch2[3] ? Number.parseInt(textMonthMatch2[3], 10) : referenceYear;
    if (rawYear < 100) rawYear += 2000;
    if (monthNum && day >= 1 && day <= 31) {
      return `${rawYear}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Resolves user date/time modifications for an existing transaction.
 * Uses AI provider when available to smart-recognize what changed (clock time, calendar date, or both),
 * and deterministically falls back to time parser rules.
 */
export async function resolveRecordDateEdit(
  inputHint: string,
  existingDateIso: string,
  options?: RecordDateEditResolutionOptions
): Promise<RecordDateEditResolutionResult | undefined> {
  if (!inputHint || typeof inputHint !== 'string' || !inputHint.trim()) {
    return undefined;
  }

  const cleanHint = inputHint.trim();
  const referenceDate = options?.referenceDate || new Date();
  const timezone = options?.timezone || 'Asia/Jakarta';

  // 1. Primary: Use AI Provider for smart contextual time recognition
  if (options?.aiProvider && typeof options.aiProvider.interpretRecordDateEdit === 'function') {
    try {
      const proposal = await options.aiProvider.interpretRecordDateEdit(
        cleanHint,
        existingDateIso,
        referenceDate,
        timezone
      );
      if (proposal && proposal.resolvedUtcIso) {
        applicationLogger.info(
          `[Date Edit AI] Resolved "${cleanHint}" -> ${proposal.resolvedUtcIso} (${proposal.changeScope}) via ${options.aiProvider.providerName}`
        );
        return {
          resolvedUtcIso: proposal.resolvedUtcIso,
          changeScope: proposal.changeScope,
          source: 'AI',
        };
      }
    } catch (aiError) {
      applicationLogger.warn(
        `[Date Edit AI] Interpretation failed for "${cleanHint}": ${formatConciseErrorMessage(aiError)}. Falling back to deterministic resolver.`
      );
    }
  }

  // 2. Deterministic Resolver Fallback
  const parsedExisting = Date.parse(existingDateIso);
  const existingDate = Number.isNaN(parsedExisting) ? referenceDate : new Date(parsedExisting);
  const existingLocal = getLocalTimeParts(existingDate, timezone);
  const refLocal = getLocalTimeParts(referenceDate, timezone);

  // Normalize standalone dot-notation clock time (e.g. "14.30" -> "14:30")
  const normalizedHint = cleanHint.replace(/^(\d{1,2})\.(\d{2})$/, '$1:$2');

  const explicitClock = extractExplicitClockTime(normalizedHint);
  const relativeTime = parseRelativeTime(cleanHint, referenceDate, timezone);
  const explicitDate = parseExplicitCalendarDate(cleanHint, refLocal.year);

  let targetDateString: string | null = null;
  let targetHour: number = existingLocal.hour;
  let targetMinute: number = existingLocal.minute;
  let changeScope: 'TIME_ONLY' | 'DATE_ONLY' | 'BOTH' = 'BOTH';

  if (explicitDate) {
    targetDateString = explicitDate;
    if (explicitClock) {
      targetHour = explicitClock.hour;
      targetMinute = explicitClock.minute;
      changeScope = 'BOTH';
    } else {
      targetHour = existingLocal.hour;
      targetMinute = existingLocal.minute;
      changeScope = 'DATE_ONLY';
    }
  } else if (relativeTime) {
    targetDateString = relativeTime.targetDateString;
    const hasSpecificClock = Boolean(explicitClock || relativeTime.hasExplicitTime || relativeTime.periodName);
    if (hasSpecificClock) {
      targetHour = explicitClock ? explicitClock.hour : relativeTime.targetHour;
      targetMinute = explicitClock ? explicitClock.minute : relativeTime.targetMinute;
      changeScope = 'BOTH';
    } else {
      // Relative day like "kemarin", "yesterday" preserves the original clock time
      targetHour = existingLocal.hour;
      targetMinute = existingLocal.minute;
      changeScope = 'DATE_ONLY';
    }
  } else if (explicitClock) {
    // Only clock time was specified: keep original calendar date!
    targetDateString = existingLocal.dateString;
    targetHour = explicitClock.hour;
    targetMinute = explicitClock.minute;
    changeScope = 'TIME_ONLY';
  } else {
    // Unrecognized date/time expression
    return undefined;
  }

  const resolvedUtcIso = resolveTargetLocalToUtcIso(
    targetDateString,
    targetHour,
    targetMinute,
    timezone,
    changeScope === 'DATE_ONLY' ? (existingLocal.second ?? 0) : 0,
    0
  );

  return {
    resolvedUtcIso,
    changeScope,
    source: 'DETERMINISTIC',
  };
}
