import { WalletMcpClientService } from '../../src/services/walletMcpService.js';
import { WalletCacheService } from '../../src/services/walletCacheService.js';
import { TransactionHistoryService } from '../../src/services/transactionHistoryService.js';
import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../../src/types/walletTypes.js';

export const CANONICAL_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA Tabungan', currency: 'IDR', bankAccountNumber: '1234567890' },
  { id: 'acc-mandiri', name: 'Mandiri Utama', currency: 'IDR', bankAccountNumber: '9876543210' },
  { id: 'acc-cash', name: 'Cash Dompet', currency: 'IDR' },
  { id: 'acc-jago', name: 'Bank Jago', currency: 'IDR', bankAccountNumber: '55551234' },
];

export const CANONICAL_FILTER_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca-001', name: 'BCA Tabungan', currency: 'IDR', bankAccountNumber: '1234567890' },
  { id: 'acc-mandiri-002', name: 'Mandiri Utama', currency: 'IDR', bankAccountNumber: '9876543210' },
  { id: 'acc-cash-003', name: 'Cash Dompet', currency: 'IDR' },
  { id: 'acc-jago-004', name: 'Bank Jago', currency: 'IDR', bankAccountNumber: '55551234' },
];

export const CANONICAL_CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
  { id: 'cat-transport', name: 'Transportasi', group: { id: 'transportation', name: 'Transportation' } },
  { id: 'cat-salary', name: 'Gaji', group: { id: 'income', name: 'Income' } },
  { id: 'cat-bills', name: 'Tagihan Listrik', group: { id: 'bills', name: 'Bills' } },
];

export const CANONICAL_FILTER_CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food-001', name: 'Makanan & Minuman' },
  { id: 'cat-transport-002', name: 'Transportasi' },
  { id: 'cat-salary-003', name: 'Gaji' },
  { id: 'cat-bills-004', name: 'Tagihan Listrik' },
];

export const CANONICAL_REFERENCE_DATE = new Date('2026-09-11T12:00:00.000Z');

export const CANONICAL_RECORDS: WalletRecordItem[] = [
  {
    id: 'rec-1',
    accountId: 'acc-bca',
    accountName: 'BCA Tabungan',
    amount: -45000,
    currency: 'IDR',
    recordDate: '2026-09-11T10:00:00.000Z',
    recordType: 'expense',
    categoryId: 'cat-food',
    category: { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
    counterParty: 'Starbucks Reserve',
    note: 'Caramel Macchiato',
  },
  {
    id: 'rec-2',
    accountId: 'acc-cash',
    accountName: 'Cash Dompet',
    amount: -15000,
    currency: 'IDR',
    recordDate: '2026-09-11T11:00:00.000Z',
    recordType: 'expense',
    categoryId: 'cat-food',
    category: { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
    counterParty: 'Indomaret Point',
    note: 'Kopi dan snack',
  },
  {
    id: 'rec-3',
    accountId: 'acc-bca',
    accountName: 'BCA Tabungan',
    amount: -30000,
    currency: 'IDR',
    recordDate: '2026-09-11T12:00:00.000Z',
    recordType: 'expense',
    categoryId: 'cat-food',
    category: { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
    counterParty: 'Warung Padang Sederhana',
    note: 'Beli nasi padang rendang',
  },
  {
    id: 'rec-4',
    accountId: 'acc-bca',
    accountName: 'BCA Tabungan',
    amount: 1000000,
    currency: 'IDR',
    recordDate: '2026-09-11T13:00:00.000Z',
    recordType: 'income',
    categoryId: 'cat-salary',
    category: { id: 'cat-salary', name: 'Gaji', group: { id: 'income', name: 'Income' } },
    counterParty: 'PT Teknologi Digital',
    note: 'Bonus freelance dan gaji',
  },
  {
    id: 'rec-5',
    accountId: 'acc-bca',
    accountName: 'BCA Tabungan',
    amount: -25000,
    currency: 'IDR',
    recordDate: '2026-09-11T08:00:00.000Z',
    recordType: 'expense',
    categoryId: 'cat-transport',
    category: { id: 'cat-transport', name: 'Transportasi', group: { id: 'transportation', name: 'Transportation' } },
    counterParty: 'GoRide',
    note: 'Transport kantor Stasiun Gambir',
  },
];

export function getCanonicalTransactions(): WalletRecordItem[] {
  return structuredClone(CANONICAL_RECORDS);
}

export function getCanonicalAccounts(): WalletAccountItem[] {
  return structuredClone(CANONICAL_ACCOUNTS);
}

export function getCanonicalCategories(): WalletCategoryItem[] {
  return structuredClone(CANONICAL_CATEGORIES);
}

export interface QueryExecutionContext {
  client: WalletMcpClientService;
  cache: WalletCacheService;
  service: TransactionHistoryService;
  capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }>;
  setNextResponse: (response: any) => void;
  setError: (error: Error) => void;
  records: WalletRecordItem[];
}

export function createQueryExecutionContext(options: {
  records?: WalletRecordItem[];
  accounts?: WalletAccountItem[];
  categories?: WalletCategoryItem[];
  mockHandler?: (toolName: string, args: Record<string, unknown>) => Promise<any>;
} = {}): QueryExecutionContext {
  const records = options.records ? structuredClone(options.records) : getCanonicalTransactions();
  const accounts = options.accounts ? structuredClone(options.accounts) : getCanonicalAccounts();
  const categories = options.categories ? structuredClone(options.categories) : getCanonicalCategories();

  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let explicitResponse: any = null;
  let nextError: Error | null = null;

  client.callMcpTool = async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    capturedCalls.push({ toolName, args });
    if (nextError) {
      const errorToThrow = nextError;
      nextError = null;
      throw errorToThrow;
    }
    if (options.mockHandler) {
      return (await options.mockHandler(toolName, args)) as T;
    }
    if (explicitResponse !== null) {
      return explicitResponse as T;
    }
    return {
      records: structuredClone(records),
      total: records.length,
    } as T;
  };

  const cache = new WalletCacheService(client);
  (cache as any).cachedAccountList = [...accounts];
  (cache as any).cachedCategoryList = [...categories];
  (cache as any).cachedLabelList = [];

  const service = new TransactionHistoryService(client, cache);

  return {
    client,
    cache,
    service,
    capturedCalls,
    setNextResponse: (response: any) => {
      explicitResponse = response;
      nextError = null;
    },
    setError: (error: Error) => {
      nextError = error;
    },
    records,
  };
}
