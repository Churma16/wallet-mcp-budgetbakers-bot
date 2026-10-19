import { describe, it, expect } from 'vitest';
import { formatFinancialHealthMessage } from '../src/utils/financialHealthFormatter.js';
import { FinancialHealthEvaluationResult } from '../src/types/financialHealthTypes.js';

describe('FinancialHealthFormatter Tests', () => {
  const baseResult: FinancialHealthEvaluationResult = {
    cashFlow: {
      currentMonth: {
        income: 15000000,
        expense: 6000000,
        net: 9000000,
        regularExpense: 4000000,
        discretionaryExpense: 2000000,
        transactionCount: 25,
      },
      previousMonth: {
        income: 14000000,
        expense: 5500000,
        net: 8500000,
        regularExpense: 3800000,
        discretionaryExpense: 1700000,
        transactionCount: 22,
      },
      currency: 'IDR',
    },
    liquidAccounts: [
      { id: 'acc-1', name: 'BCA Utama', balance: 12000000, currency: 'IDR' },
      { id: 'acc-2', name: 'GoPay', balance: 500000, currency: 'IDR' },
    ],
    totalLiquidBalance: 12500000,
    activeBudgets: [
      {
        id: 'b-1',
        name: 'Belanja Santai',
        spentAmount: 2500000,
        limitAmount: 2000000,
        remainingAmount: -500000,
        currency: 'IDR',
        isOverspent: true,
      },
      {
        id: 'b-2',
        name: 'Makan',
        spentAmount: 2000000,
        limitAmount: 3500000,
        remainingAmount: 1500000,
        currency: 'IDR',
        isOverspent: false,
      },
    ],
    topPurchases: [
      { categoryId: 'c-gadget', categoryName: 'Gadget', amount: 1500000, transactionCount: 1, classification: 'discretionary' },
      { categoryId: 'c-cafe', categoryName: 'Cafe Nongkrong', amount: 500000, transactionCount: 3, classification: 'discretionary' },
    ],
    topRegularExpenses: [
      { categoryId: 'c-makan', categoryName: 'Makan Harian', amount: 2500000, transactionCount: 15, classification: 'regular' },
      { categoryId: 'c-commute', categoryName: 'Commute/Ojol', amount: 1500000, transactionCount: 12, classification: 'regular' },
    ],
    runway: {
      totalLiquidBalance: 12500000,
      daysElapsedInMonth: 20,
      daysRemainingInMonth: 11,
      dailyRegularBurnRate: 200000,
      projectedRemainingRegularExpense: 2200000,
      projectedNetSavingsEndOfMonth: 6800000,
      runwayCoverageRatio: 5.68,
      isSufficient: true,
    },
    referenceDate: new Date('2026-10-20T00:00:00Z'),
  };

  it('formats human-facing financial health message in Indonesian with healthy status', () => {
    const formatted = formatFinancialHealthMessage(baseResult, 'id');

    expect(formatted).toContain('📊 *Laporan Kesehatan Keuangan & Runway*');
    expect(formatted).toContain('*1. Arus Kas (Cash Flow)*');
    expect(formatted).toContain('Bulan Ini (MTD): Masuk Rp 15.000.000, Keluar Rp 6.000.000 (Net: +Rp 9.000.000)');
    expect(formatted).toContain('Bulan Lalu: Masuk Rp 14.000.000, Keluar Rp 5.500.000 (Net: +Rp 8.500.000)');

    expect(formatted).toContain('*2. Rincian Pengeluaran Bulan Ini*');
    expect(formatted).toContain('🛒 *Purchases (Belanja Diskresioner)*: Rp 2.000.000 (33%)');
    expect(formatted).toContain('Top: Gadget (Rp 1.500.000), Cafe Nongkrong (Rp 500.000)');
    expect(formatted).toContain('🔄 *Regular Purchases (Kebutuhan Rutin)*: Rp 4.000.000 (67%)');
    expect(formatted).toContain('Top: Makan Harian (Rp 2.500.000), Commute/Ojol (Rp 1.500.000)');

    expect(formatted).toContain('*3. Saldo Likuid Akun*');
    expect(formatted).toContain('• BCA Utama: Rp 12.000.000');
    expect(formatted).toContain('• GoPay: Rp 500.000');
    expect(formatted).toContain('*Total Saldo Likuid*: Rp 12.500.000');

    expect(formatted).toContain('*4. Status Anggaran (Budgets)*');
    expect(formatted).toContain('⚠️ Belanja Santai: Terpakai Rp 2.500.000 / Rp 2.000.000 (Overspent: Rp 500.000)');
    expect(formatted).toContain('✅ Makan: Terpakai Rp 2.000.000 / Rp 3.500.000 (Sisa: Rp 1.500.000)');

    expect(formatted).toContain('*5. Evaluasi Runway & Keputusan*');
    expect(formatted).toContain('• Sisa hari bulan ini: 11 hari');
    expect(formatted).toContain('• Rata-rata rutin harian: Rp 200.000/hari');
    expect(formatted).toContain('• Estimasi sisa kebutuhan rutin: Rp 2.200.000');
    expect(formatted).toContain('✅ *DANA SANGAT CUKUP*: Saldo likuid Anda (Rp 12.500.000) menutup 5.68x estimasi sisa kebutuhan rutin sampai akhir bulan.');
  });

  it('formats human-facing financial health message in English with tight status', () => {
    const tightResult: FinancialHealthEvaluationResult = {
      ...baseResult,
      totalLiquidBalance: 800000,
      liquidAccounts: [
        { id: 'acc-1', name: 'Main Account', balance: 800000, currency: 'IDR' },
      ],
      runway: {
        totalLiquidBalance: 800000,
        daysElapsedInMonth: 15,
        daysRemainingInMonth: 15,
        dailyRegularBurnRate: 150000,
        projectedRemainingRegularExpense: 2250000,
        projectedNetSavingsEndOfMonth: -1450000,
        runwayCoverageRatio: 0.36,
        isSufficient: false,
      },
    };

    const formatted = formatFinancialHealthMessage(tightResult, 'en');

    expect(formatted).toContain('📊 *Financial Health & Runway Report*');
    expect(formatted).toContain('*1. Cash Flow Overview*');
    expect(formatted).toContain('*2. Spending Breakdown (This Month)*');
    expect(formatted).toContain('*3. Real-Time Liquid Balances*');
    expect(formatted).toContain('*Total Liquid Funds*: Rp 800,000');
    expect(formatted).toContain('*5. Runway & Affordability Verdict*');
    expect(formatted).toContain('• Days remaining in month: 15 days');
    expect(formatted).toContain('• Daily routine burn rate: Rp 150,000/day');
    expect(formatted).toContain('⚠️ *TIGHT LIQUID RUNWAY*: Your liquid funds (Rp 800,000) are below your projected routine expenses (Rp 2,250,000). Pause discretionary shopping.');
  });

  it('handles empty liquid accounts and no active budgets cleanly', () => {
    const emptyResult: FinancialHealthEvaluationResult = {
      ...baseResult,
      liquidAccounts: [],
      totalLiquidBalance: 0,
      activeBudgets: [],
      runway: {
        ...baseResult.runway,
        totalLiquidBalance: 0,
        runwayCoverageRatio: 0,
        isSufficient: false,
      },
    };

    const formattedId = formatFinancialHealthMessage(emptyResult, 'id');
    expect(formattedId).toContain('• Tidak ada saldo aktif');
    expect(formattedId).not.toContain('*4. Status Anggaran (Budgets)*');

    const formattedEn = formatFinancialHealthMessage(emptyResult, 'en');
    expect(formattedEn).toContain('• No active balances');
    expect(formattedEn).not.toContain('*4. Active Budgets*');
  });
});
