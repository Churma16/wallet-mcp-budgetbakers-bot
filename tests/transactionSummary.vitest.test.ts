import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionSummaryMessage } from '../src/utils/transactionSummaryFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import type {
  TransactionHistoryPage,
  TransactionHistoryQueryOptions,
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
} from '../src/types/walletTypes.js';

const cachedAccounts: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
  { id: 'acc-usd', name: 'USD Wallet', currency: 'USD' },
];

const cachedCategories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food', group: { id: 'food', name: 'Food' } },
  { id: 'cat-transport', name: 'Transport', group: { id: 'transport', name: 'Transport' } },
  { id: 'cat-salary', name: 'Salary', group: { id: 'income', name: 'Income' } },
];

function createMockWalletCacheService(): WalletCacheService {
  return {
    getAccounts: () => cachedAccounts,
    getCategories: () => cachedCategories,
    getLabels: () => [],
    getBudgets: () => [],
    refreshCache: async () => {},
    isCacheValid: () => true,
  } as unknown as WalletCacheService;
}

function createMockWalletMcpClient(
  aggregationHandler: (payload: WalletRecordAggregationQueryPayload) => Promise<WalletRecordAggregationResponse>
): WalletMcpClientService {
  const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
  vi.spyOn(client, 'fetchRecordsAggregation').mockImplementation(aggregationHandler);
  return client;
}

describe('Transaction Summary & Breakdown Tests (Issue #103 & #140)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
    vi.restoreAllMocks();
  });

  describe('Suite 1: Aggregates totals via native aggregation and excludes transfers', () => {
    it('verifies native aggregation, totals, transfer exclusion, category breakdown, and does not invoke transaction history', async () => {
      const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
      const referenceDate = new Date('2026-09-12T09:30:00.000Z');

      const mockMcpClient = createMockWalletMcpClient(async (payload) => {
        capturedPayloads.push(payload);
        if (payload.isTransfer === true) {
          return {
            results: [{ count: 1 }],
            limit: 1000,
            offset: 0,
          };
        }
        return {
          results: [
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 1,
              'amount:sum': -100000,
              'category:id': 'cat-food',
              'category:name': 'Food',
            },
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 1,
              'amount:sum': -50000,
              'category:id': 'cat-transport',
              'category:name': 'Transport',
            },
            {
              currency: 'IDR',
              recordType: 'income',
              count: 1,
              'amount:sum': 500000,
              'category:id': 'cat-salary',
              'category:name': 'Salary',
            },
          ],
          limit: 1000,
          offset: 0,
        };
      });

      const mockCache = createMockWalletCacheService();
      const mockHistoryService = {
        getTransactionHistory: vi.fn(),
      } as unknown as TransactionHistoryService;

      const service = new TransactionSummaryService(mockMcpClient, mockCache, mockHistoryService);
      const result = await service.getTransactionSummary(
        { categoryName: 'food', datePeriod: 'this_month', groupBy: 'category' },
        referenceDate
      );

      // Verify native aggregation payload was constructed
      expect(capturedPayloads.length).toBe(2);
      expect(capturedPayloads[0]).toMatchObject({
        groupBy: ['currency', 'recordType', 'category:id', 'category:name'],
        compute: ['amount:sum'],
        isTransfer: false,
        categoryId: ['cat-food'],
      });
      expect(capturedPayloads[1]).toMatchObject({
        isTransfer: true,
        categoryId: ['cat-food'],
      });

      // REQUIRED REGRESSION TEST: native aggregation path must NOT call getTransactionHistory
      expect(mockHistoryService.getTransactionHistory).not.toHaveBeenCalled();

      expect(result.transactionCount).toBe(3);
      expect(result.excludedTransferCount).toBe(1);
      expect(result.isComplete).toBe(true);
      expect(result.totals.length).toBe(1);
      expect(result.totals[0]).toEqual({
        currency: 'IDR',
        income: 500000,
        expense: 150000,
        net: 350000,
        transactionCount: 3,
      });
      expect(result.breakdown.length).toBe(3);
      expect(result.breakdown[0].name).toBe('Food');
      expect(result.breakdown[0].totals[0].expense).toBe(100000);

      setActiveLanguage('en');
      const formatted = formatTransactionSummaryMessage(result);
      expect(formatted).toMatch(/Income:/);
      expect(formatted).toMatch(/Expenses:/);
      expect(formatted).toMatch(/Net:/);
    });
  });

  describe('Suite 2: Filtered totals preserve history filter semantics without pseudo-net output', () => {
    it('renders only the requested metric and omits pseudo-net values for type-filtered summaries', async () => {
      const mockMcpClient = createMockWalletMcpClient(async (payload) => {
        if (payload.isTransfer === true) {
          return { results: [{ count: 0 }], limit: 1000, offset: 0 };
        }
        if (payload.recordType === 'income') {
          return {
            results: [
              {
                currency: 'IDR',
                recordType: 'income',
                count: 1,
                'amount:sum': 750000,
              },
            ],
            limit: 1000,
            offset: 0,
          };
        }
        return {
          results: [
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 1,
              'amount:sum': -250000,
            },
          ],
          limit: 1000,
          offset: 0,
        };
      });

      const mockCache = createMockWalletCacheService();
      const mockHistoryService = {
        getTransactionHistory: vi.fn(),
      } as unknown as TransactionHistoryService;

      const service = new TransactionSummaryService(mockMcpClient, mockCache, mockHistoryService);

      const incomeResult = await service.getTransactionSummary({
        accountName: 'bca',
        recordType: 'income',
        datePeriod: 'today',
      });

      expect(mockHistoryService.getTransactionHistory).not.toHaveBeenCalled();
      expect(incomeResult.totals[0].income).toBe(750000);
      expect(incomeResult.totals[0].expense).toBe(0);
      expect(incomeResult.totals[0].net).toBe(750000);

      setActiveLanguage('en');
      const incomeFormatted = formatTransactionSummaryMessage(incomeResult);
      expect(incomeFormatted).toMatch(/Income:/);
      expect(incomeFormatted).not.toMatch(/Expenses:/);
      expect(incomeFormatted).not.toMatch(/Net:/);

      const expenseResult = await service.getTransactionSummary({
        accountName: 'bca',
        recordType: 'expense',
        datePeriod: 'today',
      });

      expect(mockHistoryService.getTransactionHistory).not.toHaveBeenCalled();
      expect(expenseResult.totals[0].income).toBe(0);
      expect(expenseResult.totals[0].expense).toBe(250000);
      expect(expenseResult.totals[0].net).toBe(-250000);

      const expenseFormatted = formatTransactionSummaryMessage(expenseResult);
      expect(expenseFormatted).not.toMatch(/Income:/);
      expect(expenseFormatted).toMatch(/Expenses:/);
      expect(expenseFormatted).not.toMatch(/Net:/);
    });
  });

  describe('Suite 3: Multi-currency totals remain isolated', () => {
    it('ensures cross-currency values are never silently combined', async () => {
      const mockMcpClient = createMockWalletMcpClient(async (payload) => {
        if (payload.isTransfer === true) {
          return { results: [{ count: 0 }], limit: 1000, offset: 0 };
        }
        return {
          results: [
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 1,
              'amount:sum': -100000,
              accountId: 'acc-bca',
            },
            {
              currency: 'USD',
              recordType: 'expense',
              count: 1,
              'amount:sum': -10,
              accountId: 'acc-usd',
            },
            {
              currency: 'USD',
              recordType: 'income',
              count: 1,
              'amount:sum': 20,
              accountId: 'acc-usd',
            },
          ],
          limit: 1000,
          offset: 0,
        };
      });

      const mockCache = createMockWalletCacheService();
      const service = new TransactionSummaryService(mockMcpClient, mockCache);
      const result = await service.getTransactionSummary({ groupBy: 'account' });

      expect(result.isMultiCurrency).toBe(true);
      expect(result.totals.length).toBe(2);
      expect(result.totals.map(item => item.currency)).toEqual(['IDR', 'USD']);
      expect(result.totals.find(item => item.currency === 'IDR')?.expense).toBe(100000);
      expect(result.totals.find(item => item.currency === 'USD')?.expense).toBe(10);
      expect(result.totals.find(item => item.currency === 'USD')?.income).toBe(20);
      expect(result.breakdown.length).toBe(2);

      setActiveLanguage('en');
      const formatted = formatTransactionSummaryMessage(result);
      expect(formatted).toMatch(/Currencies are shown separately/);
      expect(formatted).toMatch(/\*IDR\*/);
      expect(formatted).toMatch(/\*USD\*/);
    });
  });

  describe('Suite 4: Empty and unresolved results fail clearly', () => {
    it('produces deterministic no-data results for empty data and unresolved filters', async () => {
      const emptyMcpClient = createMockWalletMcpClient(async (payload) => {
        if (payload.isTransfer === true) {
          return { results: [{ count: 0 }], limit: 1000, offset: 0 };
        }
        return { results: [], limit: 1000, offset: 0 };
      });

      const mockCache = createMockWalletCacheService();
      const emptyService = new TransactionSummaryService(emptyMcpClient, mockCache);
      const emptyResult = await emptyService.getTransactionSummary();
      expect(emptyResult.transactionCount).toBe(0);
      expect(emptyResult.totals).toEqual([]);
      expect(emptyResult.isComplete).toBe(true);

      setActiveLanguage('id');
      expect(formatTransactionSummaryMessage(emptyResult)).toMatch(/Tidak ada transaksi/);

      const unresolvedResult = await emptyService.getTransactionSummary({ accountName: 'does-not-exist' });
      expect(unresolvedResult.isComplete).toBe(false);
      expect(unresolvedResult.transactionCount).toBe(0);
      expect(unresolvedResult.unresolvedFilters?.length).toBe(1);
    });
  });

  describe('Suite 5: Fast-path summary intents reuse history-style filters', () => {
    it('routes command and natural-language summary questions through deterministic parsing', () => {
      const expenseAction = detectFastPathAction('total pengeluaran bulan ini');
      expect(typeof expenseAction).toBe('object');
      expect((expenseAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((expenseAction as any)?.options.recordType).toBe('expense');
      expect((expenseAction as any)?.options.datePeriod).toBe('this_month');

      const categoryAction = detectFastPathAction('summary by category this month');
      expect((categoryAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((categoryAction as any)?.options.groupBy).toBe('category');
      expect((categoryAction as any)?.options.datePeriod).toBe('this_month');

      const accountAction = detectFastPathAction('pengeluaran per akun bulan ini');
      expect((accountAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((accountAction as any)?.options.groupBy).toBe('account');
      expect((accountAction as any)?.options.recordType).toBe('expense');

      const filteredAction = detectFastPathAction('ringkasan makanan bulan ini');
      expect((filteredAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((filteredAction as any)?.options.categoryName).toBe('makanan');
      expect((filteredAction as any)?.options.datePeriod).toBe('this_month');

      const naturalEnglishAction = detectFastPathAction('how much did I spend on food this month?');
      expect((naturalEnglishAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((naturalEnglishAction as any)?.options.recordType).toBe('expense');
      expect((naturalEnglishAction as any)?.options.categoryName).toBe('food');
      expect((naturalEnglishAction as any)?.options.datePeriod).toBe('this_month');

      const naturalIndonesianAction = detectFastPathAction('berapa total pengeluaran makanan bulan ini?');
      expect((naturalIndonesianAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((naturalIndonesianAction as any)?.options.recordType).toBe('expense');
      expect((naturalIndonesianAction as any)?.options.categoryName).toBe('makanan');
      expect((naturalIndonesianAction as any)?.options.datePeriod).toBe('this_month');

      const categoryRankingAction = detectFastPathAction('which category did I spend the most on?');
      expect((categoryRankingAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((categoryRankingAction as any)?.options.recordType).toBe('expense');
      expect((categoryRankingAction as any)?.options.groupBy).toBe('category');

      const indonesianCategoryRankingAction = detectFastPathAction('kategori mana yang paling banyak pengeluarannya?');
      expect((indonesianCategoryRankingAction as any)?.type).toBe('TRANSACTION_SUMMARY');
      expect((indonesianCategoryRankingAction as any)?.options.recordType).toBe('expense');
      expect((indonesianCategoryRankingAction as any)?.options.groupBy).toBe('category');

      expect(detectFastPathAction('bayar 50rb makan siang')).toBeNull();
    });
  });

  describe('Suite 6: Compatibility fallback for free-text search gap', () => {
    it('falls back to TransactionHistoryService when free-text search is requested', async () => {
      const mockMcpClient = createMockWalletMcpClient(async () => {
        throw new Error('fetchRecordsAggregation should not be called when search gap is active');
      });

      const capturedSearchOptions: TransactionHistoryQueryOptions[] = [];
      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockImplementation(async (options: TransactionHistoryQueryOptions): Promise<TransactionHistoryPage> => {
          capturedSearchOptions.push(options);
          return {
            records: [
              {
                id: 'search-record-1',
                accountId: 'acc-bca',
                accountName: 'BCA',
                amount: -75000,
                currency: 'IDR',
                recordDate: '2026-09-12T05:00:00.000Z',
                recordType: 'expense',
                note: 'Lunch at cafe',
              },
            ],
            total: 1,
            limit: 50,
            offset: 0,
            page: 1,
            totalPages: 1,
            nextOffset: null,
            hasMore: false,
            sort: 'newest',
          };
        }),
      } as unknown as TransactionHistoryService;

      const mockCache = createMockWalletCacheService();
      const service = new TransactionSummaryService(mockMcpClient, mockCache, mockHistoryService);

      const searchSummaryResult = await service.getTransactionSummary({
        searchQuery: 'Lunch',
      });

      expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
      expect(capturedSearchOptions.length).toBe(1);
      expect(capturedSearchOptions[0].searchQuery).toBe('Lunch');
      expect(searchSummaryResult.transactionCount).toBe(1);
      expect(searchSummaryResult.totals[0].expense).toBe(75000);
    });
  });
});
