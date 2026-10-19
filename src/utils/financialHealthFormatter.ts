import { FinancialHealthEvaluationResult } from '../types/financialHealthTypes.js';
import { getActiveLanguage, SupportedLanguage } from '../i18n/index.js';
import { formatCurrencyAmount } from './humanResponseFormatter.js';

export function formatFinancialHealthMessage(
  result: FinancialHealthEvaluationResult,
  languageCode?: SupportedLanguage
): string {
  const activeLanguage = languageCode || getActiveLanguage();
  const isId = activeLanguage === 'id';
  const currency = result.cashFlow.currency || 'IDR';

  const formatMoney = (amount: number): string =>
    formatCurrencyAmount(amount, currency, activeLanguage);

  const formatSignedMoney = (amount: number): string => {
    const formatted = formatMoney(Math.abs(amount));
    if (amount > 0) return `+${formatted}`;
    if (amount < 0) return `-${formatted}`;
    return formatted;
  };

  const current = result.cashFlow.currentMonth;
  const previous = result.cashFlow.previousMonth;
  const currentExpenseTotal = Math.max(1, current.expense);

  const regularPct = Math.round((current.regularExpense / currentExpenseTotal) * 100);
  const discretionaryPct = Math.max(0, 100 - regularPct);

  const lines: string[] = [];

  // Header
  lines.push(
    isId
      ? '📊 *Laporan Kesehatan Keuangan & Runway*'
      : '📊 *Financial Health & Runway Report*'
  );
  lines.push('');

  // 1. Cash Flow
  lines.push(isId ? '*1. Arus Kas (Cash Flow)*' : '*1. Cash Flow Overview*');
  lines.push(
    isId
      ? `• Bulan Ini (MTD): Masuk ${formatMoney(current.income)}, Keluar ${formatMoney(current.expense)} (Net: ${formatSignedMoney(current.net)})`
      : `• This Month (MTD): Income ${formatMoney(current.income)}, Expense ${formatMoney(current.expense)} (Net: ${formatSignedMoney(current.net)})`
  );
  lines.push(
    isId
      ? `• Bulan Lalu: Masuk ${formatMoney(previous.income)}, Keluar ${formatMoney(previous.expense)} (Net: ${formatSignedMoney(previous.net)})`
      : `• Last Month: Income ${formatMoney(previous.income)}, Expense ${formatMoney(previous.expense)} (Net: ${formatSignedMoney(previous.net)})`
  );
  lines.push('');

  // 2. Spending Breakdown
  lines.push(isId ? '*2. Rincian Pengeluaran Bulan Ini*' : '*2. Spending Breakdown (This Month)*');
  lines.push(
    isId
      ? `• 🛒 *Purchases (Belanja Diskresioner)*: ${formatMoney(current.discretionaryExpense)} (${discretionaryPct}%)`
      : `• 🛒 *Discretionary Purchases*: ${formatMoney(current.discretionaryExpense)} (${discretionaryPct}%)`
  );
  if (result.topPurchases.length > 0) {
    const topStr = result.topPurchases.slice(0, 3).map(p => `${p.categoryName} (${formatMoney(p.amount)})`).join(', ');
    lines.push(`   Top: ${topStr}`);
  }

  lines.push(
    isId
      ? `• 🔄 *Regular Purchases (Kebutuhan Rutin)*: ${formatMoney(current.regularExpense)} (${regularPct}%)`
      : `• 🔄 *Regular Routine Living*: ${formatMoney(current.regularExpense)} (${regularPct}%)`
  );
  if (result.topRegularExpenses.length > 0) {
    const topStr = result.topRegularExpenses.slice(0, 3).map(p => `${p.categoryName} (${formatMoney(p.amount)})`).join(', ');
    lines.push(`   Top: ${topStr}`);
  }
  lines.push('');

  // 3. Liquid Balances
  lines.push(isId ? '*3. Saldo Likuid Akun*' : '*3. Real-Time Liquid Balances*');
  if (result.liquidAccounts.length === 0) {
    lines.push(isId ? '• Tidak ada saldo aktif' : '• No active balances');
  } else {
    for (const acc of result.liquidAccounts) {
      lines.push(`• ${acc.name}: ${formatMoney(acc.balance)}`);
    }
  }
  lines.push(
    isId
      ? `*Total Saldo Likuid*: ${formatMoney(result.totalLiquidBalance)}`
      : `*Total Liquid Funds*: ${formatMoney(result.totalLiquidBalance)}`
  );
  lines.push('');

  // 4. Budgets
  if (result.activeBudgets.length > 0) {
    lines.push(isId ? '*4. Status Anggaran (Budgets)*' : '*4. Active Budgets*');
    for (const b of result.activeBudgets) {
      if (b.isOverspent) {
        lines.push(
          isId
            ? `• ⚠️ ${b.name}: Terpakai ${formatMoney(b.spentAmount)} / ${formatMoney(b.limitAmount)} (Overspent: ${formatMoney(Math.abs(b.remainingAmount))})`
            : `• ⚠️ ${b.name}: Spent ${formatMoney(b.spentAmount)} / ${formatMoney(b.limitAmount)} (Overspent: ${formatMoney(Math.abs(b.remainingAmount))})`
        );
      } else {
        lines.push(
          isId
            ? `• ✅ ${b.name}: Terpakai ${formatMoney(b.spentAmount)} / ${formatMoney(b.limitAmount)} (Sisa: ${formatMoney(b.remainingAmount)})`
            : `• ✅ ${b.name}: Spent ${formatMoney(b.spentAmount)} / ${formatMoney(b.limitAmount)} (Remaining: ${formatMoney(b.remainingAmount)})`
        );
      }
    }
    lines.push('');
  }

  // 5. Runway & Verdict
  const r = result.runway;
  lines.push(isId ? '*5. Evaluasi Runway & Keputusan*' : '*5. Runway & Affordability Verdict*');
  lines.push(
    isId
      ? `• Sisa hari bulan ini: ${r.daysRemainingInMonth} hari`
      : `• Days remaining in month: ${r.daysRemainingInMonth} days`
  );
  lines.push(
    isId
      ? `• Rata-rata rutin harian: ${formatMoney(r.dailyRegularBurnRate)}/hari`
      : `• Daily routine burn rate: ${formatMoney(r.dailyRegularBurnRate)}/day`
  );
  lines.push(
    isId
      ? `• Estimasi sisa kebutuhan rutin: ${formatMoney(r.projectedRemainingRegularExpense)}`
      : `• Projected remaining routine expenses: ${formatMoney(r.projectedRemainingRegularExpense)}`
  );
  lines.push(
    isId
      ? `• Proyeksi sisa tabungan akhir bulan: ${formatSignedMoney(r.projectedNetSavingsEndOfMonth)}`
      : `• Projected net savings at month-end: ${formatSignedMoney(r.projectedNetSavingsEndOfMonth)}`
  );
  lines.push('');

  if (r.isSufficient) {
    lines.push(
      isId
        ? `✅ *DANA SANGAT CUKUP*: Saldo likuid Anda (${formatMoney(r.totalLiquidBalance)}) menutup ${r.runwayCoverageRatio}x estimasi sisa kebutuhan rutin sampai akhir bulan.`
        : `✅ *SUFFICIENT LIQUID RUNWAY*: Your liquid funds (${formatMoney(r.totalLiquidBalance)}) cover ${r.runwayCoverageRatio}x of your projected routine expenses until month-end.`
    );
  } else {
    lines.push(
      isId
        ? `⚠️ *DANA KETAT / PERLU DIREM*: Saldo likuid Anda (${formatMoney(r.totalLiquidBalance)}) lebih rendah dari proyeksi kebutuhan rutin (${formatMoney(r.projectedRemainingRegularExpense)}). Tahan belanja diskresioner.`
        : `⚠️ *TIGHT LIQUID RUNWAY*: Your liquid funds (${formatMoney(r.totalLiquidBalance)}) are below your projected routine expenses (${formatMoney(r.projectedRemainingRegularExpense)}). Pause discretionary shopping.`
    );
  }

  return lines.join('\n');
}
