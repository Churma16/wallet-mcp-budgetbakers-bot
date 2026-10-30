import type { FilterErrorReasonValue } from './constants.js';
import type { WalletAccountItem, WalletCategoryItem, WalletRecordItem } from './types.js';

export type TransactionSortOrder = 'newest' | 'oldest';
export type TransactionRecordTypeFilter = 'expense' | 'income';

export interface TransactionDateRangeFilter {
  from?: string;
  to?: string;
}

export type RelativeDatePeriod =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_year';

export interface TransactionHistoryFilters {
  accountId?: string | string[];
  accountName?: string;
  categoryId?: string | string[];
  categoryName?: string;
  categoryGroup?: string;
  isGroupQuery?: boolean;
  recordType?: TransactionRecordTypeFilter;
  startDate?: string;
  endDate?: string;
  dateRange?: string[] | TransactionDateRangeFilter;
  datePeriod?: RelativeDatePeriod;
  searchQuery?: string;
  counterParty?: string;
  note?: string;
}

export interface TransactionHistoryQueryOptions extends TransactionHistoryFilters {
  limit?: number;
  offset?: number;
  page?: number;
  sort?: TransactionSortOrder;
  searchScanFallback?: boolean;
}

export interface AppliedTransactionHistoryFilters {
  account?: {
    id: string;
    name: string;
    selector?: string;
  };
  category?: {
    id: string;
    name: string;
    group?: string;
    selector?: string;
  };
  categoryGroup?: string;
  recordType?: TransactionRecordTypeFilter;
  dateRange?: {
    from?: string;
    to?: string;
    rawRange?: string[];
    label?: string;
    selector?: string;
  };
  searchQuery?: string;
  navigationTokens?: string[];
}

export interface UnresolvedFilterIssue {
  filterKey: 'account' | 'category' | 'recordType' | 'dateRange' | 'searchQuery';
  rawValue: string;
  reason: FilterErrorReasonValue;
  message: string;
  candidates?: string[];
  subType?:
    | 'bank_account'
    | 'name'
    | 'operator_prefix'
    | 'calendar_date'
    | 'start_after_end'
    | 'unsupported_upstream_search';
}

export interface TransactionHistoryPage {
  records: WalletRecordItem[];
  total?: number;
  limit: number;
  offset: number;
  page: number;
  totalPages?: number;
  nextOffset: number | null;
  hasMore: boolean;
  continuationUnknown?: boolean;
  sort: TransactionSortOrder;
  appliedFilters?: AppliedTransactionHistoryFilters;
  unresolvedFilters?: UnresolvedFilterIssue[];
}

export type TransactionSummaryGroupBy = 'none' | 'category' | 'account';

export interface TransactionSummaryQueryOptions extends TransactionHistoryFilters {
  groupBy?: TransactionSummaryGroupBy;
}

export interface TransactionCurrencyTotals {
  currency: string;
  income: number;
  expense: number;
  net: number;
  transactionCount: number;
}

export interface TransactionSummaryBreakdownItem {
  key: string;
  name?: string;
  transactionCount: number;
  totals: TransactionCurrencyTotals[];
}

export interface TransactionSummaryResult {
  transactionCount: number;
  excludedTransferCount: number;
  transferCountUnknown?: boolean;
  totals: TransactionCurrencyTotals[];
  breakdown: TransactionSummaryBreakdownItem[];
  groupBy: TransactionSummaryGroupBy;
  isMultiCurrency: boolean;
  isComplete: boolean;
  appliedFilters?: AppliedTransactionHistoryFilters;
  unresolvedFilters?: UnresolvedFilterIssue[];
}

export interface SummaryCache {
  getAccounts(): WalletAccountItem[];
  getCategories(): WalletCategoryItem[];
}

export interface SummaryHistoryProvider {
  getTransactionHistory(
    queryOptions?: any,
    referenceDate?: Date
  ): Promise<{ records: WalletRecordItem[]; nextOffset: number | null; hasMore: boolean }>;
}
