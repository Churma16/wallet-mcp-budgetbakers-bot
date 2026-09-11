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

export interface TransactionHistoryQueryOptions {
  limit?: number;
  offset?: number;
  page?: number;
  sort?: TransactionSortOrder;
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
}

