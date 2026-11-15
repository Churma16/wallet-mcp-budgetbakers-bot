import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  formatBudgetStatusMessage,
  evaluateBudgetPace,
  formatBudgetProgressBar,
  calculateBudgetMetrics,
  sortBudgetItems,
  sanitizeCategoryName,
} from '../src/wallet/formatters/budgetFormatter.js';
import type { WalletBudgetItem } from '../src/wallet/types.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('Mobile Budget Status Formatter', () => {
  const referenceDate = new Date('2026-09-15T12:00:00.000Z'); // mid-month (approx 50% through Sept)

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(referenceDate);
    setActiveLanguage('id');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('evaluateBudgetPace', () => {
    it('returns "over" when isOverspent is true or spent exceeds limit', () => {
      expect(evaluateBudgetPace(1200000, 1000000, false, 50)).toBe('over');
      expect(evaluateBudgetPace(500000, 1000000, true, 50)).toBe('over');
    });

    it('returns "zero" when spent amount is 0', () => {
      expect(evaluateBudgetPace(0, 1000000, false, 50)).toBe('zero');
    });

    it('returns "safe" (🟢) when spending pace is on track or slower than time elapsed', () => {
      // 50% time elapsed, 40% spent (40 <= 50 + 5)
      expect(evaluateBudgetPace(400000, 1000000, false, 50)).toBe('safe');
      // 50% time elapsed, 55% spent (55 <= 50 + 5)
      expect(evaluateBudgetPace(550000, 1000000, false, 50)).toBe('safe');
    });

    it('returns "warning" (🟡) when spending pace is slightly ahead of time elapsed (+5% to +20%)', () => {
      // 50% time elapsed, 65% spent (55 < 65 <= 70)
      expect(evaluateBudgetPace(650000, 1000000, false, 50)).toBe('warning');
    });

    it('returns "critical" (🔴) when spending pace is far ahead of time elapsed (> +20%)', () => {
      // 40% time elapsed, 75% spent (75 > 40 + 20)
      expect(evaluateBudgetPace(750000, 1000000, false, 40)).toBe('critical');
    });

    it('guards early period (timeElapsed < 15%) to prevent false critical spikes', () => {
      // Early period: day 2 of month (6.7% elapsed)
      // Normal routine groceries: 20% spent -> should remain safe
      expect(evaluateBudgetPace(200000, 1000000, false, 6.7)).toBe('safe');
      // 35% spent early on -> warning
      expect(evaluateBudgetPace(350000, 1000000, false, 6.7)).toBe('warning');
      // >=50% spent early on -> critical
      expect(evaluateBudgetPace(600000, 1000000, false, 6.7)).toBe('critical');
      // Over budget early on -> over
      expect(evaluateBudgetPace(1100000, 1000000, false, 6.7)).toBe('over');
    });
  });

  describe('formatBudgetProgressBar', () => {
    it('renders 8 segments for over budget or full limit', () => {
      expect(formatBudgetProgressBar(1200000, 1000000, true)).toBe('▰▰▰▰▰▰▰▰');
      expect(formatBudgetProgressBar(1000000, 1000000, false)).toBe('▰▰▰▰▰▰▰▰');
    });

    it('renders empty 8 segments when spent is 0', () => {
      expect(formatBudgetProgressBar(0, 1000000, false)).toBe('▱▱▱▱▱▱▱▱');
    });

    it('renders proportional 8 segments accurately', () => {
      // 50% -> 4 solid, 4 outline
      expect(formatBudgetProgressBar(500000, 1000000, false)).toBe('▰▰▰▰▱▱▱▱');
      // 25% -> 2 solid, 6 outline
      expect(formatBudgetProgressBar(250000, 1000000, false)).toBe('▰▰▱▱▱▱▱▱');
      // 75% -> 6 solid, 2 outline
      expect(formatBudgetProgressBar(750000, 1000000, false)).toBe('▰▰▰▰▰▰▱▱');
      // Minimal spend > 0 ensures at least 1 solid segment
      expect(formatBudgetProgressBar(10000, 1000000, false)).toBe('▰▱▱▱▱▱▱▱');
    });
  });

  describe('sanitizeCategoryName', () => {
    it('strips markdown formatting characters from names', () => {
      expect(sanitizeCategoryName('*Makan* _Siang_ ~Cemilan~ `Kopi`')).toBe('Makan Siang Cemilan Kopi');
    });

    it('prevents double period label when raw name already contains (1w) or (1m)', () => {
      const doubleLabelBudgets: WalletBudgetItem[] = [
        {
          id: 'w1',
          name: 'Makan Nafsu Ngemil (1w)',
          limitAmount: 500000,
          spentAmount: 200000,
          remainingAmount: 300000,
          periodType: 'WEEK',
          period: '2026-W37',
        },
        {
          id: 'm1',
          name: 'Makan Nafsu Ngemil (1m)',
          limitAmount: 2000000,
          spentAmount: 800000,
          remainingAmount: 1200000,
          periodType: 'MONTH',
          period: '2026-M09',
        },
        {
          id: 'm2',
          name: 'Spending Bulanan',
          limitAmount: 3000000,
          spentAmount: 1000000,
          remainingAmount: 2000000,
          periodType: 'MONTH',
          period: '2026-M09',
        },
      ];

      const output = formatBudgetStatusMessage(doubleLabelBudgets, {
        mode: 'compact',
        period: 'all',
        languageCode: 'id',
        referenceDate,
      });

      expect(output).toContain('*Makan Nafsu Ngemil* [1w]');
      expect(output).not.toContain('*Makan Nafsu Ngemil (1w)* [1w]');
      expect(output).toContain('*Makan Nafsu Ngemil* [1m]');
      expect(output).not.toContain('*Makan Nafsu Ngemil (1m)* [1m]');
      expect(output).toContain('*Spending Bulanan* [1m]');
    });
  });

  describe('sortBudgetItems', () => {
    const sampleBudgets: WalletBudgetItem[] = [
      {
        id: '1',
        name: 'Transportasi',
        limitAmount: 1000000,
        spentAmount: 300000, // Safe
        periodType: 'MONTH',
        period: '2026-M09',
      },
      {
        id: '2',
        name: 'Makan',
        limitAmount: 500000,
        spentAmount: 450000, // Critical
        periodType: 'WEEK',
        period: '2026-W38',
      },
      {
        id: '3',
        name: 'Makan (1m)',
        limitAmount: 2000000,
        spentAmount: 900000, // Safe
        periodType: 'MONTH',
        period: '2026-M09',
      },
      {
        id: '4',
        name: 'Belanja Gadget',
        limitAmount: 5000000,
        spentAmount: 6000000, // Over budget
        isOverspent: true,
        periodType: 'MONTH',
        period: '2026-M09',
      },
      {
        id: '5',
        name: 'Emergency Fund',
        limitAmount: 10000000,
        spentAmount: 0, // Zero spent
        periodType: 'MONTH',
        period: '2026-M09',
      },
    ];

    it('pulls critical & over-budget categories to the top and groups 0-spent at bottom with uniform individual cards', () => {
      const metrics = sampleBudgets.map(b => calculateBudgetMetrics(b, referenceDate));
      const { activeItems, zeroItems } = sortBudgetItems(metrics, 'all');

      // Top items should be critical / over: Belanja Gadget (over) and Makan 1w (critical)
      const topStatuses = [activeItems[0].paceStatus, activeItems[1].paceStatus];
      expect(topStatuses).toContain('over');
      expect(topStatuses).toContain('critical');

      // Each period remains an individual card preserving pattern consistency (4 active items)
      expect(activeItems.length).toBe(4);
      expect(activeItems.some(i => i.budget.name === 'Makan' && i.periodKey === '1w')).toBe(true);
      expect(activeItems.some(i => i.budget.name === 'Makan (1m)' && i.periodKey === '1m')).toBe(true);

      // Zero items
      expect(zeroItems.length).toBe(1);
      expect(zeroItems[0].budget.name).toBe('Emergency Fund');
    });

    it('filters by period correctly when specified', () => {
      const metrics = sampleBudgets.map(b => calculateBudgetMetrics(b, referenceDate));
      const { activeItems, zeroItems } = sortBudgetItems(metrics, '1w');

      expect(activeItems.length).toBe(1);
      expect(activeItems[0].cleanCategoryName.toLowerCase()).toBe('makan');
      expect(zeroItems.length).toBe(0);
    });
  });

  describe('formatBudgetStatusMessage (Compact vs Detail Mode)', () => {
    const mockBudgets: WalletBudgetItem[] = [
      {
        id: 'b-over',
        name: 'Liburan Weekend',
        limitAmount: 2000000,
        spentAmount: 2500000,
        remainingAmount: -500000,
        isOverspent: true,
        periodType: 'MONTH',
        period: '2026-M09',
      },
      {
        id: 'b-safe',
        name: 'Makan & Minum',
        limitAmount: 1000000,
        spentAmount: 300000,
        remainingAmount: 700000,
        periodType: 'MONTH',
        period: '2026-M09',
      },
      {
        id: 'b-zero',
        name: 'Investasi',
        limitAmount: 5000000,
        spentAmount: 0,
        remainingAmount: 5000000,
        periodType: 'MONTH',
        period: '2026-M09',
      },
    ];

    it('formats Mode Ringkas with single visual anchor + single number anchor (sisa)', () => {
      const output = formatBudgetStatusMessage(mockBudgets, {
        mode: 'compact',
        period: 'all',
        languageCode: 'id',
        referenceDate,
      });

      expect(output).toContain('📈 *Status Anggaran*');
      // Over budget item sorted to top with ⛔ and clean 'Lebih' without redundant warning icon
      expect(output).toContain('⛔ *Liburan Weekend* [1m]');
      expect(output).toContain('▰▰▰▰▰▰▰▰ • Lebih Rp 500.000');
      expect(output).not.toContain('⚠️');

      // Safe item with remaining amount (sisa) in unbolded regular text to keep visual anchor clean
      expect(output).toContain('🟢 *Makan & Minum* [1m]');
      expect(output).toContain('sisa Rp 700.000');
      expect(output).not.toContain('*sisa Rp 700.000*');
      expect(output).not.toContain('/hari');

      // Zero-spent summarized at bottom
      expect(output).toContain('⚪ _Belum terpakai: Investasi [1m]_');
    });

    it('formats Mode Detail with full percentage, limits, sisa, and daily breakdown', () => {
      const output = formatBudgetStatusMessage(mockBudgets, {
        mode: 'detail',
        period: 'all',
        languageCode: 'id',
        referenceDate,
      });

      expect(output).toContain('📈 *Status Anggaran* _(Detail)_');
      expect(output).toContain('⛔ *Liburan Weekend* [1m]');
      expect(output).toContain('• Terpakai: Rp 2.500.000 / Rp 2.000.000');
      expect(output).toContain('• Lebih: Rp 500.000');
      expect(output).not.toContain('⚠️');
      expect(output).toContain('• Terpakai: Rp 300.000 / Rp 1.000.000');
      expect(output).toContain('• Sisa: Rp 700.000');
      expect(output).toContain('• Jatah:');
      // Zero-spent title and item in detail mode
      expect(output).toContain('*Belum terpakai*');
      expect(output).toContain('• ⚪ *Investasi* [1m]: Rp 0 / Rp 5.000.000');
    });

    it('formats zero-spent items with non-IDR currency accurately without hardcoding Rp', () => {
      const usdBudgets: WalletBudgetItem[] = [
        {
          id: 'usd-1',
          name: 'Server Cloud',
          limitAmount: 50,
          spentAmount: 0,
          remainingAmount: 50,
          currency: 'USD',
          periodType: 'MONTH',
          period: '2026-M09',
        },
      ];

      const output = formatBudgetStatusMessage(usdBudgets, {
        mode: 'detail',
        period: 'all',
        languageCode: 'en',
        referenceDate,
      });

      expect(output).toContain('*Zero spent*');
      expect(output).not.toContain('Rp 0');
      expect(output).toContain('$0.00 / $50.00');
    });

    it('handles expired budgets correctly with 0 remaining days', () => {
      const expiredBudget: WalletBudgetItem = {
        id: 'b-exp',
        name: 'Weekly Snacks',
        limitAmount: 200000,
        spentAmount: 150000,
        remainingAmount: 50000,
        periodType: 'WEEK',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-09-07T23:59:59.999Z', // already ended relative to referenceDate 2026-09-15
      };

      const metrics = calculateBudgetMetrics(expiredBudget, referenceDate);
      expect(metrics.remainingDays).toBe(0);
      expect(metrics.dailyAllowance).toBe(0);

      const output = formatBudgetStatusMessage([expiredBudget], {
        mode: 'detail',
        period: 'all',
        languageCode: 'id',
        referenceDate,
      });

      expect(output).toContain('(sisa 0 hari)');
      expect(output).toContain('Rp 0/hari');
    });

    it('handles empty budget list gracefully', () => {
      const output = formatBudgetStatusMessage([], {
        languageCode: 'id',
        referenceDate,
      });
      expect(output).toContain('Belum ada anggaran aktif yang ditemukan.');
    });

    it('handles no budgets matching a specific period filter', () => {
      const output = formatBudgetStatusMessage(mockBudgets, {
        mode: 'compact',
        period: '1y',
        languageCode: 'id',
        referenceDate,
      });
      expect(output).toContain('Belum ada anggaran aktif untuk periode 1 Tahun.');
    });
  });
});
