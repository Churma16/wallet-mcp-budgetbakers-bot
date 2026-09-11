export interface WalletAccountItem {
  id: string;
  name: string;
  currency?: string;
  balance?: number;
  accountType?: string;
  bankAccountNumber?: string;
}

export interface WalletCategoryItem {
  id: string;
  name: string;
  parentCategoryId?: string;
}

export interface WalletLabelItem {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

export interface CreateRecordInputPayload {
  accountId: string;
  amount: number;
  recordDate: string;
  categoryId?: string;
  note?: string;
  counterParty?: string;
  labelIds?: string[];
  labels?: string[];
}

export interface WalletCreateRecordsResponse {
  summary?: {
    total: number;
    succeeded: number;
    failed: number;
  };
  results?: Array<{
    id?: string;
    success: boolean;
    error?: string;
  }>;
}

export interface WalletBudgetItem {
  id: string;
  name: string;
  spentAmount?: number;
  limitAmount?: number;
  remainingAmount?: number;
  currency?: string;
  isClosed?: boolean;
  period?: string;
  periodType?: string;
  isOverspent?: boolean;
}

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
  recordType?: TransactionRecordTypeFilter;
  startDate?: string;
  endDate?: string;
  dateRange?: string[] | TransactionDateRangeFilter;
  datePeriod?: RelativeDatePeriod;
  searchQuery?: string;
}

export interface TransactionHistoryQueryOptions extends TransactionHistoryFilters {
  limit?: number;
  offset?: number;
  page?: number;
  sort?: TransactionSortOrder;
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
  reason: 'NOT_FOUND' | 'INVALID_FORMAT' | 'INVALID_RANGE' | 'UNSUPPORTED' | 'UNRESOLVED' | 'AMBIGUOUS';
  message: string;
  candidates?: string[];
  subType?: 'bank_account' | 'name' | 'operator_prefix' | 'calendar_date' | 'start_after_end' | 'unsupported_upstream_search';
}

export interface WalletRecordItem {
  id: string;
  accountId: string;
  accountName?: string;
  amount: number;
  currency: string;
  recordDate: string;
  recordType: 'expense' | 'income';
  category?: {
    id: string;
    name: string;
    color?: string;
    group?: string;
  };
  note?: string;
  counterParty?: string;
  labels?: Array<{
    id: string;
    name: string;
    color?: string;
    icon?: string;
  }>;
  recordState?: string;
  transfer?: {
    type: string;
    transferId?: string;
    mirrorRecord?: unknown;
  } | null;
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
  sort: TransactionSortOrder;
  appliedFilters?: AppliedTransactionHistoryFilters;
  unresolvedFilters?: UnresolvedFilterIssue[];
}

