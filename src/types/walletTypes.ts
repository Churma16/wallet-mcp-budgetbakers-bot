export interface WalletAccountItem {
  id: string;
  name: string;
  currency?: string;
  balance?: number;
  accountType?: string;
}

export interface WalletCategoryItem {
  id: string;
  name: string;
  parentCategoryId?: string;
}

export interface CreateRecordInputPayload {
  accountId: string;
  categoryId?: string;
  amount: number;
  recordDate: string;
  note?: string;
  paymentType?: 'Cash' | 'DebitCard' | 'CreditCard' | 'Transfer' | 'Voucher' | 'MobilePayment' | 'WebPayment';
  counterParty?: string;
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
  currency?: string;
}
