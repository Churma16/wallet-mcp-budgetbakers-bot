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
  parentCategoryName?: string;
  group?: {
    id: string;
    name: string;
  };
  systemId?: string;
  cardinality?: string;
  customCategory?: boolean;
  archived?: boolean;
  enabled?: boolean;
  isAssignable?: boolean;
}

export interface WalletTransferInput {
  pairingMode: 'new' | 'existing' | 'unpaired';
  accountId?: string;
  accountHint?: string;
  recordId?: string;
  counterAmount?: {
    value: number;
    currencyCode: string;
  };
}

export interface WalletLabelItem {
  id: string;
  name: string;
  color?: string;
  icon?: string;
}

export interface CreateRecordInputPayload {
  accountId: string;
  accountHint?: string;
  amount: number;
  recordDate?: string;
  categoryId?: string;
  categoryHint?: string;
  note?: string;
  counterParty?: string;
  labelIds?: string[];
  labels?: string[];
  currency?: string;
  transfer?: WalletTransferInput;
}

export interface WalletAgentHint {
  type: string;
  severity?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface WalletCreateRecordsResponse {
  summary?: {
    total: number;
    succeeded: number;
    failed?: number;
    clientErrors?: number;
    serverErrors?: number;
    documentsWritten?: number;
  };
  agentHints?: WalletAgentHint[];
  results?: Array<{
    id?: string;
    inputIndex?: number;
    success: boolean;
    error?: string;
    errorType?: string;
    fields?: string[];
    pairingMode?: string;
    createdMirrorRecordId?: string;
    isMirror?: boolean;
    resultType?: 'root' | 'mirror';
    mirrorOfRecordId?: string;
    record?: Record<string, unknown>;
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
  counterParty?: string;
  note?: string;
}

export interface TransactionHistoryQueryOptions extends TransactionHistoryFilters {
  limit?: number;
  offset?: number;
  page?: number;
  sort?: TransactionSortOrder;
  /**
   * Compatibility flag for multi-field searchQuery.
   * Based on the live upstream capability audit (Issue #162), Wallet MCP get_records
   * has no cross-field query parameter (only separate counterParty and note filters).
   * Defaults to true (executing the bounded local scan-and-match compatibility shim).
   * Set to false to force dispatching raw `query` to upstream for forward-compatible / mock testing.
   */
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

export interface WalletRecordAggregationQueryPayload {
  groupBy?: string[];
  compute?: string[];
  sortBy?: string[];
  accountId?: string | string[];
  recordDate?: string[];
  categoryId?: string[];
  categoryGroup?: string;
  labelId?: string;
  recordType?: TransactionRecordTypeFilter;
  source?: string[];
  recordState?: string[];
  isTransfer?: boolean;
  amount?: string[];
  note?: string;
  counterParty?: string;
  limit?: number;
  offset?: number;
}

export interface WalletRecordAggregationResultItem {
  currency?: string;
  recordType?: TransactionRecordTypeFilter;
  count: number;
  'amount:sum'?: number;
  'amount:absSum'?: number;
  'category:id'?: string;
  'category:name'?: string;
  'category:parentId'?: string | null;
  'category:customCategory'?: boolean;
  accountId?: string;
  [key: string]: unknown;
}

export interface WalletRecordAggregationResponse {
  results: WalletRecordAggregationResultItem[];
  isTransfer?: boolean | null;
  baseCurrency?: string;
  limit: number;
  offset: number;
  agentHints?: WalletAgentHint[];
  _meta?: {
    rateLimit?: {
      capacity?: number;
      remaining?: number;
      refillPerMinute?: number;
      resetAt?: string;
    };
    syncedAt?: string;
    lastResourceChange?: unknown;
  };
}

