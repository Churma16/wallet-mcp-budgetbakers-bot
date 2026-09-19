import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/app.js';
import { WalletMcpCapabilityService } from '../src/services/walletMcpCapabilityService.js';
import { WalletMcpClientService, WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { FinancialActionExecutor } from '../src/services/financialActionExecutor.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordAggregationResponse,
  WalletRecordAggregationQueryPayload,
  TransactionHistoryPage,
  TransactionHistoryQueryOptions,
  TransactionSummaryResult,
  WalletRecordItem,
} from '../src/types/walletTypes.js';
import { formatTransactionSummaryMessage } from '../src/utils/transactionSummaryFormatter.js';
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

    expect(capturedPayloads).toHaveLength(2);
    expect(capturedPayloads[0].recordType).toBe('expense');
    expect(capturedPayloads[1].recordType).toBe('expense');
    expect(capturedPayloads[1].isTransfer).toBe(true);
    expect(summaryResult.totals[0]).toEqual({
      currency: 'IDR',
      income: 0,
      expense: 750000,
      net: -750000,
      transactionCount: 8,
    });
    expect(summaryResult.appliedFilters?.recordType).toBe('expense');
  });

  it('passes recordType filter to both main aggregation and transfer probe for income', async () => {
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
            recordType: 'income',
            count: 3,
            'amount:sum': 500000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summaryResult = await service.getTransactionSummary({
      recordType: 'income',
      datePeriod: 'this_month',
    });

    expect(capturedPayloads).toHaveLength(2);
    expect(capturedPayloads[0].recordType).toBe('income');
    expect(capturedPayloads[1].recordType).toBe('income');
    expect(capturedPayloads[1].isTransfer).toBe(true);
    expect(summaryResult.totals[0].income).toBe(500000);
    expect(summaryResult.totals[0].expense).toBe(0);
    expect(summaryResult.appliedFilters?.recordType).toBe('income');
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

  it('throws descriptive error when neither client nor history service is configured', async () => {
    const service = new TransactionSummaryService();
    await expect(service.getTransactionSummary()).rejects.toThrow(
      'TransactionSummaryService requires WalletMcpClientService or TransactionHistoryService'
    );
  });

  it('extracts walletMcpClient and cache from TransactionHistoryService when provided as first argument', async () => {
    const mockClient = createMockWalletMcpClient(async () => ({
      results: [
        {
          currency: 'IDR',
          recordType: 'expense',
          count: 1,
          'amount:sum': -25000,
        },
      ],
      limit: 1000,
      offset: 0,
    }));
    const mockCache = createMockWalletCacheService();
    const historyService = new TransactionHistoryService(mockClient, mockCache);

    expect(historyService.getWalletMcpClient()).toBe(mockClient);
    expect(historyService.getWalletCacheService()).toBe(mockCache);

    const service = new TransactionSummaryService(historyService);
    const summary = await service.getTransactionSummary();

    expect(summary.transactionCount).toBe(1);
    expect(summary.totals[0].expense).toBe(25000);
  });

  it('initializes FastPathHandler default TransactionSummaryService when none is provided', () => {
    const mockClient = createMockWalletMcpClient(async () => ({ results: [], limit: 1000, offset: 0 }));
    const mockCache = createMockWalletCacheService();
    const handler = new FastPathHandler(
      {
        pendingActionHandler: {} as any,
        emailTransactionHandler: {} as any,
        userMessageHandler: {} as any,
      },
      mockClient,
      mockCache
    );
    expect(handler).toBeDefined();
  });

  it('initializes FinancialActionExecutor default TransactionSummaryService when none is provided', () => {
    const mockClient = createMockWalletMcpClient(async () => ({ results: [], limit: 1000, offset: 0 }));
    const mockCache = createMockWalletCacheService();
    const executor = new FinancialActionExecutor(mockClient, mockCache);
    expect(executor).toBeDefined();
  });

  it('dispatches fetchRecordsAggregation tool call with full filters through callMcpTool', async () => {
    const sdkClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      callTool: vi.fn().mockResolvedValue({
        content: [],
        structuredContent: {
          results: [
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 3,
              'amount:sum': -150000,
            },
          ],
          limit: 1000,
          offset: 0,
        },
      }),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as WalletMcpSdkClient;

    const client = new WalletMcpClientService(
      'https://wallet.example.com',
      'test-token',
      { createClient: () => sdkClient }
    );

    const result = await client.fetchRecordsAggregation({
      groupBy: ['currency', 'recordType'],
      compute: ['amount:sum'],
      isTransfer: false,
      accountId: 'acc-1',
      categoryId: 'cat-1',
      categoryGroup: 'food_and_drinks',
      recordType: 'expense',
      recordDate: '2026-09-01T00:00:00.000Z~2026-09-30T23:59:59.999Z',
    });

    expect(sdkClient.callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'get_records_aggregation',
        arguments: expect.objectContaining({
          accountId: 'acc-1',
          categoryId: 'cat-1',
          categoryGroup: 'food_and_drinks',
          recordType: 'expense',
          recordDate: '2026-09-01T00:00:00.000Z~2026-09-30T23:59:59.999Z',
        }),
      }),
      expect.anything()
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]['amount:sum']).toBe(-150000);
  });

  it('composes category name filter into category ID for native aggregation and transfer probe', async () => {
    const capturedPayloads: WalletRecordAggregationQueryPayload[] = [];
    const mockClient = createMockWalletMcpClient(async (payload) => {
      capturedPayloads.push(payload);
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 1,
            'amount:sum': -50000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summary = await service.getTransactionSummary({
      categoryName: 'Food & Drinks',
    });

    expect(capturedPayloads[0].categoryId).toEqual(['cat-food']);
    expect(capturedPayloads[1].categoryId).toEqual(['cat-food']);
    expect(summary.appliedFilters?.category?.id).toBe('cat-food');
  });

  it('handles transfer count probe failure gracefully and defaults excludedTransferCount to 0', async () => {
    const mockClient = createMockWalletMcpClient(async (payload) => {
      if (payload.isTransfer === true) {
        throw new Error('Transfer aggregation unavailable');
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 1,
            'amount:sum': -20000,
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summary = await service.getTransactionSummary();

    expect(summary.transactionCount).toBe(1);
    expect(summary.excludedTransferCount).toBe(0);
    expect(summary.transferCountUnknown).toBe(true);
    expect(summary.isComplete).toBe(false);
  });

  it('skips non-positive rows and handles uncategorized / unknown-account rows in breakdown', async () => {
    const mockClient = createMockWalletMcpClient(async (payload) => {
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 0, // skipped
            'amount:sum': 0,
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 1,
            'amount:sum': -15000,
            // no category:id, no category:name -> __uncategorized__
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summary = await service.getTransactionSummary({ groupBy: 'category' });

    expect(summary.transactionCount).toBe(1);
    expect(summary.breakdown).toHaveLength(1);
    expect(summary.breakdown[0].key).toBe('__uncategorized__');
  });

  it('sorts multi-currency breakdowns alphabetically by name/key', async () => {
    const mockClient = createMockWalletMcpClient(async (payload) => {
      if (payload.isTransfer === true) {
        return { results: [{ count: 0 }], limit: 1000, offset: 0 };
      }
      return {
        results: [
          {
            currency: 'USD',
            recordType: 'expense',
            count: 1,
            'amount:sum': -10,
            'category:id': 'cat-zebra',
            'category:name': 'Zebra Category',
          },
          {
            currency: 'IDR',
            recordType: 'expense',
            count: 1,
            'amount:sum': -50000,
            'category:id': 'cat-alpha',
            'category:name': 'Alpha Category',
          },
        ],
        limit: 1000,
        offset: 0,
      };
    });

    const mockCache = createMockWalletCacheService();
    const service = new TransactionSummaryService(mockClient, mockCache);

    const summary = await service.getTransactionSummary({ groupBy: 'category' });

    expect(summary.isMultiCurrency).toBe(true);
    expect(summary.breakdown).toHaveLength(2);
    expect(summary.breakdown[0].name).toBe('Alpha Category');
    expect(summary.breakdown[1].name).toBe('Zebra Category');
  });

  it('exercises compatibility fallback pagination loops, multi-page retrieval, and safety cap', async () => {
    const pageRecords = (pageNumber: number): WalletRecordItem[] => [
      {
        id: `rec-page-${pageNumber}`,
        accountId: 'acc-bca',
        amount: -10000 * pageNumber,
        currency: 'IDR',
        recordDate: '2026-09-12T10:00:00.000Z',
        recordType: 'expense',
      },
    ];

    let callCount = 0;
    const mockHistoryService = {
      getTransactionHistory: vi.fn().mockImplementation(async (options: TransactionHistoryQueryOptions) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            records: pageRecords(1),
            total: 2,
            limit: 1,
            offset: 0,
            page: 1,
            totalPages: 2,
            nextOffset: 1,
            hasMore: true,
            sort: 'newest',
          } as TransactionHistoryPage;
        }
        return {
          records: pageRecords(2),
          total: 2,
          limit: 50,
          offset: 1,
          page: 2,
          totalPages: 2,
          nextOffset: null,
          hasMore: false,
          sort: 'newest',
        } as TransactionHistoryPage;
      }),
    } as unknown as TransactionHistoryService;

    const legacyService = new TransactionSummaryService(mockHistoryService);

    const summary = await legacyService.getTransactionSummary({
      recordType: 'expense',
      datePeriod: 'this_month',
    });

    expect(mockHistoryService.getTransactionHistory).toHaveBeenCalledTimes(2);
    expect(summary.transactionCount).toBe(2);
    expect(summary.totals[0].expense).toBe(30000);
    expect(summary.isComplete).toBe(true);
  });

  describe('Wallet MCP aggregation response validation', () => {
    const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');

    it('rejects non-object raw response', () => {
      expect(() =>
        client.validateRecordAggregationResponse('invalid', {
          groupBy: ['currency', 'recordType'],
        })
      ).toThrow(WalletMcpRequestError);
    });

    it('rejects response missing results array', () => {
      expect(() =>
        client.validateRecordAggregationResponse({}, {
          groupBy: ['currency', 'recordType'],
        })
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse({ results: null }, {
          groupBy: ['currency', 'recordType'],
        })
      ).toThrow(WalletMcpRequestError);
    });

    it('rejects malformed row elements or invalid count', () => {
      expect(() =>
        client.validateRecordAggregationResponse(
          { results: ['not-an-object'] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: -1, currency: 'IDR', recordType: 'expense' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 'two', currency: 'IDR', recordType: 'expense' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);
    });

    it('rejects missing or invalid currency when currency is grouped', () => {
      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, recordType: 'expense' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, currency: '   ', recordType: 'expense' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);
    });

    it('rejects missing or invalid recordType when recordType is grouped', () => {
      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, currency: 'IDR' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, currency: 'IDR', recordType: 'transfer' }] },
          { groupBy: ['currency', 'recordType'] }
        )
      ).toThrow(WalletMcpRequestError);
    });

    it('rejects non-numeric or missing amount:sum when amount:sum is computed', () => {
      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, currency: 'IDR', recordType: 'expense' }] },
          { groupBy: ['currency', 'recordType'], compute: ['amount:sum'] }
        )
      ).toThrow(WalletMcpRequestError);

      expect(() =>
        client.validateRecordAggregationResponse(
          { results: [{ count: 1, currency: 'IDR', recordType: 'expense', 'amount:sum': 'not-a-number' }] },
          { groupBy: ['currency', 'recordType'], compute: ['amount:sum'] }
        )
      ).toThrow(WalletMcpRequestError);
    });

    it('prevents malformed aggregation responses from becoming valid empty/zero/complete summaries', async () => {
      const sdkClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        callTool: vi.fn().mockResolvedValue({
          content: [],
          structuredContent: {
            // Missing results array entirely
            invalidField: true,
          },
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as WalletMcpSdkClient;

      const clientWithMockTransport = new WalletMcpClientService(
        'https://wallet.example.com',
        'test-token',
        { createClient: () => sdkClient }
      );

      const mockCache = createMockWalletCacheService();
      const service = new TransactionSummaryService(clientWithMockTransport, mockCache);

      // Must fail closed (reject) rather than returning a default 0 / complete summary
      await expect(service.getTransactionSummary()).rejects.toThrow(WalletMcpRequestError);
    });
  });

  describe('formatTransactionSummaryMessage partial and unknown transfer state', () => {
    it('surfaces transferCountUnknown and partial state when transactionCount is zero', () => {
      const zeroResult: TransactionSummaryResult = {
        transactionCount: 0,
        excludedTransferCount: 0,
        transferCountUnknown: true,
        isComplete: false,
        totals: [],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
      };

      const formattedEn = formatTransactionSummaryMessage(zeroResult, 'en');
      expect(formattedEn).toContain('No transactions match these filters.');
      expect(formattedEn).toContain('Transfer count could not be verified.');
      expect(formattedEn).toContain(
        'This summary is partial because the upstream history could not be scanned completely.'
      );

      const formattedId = formatTransactionSummaryMessage(zeroResult, 'id');
      expect(formattedId).toContain('Tidak ada transaksi yang cocok dengan filter ini.');
      expect(formattedId).toContain('Jumlah transfer tidak dapat diverifikasi.');
      expect(formattedId).toContain(
        'Ringkasan ini bersifat parsial karena riwayat upstream tidak dapat dipindai sepenuhnya.'
      );
    });

    it('surfaces partial state warning when transactionCount is zero but isComplete is false without transferCountUnknown', () => {
      const partialZeroResult: TransactionSummaryResult = {
        transactionCount: 0,
        excludedTransferCount: 0,
        isComplete: false,
        totals: [],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
      };

      const formattedEn = formatTransactionSummaryMessage(partialZeroResult, 'en');
      expect(formattedEn).toContain('No transactions match these filters.');
      expect(formattedEn).not.toContain('Transfer count could not be verified.');
      expect(formattedEn).toContain(
        'This summary is partial because the upstream history could not be scanned completely.'
      );
    });

    it('surfaces transferCountUnknown when transactionCount is non-zero', () => {
      const nonZeroResult: TransactionSummaryResult = {
        transactionCount: 1,
        excludedTransferCount: 0,
        transferCountUnknown: true,
        isComplete: false,
        totals: [
          {
            currency: 'IDR',
            income: 100000,
            expense: 0,
            net: 100000,
            transactionCount: 1,
          },
        ],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
      };

      const formattedEn = formatTransactionSummaryMessage(nonZeroResult, 'en');
      expect(formattedEn).toContain('Transfer count could not be verified.');
      expect(formattedEn).toContain('This summary is partial');

      const formattedId = formatTransactionSummaryMessage(nonZeroResult, 'id');
      expect(formattedId).toContain('Jumlah transfer tidak dapat diverifikasi.');
      expect(formattedId).toContain('Ringkasan ini bersifat parsial');
    });
  });

  describe('WalletMcpCapabilityService consultation (Issue #163)', () => {
    it('bypasses native aggregation immediately when capabilityService reports unsupported tool', async () => {
      const mockClient = {
        fetchRecordsAggregation: vi.fn(),
      } as unknown as WalletMcpClientService;

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [],
          limit: 50,
          offset: 0,
          page: 1,
          nextOffset: null,
          hasMore: false,
          sort: 'newest',
        }),
      } as unknown as TransactionHistoryService;

      const mockCapability = {
        supportsTool: vi.fn().mockReturnValue(false),
        markToolRejection: vi.fn(),
      };

      const service = new TransactionSummaryService(
        mockClient,
        undefined,
        mockHistoryService,
        mockCapability as never
      );

      const result = await service.getTransactionSummary({});

      expect(mockCapability.supportsTool).toHaveBeenCalledWith('get_records_aggregation');
      expect(mockClient.fetchRecordsAggregation).not.toHaveBeenCalled();
      expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
      expect(result.transactionCount).toBe(0);
    });

    it('marks tool rejection when native aggregation fails with definitive failure and falls back to history', async () => {
      const mockClient = {
        fetchRecordsAggregation: vi.fn().mockRejectedValue(
          new WalletMcpRequestError('Method not found', 'DEFINITIVE_FAILURE')
        ),
      } as unknown as WalletMcpClientService;

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [],
          limit: 50,
          offset: 0,
          page: 1,
          nextOffset: null,
          hasMore: false,
          sort: 'newest',
        }),
      } as unknown as TransactionHistoryService;

      const mockCapability = {
        supportsTool: vi.fn().mockReturnValue(true),
        markToolRejection: vi.fn(),
      };

      const service = new TransactionSummaryService(
        mockClient,
        undefined,
        mockHistoryService,
        mockCapability as never
      );

      const result = await service.getTransactionSummary({});

      expect(mockCapability.supportsTool).toHaveBeenCalledWith('get_records_aggregation');
      expect(mockClient.fetchRecordsAggregation).toHaveBeenCalled();
      expect(mockCapability.markToolRejection).toHaveBeenCalledWith(
        'get_records_aggregation',
        expect.stringContaining('Method not found')
      );
      expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
      expect(result.transactionCount).toBe(0);
    });

    it('does not mark tool rejection when aggregation fails with request-level parameter or schema validation error', async () => {
      const mockClient = {
        fetchRecordsAggregation: vi.fn().mockRejectedValue(
          new WalletMcpRequestError(
            '[error] Wallet MCP protocol rejection: Invalid params: invalid date range (-32602)',
            'DEFINITIVE_FAILURE'
          )
        ),
      } as unknown as WalletMcpClientService;

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [],
          limit: 50,
          offset: 0,
          page: 1,
          nextOffset: null,
          hasMore: false,
          sort: 'newest',
        }),
      } as unknown as TransactionHistoryService;

      const mockCapability = {
        supportsTool: vi.fn().mockReturnValue(true),
        markToolRejection: vi.fn(),
      };

      const service = new TransactionSummaryService(
        mockClient,
        undefined,
        mockHistoryService,
        mockCapability as never
      );

      const result = await service.getTransactionSummary({});

      expect(mockCapability.supportsTool).toHaveBeenCalledWith('get_records_aggregation');
      expect(mockClient.fetchRecordsAggregation).toHaveBeenCalled();
      // Crucial: markToolRejection must NOT be called for request-specific parameter/schema errors
      expect(mockCapability.markToolRejection).not.toHaveBeenCalled();
      expect(mockHistoryService.getTransactionHistory).toHaveBeenCalled();
      expect(result.transactionCount).toBe(0);
    });

    it('wires capability facade into production runtime via Application and skips native aggregation when unsupported', async () => {
      const validConfig = {
        appLanguage: 'en' as const,
        aiProvider: 'gemini' as const,
        aiProviders: ['gemini' as const],
        geminiApiKey: 'test-key',
        geminiModel: 'gemini-2.5-flash',
        walletMcpBaseUrl: 'https://wallet.example.com',
        walletMcpAccessToken: 'test-token',
        enabledMessengerChannels: ['console' as const],
        logRetentionDays: 7,
        defaultCurrency: 'IDR',
      };

      const app = new Application(validConfig as never);
      const capabilityService = app.getWalletCapabilityService();
      expect(capabilityService).toBeInstanceOf(WalletMcpCapabilityService);

      // Explicitly mark tool rejection on the application capability service
      capabilityService.markToolRejection('get_records_aggregation', 'Tool not available on server');
      expect(capabilityService.supportsTool('get_records_aggregation')).toBe(false);

      // Access the internal runtime services wired in the application
      const summaryService = (app as unknown as { transactionSummaryService: TransactionSummaryService })
        .transactionSummaryService;
      const fetchAggregationSpy = vi.spyOn(
        (app as unknown as { walletMcpClient: WalletMcpClientService }).walletMcpClient,
        'fetchRecordsAggregation'
      );

      const historySpy = vi.spyOn(
        (app as unknown as { transactionHistoryService: TransactionHistoryService }).transactionHistoryService,
        'getTransactionHistory'
      ).mockResolvedValue({
        records: [],
        limit: 50,
        offset: 0,
        page: 1,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
      });

      const result = await summaryService.getTransactionSummary({});

      // Must skip native aggregation and directly execute history fallback
      expect(fetchAggregationSpy).not.toHaveBeenCalled();
      expect(historySpy).toHaveBeenCalled();
      expect(result.transactionCount).toBe(0);
    });
  });
});
