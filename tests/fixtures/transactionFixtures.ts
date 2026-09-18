import { vi } from 'vitest';
import { WalletMcpClientService } from '../../src/services/walletMcpService.js';
import { WalletCacheService } from '../../src/services/walletCacheService.js';
import { TransactionHistoryService } from '../../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../../src/services/transactionSummaryService.js';
import type {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
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

export const CANONICAL_SUMMARY_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
  { id: 'acc-usd', name: 'USD Wallet', currency: 'USD' },
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

export const CANONICAL_SUMMARY_CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food', group: { id: 'food', name: 'Food' } },
  { id: 'cat-transport', name: 'Transport', group: { id: 'transport', name: 'Transport' } },
  { id: 'cat-salary', name: 'Salary', group: { id: 'income', name: 'Income' } },
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
    recordDate: '2026-09-10T11:00:00.000Z',
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
    recordDate: '2026-09-05T12:00:00.000Z',
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
    recordDate: '2026-09-01T13:00:00.000Z',
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
    recordDate: '2026-08-25T08:00:00.000Z',
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

export function filterCanonicalRecords(
  allRecords: WalletRecordItem[],
  queryArguments: Record<string, unknown> = {}
): { records: WalletRecordItem[]; total: number } {
  let filteredRecordList = [...allRecords];

  if (queryArguments.accountId) {
    const rawAccountIds = Array.isArray(queryArguments.accountId)
      ? queryArguments.accountId
      : typeof queryArguments.accountId === 'string'
        ? queryArguments.accountId.split(',')
        : [];
    const targetAccountIds = rawAccountIds.map(accountId => String(accountId).trim()).filter(Boolean);
    if (targetAccountIds.length > 0) {
      filteredRecordList = filteredRecordList.filter(record => targetAccountIds.includes(record.accountId));
    }
  }

  if (queryArguments.categoryId) {
    const rawCategoryIds = Array.isArray(queryArguments.categoryId)
      ? queryArguments.categoryId
      : typeof queryArguments.categoryId === 'string'
        ? queryArguments.categoryId.split(',')
        : [];
    const targetCategoryIds = rawCategoryIds.map(categoryId => String(categoryId).trim()).filter(Boolean);
    if (targetCategoryIds.length > 0) {
      filteredRecordList = filteredRecordList.filter(record => {
        const recordCategoryId = record.categoryId || record.category?.id;
        return recordCategoryId ? targetCategoryIds.includes(recordCategoryId) : false;
      });
    }
  }

  if (queryArguments.categoryGroup && typeof queryArguments.categoryGroup === 'string') {
    const targetGroup = queryArguments.categoryGroup.trim().toLowerCase();
    filteredRecordList = filteredRecordList.filter(record => {
      const recordGroupId = record.category?.group?.id?.toLowerCase();
      const recordGroupName = record.category?.group?.name?.toLowerCase();
      return recordGroupId === targetGroup || recordGroupName === targetGroup;
    });
  }

  if (queryArguments.recordType && typeof queryArguments.recordType === 'string') {
    filteredRecordList = filteredRecordList.filter(
      record => record.recordType === queryArguments.recordType
    );
  }

  if (Array.isArray(queryArguments.recordDate) && queryArguments.recordDate.length > 0) {
    filteredRecordList = filteredRecordList.filter(record => {
      const recordTimestamp = Date.parse(record.recordDate);
      if (Number.isNaN(recordTimestamp)) {
        return false;
      }

      for (const dateCondition of queryArguments.recordDate as string[]) {
        if (typeof dateCondition !== 'string') {
          continue;
        }
        const operatorSeparatorIndex = dateCondition.indexOf('.');
        if (operatorSeparatorIndex === -1) {
          continue;
        }
        const comparisonOperator = dateCondition.slice(0, operatorSeparatorIndex);
        const conditionDateString = dateCondition.slice(operatorSeparatorIndex + 1);
        const conditionTimestamp = Date.parse(conditionDateString);
        if (Number.isNaN(conditionTimestamp)) {
          continue;
        }

        if (comparisonOperator === 'gte' && !(recordTimestamp >= conditionTimestamp)) {
          return false;
        }
        if (comparisonOperator === 'gt' && !(recordTimestamp > conditionTimestamp)) {
          return false;
        }
        if (comparisonOperator === 'lte' && !(recordTimestamp <= conditionTimestamp)) {
          return false;
        }
        if (comparisonOperator === 'lt' && !(recordTimestamp < conditionTimestamp)) {
          return false;
        }
        if (comparisonOperator === 'eq' && !(recordTimestamp === conditionTimestamp)) {
          return false;
        }
      }
      return true;
    });
  }

  if (queryArguments.counterParty && typeof queryArguments.counterParty === 'string') {
    const targetCounterParty = queryArguments.counterParty
      .replace(/^(contains-i\.|contains\.|eq\.)/, '')
      .trim()
      .toLowerCase();
    filteredRecordList = filteredRecordList.filter(record =>
      record.counterParty ? record.counterParty.toLowerCase().includes(targetCounterParty) : false
    );
  }

  if (queryArguments.note && typeof queryArguments.note === 'string') {
    const targetNote = queryArguments.note
      .replace(/^(contains-i\.|contains\.|eq\.)/, '')
      .trim()
      .toLowerCase();
    filteredRecordList = filteredRecordList.filter(record =>
      record.note ? record.note.toLowerCase().includes(targetNote) : false
    );
  }

  if (queryArguments.query && typeof queryArguments.query === 'string') {
    const targetQuery = queryArguments.query.trim().toLowerCase();
    filteredRecordList = filteredRecordList.filter(record => {
      const counterPartyMatches = record.counterParty?.toLowerCase().includes(targetQuery) ?? false;
      const noteMatches = record.note?.toLowerCase().includes(targetQuery) ?? false;
      return counterPartyMatches || noteMatches;
    });
  }

  if (Array.isArray(queryArguments.sortBy) && queryArguments.sortBy.length > 0) {
    const isOldestFirst = (queryArguments.sortBy as string[]).some(sortField =>
      sortField.startsWith('+recordDate')
    );
    filteredRecordList.sort((recordA, recordB) => {
      const timestampA = Date.parse(recordA.recordDate) || 0;
      const timestampB = Date.parse(recordB.recordDate) || 0;
      return isOldestFirst ? timestampA - timestampB : timestampB - timestampA;
    });
  } else {
    filteredRecordList.sort((recordA, recordB) => {
      const timestampA = Date.parse(recordA.recordDate) || 0;
      const timestampB = Date.parse(recordB.recordDate) || 0;
      return timestampB - timestampA;
    });
  }

  const totalMatchingRecords = filteredRecordList.length;

  const resolvedOffset =
    typeof queryArguments.offset === 'number' &&
    Number.isFinite(queryArguments.offset) &&
    queryArguments.offset >= 0
      ? Math.floor(queryArguments.offset)
      : 0;

  const resolvedLimit =
    typeof queryArguments.limit === 'number' &&
    Number.isFinite(queryArguments.limit) &&
    queryArguments.limit >= 1
      ? Math.floor(queryArguments.limit)
      : filteredRecordList.length;

  const pagedRecords = filteredRecordList.slice(resolvedOffset, resolvedOffset + resolvedLimit);

  return {
    records: structuredClone(pagedRecords),
    total: totalMatchingRecords,
  };
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
    if (toolName === 'get_records') {
      return filterCanonicalRecords(records, args) as T;
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

export interface SummaryExecutionContext {
  client: WalletMcpClientService;
  cache: WalletCacheService;
  historyService: TransactionHistoryService;
  service: TransactionSummaryService;
  capturedPayloads: WalletRecordAggregationQueryPayload[];
  mockGetTransactionHistory: ReturnType<typeof vi.fn>;
  setAggregationHandler: (
    handler: (payload: WalletRecordAggregationQueryPayload) => Promise<WalletRecordAggregationResponse>
  ) => void;
  setAggregationResponse: (response: WalletRecordAggregationResponse) => void;
}

export function createSummaryExecutionContext(options: {
  accounts?: WalletAccountItem[];
  categories?: WalletCategoryItem[];
  aggregationHandler?: (payload: WalletRecordAggregationQueryPayload) => Promise<WalletRecordAggregationResponse>;
  mockGetTransactionHistory?: (options: any) => Promise<any>;
} = {}): SummaryExecutionContext {
  const accounts = options.accounts ? structuredClone(options.accounts) : structuredClone(CANONICAL_SUMMARY_ACCOUNTS);
  const categories = options.categories ? structuredClone(options.categories) : structuredClone(CANONICAL_SUMMARY_CATEGORIES);

  const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
  const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
  let currentHandler = options.aggregationHandler;

  vi.spyOn(client, 'fetchRecordsAggregation').mockImplementation(async (payload) => {
    capturedPayloads.push(payload);
    if (currentHandler) {
      return await currentHandler(payload);
    }
    return {
      results: [],
      limit: 1000,
      offset: 0,
    };
  });

  const cache = new WalletCacheService(client);
  (cache as any).cachedAccountList = [...accounts];
  (cache as any).cachedCategoryList = [...categories];
  (cache as any).cachedLabelList = [];

  const mockGetTransactionHistory = vi.fn().mockImplementation(
    options.mockGetTransactionHistory ?? (async () => ({ records: [], total: 0 }))
  );

  const historyService = {
    getTransactionHistory: mockGetTransactionHistory,
    getWalletCacheService: () => cache,
    getWalletMcpClient: () => client,
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(client, cache, historyService);

  return {
    client,
    cache,
    historyService,
    service,
    capturedPayloads,
    mockGetTransactionHistory,
    setAggregationHandler: (handler) => {
      currentHandler = handler;
    },
    setAggregationResponse: (response) => {
      currentHandler = async () => response;
    },
  };
}

