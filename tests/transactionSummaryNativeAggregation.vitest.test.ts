import { describe, expect, it, vi } from 'vitest';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordAggregationResponse,
  WalletRecordAggregationQueryPayload,
  TransactionHistoryPage,
  TransactionHistoryQueryOptions,
  WalletRecordItem,
} from '../src/types/walletTypes.js';
import type {
  WalletMcpSdkClient,
  WalletMcpTransportDependencies,
} from '../src/services/walletMcpTransport.js';

describe('native Wallet MCP summary aggregation (Issue #161)', () => {
  const cachedAccounts: WalletAccountItem[] = [
    { id: 'acc-bca', name: 'BCA Account', currency: 'IDR' },
    { id: 'acc-jago', name: 'Jago Account', currency: 'IDR' },
    { id: 'acc-usd', name: 'USD Wallet', currency: 'USD' },
  ];

  const cachedCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Food & Drinks', group: { id: 'food_and_drinks', name: 'Food and drinks' } },
    { id: 'cat-transport', name: 'Transportation', group: { id: 'transportation', name: 'Transportation' } },
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

  it('aggregates single-currency grand totals with expense, income, net, and excluded transfers', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      if (payload.isTransfer === true) {
        return {
          results: [{ count: 3 }],
          limit: 1000,
          offset: 0,
        };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'income',
            count: 5,
            'amount:sum': 5000000,
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 12,
            'amount:sum': -1500000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      datePeriod: 'this_month',
    });

    expect(capturedPayloads.length).toBe(2);
    // Main aggregation call
    expect(capturedPayloads[0]).toMatchObject({
      groupBy: ['currency', 'recordType'],
      compute: ['amount:sum'],
      isTransfer: false,
      limit: 1000,
    });
    // Transfer probe call
    expect(capturedPayloads[1]).toMatchObject({
      isTransfer: true,
    });

    expect(summaryResult.transactionCount).toBe(17);
    expect(summaryResult.excludedTransferCount).toBe(3);
    expect(summaryResult.isMultiCurrency).toBe(false);
    expect(summaryResult.isComplete).toBe(true);
    expect(summaryResult.totals).toHaveLength(1);
    expect(summaryResult.totals[0]).toEqual({
      currency: 'IDR',
      income: 5000000,
      expense: 1500000,
      net: 3500000,
      transactionCount: 17,
    });
    expect(summaryResult.breakdown).toHaveLength(0);
    expect(summaryResult.appliedFilters?.dateRange?.label).toBeDefined();
  });

  it('keeps multi-currency totals isolated without cross-currency blending', async () => {
    const mockClient = createMockWalletMcpClient(async (payload) => {
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 4,
            'amount:sum': -200000,
          },
          {
            currency: 'USD',
            recordType: 'expense',
            count: 2,
            'amount:sum': -25.5,
          },
          {
            currency: 'USD',
            recordType: 'income',
            count: 1,
            'amount:sum': 100,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({ groupBy: 'account' });

    expect(summaryResult.isMultiCurrency).toBe(true);
    expect(summaryResult.totals).toHaveLength(2);
    expect(summaryResult.totals[0]).toEqual({
      currency: 'IDR',
      income: 0,
      expense: 200000,
      net: -200000,
      transactionCount: 4,
    });
    expect(summaryResult.totals[1]).toEqual({
      currency: 'USD',
      income: 100,
      expense: 25.5,
      net: 74.5,
      transactionCount: 3,
    });
    expect(summaryResult.transactionCount).toBe(7);
  });

  it('passes recordType filter and respects type-only aggregates', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 8,
            'amount:sum': -750000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      recordType: 'expense',
      datePeriod: 'today',
    });

    expect(capturedPayloads[0].recordType).toBe('expense');
    expect(summaryResult.totals[0]).toEqual({
      currency: 'IDR',
      income: 0,
      expense: 750000,
      net: -750000,
      transactionCount: 8,
    });
    expect(summaryResult.appliedFilters?.recordType).toBe('expense');
  });

  it('performs category breakdown with name enrichment and expense-descending ranking', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      if (payload.isTransfer === true) {
        return { results: [{ count: 1 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            'category:id': 'cat-transport',
            'category:name': 'Transportation',
            count: 3,
            'amount:sum': -60000,
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            'category:id': 'cat-food',
            'category:name': 'Food & Drinks',
            count: 5,
            'amount:sum': -150000,
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            'category:id': '',
            count: 2,
            'amount:sum': -20000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      groupBy: 'category',
    });

    expect(capturedPayloads[0].groupBy).toEqual([
      'currency',
      'recordType',
      'category:id',
      'category:name',
    ]);

    expect(summaryResult.breakdown).toHaveLength(3);
    // Ranked by highest expense descending
    expect(summaryResult.breakdown[0].key).toBe('cat-food');
    expect(summaryResult.breakdown[0].name).toBe('Food & Drinks');
    expect(summaryResult.breakdown[0].transactionCount).toBe(5);
    expect(summaryResult.breakdown[0].totals[0].expense).toBe(150000);

    expect(summaryResult.breakdown[1].key).toBe('cat-transport');
    expect(summaryResult.breakdown[1].name).toBe('Transportation');
    expect(summaryResult.breakdown[1].totals[0].expense).toBe(60000);

    // Uncategorized item
    expect(summaryResult.breakdown[2].key).toBe('__uncategorized__');
    expect(summaryResult.breakdown[2].name).toBeUndefined();
    expect(summaryResult.breakdown[2].totals[0].expense).toBe(20000);
  });

  it('performs account breakdown with cache name enrichment', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            accountId: 'acc-bca',
            count: 6,
            'amount:sum': -300000,
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            accountId: 'acc-jago',
            count: 4,
            'amount:sum': -500000,
          },
          {
            currency: 'IDR',
            recordType: 'income',
            accountId: 'acc-bca',
            count: 1,
            'amount:sum': 2000000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      groupBy: 'account',
    });

    expect(capturedPayloads[0].groupBy).toEqual([
      'currency',
      'recordType',
      'accountId',
    ]);

    expect(summaryResult.breakdown).toHaveLength(2);
    // Highest expense first: Jago (500,000) > BCA (300,000)
    expect(summaryResult.breakdown[0].key).toBe('acc-jago');
    expect(summaryResult.breakdown[0].name).toBe('Jago Account');
    expect(summaryResult.breakdown[0].totals[0].expense).toBe(500000);

    expect(summaryResult.breakdown[1].key).toBe('acc-bca');
    expect(summaryResult.breakdown[1].name).toBe('BCA Account');
    expect(summaryResult.breakdown[1].totals[0].expense).toBe(300000);
    expect(summaryResult.breakdown[1].totals[0].income).toBe(2000000);
  });

  it('composes category group and account filters into native aggregation request', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 2,
            'amount:sum': -45000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      categoryGroup: 'food_and_drinks',
      accountName: 'BCA Account',
      datePeriod: 'this_month',
    });

    expect(capturedPayloads[0].categoryGroup).toBe('food_and_drinks');
    expect(capturedPayloads[0].accountId).toBe('acc-bca');
    expect(capturedPayloads[0].recordDate).toBeDefined();
    expect(summaryResult.appliedFilters?.account?.id).toBe('acc-bca');
    expect(summaryResult.appliedFilters?.categoryGroup).toBe('food_and_drinks');
  });

  it('returns clean zeroed totals when aggregation produces no matching records', async () => {
    const mockClient = createMockWalletMcpClient(async (payload) => {
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [{ count: 0 }],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary();

    expect(summaryResult.transactionCount).toBe(0);
    expect(summaryResult.totals).toEqual([]);
    expect(summaryResult.breakdown).toEqual([]);
    expect(summaryResult.isComplete).toBe(true);
  });

  it('fails closed when query contains unresolved entity filters without dispatching MCP', async () => {
    let mcpCalled = false;
    const mockClient = createMockWalletMcpClient(async () => {
      mcpCalled = true;
      return { results: [], limit: 1000, offset: 0 };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      accountName: 'NonExistentBankXYZ',
    });

    expect(mcpCalled).toBe(false);
    expect(summaryResult.isComplete).toBe(false);
    expect(summaryResult.transactionCount).toBe(0);
    expect(summaryResult.unresolvedFilters).toHaveLength(1);
    expect(summaryResult.unresolvedFilters?.[0].filterKey).toBe('account');
    expect(summaryResult.unresolvedFilters?.[0].reason).toBe('NOT_FOUND');
  });

  it('falls back to compatibility scanner when walletMcpClient is not available', async () => {
    const mockRecords: WalletRecordItem[] = [
      {
        id: 'rec-1',
        accountId: 'acc-bca',
        accountName: 'BCA Account',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-09-12T10:00:00.000Z',
        recordType: 'expense',
        category: { id: 'cat-food', name: 'Food & Drinks' },
      },
      {
        id: 'rec-2',
        accountId: 'acc-bca',
        accountName: 'BCA Account',
        amount: 250000,
        currency: 'IDR',
        recordDate: '2026-09-12T11:00:00.000Z',
        recordType: 'income',
        category: { id: 'cat-salary', name: 'Salary' },
      },
    ];

    const mockHistoryService = {
      getTransactionHistory: vi.fn().mockResolvedValue({
        records: mockRecords,
        total: 2,
        limit: 50,
        offset: 0,
        page: 1,
        totalPages: 1,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
      } as TransactionHistoryPage),
    } as unknown as TransactionHistoryService;

    // Instantiated with only TransactionHistoryService (no MCP client access)
    const legacyService = new TransactionSummaryService(mockHistoryService);

    const summaryResult = await legacyService.getTransactionSummary({
      groupBy: 'category',
    });

    expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
    expect(summaryResult.transactionCount).toBe(2);
    expect(summaryResult.totals[0]).toEqual({
      currency: 'IDR',
      income: 250000,
      expense: 50000,
      net: 200000,
      transactionCount: 2,
    });
    expect(summaryResult.breakdown).toHaveLength(2);
  });

  it('falls back to compatibility scanner when search query gap is present', async () => {
    const mockRecords: WalletRecordItem[] = [
      {
        id: 'rec-searched',
        accountId: 'acc-bca',
        accountName: 'BCA Account',
        amount: -15000,
        currency: 'IDR',
        recordDate: '2026-09-12T10:00:00.000Z',
        recordType: 'expense',
        note: 'coffee latte',
      },
    ];

    let aggregationCalled = false;
    const mockClient = createMockWalletMcpClient(async () => {
      aggregationCalled = true;
      return { results: [], limit: 1000, offset: 0 };
    });

    const mockHistoryService = {
      getTransactionHistory: vi.fn().mockResolvedValue({
        records: mockRecords,
        total: 1,
        limit: 50,
        offset: 0,
        page: 1,
        totalPages: 1,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
      } as TransactionHistoryPage),
    } as unknown as TransactionHistoryService;

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache, mockHistoryService);

    const summaryResult = await service.getTransactionSummary({
      searchQuery: 'coffee',
    });

    // Native aggregation was bypassed because searchQuery is an upstream gap
    expect(aggregationCalled).toBe(false);
    expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
    expect(summaryResult.transactionCount).toBe(1);
    expect(summaryResult.totals[0].expense).toBe(15000);
  });

  it('retains rateLimit and agentHints metadata on client after aggregation calls', async () => {
    const sdkClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [],
        structuredContent: {
          results: [
            {
              currency: 'IDR',
              recordType: 'income',
              count: 1,
              'amount:sum': 100000,
            },
          ],
          limit: 1000,
          offset: 0,
          agentHints: [{ type: 'info', text: 'Aggregation cached' }],
        },
        _meta: {
          rateLimit: {
            limit: 300,
            remaining: 295,
          },
        },
      }),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WalletMcpSdkClient;

    const transportDependencies: WalletMcpTransportDependencies = {
      createClient: () => sdkClient,
    };

    const client = new WalletMcpClientService(
      'https://wallet.example.com',
      'test-token',
      transportDependencies
    );

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(client, mockCache);

    await service.getTransactionSummary();

    const metadata = client.getLastResponseMetadata('get_records_aggregation');
    expect(metadata).toBeDefined();
    expect(metadata?.rateLimit?.remaining).toBe(295);
    expect(metadata?.rateLimit?.limit).toBe(300);
    expect(metadata?.agentHints?.[0].text).toBe('Aggregation cached');
  });
});
