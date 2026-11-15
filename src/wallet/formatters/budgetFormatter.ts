import type { SupportedLanguage } from '../../i18n/index.js';
import { getDictionary } from '../../i18n/index.js';
import { getDefaultCurrency } from '../../config/applicationConfig.js';
import {
  formatCurrencyAmount,
  getHumanReadableTimestamp,
} from './humanResponseFormatter.js';
import type { WalletBudgetItem } from '../types.js';
import type { BudgetPeriodFilter, BudgetViewMode } from '../../gateway/telegramMenu.js';

export type BudgetPaceStatus = 'over' | 'critical' | 'warning' | 'safe' | 'zero';

export interface BudgetCalculatedMetrics {
  readonly budget: WalletBudgetItem;
  readonly periodKey: BudgetPeriodFilter;
  readonly cleanCategoryName: string;
  readonly startDate: Date;
  readonly endDate: Date;
  readonly totalDays: number;
  readonly elapsedDays: number;
  readonly remainingDays: number;
  readonly timeElapsedPercent: number;
  readonly spentAmount: number;
  readonly limitAmount: number;
  readonly remainingAmount: number;
  readonly spentPercent: number;
  readonly isOverspent: boolean;
  readonly paceStatus: BudgetPaceStatus;
  readonly dailyAllowance: number;
  readonly progressBar: string;
  readonly currency: string;
}

export interface FormatBudgetStatusOptions {
  readonly mode?: BudgetViewMode;
  readonly period?: BudgetPeriodFilter;
  readonly languageCode?: SupportedLanguage;
  readonly referenceDate?: Date;
}

/**
 * Escapes characters that interfere with markdown/HTML formatting inside user category names.
 */
export function sanitizeCategoryName(rawName: string): string {
  return rawName.replace(/[*_`~]/g, '').trim();
}

/**
 * Normalizes a budget item to a standard period key ('1w' | '1m' | '6m' | '1y').
 */
export function normalizeBudgetPeriod(budget: WalletBudgetItem): BudgetPeriodFilter {
  const periodType = (budget.periodType || '').toUpperCase().trim();
  const period = (budget.period || '').toUpperCase().trim();
  const name = (budget.name || '').toLowerCase();

  if (
    periodType === 'WEEK' ||
    periodType === 'WEEKLY' ||
    periodType === 'BUDGET_INTERVAL_WEEK' ||
    /-W\d+/.test(period) ||
    /\b(1w|mingguan|weekly)\b/i.test(name)
  ) {
    return '1w';
  }

  if (
    periodType === 'HALF_YEAR' ||
    periodType === '6M' ||
    periodType === 'SEMESTER' ||
    /\b(6m|semester|6\s*bulan)\b/i.test(name)
  ) {
    return '6m';
  }

  if (
    periodType === 'YEAR' ||
    periodType === 'YEARLY' ||
    periodType === 'BUDGET_INTERVAL_YEAR' ||
    /^\d{4}$/.test(period) ||
    /\b(1y|tahunan|yearly)\b/i.test(name)
  ) {
    return '1y';
  }

  // Default standard interval in BudgetBakers is monthly
  return '1m';
}

/**
 * Calculates start and end dates for a budget's active cycle.
 */
export function resolveBudgetPeriodDates(
  budget: WalletBudgetItem,
  referenceDate: Date = new Date()
): { startDate: Date; endDate: Date } {
  if (budget.periodStart && budget.periodEnd) {
    const parsedStart = new Date(budget.periodStart);
    const parsedEnd = new Date(budget.periodEnd);
    if (!Number.isNaN(parsedStart.getTime()) && !Number.isNaN(parsedEnd.getTime())) {
      return { startDate: parsedStart, endDate: parsedEnd };
    }
  }

  const periodStr = (budget.period || '').trim();

  // ISO Week format: YYYY-Www (e.g. 2026-W37)
  const weekMatch = periodStr.match(/^(\d{4})-W(\d{1,2})$/i);
  if (weekMatch) {
    const year = parseInt(weekMatch[1], 10);
    const week = parseInt(weekMatch[2], 10);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const mondayWeek1 = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
    const startDate = new Date(mondayWeek1.getTime() + (week - 1) * 7 * 86400000);
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(startDate.getTime() + 6 * 86400000);
    endDate.setUTCHours(23, 59, 59, 999);
    return { startDate, endDate };
  }

  // Month format: YYYY-Mmm (e.g. 2026-M09)
  const monthMatch = periodStr.match(/^(\d{4})-M(\d{1,2})$/i);
  if (monthMatch) {
    const year = parseInt(monthMatch[1], 10);
    const month = parseInt(monthMatch[2], 10) - 1;
    const startDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
    return { startDate, endDate };
  }

  // Relative to reference date
  const periodKey = normalizeBudgetPeriod(budget);
  const refYear = referenceDate.getFullYear();
  const refMonth = referenceDate.getMonth();

  if (periodKey === '1w') {
    const currentDay = referenceDate.getDay() || 7; // Monday = 1, Sunday = 7
    const startDate = new Date(referenceDate);
    startDate.setDate(referenceDate.getDate() - (currentDay - 1));
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
    return { startDate, endDate };
  }

  if (periodKey === '6m') {
    // 1st half: Jan 1 - Jun 30, 2nd half: Jul 1 - Dec 31
    const isFirstHalf = refMonth < 6;
    const startDate = new Date(refYear, isFirstHalf ? 0 : 6, 1, 0, 0, 0, 0);
    const endDate = new Date(refYear, isFirstHalf ? 6 : 12, 0, 23, 59, 59, 999);
    return { startDate, endDate };
  }

  if (periodKey === '1y') {
    const startDate = new Date(refYear, 0, 1, 0, 0, 0, 0);
    const endDate = new Date(refYear, 11, 31, 23, 59, 59, 999);
    return { startDate, endDate };
  }

  // '1m'
  const startDate = new Date(refYear, refMonth, 1, 0, 0, 0, 0);
  const endDate = new Date(refYear, refMonth + 1, 0, 23, 59, 59, 999);
  return { startDate, endDate };
}

/**
 * Evaluates budget spending pace against elapsed time in period.
 */
export function evaluateBudgetPace(
  spentAmount: number,
  limitAmount: number,
  isOverspent: boolean,
  timeElapsedPercent: number
): BudgetPaceStatus {
  if (isOverspent || (limitAmount > 0 && spentAmount > limitAmount)) {
    return 'over';
  }

  if (spentAmount <= 0) {
    return 'zero';
  }

  const spentPercent = limitAmount > 0 ? (spentAmount / limitAmount) * 100 : 0;

  // Early period protection: during first 15% of period duration (e.g. first 4 days of month)
  // prevent rapid fluctuations from normal initial expenses.
  if (timeElapsedPercent < 15) {
    if (spentPercent >= 50) {
      return 'critical';
    }
    if (spentPercent >= 25) {
      return 'warning';
    }
    return 'safe';
  }

  // Normal pace thresholds:
  // 🔴 Critical: spentPercent exceeds elapsed time by > 20% or spent >= 100%
  const paceDiff = spentPercent - timeElapsedPercent;
  const epsilon = 0.0001;

  if (spentPercent >= 100 || paceDiff > 20 + epsilon) {
    return 'critical';
  }

  // 🟡 Warning: spentPercent exceeds elapsed time by 5% to 20%
  if (paceDiff > 5 + epsilon) {
    return 'warning';
  }

  // 🟢 Safe: on track or slower than elapsed time
  return 'safe';
}

/**
 * Formats an 8-segment solid/outline block progress bar.
 */
export function formatBudgetProgressBar(
  spentAmount: number,
  limitAmount: number,
  isOverspent: boolean
): string {
  if (isOverspent || (limitAmount > 0 && spentAmount >= limitAmount)) {
    return '▰▰▰▰▰▰▰▰';
  }

  if (limitAmount <= 0 || spentAmount <= 0) {
    return '▱▱▱▱▱▱▱▱';
  }

  const fraction = Math.min(1, Math.max(0, spentAmount / limitAmount));
  let filledSegments = Math.round(fraction * 8);
  if (spentAmount > 0 && filledSegments === 0) {
    filledSegments = 1;
  }
  filledSegments = Math.min(8, Math.max(0, filledSegments));

  return '▰'.repeat(filledSegments) + '▱'.repeat(8 - filledSegments);
}

/**
 * Calculates complete metrics for a budget item.
 */
export function calculateBudgetMetrics(
  budget: WalletBudgetItem,
  referenceDate: Date = new Date()
): BudgetCalculatedMetrics {
  const { startDate, endDate } = resolveBudgetPeriodDates(budget, referenceDate);
  const msPerDay = 86400000;

  const totalDays = Math.max(1, Math.round((endDate.getTime() - startDate.getTime()) / msPerDay));
  const elapsedMs = referenceDate.getTime() - startDate.getTime();
  const elapsedDays = Math.max(0, Math.min(totalDays, Math.floor(elapsedMs / msPerDay)));
  const timeElapsedPercent = Math.min(100, Math.max(0, (elapsedDays / totalDays) * 100));

  const remainingMs = endDate.getTime() - referenceDate.getTime();
  const remainingDays = remainingMs <= 0 ? 0 : Math.ceil(remainingMs / msPerDay);

  const spentAmount = Number(budget.spentAmount ?? 0);
  const limitAmount = Number(budget.limitAmount ?? 0);
  const remainingAmount = budget.remainingAmount !== undefined
    ? Number(budget.remainingAmount)
    : (limitAmount - spentAmount);

  const isOverspent = Boolean(
    budget.isOverspent ||
    remainingAmount < 0 ||
    (limitAmount > 0 && spentAmount > limitAmount)
  );

  const spentPercent = limitAmount > 0 ? (spentAmount / limitAmount) * 100 : 0;
  const paceStatus = evaluateBudgetPace(spentAmount, limitAmount, isOverspent, timeElapsedPercent);
  const dailyAllowance = remainingAmount > 0 && remainingDays > 0 ? remainingAmount / remainingDays : 0;
  const progressBar = formatBudgetProgressBar(spentAmount, limitAmount, isOverspent);
  const periodKey = normalizeBudgetPeriod(budget);
  const currency = budget.currency || getDefaultCurrency();

  const rawClean = budget.name
    .replace(/\s*(?:[\(\[]\s*(?:1w|1m|6m|1y|mingguan|bulanan|tahunan)\s*[\)\]]|\b(?:1w|1m|6m|1y)$)/gi, '')
    .trim();
  const cleanCategoryName = sanitizeCategoryName(rawClean || budget.name);

  return {
    budget,
    periodKey,
    cleanCategoryName,
    startDate,
    endDate,
    totalDays,
    elapsedDays,
    remainingDays,
    timeElapsedPercent,
    spentAmount,
    limitAmount,
    remainingAmount,
    spentPercent,
    isOverspent,
    paceStatus,
    dailyAllowance,
    progressBar,
    currency,
  };
}

export function getBudgetStatusEmoji(status: BudgetPaceStatus): string {
  switch (status) {
    case 'over':
    case 'critical':
      return '🔴';
    case 'warning':
      return '🟡';
    case 'safe':
      return '🟢';
    case 'zero':
      return '⚪';
  }
}

/**
 * Filters and sorts budget metrics:
 * - Filtered by active period (if period !== 'all')
 * - Uniform individual card presentation (no nested multi-row merging)
 * - 🔴 Critical / Over budget items sorted to top
 * - Consistent alphabetical ordering for other active items
 * - Zero spending items kept separate for compact bottom line
 */
export function sortBudgetItems(
  metricsList: BudgetCalculatedMetrics[],
  periodFilter: BudgetPeriodFilter = 'all'
): { activeItems: BudgetCalculatedMetrics[]; zeroItems: BudgetCalculatedMetrics[] } {
  const filteredMetrics = periodFilter === 'all'
    ? metricsList
    : metricsList.filter(m => m.periodKey === periodFilter);

  const activeItems: BudgetCalculatedMetrics[] = [];
  const zeroItems: BudgetCalculatedMetrics[] = [];

  for (const metric of filteredMetrics) {
    if (metric.spentAmount === 0 && !metric.isOverspent) {
      zeroItems.push(metric);
    } else {
      activeItems.push(metric);
    }
  }

  // Sort active items: critical/over first, then alphabetically by cleanCategoryName, then period
  const periodOrder: Record<BudgetPeriodFilter, number> = {
    'all': 0,
    '1w': 1,
    '1m': 2,
    '6m': 3,
    '1y': 4,
  };

  activeItems.sort((a, b) => {
    const aCrit = a.paceStatus === 'critical' || a.paceStatus === 'over';
    const bCrit = b.paceStatus === 'critical' || b.paceStatus === 'over';
    if (aCrit && !bCrit) return -1;
    if (!aCrit && bCrit) return 1;

    const nameCompare = a.cleanCategoryName.localeCompare(b.cleanCategoryName);
    if (nameCompare !== 0) return nameCompare;

    return (periodOrder[a.periodKey] ?? 0) - (periodOrder[b.periodKey] ?? 0);
  });

  zeroItems.sort((a, b) => a.cleanCategoryName.localeCompare(b.cleanCategoryName));

  return { activeItems, zeroItems };
}

/**
 * Formats the full budget status message in Compact or Detail mode.
 */
export function formatBudgetStatusMessage(
  budgetList: WalletBudgetItem[],
  options: FormatBudgetStatusOptions = {}
): string {
  const mode = options.mode || 'compact';
  const period = options.period || 'all';
  const languageCode = options.languageCode;
  const referenceDate = options.referenceDate || new Date();

  const dictionary = getDictionary(languageCode);
  const currentTimestamp = getHumanReadableTimestamp(referenceDate, languageCode);

  const activeBudgetList = (budgetList || []).filter(item => !item.isClosed);
  if (activeBudgetList.length === 0) {
    return `${dictionary.budget.header(currentTimestamp)}\n\n${dictionary.budget.emptyState}`;
  }

  const allMetrics = activeBudgetList.map(budget => calculateBudgetMetrics(budget, referenceDate));
  const { activeItems, zeroItems } = sortBudgetItems(allMetrics, period);

  const periodLabel = dictionary.budget.periodLabels[period];
  const isDetail = mode === 'detail';
  const header = dictionary.budget.header(currentTimestamp, periodLabel, isDetail);

  if (activeItems.length === 0 && zeroItems.length === 0) {
    return `${header}\n\n${dictionary.budget.emptyPeriodState(periodLabel)}`;
  }

  const sections: string[] = [header, ''];

  if (mode === 'compact') {
    // Mode Ringkas: tiap kategori 1 anchor visual + 1 anchor angka (Sisa)
    for (const item of activeItems) {
      const emoji = getBudgetStatusEmoji(item.paceStatus);
      const displayName = sanitizeCategoryName(item.cleanCategoryName || item.budget.name);

      sections.push(`${emoji} *${displayName}* [${item.periodKey}]`);
      if (item.isOverspent) {
        const overAmount = Math.abs(item.remainingAmount);
        const formattedOver = formatCurrencyAmount(overAmount, item.currency, languageCode);
        sections.push(`${item.progressBar} • ⚠️ *${dictionary.budget.overLabel} ${formattedOver}*`);
      } else {
        const formattedRemaining = formatCurrencyAmount(Math.max(0, item.remainingAmount), item.currency, languageCode);
        sections.push(`${item.progressBar} • *${dictionary.budget.remainingSummary(formattedRemaining)}*`);
      }
      sections.push('');
    }

    // Zero spending items summarized in single line at bottom
    if (zeroItems.length > 0) {
      const zeroSummaryList = zeroItems.map(item => `${sanitizeCategoryName(item.cleanCategoryName || item.budget.name)} [${item.periodKey}]`);
      sections.push(dictionary.budget.zeroSpentSummary(zeroSummaryList.join(', ')));
    }
  } else {
    // Mode Detail: rincian lengkap per kategori
    for (const item of activeItems) {
      const emoji = getBudgetStatusEmoji(item.paceStatus);
      const displayName = sanitizeCategoryName(item.cleanCategoryName || item.budget.name);
      const formattedSpent = formatCurrencyAmount(item.spentAmount, item.currency, languageCode);
      const formattedLimit = formatCurrencyAmount(item.limitAmount, item.currency, languageCode);
      const formattedDaily = formatCurrencyAmount(Math.round(item.dailyAllowance), item.currency, languageCode);
      const spentPercentDisplay = Math.round(item.spentPercent);
      const timeElapsedDisplay = Math.round(item.timeElapsedPercent);

      sections.push(`${emoji} *${displayName}* [${item.periodKey}]`);
      sections.push(`${item.progressBar} ${spentPercentDisplay}% (${dictionary.budget.timeElapsed(timeElapsedDisplay)})`);
      sections.push(`• ${dictionary.budget.spentLabel}: ${formattedSpent} / ${formattedLimit}`);

      if (item.isOverspent) {
        const overAmount = Math.abs(item.remainingAmount);
        const formattedOver = formatCurrencyAmount(overAmount, item.currency, languageCode);
        sections.push(`• ⚠️ *${dictionary.budget.overLabel}: ${formattedOver}* (${dictionary.budget.remainingDays(item.remainingDays)})`);
        sections.push(`• ${dictionary.budget.dailyAllowanceLabel}: *${dictionary.budget.dailyAllowance(formatCurrencyAmount(0, item.currency, languageCode))}*`);
      } else {
        const formattedRemaining = formatCurrencyAmount(Math.max(0, item.remainingAmount), item.currency, languageCode);
        sections.push(`• ${dictionary.budget.remainingLabel}: ${formattedRemaining} (${dictionary.budget.remainingDays(item.remainingDays)})`);
        sections.push(`• ${dictionary.budget.dailyAllowanceLabel}: *${dictionary.budget.dailyAllowance(formattedDaily)}*`);
      }
      sections.push('');
    }

    if (zeroItems.length > 0) {
      sections.push(`*${dictionary.budget.zeroSpentTitle}*`);
      for (const item of zeroItems) {
        const displayName = sanitizeCategoryName(item.cleanCategoryName || item.budget.name);
        const formattedSpentZero = formatCurrencyAmount(0, item.currency, languageCode);
        const formattedLimit = formatCurrencyAmount(item.limitAmount, item.currency, languageCode);
        const formattedDaily = formatCurrencyAmount(Math.round(item.dailyAllowance), item.currency, languageCode);
        sections.push(
          `• ⚪ *${displayName}* [${item.periodKey}]: ${formattedSpentZero} / ${formattedLimit} • ${dictionary.budget.remainingDays(item.remainingDays)} • ${dictionary.budget.dailyAllowance(formattedDaily)}`
        );
      }
    }
  }

  return sections.join('\n').trim();
}
