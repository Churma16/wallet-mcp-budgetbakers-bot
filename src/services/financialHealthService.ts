import { WalletMcpClientService } from './walletMcpService.js';
import { WalletCacheService } from './walletCacheService.js';
import { CategoryContextService } from './categoryContextService.js';
import { TransactionHistoryService } from './transactionHistoryService.js';
import { TransactionSummaryService } from './transactionSummaryService.js';
import {
  WalletAccountItem,
  WalletBudgetItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../types/walletTypes.js';
import {
  CategoryExpenseBreakdownItem,
  ClassificationCacheEntry,
  ClassificationCacheMap,
  ExpenseClassification,
  FinancialHealthBudgetItem,
  FinancialHealthConfigOverride,
  FinancialHealthEvaluationResult,
  FinancialHealthLiquidAccountItem,
  PeriodCashFlowMetrics,
} from '../types/financialHealthTypes.js';
import { applicationLogger } from '../utils/logger.js';

export const CLASSIFICATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const DEFAULT_REGULAR_CATEGORY_GROUPS = new Set<string>([
  'food_and_drinks',
  'food & drinks',
  'food and drinks',
  'transportation',
  'financial_expenses',
  'financial expenses',
  'housing',
  'communication_pc',
  'communication & pc',
  'communication and pc',
  'vehicle',
]);

export const DEFAULT_DISCRETIONARY_CATEGORY_GROUPS = new Set<string>([
  'shopping',
  'life_entertainment',
  'life & entertainment',
  'life and entertainment',
  'investments',
]);

export class FinancialHealthService {
  private readonly classificationCache: ClassificationCacheMap = new Map();
  private isWarmingUp: boolean = false;
  private warmUpPromise: Promise<void> | null = null;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly transactionHistoryService: TransactionHistoryService,
    private readonly transactionSummaryService?: TransactionSummaryService,
    private readonly categoryContextService?: CategoryContextService
  ) {}

  /**
   * Returns current size of classification cache (useful for testing and diagnostics)
   */
  public getCacheSize(): number {
    return this.classificationCache.size;
  }

  /**
   * Directly set or seed a cache entry (useful for hermetic tests)
   */
  public setCacheEntry(categoryId: string, classification: ExpenseClassification, timestamp: number = Date.now()): void {
    this.classificationCache.set(categoryId, {
      categoryId,
      classification,
      lastComputedAt: timestamp,
    });
  }

  /**
   * Clear all cache entries
   */
  public clearCache(): void {
    this.classificationCache.clear();
  }

  /**
   * Eagerly warms up Layer 3 category heuristics from historical records in the background.
   */
  public async warmUpCache(referenceDate: Date = new Date()): Promise<void> {
    if (this.isWarmingUp && this.warmUpPromise) {
      return this.warmUpPromise;
    }

    this.isWarmingUp = true;
    this.warmUpPromise = (async () => {
      try {
        applicationLogger.info('[INFO] Starting eager warm-up for Financial Health category heuristics...');

        // Query historical transactions for last month to determine frequency patterns
        const historyPage = await this.transactionHistoryService.getTransactionHistory(
          { datePeriod: 'last_month', limit: 50 },
          referenceDate
        );

        const categoryCounts = new Map<string, number>();
        const categoryPayees = new Map<string, Set<string>>();

        for (const record of historyPage.records) {
          if (record.recordType !== 'expense') continue;
          const catId = record.category?.id;
          if (!catId) continue;

          categoryCounts.set(catId, (categoryCounts.get(catId) || 0) + 1);

          if (record.counterParty) {
            const payeeSet = categoryPayees.get(catId) || new Set<string>();
            payeeSet.add(record.counterParty.trim().toLowerCase());
            categoryPayees.set(catId, payeeSet);
          }
        }

        const now = Date.now();
        let populatedCount = 0;

        for (const [catId, count] of categoryCounts.entries()) {
          // If already classified by higher layer, keep, else evaluate frequency
          if (!this.classificationCache.has(catId)) {
            // Frequency >= 4 times per month indicates a routine living expense
            const classification: ExpenseClassification = count >= 4 ? 'regular' : 'discretionary';
            this.classificationCache.set(catId, {
              categoryId: catId,
              classification,
              lastComputedAt: now,
            });
            populatedCount += 1;
          }
        }

        applicationLogger.info(
          `[INFO] Financial Health category heuristics warmed up with ${populatedCount} category classification(s).`
        );
      } catch (warmUpError) {
        applicationLogger.warn(
          `[WARN] Financial Health warmUpCache encountered error: ${
            warmUpError instanceof Error ? warmUpError.message : String(warmUpError)
          }. Falling back gracefully to Layers 1 and 2.`
        );
      } finally {
        this.isWarmingUp = false;
        this.warmUpPromise = null;
      }
    })();

    return this.warmUpPromise;
  }

  /**
   * 3-Layer Hybrid Category Classifier:
   * 1. Explicit Config Override (category-context.json)
   * 2. BudgetBakers Authoritative Native Category Group
   * 3. Rolling Historical Pattern Heuristics (with 24h TTL cache)
   */
  public classifyCategory(
    categoryItem?:
      | WalletCategoryItem
      | {
          id?: string;
          name?: string;
          color?: string;
          group?: string | { id?: string; name?: string };
        },
    counterParty?: string
  ): ExpenseClassification {
    const configOverride = this.categoryContextService?.getConfiguration()?.financialHealth;
    const normalizedPayee = counterParty?.trim().toLowerCase();

    // --- Layer 1: Explicit Config Override ---
    if (configOverride) {
      if (categoryItem?.id) {
        if (configOverride.overrideRegularCategoryIds?.includes(categoryItem.id)) {
          return 'regular';
        }
        if (configOverride.overrideDiscretionaryCategoryIds?.includes(categoryItem.id)) {
          return 'discretionary';
        }
      }

      if (categoryItem?.name) {
        const catNameLower = categoryItem.name.trim().toLowerCase();
        if (
          configOverride.overrideRegularCategoryNames?.some(
            name => name.trim().toLowerCase() === catNameLower
          )
        ) {
          return 'regular';
        }
        if (
          configOverride.overrideDiscretionaryCategoryNames?.some(
            name => name.trim().toLowerCase() === catNameLower
          )
        ) {
          return 'discretionary';
        }
      }

      if (normalizedPayee && configOverride.recurringPayees) {
        if (
          configOverride.recurringPayees.some(payee =>
            normalizedPayee.includes(payee.trim().toLowerCase())
          )
        ) {
          return 'regular';
        }
      }
    }

    // --- Layer 2: Native Category Group Mapping ---
    const groupCandidateIds: string[] = [];
    if (typeof categoryItem?.group === 'string') {
      groupCandidateIds.push(categoryItem.group.trim().toLowerCase());
    } else if (categoryItem?.group && typeof categoryItem.group === 'object') {
      if (categoryItem.group.id) {
        groupCandidateIds.push(categoryItem.group.id.trim().toLowerCase());
      }
      if (categoryItem.group.name) {
        groupCandidateIds.push(categoryItem.group.name.trim().toLowerCase());
      }
    }

    for (const groupVal of groupCandidateIds) {
      if (DEFAULT_REGULAR_CATEGORY_GROUPS.has(groupVal)) {
        return 'regular';
      }
      if (DEFAULT_DISCRETIONARY_CATEGORY_GROUPS.has(groupVal)) {
        return 'discretionary';
      }
    }

    // Secondary fallback for standard known category names
    if (categoryItem?.name) {
      const nameLower = categoryItem.name.trim().toLowerCase();
      if (
        nameLower.includes('ojol') ||
        nameLower.includes('transport') ||
        nameLower.includes('taxi') ||
        nameLower.includes('commute') ||
        nameLower.includes('makan') ||
        nameLower.includes('food') ||
        nameLower.includes('groceries') ||
        nameLower.includes('pulsa') ||
        nameLower.includes('internet')
      ) {
        return 'regular';
      }
      if (
        nameLower.includes('shop') ||
        nameLower.includes('cloth') ||
        nameLower.includes('gadget') ||
        nameLower.includes('gift')
      ) {
        return 'discretionary';
      }
    }

    // --- Layer 3: Historical Heuristic Cache ---
    if (categoryItem?.id) {
      const cached = this.classificationCache.get(categoryItem.id);
      if (cached && Date.now() - cached.lastComputedAt < CLASSIFICATION_CACHE_TTL_MS) {
        return cached.classification;
      }
    }

    // Default fallback if unmapped
    return 'discretionary';
  }

  /**
   * Fetches all records for a relative date period handling pagination.
   */
  private async fetchAllRecordsForPeriod(
    period: 'this_month' | 'last_month',
    referenceDate: Date
  ): Promise<WalletRecordItem[]> {
    const records: WalletRecordItem[] = [];
    let page = 1;
    const pageSize = 50;
    const maxPages = 5;

    while (page <= maxPages) {
      const res = await this.transactionHistoryService.getTransactionHistory(
        { datePeriod: period, limit: pageSize, page },
        referenceDate
      );
      records.push(...res.records);
      if ((res.total !== undefined && records.length >= res.total) || res.records.length === 0) {
        break;
      }
      page += 1;
    }

    return records;
  }

  /**
   * Performs the comprehensive Financial Health & Affordability Evaluation.
   */
  public async evaluateFinancialHealth(
    referenceDate: Date = new Date()
  ): Promise<FinancialHealthEvaluationResult> {
    applicationLogger.info('[INFO] Evaluating Financial Health and Runway...');

    // 1. Fetch Accounts & Liquid Balances
    const accounts = await this.walletCacheService.refreshAccounts().catch(() => this.walletCacheService.getAccounts());
    const liquidAccounts: FinancialHealthLiquidAccountItem[] = [];
    let totalLiquidBalance = 0;

    for (const account of accounts) {
      const bal = account.balance || 0;
      const cur = account.currency || 'IDR';
      // Include non-negative liquid accounts
      if (bal > 0) {
        liquidAccounts.push({
          id: account.id,
          name: account.name,
          balance: bal,
          currency: cur,
        });
        totalLiquidBalance += bal;
      }
    }

    // 2. Fetch Active Budgets
    const budgets = await this.walletMcpClient.fetchBudgets(true).catch(() => [] as WalletBudgetItem[]);
    const activeBudgets: FinancialHealthBudgetItem[] = budgets.map(b => {
      const spent = b.spentAmount || 0;
      const limit = b.limitAmount || 0;
      const remaining = b.remainingAmount ?? (limit - spent);
      return {
        id: b.id,
        name: b.name,
        spentAmount: spent,
        limitAmount: limit,
        remainingAmount: remaining,
        currency: b.currency || 'IDR',
        isOverspent: remaining < 0 || (b.isOverspent ?? false),
      };
    });

    // 3. Fetch Records for This Month and Last Month
    const [currentRecords, previousRecords] = await Promise.all([
      this.fetchAllRecordsForPeriod('this_month', referenceDate),
      this.fetchAllRecordsForPeriod('last_month', referenceDate),
    ]);

    // 4. Aggregate Cash Flow and Classify
    const categoryTotals = new Map<
      string,
      {
        id: string;
        name: string;
        amount: number;
        count: number;
        classification: ExpenseClassification;
      }
    >();

    let currentIncome = 0;
    let currentExpense = 0;
    let currentRegular = 0;
    let currentDiscretionary = 0;

    for (const record of currentRecords) {
      const amt = Math.abs(record.amount);
      if (record.recordType === 'income') {
        currentIncome += amt;
      } else if (record.recordType === 'expense') {
        currentExpense += amt;
        const classification = this.classifyCategory(record.category, record.counterParty);

        if (classification === 'regular') {
          currentRegular += amt;
        } else {
          currentDiscretionary += amt;
        }

        const catId = record.category?.id || 'uncategorized';
        const catName = record.category?.name || 'Uncategorized';
        const existing = categoryTotals.get(catId);
        if (!existing) {
          categoryTotals.set(catId, {
            id: catId,
            name: catName,
            amount: amt,
            count: 1,
            classification,
          });
        } else {
          existing.amount += amt;
          existing.count += 1;
        }
      }
    }

    let prevIncome = 0;
    let prevExpense = 0;
    let prevRegular = 0;
    let prevDiscretionary = 0;

    for (const record of previousRecords) {
      const amt = Math.abs(record.amount);
      if (record.recordType === 'income') {
        prevIncome += amt;
      } else if (record.recordType === 'expense') {
        prevExpense += amt;
        const classification = this.classifyCategory(record.category, record.counterParty);
        if (classification === 'regular') {
          prevRegular += amt;
        } else {
          prevDiscretionary += amt;
        }
      }
    }

    const currentMonthMetrics: PeriodCashFlowMetrics = {
      income: currentIncome,
      expense: currentExpense,
      net: currentIncome - currentExpense,
      regularExpense: currentRegular,
      discretionaryExpense: currentDiscretionary,
      transactionCount: currentRecords.length,
    };

    const previousMonthMetrics: PeriodCashFlowMetrics = {
      income: prevIncome,
      expense: prevExpense,
      net: prevIncome - prevExpense,
      regularExpense: prevRegular,
      discretionaryExpense: prevDiscretionary,
      transactionCount: previousRecords.length,
    };

    // 5. Segment Top Categories
    const allCategoryBreakdowns: CategoryExpenseBreakdownItem[] = [...categoryTotals.values()].map(c => ({
      categoryId: c.id,
      categoryName: c.name,
      amount: c.amount,
      transactionCount: c.count,
      classification: c.classification,
    }));

    const topPurchases = allCategoryBreakdowns
      .filter(item => item.classification === 'discretionary')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    const topRegularExpenses = allCategoryBreakdowns
      .filter(item => item.classification === 'regular')
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5);

    // 6. Calculate Runway & Projection
    const year = referenceDate.getFullYear();
    const month = referenceDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const currentDay = referenceDate.getDate();
    const daysElapsed = Math.max(1, currentDay);
    const daysRemaining = Math.max(0, daysInMonth - currentDay);

    const dailyRegularBurnRate = Math.round(currentRegular / daysElapsed);
    const projectedRemainingRegularExpense = Math.round(dailyRegularBurnRate * daysRemaining);
    const projectedNetSavingsEndOfMonth = currentIncome - (currentExpense + projectedRemainingRegularExpense);
    const runwayCoverageRatio =
      projectedRemainingRegularExpense > 0
        ? Number((totalLiquidBalance / projectedRemainingRegularExpense).toFixed(2))
        : 99.0;
    const isSufficient = totalLiquidBalance >= projectedRemainingRegularExpense;

    const runway = {
      totalLiquidBalance,
      daysElapsedInMonth: daysElapsed,
      daysRemainingInMonth: daysRemaining,
      dailyRegularBurnRate,
      projectedRemainingRegularExpense,
      projectedNetSavingsEndOfMonth,
      runwayCoverageRatio,
      isSufficient,
    };

    return {
      cashFlow: {
        currentMonth: currentMonthMetrics,
        previousMonth: previousMonthMetrics,
        currency: 'IDR',
      },
      liquidAccounts,
      totalLiquidBalance,
      activeBudgets,
      topPurchases,
      topRegularExpenses,
      runway,
      referenceDate,
    };
  }
}
