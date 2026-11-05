import { describe, expect, it } from 'vitest';
import {
  FAST_PATH_OPERATOR_MAP,
  FAST_PATH_PERIOD_MAP,
  extractHistoryQueryOptionsFromTokens,
} from '../src/brain/fastpath/fastPathTokens.js';

describe('Fast-Path Tokens Lookup Tables & Operator/Period Resolution', () => {
  it('maps single operator keywords to standard operators', () => {
    expect(FAST_PATH_OPERATOR_MAP['>']).toBe('gt');
    expect(FAST_PATH_OPERATOR_MAP['gt']).toBe('gt');
    expect(FAST_PATH_OPERATOR_MAP['>=']).toBe('gte');
    expect(FAST_PATH_OPERATOR_MAP['gte']).toBe('gte');
    expect(FAST_PATH_OPERATOR_MAP['<']).toBe('lt');
    expect(FAST_PATH_OPERATOR_MAP['lt']).toBe('lt');
    expect(FAST_PATH_OPERATOR_MAP['<=']).toBe('lte');
    expect(FAST_PATH_OPERATOR_MAP['lte']).toBe('lte');
  });

  it('maps all supported date period tokens correctly', () => {
    expect(FAST_PATH_PERIOD_MAP['hari ini']).toBe('today');
    expect(FAST_PATH_PERIOD_MAP['today']).toBe('today');
    expect(FAST_PATH_PERIOD_MAP['kemarin']).toBe('yesterday');
    expect(FAST_PATH_PERIOD_MAP['yesterday']).toBe('yesterday');
    expect(FAST_PATH_PERIOD_MAP['semalam']).toBe('yesterday');
    expect(FAST_PATH_PERIOD_MAP['minggu ini']).toBe('this_week');
    expect(FAST_PATH_PERIOD_MAP['this week']).toBe('this_week');
    expect(FAST_PATH_PERIOD_MAP['minggu lalu']).toBe('last_week');
    expect(FAST_PATH_PERIOD_MAP['last week']).toBe('last_week');
    expect(FAST_PATH_PERIOD_MAP['bulan ini']).toBe('this_month');
    expect(FAST_PATH_PERIOD_MAP['this month']).toBe('this_month');
    expect(FAST_PATH_PERIOD_MAP['bulan lalu']).toBe('last_month');
    expect(FAST_PATH_PERIOD_MAP['last month']).toBe('last_month');
    expect(FAST_PATH_PERIOD_MAP['tahun ini']).toBe('this_year');
    expect(FAST_PATH_PERIOD_MAP['this year']).toBe('this_year');
  });

  it('extracts date periods using lookup table correctly in queries', () => {
    const todayResult = extractHistoryQueryOptionsFromTokens('hari ini pengeluaran');
    expect(todayResult?.datePeriod).toBe('today');
    expect(todayResult?.recordType).toBe('expense');

    const lastMonthResult = extractHistoryQueryOptionsFromTokens('bulan lalu pemasukan');
    expect(lastMonthResult?.datePeriod).toBe('last_month');
    expect(lastMonthResult?.recordType).toBe('income');

    const yesterdayResult = extractHistoryQueryOptionsFromTokens('semalam');
    expect(yesterdayResult?.datePeriod).toBe('yesterday');
  });

  it('extracts single operator dates using lookup table', () => {
    const singleOpResult = extractHistoryQueryOptionsFromTokens('>2026-10-01');
    expect(singleOpResult?.dateRange).toEqual(['gt.2026-10-01']);

    const lteOpResult = extractHistoryQueryOptionsFromTokens('<=2026-10-31');
    expect(lteOpResult?.dateRange).toEqual(['lte.2026-10-31']);
  });

  it('extracts dual operator date ranges using lookup table', () => {
    const dualResult = extractHistoryQueryOptionsFromTokens('>=2026-10-01 <=2026-10-31');
    expect(dualResult?.dateRange).toEqual(['gte.2026-10-01', 'lte.2026-10-31']);
  });
});
