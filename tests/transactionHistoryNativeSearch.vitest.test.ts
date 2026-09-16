import { describe, expect, it, vi } from 'vitest';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
  TransactionHistoryPage,
  TransactionHistoryQueryOptions,
} from '../src/types/walletTypes.js';

describe('native Wallet MCP text search (Issue #162)', () => {
  const cachedAccounts: WalletAccountItem[] = [
    { id: 'acc-bca', name: 'BCA Tabungan', currency: 'IDR' },
    { id: 'acc-cash', name: 'Cash Dompet', currency: 'IDR' },
    { id: 'acc-jago', name: 'Bank Jago', currency: 'IDR' },
  ];

  const cachedCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
    { id: 'cat-transport', name: 'Transportasi', group: { id: 'transportation', name: 'Transportation' } },
    { id: 'cat-bills', name: 'Tagihan & Utilitas', group: { id: 'bills', name: 'Bills' } },
  ];

  const REFERENCE_DATE = new Date('2026-09-16T12:00:00Z');

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

  function createHarness(options: {
    mockHandler?: (toolName: string, args: Record<string, unknown>) => Promise<any>;
    defaultResponse?: any;
    defaultMetadata?: any;
  } = {}) {
    const client = new WalletMcpClientService('https://wallet.example.com/mcp', 'mock-token');
    const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    client.callMcpTool = vi.fn().mockImplementation(async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
      capturedCalls.push({ toolName, args });
      if (options.mockHandler) {
        return await options.mockHandler(toolName, args);
      }
      return (options.defaultResponse ?? { records: [], total: 0 }) as T;
    });

    const cacheService = createMockWalletCacheService();
    const historyService = new TransactionHistoryService(client, cacheService);

    return { client, capturedCalls, cacheService, historyService };
  }

  const SAMPLE_RECORDS: WalletRecordItem[] = [
    {
      id: 'rec-starbucks',
      accountId: 'acc-bca',
      amount: -55000,
      currency: 'IDR',
      recordDate: '2026-09-16T08:30:00Z',
      recordType: 'expense',
      counterParty: 'Starbucks Reserve',
      note: 'Caramel Macchiato Grande',
    },
    {
      id: 'rec-padang',
      accountId: 'acc-cash',
      amount: -35000,
      currency: 'IDR',
      recordDate: '2026-09-16T12:15:00Z',
      recordType: 'expense',
      counterParty: 'Rumah Makan Sederhana',
      note: 'Nasi Padang Rendang + Es Teh',
    },
    {
      id: 'rec-indomaret',
      accountId: 'acc-bca',
      amount: -22500,
      currency: 'IDR',
      recordDate: '2026-09-15T19:00:00Z',
      recordType: 'expense',
      counterParty: 'Indomaret Point Stasiun',
      note: 'Roti & Air Mineral',
    },
    {
      id: 'rec-unicode',
      accountId: 'acc-cash',
      amount: -45000,
      currency: 'IDR',
      recordDate: '2026-09-14T11:00:00Z',
      recordType: 'expense',
      counterParty: 'Mie Ayam & Bakso Café 100%',
      note: 'Porsi Jumbo Special',
    },
  ];

  describe('Native contract characterization & single-dispatch verification', () => {
    it('dispatches search query natively without local scan loops or scan cache', async () => {
      const { client, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          if (args.query === 'starbucks') {
            return { records: [SAMPLE_RECORDS[0]], total: 1 };
          }
          return { records: [], total: 0 };
        },
      });

      const result = await client.fetchRecords({ searchQuery: 'starbucks' });

      // Exactly ONE upstream call dispatched
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');
      expect(capturedCalls[0].args.query).toBe('starbucks');
      expect(capturedCalls[0].args.limit).toBe(10);
      expect(capturedCalls[0].args.offset).toBe(0);

      // Records normalized directly from native response
      expect(result.records).toHaveLength(1);
      expect(result.records[0].id).toBe('rec-starbucks');
      expect(result.records[0].counterParty).toBe('Starbucks Reserve');
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.continuationUnknown).toBeUndefined();
      expect(result.unresolvedFilters).toBeUndefined();
    });

    it('characterizes counterparty/merchant search under native contract', async () => {
      const { historyService, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          const q = String(args.query || '').toLowerCase();
          const matched = SAMPLE_RECORDS.filter(r => r.counterParty?.toLowerCase().includes(q));
          return { records: matched, total: matched.length };
        },
      });

      const history = await historyService.getTransactionHistory({ searchQuery: 'Indomaret' });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args.query).toBe('Indomaret');
      expect(history.records).toHaveLength(1);
      expect(history.records[0].counterParty).toBe('Indomaret Point Stasiun');
      expect(history.appliedFilters?.searchQuery).toBe('Indomaret');
    });

    it('characterizes note search under native contract', async () => {
      const { historyService, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          const q = String(args.query || '').toLowerCase();
          const matched = SAMPLE_RECORDS.filter(r => r.note?.toLowerCase().includes(q));
          return { records: matched, total: matched.length };
        },
      });

      const history = await historyService.getTransactionHistory({ searchQuery: 'Rendang' });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args.query).toBe('Rendang');
      expect(history.records).toHaveLength(1);
      expect(history.records[0].note).toContain('Rendang');
    });

    it('handles mixed-case queries and partial term matching natively', async () => {
      const { client, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          const q = String(args.query || '').toLowerCase();
          const matched = SAMPLE_RECORDS.filter(
            r => r.counterParty?.toLowerCase().includes(q) || r.note?.toLowerCase().includes(q)
          );
          return { records: matched, total: matched.length };
        },
      });

      const caseInsensitiveResult = await client.fetchRecords({ searchQuery: 'sTaRbUcKs' });
      expect(capturedCalls[0].args.query).toBe('sTaRbUcKs');
      expect(caseInsensitiveResult.records).toHaveLength(1);
      expect(caseInsensitiveResult.records[0].id).toBe('rec-starbucks');

      const partialResult = await client.fetchRecords({ searchQuery: 'macchiato' });
      expect(capturedCalls[1].args.query).toBe('macchiato');
      expect(partialResult.records).toHaveLength(1);
      expect(partialResult.records[0].id).toBe('rec-starbucks');
    });

    it('preserves multi-word, Unicode, and Indonesian text search literals', async () => {
      const { client, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          const q = String(args.query || '').toLowerCase();
          const matched = SAMPLE_RECORDS.filter(
            r => r.counterParty?.toLowerCase().includes(q) || r.note?.toLowerCase().includes(q)
          );
          return { records: matched, total: matched.length };
        },
      });

      const multiWord = await client.fetchRecords({ searchQuery: 'nasi padang rendang' });
      expect(capturedCalls[0].args.query).toBe('nasi padang rendang');
      expect(multiWord.records).toHaveLength(1);
      expect(multiWord.records[0].id).toBe('rec-padang');

      const unicode = await client.fetchRecords({ searchQuery: 'Bakso Café 100%' });
      expect(capturedCalls[1].args.query).toBe('Bakso Café 100%');
      expect(unicode.records).toHaveLength(1);
      expect(unicode.records[0].id).toBe('rec-unicode');
    });
  });

  describe('Filter composition & multi-category support', () => {
    it('composes search query with account, category, type, date range, and sort', async () => {
      const { historyService, capturedCalls } = createHarness({
        mockHandler: async () => ({ records: [SAMPLE_RECORDS[0]], total: 1 }),
      });

      const result = await historyService.getTransactionHistory(
        {
          searchQuery: 'Starbucks',
          accountName: 'BCA Tabungan',
          categoryName: 'Makanan & Minuman',
          recordType: 'expense',
          startDate: '2026-09-01',
          endDate: '2026-09-16',
          sort: 'oldest',
          limit: 20,
        },
        REFERENCE_DATE
      );

      expect(capturedCalls).toHaveLength(1);
      const args = capturedCalls[0].args;
      expect(args.query).toBe('Starbucks');
      expect(args.accountId).toBe('acc-bca');
      expect(args.categoryId).toEqual(['cat-food']);
      expect(args.recordType).toBe('expense');
      expect(args.limit).toBe(20);
      expect(args.sortBy).toEqual(['+recordDate', '+createdAt']);
      expect(Array.isArray(args.recordDate)).toBe(true);
      expect(result.records).toHaveLength(1);
      expect(result.appliedFilters?.searchQuery).toBe('Starbucks');
      expect(result.appliedFilters?.account?.name).toBe('BCA Tabungan');
    });

    it('composes search query with multi-category filters from Issue #160', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      await client.fetchRecords({
        searchQuery: 'Grab',
        categoryId: ['cat-transport', 'cat-bills'],
      });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args.query).toBe('Grab');
      expect(capturedCalls[0].args.categoryId).toEqual(['cat-transport', 'cat-bills']);
    });

    it('composes search query with category group filter', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      await client.fetchRecords({
        searchQuery: 'Dinner',
        categoryGroup: 'food_and_drinks',
      });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args.query).toBe('Dinner');
      expect(capturedCalls[0].args.categoryGroup).toBe('food_and_drinks');
    });
  });

  describe('Pagination, total counts, and incomplete metadata normalization', () => {
    it('normalizes authoritative upstream total and nextOffset without skipping or duplicating', async () => {
      const { client, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          const offset = Number(args.offset || 0);
          const limit = Number(args.limit || 10);
          return {
            records: [SAMPLE_RECORDS[0]],
            total: 25,
            nextOffset: offset + limit < 25 ? offset + limit : null,
          };
        },
      });

      const page1 = await client.fetchRecords({ searchQuery: 'coffee', limit: 10, page: 1 });
      expect(capturedCalls[0].args.offset).toBe(0);
      expect(page1.records).toHaveLength(1);
      expect(page1.total).toBe(25);
      expect(page1.page).toBe(1);
      expect(page1.totalPages).toBe(3);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextOffset).toBe(10);

      const page2 = await client.fetchRecords({ searchQuery: 'coffee', limit: 10, page: 2 });
      expect(capturedCalls[1].args.offset).toBe(10);
      expect(page2.page).toBe(2);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextOffset).toBe(20);

      const page3 = await client.fetchRecords({ searchQuery: 'coffee', limit: 10, page: 3 });
      expect(capturedCalls[2].args.offset).toBe(20);
      expect(page3.page).toBe(3);
      expect(page3.hasMore).toBe(false);
      expect(page3.nextOffset).toBeNull();
    });

    it('honestly normalizes incomplete pagination metadata when total and nextOffset are omitted', async () => {
      const fullPageRecords = Array.from({ length: 10 }, (_, i) => ({
        ...SAMPLE_RECORDS[0],
        id: `rec-${i}`,
      }));

      const { client } = createHarness({
        defaultResponse: { records: fullPageRecords }, // omits total & nextOffset
      });

      const page = await client.fetchRecords({ searchQuery: 'coffee', limit: 10, page: 1 });

      // Does not falsely claim complete total when upstream omits it
      expect(page.total).toBeUndefined();
      expect(page.totalPages).toBeUndefined();
      // Full page returned indicates more records may exist
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(10);
    });

    it('marks hasMore=false when incomplete pagination returns fewer than limit', async () => {
      const { client } = createHarness({
        defaultResponse: { records: [SAMPLE_RECORDS[0]] }, // only 1 item returned for limit 10
      });

      const page = await client.fetchRecords({ searchQuery: 'coffee', limit: 10, page: 1 });

      expect(page.total).toBeUndefined();
      expect(page.totalPages).toBeUndefined();
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
    });

    it('caps limit at MAX_TRANSACTION_HISTORY_LIMIT and floors negative/fractional offsets', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      await client.fetchRecords({ searchQuery: 'coffee', limit: 200, offset: -5 });

      expect(capturedCalls[0].args.limit).toBe(MAX_TRANSACTION_HISTORY_LIMIT);
      expect(capturedCalls[0].args.offset).toBe(0);
    });
  });

  describe('Response metadata retention (_meta.rateLimit & agentHints)', () => {
    it('retains rateLimit and agentHints from get_records tool response', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com/mcp', 'mock-token');

      // Access internal responseMetadataByOperation map to simulate transport metadata retention
      (client as any).responseMetadataByOperation.set('get_records', {
        rateLimit: {
          limit: 100,
          remaining: 78,
          resetAt: '2026-09-16T18:00:00Z',
          retryAfterMilliseconds: 0,
        },
        agentHints: [
          {
            type: 'search_index_freshness',
            severity: 'info',
            text: 'Records indexed up to 2026-09-16T17:30:00Z',
          },
        ],
      });

      const metadata = client.getLastResponseMetadata('get_records');

      expect(metadata).toBeDefined();
      expect(metadata?.rateLimit?.remaining).toBe(78);
      expect(metadata?.rateLimit?.limit).toBe(100);
      expect(metadata?.agentHints).toHaveLength(1);
      expect(metadata?.agentHints?.[0].type).toBe('search_index_freshness');
    });
  });

  describe('Fast-path parsing, routing integrity, and empty/error UX', () => {
    it('detects search queries in Indonesian and English via fastPathIntentDetector', () => {
      const idSearch = detectFastPathAction('cari starbucks');
      expect((idSearch as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((idSearch as any)?.options.searchQuery).toBe('starbucks');

      const enSearch = detectFastPathAction('search indomaret');
      expect((enSearch as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((enSearch as any)?.options.searchQuery).toBe('indomaret');

      const findSearch = detectFastPathAction('find bakery');
      expect((findSearch as any)?.options.searchQuery).toBe('bakery');

      const quotedSearch = detectFastPathAction('cari "Kopi Kenangan Mantan"');
      expect((quotedSearch as any)?.options.searchQuery).toBe('Kopi Kenangan Mantan');
    });

    it('preserves single-token search literals without converting to structured filters', () => {
      const literalIncome = detectFastPathAction('search income');
      expect((literalIncome as any)?.options.searchQuery).toBe('income');
      expect((literalIncome as any)?.options.recordType).toBeUndefined();

      const literalToday = detectFastPathAction('search today');
      expect((literalToday as any)?.options.searchQuery).toBe('today');
      expect((literalToday as any)?.options.datePeriod).toBeUndefined();

      const literalOldest = detectFastPathAction('cari oldest');
      expect((literalOldest as any)?.options.searchQuery).toBe('oldest');
    });

    it('keeps transaction creation routing strictly separate from search queries', () => {
      expect(detectFastPathAction('beli kopi 25rb')).toBeNull();
      expect(detectFastPathAction('makan siang 35000')).toBeNull();
      expect(detectFastPathAction('transfer 50000 ke bca')).toBeNull();
      expect(detectFastPathAction('gaji 10000000')).toBeNull();
    });

    it('keeps semantic category fallback separate from explicit search intent', () => {
      // "riwayat starbucks" routes to categoryName filter
      const categoryQuery = detectFastPathAction('riwayat starbucks') as any;
      expect(categoryQuery?.type).toBe('TRANSACTION_HISTORY');
      expect(categoryQuery?.options.categoryName).toBe('starbucks');
      expect(categoryQuery?.options.searchQuery).toBeUndefined();

      // "cari starbucks" routes to literal text search
      const textQuery = detectFastPathAction('cari starbucks') as any;
      expect(textQuery?.type).toBe('TRANSACTION_HISTORY');
      expect(textQuery?.options.searchQuery).toBe('starbucks');
      expect(textQuery?.options.categoryName).toBeUndefined();
    });

    it('formats empty search results with clear localized messaging', () => {
      const emptyPage: TransactionHistoryPage = {
        records: [],
        total: 0,
        limit: 10,
        offset: 0,
        page: 1,
        totalPages: 0,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
        appliedFilters: { searchQuery: 'Kopi Luwak Premium' },
      };

      setActiveLanguage('id');
      const formattedId = formatTransactionHistoryMessage(emptyPage);
      expect(formattedId).toContain('Belum ada transaksi yang cocok dengan filter [Cari: "Kopi Luwak Premium"]');

      setActiveLanguage('en');
      const formattedEn = formatTransactionHistoryMessage(emptyPage);
      expect(formattedEn).toContain('No transactions match the filter [Search: "Kopi Luwak Premium"]');
    });

    it('maps unsupported upstream search parameter errors to UNSUPPORTED filter', async () => {
      const { historyService } = createHarness({
        mockHandler: async () => {
          throw new Error('Wallet MCP Error: search query not supported by upstream data source');
        },
      });

      const result = await historyService.getTransactionHistory({ searchQuery: 'Unsupported Store' });

      expect(result.records).toHaveLength(0);
      expect(result.unresolvedFilters).toHaveLength(1);
      expect(result.unresolvedFilters?.[0].filterKey).toBe('searchQuery');
      expect(result.unresolvedFilters?.[0].reason).toBe('UNSUPPORTED');
      expect(result.unresolvedFilters?.[0].subType).toBe('unsupported_upstream_search');
    });

    it('propagates network and definitive failures without masking', async () => {
      const { historyService } = createHarness({
        mockHandler: async () => {
          throw new WalletMcpRequestError('[error] MCP connection timed out', 'UNKNOWN');
        },
      });

      await expect(
        historyService.getTransactionHistory({ searchQuery: 'Test' })
      ).rejects.toThrow(/connection timed out/);
    });

    it('executes end-to-end fast path dispatch for search queries', async () => {
      setActiveLanguage('id');
      const { client, cacheService } = createHarness({
        mockHandler: async () => ({ records: [SAMPLE_RECORDS[0]], total: 1 }),
      });

      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: async (_channel: string, _chatId: string, message: string) => {
          sentMessages.push(message);
        },
      } as any;

      const fastPathHandler = new FastPathHandler(client, cacheService, mockGateway);
      const incomingEvent = {
        channel: 'whatsapp' as const,
        chatIdentifier: '628123456789@s.whatsapp.net',
        senderIdentifier: '628123456789',
        messageType: 'text' as const,
        textPayload: 'cari starbucks',
        rawMessageTimestamp: new Date(),
      };

      const matchedAction = detectFastPathAction('cari starbucks');
      const handled = await fastPathHandler.handleFastPath(incomingEvent, matchedAction, Date.now());

      expect(handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Cari: "starbucks"');
      expect(sentMessages[0]).toContain('Caramel Macchiato Grande');
    });
  });

  describe('Compatibility fallback shim (Issue #140 transitional)', () => {
    it('invokes bounded local scan compatibility shim when searchScanFallback is true', async () => {
      const capturedScanOffsets: number[] = [];
      const { client } = createHarness({
        mockHandler: async (_tool, args) => {
          const offset = Number(args.offset || 0);
          capturedScanOffsets.push(offset);
          return {
            records: [
              {
                id: `scan-${offset}`,
                accountId: 'acc-bca',
                amount: -10000,
                currency: 'IDR',
                recordDate: '2026-09-16T10:00:00Z',
                recordType: 'expense',
                counterParty: offset === 0 ? 'Target Merchant' : 'Other Merchant',
              },
            ],
            total: 100,
          };
        },
      });

      const result = await client.fetchRecords({
        searchQuery: 'Target Merchant',
        limit: 1,
        page: 1,
        searchScanFallback: true,
      });

      expect(result.records).toHaveLength(1);
      expect(result.records[0].counterParty).toBe('Target Merchant');
      // Verify that scan calls were made through the shim
      expect(capturedScanOffsets.length).toBeGreaterThanOrEqual(1);
    });
  });
});
