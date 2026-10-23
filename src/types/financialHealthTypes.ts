import { WalletCategoryItem } from './walletTypes.js';

export type ExpenseClassification = 'regular' | 'discretionary' | 'unknown';

export interface ClassificationCacheEntry {
  readonly categoryId: string;
  readonly classification: ExpenseClassification;
  readonly lastComputedAt: number;
}

export type ClassificationCacheMap = Map<string, ClassificationCacheEntry>;

export interface FinancialHealthConfigOverride {
  readonly overrideRegularCategoryIds?: string[];
  readonly overrideDiscretionaryCategoryIds?: string[];
  readonly overrideRegularCategoryNames?: string[];
  readonly overrideDiscretionaryCategoryNames?: string[];
  readonly recurringPayees?: string[];
}

export interface PeriodCashFlowMetrics {
  readonly income: number;
  readonly expense: number;
  readonly net: number;
  readonly regularExpense: number;
  readonly discretionaryExpense: number;
  readonly transactionCount: number;
}

export interface CashFlowPeriodComparison {
  readonly currentMonth: PeriodCashFlowMetrics;
  readonly previousMonth: PeriodCashFlowMetrics;
  readonly currency: string;
}

export interface CategoryExpenseBreakdownItem {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly amount: number;
  readonly transactionCount: number;
  readonly classification: ExpenseClassification;
}

export interface FinancialHealthRunwayProjection {
  readonly totalLiquidBalance: number;
  readonly daysElapsedInMonth: number;
  readonly daysRemainingInMonth: number;
  readonly dailyRegularBurnRate: number;
  readonly projectedRemainingRegularExpense: number;
  readonly projectedNetSavingsEndOfMonth: number;
  readonly runwayCoverageRatio: number;
  readonly isSufficient: boolean;
}

export interface FinancialHealthLiquidAccountItem {
  readonly id: string;
  readonly name: string;
  readonly balance: number;
  readonly currency: string;
}

export interface FinancialHealthBudgetItem {
  readonly id: string;
  readonly name: string;
  readonly spentAmount: number;
  readonly limitAmount: number;
  readonly remainingAmount: number;
  readonly currency: string;
  readonly isOverspent: boolean;
}

export interface FinancialHealthEvaluationResult {
  readonly cashFlow: CashFlowPeriodComparison;
  readonly liquidAccounts: FinancialHealthLiquidAccountItem[];
  readonly totalLiquidBalance: number;
  readonly activeBudgets: FinancialHealthBudgetItem[];
  readonly topPurchases: CategoryExpenseBreakdownItem[];
  readonly topRegularExpenses: CategoryExpenseBreakdownItem[];
  readonly runway: FinancialHealthRunwayProjection;
  readonly referenceDate: Date;
}
