import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  WalletMcpClientService,
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestFastPathHandler } from './fixtures/compositionFixtures.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import type {
  TransactionHistoryPage,
  WalletAccountItem,
  WalletCategoryItem,
} from '../src/types/walletTypes.js';
import {
  createQueryExecutionContext,
  type QueryExecutionContext,
} from './fixtures/transactionFixtures.js';

describe('Transaction History Pagination & Sorting Tests (Issue #100)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
    vi.restoreAllMocks();
  });

  describe('Suite 1: Configurable Limits & Safe Upper Bound', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
      queryContext.setNextResponse({ records: [], total: 0 });
    });

    it('conforms to configurable default (10) and hard safety cap (50)', async () => {
      // 1.1 Default limit is 10
      await queryContext.client.fetchRecords();
      expect(queryContext.capturedCalls.length).toBe(1);
      expect(queryContext.capturedCalls[0].toolName).toBe('get_records');
      expect(queryContext.capturedCalls[0].args.limit).toBe(DEFAULT_TRANSACTION_HISTORY_LIMIT);
      expect(queryContext.capturedCalls[0].args.limit).toBe(10);

      // 1.2 Custom valid limit
      await queryContext.client.fetchRecords({ limit: 25 });
      expect(queryContext.capturedCalls[1].args.limit).toBe(25);

      // 1.3 Maximum limit cap at 50
      await queryContext.client.fetchRecords({ limit: 100 });
      expect(queryContext.capturedCalls[2].args.limit).toBe(MAX_TRANSACTION_HISTORY_LIMIT);
      expect(queryContext.capturedCalls[2].args.limit).toBe(50);

      // 1.4 Limits <= 0 or invalid normalized to default limit
      await queryContext.client.fetchRecords({ limit: 0 });
      expect(queryContext.capturedCalls[3].args.limit).toBe(DEFAULT_TRANSACTION_HISTORY_LIMIT);

      await queryContext.client.fetchRecords({ limit: -10 });
      expect(queryContext.capturedCalls[4].args.limit).toBe(DEFAULT_TRANSACTION_HISTORY_LIMIT);

      await queryContext.client.fetchRecords({ limit: NaN });
      expect(queryContext.capturedCalls[5].args.limit).toBe(DEFAULT_TRANSACTION_HISTORY_LIMIT);

      // 1.5 Fractional limit floored
      await queryContext.client.fetchRecords({ limit: 15.8 });
      expect(queryContext.capturedCalls[6].args.limit).toBe(15);
    });
  });

  describe('Suite 2: Offset & Page-Based Pagination', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
      queryContext.setNextResponse({ records: [], total: 0 });
    });

    it('verifies offset and page-based pagination calculations', async () => {
      // 2.1 Default offset is 0
      await queryContext.client.fetchRecords();
      expect(queryContext.capturedCalls[0].args.offset).toBe(0);

      // 2.2 Explicit offset
      await queryContext.client.fetchRecords({ offset: 20 });
      expect(queryContext.capturedCalls[1].args.offset).toBe(20);

      // 2.3 Negative offset normalized to 0
      await queryContext.client.fetchRecords({ offset: -5 });
      expect(queryContext.capturedCalls[2].args.offset).toBe(0);

      // 2.4 Page calculation: page 1 -> offset 0
      await queryContext.client.fetchRecords({ page: 1 });
      expect(queryContext.capturedCalls[3].args.offset).toBe(0);

      // 2.5 Page calculation: page 2 with default limit (10) -> offset 10
      await queryContext.client.fetchRecords({ page: 2 });
      expect(queryContext.capturedCalls[4].args.offset).toBe(10);

      // 2.6 Page calculation: page 3 with limit 5 -> offset 10
      await queryContext.client.fetchRecords({ page: 3, limit: 5 });
      expect(queryContext.capturedCalls[5].args.offset).toBe(10);

      // 2.7 Explicit offset takes precedence when provided
      await queryContext.client.fetchRecords({ offset: 15, page: 4 });
      expect(queryContext.capturedCalls[6].args.offset).toBe(15);
    });
  });

  describe('Suite 3: Deterministic Sorting', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
      queryContext.setNextResponse({ records: [], total: 0 });
    });

    it('verifies deterministic sorting orders for newest and oldest', async () => {
      // 3.1 Default sort is newest-first with createdAt tie-breaker
      await queryContext.client.fetchRecords();
      expect(queryContext.capturedCalls[0].args.sortBy).toEqual(['-recordDate', '-createdAt']);

      // 3.2 Explicit newest-first
      await queryContext.client.fetchRecords({ sort: 'newest' });
      expect(queryContext.capturedCalls[1].args.sortBy).toEqual(['-recordDate', '-createdAt']);

      // 3.3 Explicit oldest-first
      await queryContext.client.fetchRecords({ sort: 'oldest' });
      expect(queryContext.capturedCalls[2].args.sortBy).toEqual(['+recordDate', '+createdAt']);
    });
  });

  describe('Suite 4: Pagination Metadata & Multi-Page Navigation', () => {
    let queryContext: QueryExecutionContext;
    const sampleRawRecords = Array.from({ length: 10 }, (_, index) => ({
      id: `rec-${index + 1}`,
      accountId: 'acc-1',
      accountName: 'BCA Prioritas',
      amount: { value: -25000 * (index + 1), currencyCode: 'IDR' },
      recordDate: '2026-09-11T10:00:00.000Z',
      recordType: 'expense',
      note: `Belanja item ${index + 1}`,
    }));

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
    });

    it('calculates page 1 metadata correctly', async () => {
      queryContext.setNextResponse({
        records: sampleRawRecords,
        total: 45,
        nextOffset: 10,
      });

      const page1 = await queryContext.client.fetchRecords({ limit: 10, offset: 0 });
      expect(page1.records.length).toBe(10);
      expect(page1.total).toBe(45);
      expect(page1.page).toBe(1);
      expect(page1.totalPages).toBe(5);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextOffset).toBe(10);
    });

    it('calculates page 2 metadata correctly', async () => {
      queryContext.setNextResponse({
        records: sampleRawRecords,
        total: 45,
        nextOffset: 20,
      });

      const page2 = await queryContext.client.fetchRecords({ limit: 10, offset: 10 });
      expect(page2.page).toBe(2);
      expect(page2.totalPages).toBe(5);
      expect(page2.hasMore).toBe(true);
      expect(page2.nextOffset).toBe(20);
    });

    it('calculates last page metadata correctly', async () => {
      queryContext.setNextResponse({
        records: sampleRawRecords.slice(0, 5),
        total: 45,
        nextOffset: null,
      });

      const lastPage = await queryContext.client.fetchRecords({ limit: 10, offset: 40 });
      expect(lastPage.records.length).toBe(5);
      expect(lastPage.page).toBe(5);
      expect(lastPage.totalPages).toBe(5);
      expect(lastPage.hasMore).toBe(false);
      expect(lastPage.nextOffset).toBeNull();
    });

    it('handles response with records and nextOffset but no total (Issue #105 review)', async () => {
      queryContext.setNextResponse({
        records: sampleRawRecords,
        nextOffset: 10,
      });

      const pageWithoutTotal = await queryContext.client.fetchRecords({ limit: 10, offset: 0 });
      expect(pageWithoutTotal.records.length).toBe(10);
      expect(pageWithoutTotal.total).toBeUndefined();
      expect(pageWithoutTotal.totalPages).toBeUndefined();
      expect(pageWithoutTotal.hasMore).toBe(true);
      expect(pageWithoutTotal.nextOffset).toBe(10);

      setActiveLanguage('id');
      const formattedWithoutTotalId = formatTransactionHistoryMessage(pageWithoutTotal);
      expect(formattedWithoutTotalId).toMatch(/riwayat hal 2/);

      setActiveLanguage('en');
      const formattedWithoutTotalEn = formatTransactionHistoryMessage(pageWithoutTotal);
      expect(formattedWithoutTotalEn).toMatch(/history page 2/);
    });

    it('handles last-page case with no nextOffset and no total', async () => {
      queryContext.setNextResponse({
        records: sampleRawRecords.slice(0, 5),
      });

      const lastPageWithoutTotal = await queryContext.client.fetchRecords({ limit: 10, offset: 10 });
      expect(lastPageWithoutTotal.records.length).toBe(5);
      expect(lastPageWithoutTotal.total).toBeUndefined();
      expect(lastPageWithoutTotal.totalPages).toBeUndefined();
      expect(lastPageWithoutTotal.hasMore).toBe(false);
      expect(lastPageWithoutTotal.nextOffset).toBeNull();

      const formattedLastPageWithoutTotal = formatTransactionHistoryMessage(lastPageWithoutTotal);
      expect(formattedLastPageWithoutTotal).not.toMatch(/riwayat hal/);
    });
  });

  describe('Suite 5: Empty Pages & End-of-History Behavior', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
    });

    it('handles empty history when total is 0', async () => {
      queryContext.setNextResponse({ records: [], total: 0 });
      const emptyResult = await queryContext.client.fetchRecords();
      expect(emptyResult.records.length).toBe(0);
      expect(emptyResult.total).toBe(0);
      expect(emptyResult.hasMore).toBe(false);
      expect(emptyResult.nextOffset).toBeNull();

      setActiveLanguage('id');
      const emptyFormattedId = formatTransactionHistoryMessage(emptyResult);
      expect(emptyFormattedId).toMatch(/Belum ada transaksi yang tercatat/);

      setActiveLanguage('en');
      const emptyFormattedEn = formatTransactionHistoryMessage(emptyResult);
      expect(emptyFormattedEn).toMatch(/No transactions recorded yet/);
    });

    it('handles out-of-bounds offset where offset >= total', async () => {
      queryContext.setNextResponse({ records: [], total: 20 });
      const outOfBoundsResult = await queryContext.client.fetchRecords({ offset: 30, limit: 10 });
      expect(outOfBoundsResult.records.length).toBe(0);
      expect(outOfBoundsResult.hasMore).toBe(false);
      expect(outOfBoundsResult.nextOffset).toBeNull();

      setActiveLanguage('id');
      const outOfBoundsFormattedId = formatTransactionHistoryMessage(outOfBoundsResult);
      expect(outOfBoundsFormattedId).toMatch(/Halaman ini melebihi jumlah transaksi/);

      setActiveLanguage('en');
      const outOfBoundsFormattedEn = formatTransactionHistoryMessage(outOfBoundsResult);
      expect(outOfBoundsFormattedEn).toMatch(/This page exceeds available transactions/);
    });
  });

  describe('Suite 6: Data Normalization & Cache Enrichment', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: [
          { id: 'acc-uuid-1', name: 'Bank Jago Main', currency: 'IDR', balance: 1000000 },
        ],
        categories: [
          { id: 'cat-uuid-1', name: 'Kebutuhan Harian' },
        ],
      });
      queryContext.setNextResponse({
        records: [
          {
            id: 'rec-test-1',
            accountId: 'acc-uuid-1',
            amount: -50000,
            currency: 'IDR',
            recordDate: '2026-09-11T12:00:00.000Z',
            recordType: 'expense',
            note: 'Supermarket belanja',
            categoryId: 'cat-uuid-1',
            labels: [{ id: 'lbl-1', name: 'groceries' }],
          },
        ],
        total: 1,
      });
    });

    it('enriches accountName and category name from cache', async () => {
      const enrichedResult = await queryContext.service.getTransactionHistory();
      expect(enrichedResult.records.length).toBe(1);
      expect(enrichedResult.records.map(record => record.id)).toEqual(['rec-test-1']);
      const record = enrichedResult.records[0];

      expect(record.accountName).toBe('Bank Jago Main');
      expect(record.category?.name).toBe('Kebutuhan Harian');
      expect(record.amount).toBe(-50000);
      expect(record.labels?.[0]?.name).toBe('groceries');
    });
  });

  describe('Suite 7: Human-Facing Response Formatting (i18n)', () => {
    const samplePage: TransactionHistoryPage = {
      records: [
        {
          id: 'rec-1',
          accountId: 'acc-1',
          accountName: 'BCA Prioritas',
          amount: -25000,
          currency: 'IDR',
          recordDate: '2026-09-11T07:30:00.000Z',
          recordType: 'expense',
          note: 'Nasi Goreng',
          category: { id: 'cat-1', name: 'Makanan & Minuman' },
          labels: [{ id: 'l1', name: 'lunch' }],
        },
        {
          id: 'rec-2',
          accountId: 'acc-1',
          accountName: 'BCA Prioritas',
          amount: 500000,
          currency: 'IDR',
          recordDate: '2026-09-11T08:00:00.000Z',
          recordType: 'income',
          note: 'Bonus Freelance',
          category: { id: 'cat-2', name: 'Gaji & Pemasukan' },
        },
      ],
      total: 15,
      limit: 10,
      offset: 0,
      page: 1,
      totalPages: 2,
      nextOffset: 10,
      hasMore: true,
      sort: 'newest',
    };

    it('formats transaction history in Indonesian and English', () => {
      // Indonesian
      setActiveLanguage('id');
      const formattedId = formatTransactionHistoryMessage(samplePage);
      expect(formattedId).toMatch(/Riwayat Transaksi/);
      expect(formattedId).toMatch(/Hal\. 1\/2 • 2 item/);
      expect(formattedId).toMatch(/1\. Nasi Goreng/);
      expect(formattedId).toMatch(/\*-Rp25\.000\* • BCA Prioritas/);
      expect(formattedId).toMatch(/2\. Bonus Freelance/);
      expect(formattedId).toMatch(/\*\+Rp500\.000\* • BCA Prioritas/);
      expect(formattedId).toMatch(/#lunch/);
      expect(formattedId).not.toMatch(/[💸💰🔄🏷️🔖]/u);
      expect(formattedId).toMatch(/riwayat hal 2/);

      // English
      setActiveLanguage('en');
      const formattedEn = formatTransactionHistoryMessage(samplePage);
      expect(formattedEn).toMatch(/Transaction History/);
      expect(formattedEn).toMatch(/Page 1\/2 • 2 items/);
      expect(formattedEn).toMatch(/1\. Nasi Goreng/);
      expect(formattedEn).toMatch(/\*-Rp25,000\* • BCA Prioritas/);
      expect(formattedEn).toMatch(/2\. Bonus Freelance/);
      expect(formattedEn).toMatch(/\*\+Rp500,000\* • BCA Prioritas/);
      expect(formattedEn).toMatch(/history page 2/);
    });

    it('indicates oldest sort order in formatted output', () => {
      const oldestPage: TransactionHistoryPage = {
        ...samplePage,
        sort: 'oldest',
      };

      setActiveLanguage('id');
      expect(formatTransactionHistoryMessage(oldestPage)).toMatch(/\[Terlama\]/);

      setActiveLanguage('en');
      expect(formatTransactionHistoryMessage(oldestPage)).toMatch(/\[Oldest\]/);
    });

    it('preserves query options in navigation hints', () => {
      const customQueryPage: TransactionHistoryPage = {
        ...samplePage,
        limit: 5,
        sort: 'oldest',
      };

      // Indonesian: starts from { limit: 5, sort: 'oldest' }
      setActiveLanguage('id');
      const formattedCustomId = formatTransactionHistoryMessage(customQueryPage);
      const idMatch = formattedCustomId.match(/_Ketik \*(.+?)\* untuk halaman selanjutnya\._/);
      expect(idMatch).toBeTruthy();
      const idNextCommand = idMatch![1];
      expect(idNextCommand).toBe('riwayat 5 hal 2 terlama');

      const parsedIdAction = detectFastPathAction(idNextCommand);
      expect(typeof parsedIdAction).toBe('object');
      expect((parsedIdAction as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((parsedIdAction as any)?.options).toEqual({
        limit: 5,
        page: 2,
        sort: 'oldest',
      });

      // English: starts from { limit: 5, sort: 'oldest' }
      setActiveLanguage('en');
      const formattedCustomEn = formatTransactionHistoryMessage(customQueryPage);
      const enMatch = formattedCustomEn.match(/_Type \*(.+?)\* for the next page\._/);
      expect(enMatch).toBeTruthy();
      const enNextCommand = enMatch![1];
      expect(enNextCommand).toBe('history 5 page 2 oldest');

      const parsedEnAction = detectFastPathAction(enNextCommand);
      expect(typeof parsedEnAction).toBe('object');
      expect((parsedEnAction as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((parsedEnAction as any)?.options).toEqual({
        limit: 5,
        page: 2,
        sort: 'oldest',
      });
    });
  });

  describe('Suite 8: Fast-Path Intent Detection', () => {
    it('detects basic keywords', () => {
      const action1 = detectFastPathAction('riwayat');
      expect(typeof action1).toBe('object');
      expect((action1 as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((action1 as any)?.options.sort).toBe('newest');

      const action2 = detectFastPathAction('history');
      expect((action2 as any)?.type).toBe('TRANSACTION_HISTORY');

      const action3 = detectFastPathAction('transaksi terakhir');
      expect((action3 as any)?.type).toBe('TRANSACTION_HISTORY');

      const action4 = detectFastPathAction('recent transactions');
      expect((action4 as any)?.type).toBe('TRANSACTION_HISTORY');
    });

    it('detects parameterized limit', () => {
      const actionLimit1 = detectFastPathAction('riwayat 5');
      expect((actionLimit1 as any)?.options.limit).toBe(5);

      const actionLimit2 = detectFastPathAction('history 20');
      expect((actionLimit2 as any)?.options.limit).toBe(20);

      const actionLimit3 = detectFastPathAction('10 transaksi terakhir');
      expect((actionLimit3 as any)?.options.limit).toBe(10);

      const actionLimit4 = detectFastPathAction('5 recent transactions');
      expect((actionLimit4 as any)?.options.limit).toBe(5);
    });

    it('detects parameterized page', () => {
      const actionPage1 = detectFastPathAction('riwayat hal 2');
      expect((actionPage1 as any)?.options.page).toBe(2);

      const actionPage2 = detectFastPathAction('history page 3');
      expect((actionPage2 as any)?.options.page).toBe(3);
    });

    it('detects combined limit and page', () => {
      const actionCombined = detectFastPathAction('riwayat 5 hal 2');
      expect((actionCombined as any)?.options.limit).toBe(5);
      expect((actionCombined as any)?.options.page).toBe(2);
    });

    it('detects sorting variants', () => {
      const actionSort1 = detectFastPathAction('riwayat terlama');
      expect((actionSort1 as any)?.options.sort).toBe('oldest');

      const actionSort2 = detectFastPathAction('history oldest');
      expect((actionSort2 as any)?.options.sort).toBe('oldest');

      const actionSort3 = detectFastPathAction('riwayat 5 terlama');
      expect((actionSort3 as any)?.options.limit).toBe(5);
      expect((actionSort3 as any)?.options.sort).toBe('oldest');

      const actionSort4 = detectFastPathAction('10 transaksi terakhir terlama');
      expect((actionSort4 as any)?.options.limit).toBe(10);
      expect((actionSort4 as any)?.options.sort).toBe('oldest');
    });

    it('rejects recording inputs and invalid syntax', () => {
      expect(detectFastPathAction('beli kopi 25rb')).toBeNull();
      expect(detectFastPathAction('tambah saldo 50k')).toBeNull();
      expect(detectFastPathAction('catat riwayat belanja 50rb')).toBeNull();
      expect(detectFastPathAction('transfer 100k ke bca')).toBeNull();

      const unknownCategoryHistory = detectFastPathAction('history coffee') as any;
      expect(unknownCategoryHistory?.type).toBe('TRANSACTION_HISTORY');
      expect(unknownCategoryHistory?.options.categoryName).toBe('coffee');
      expect(unknownCategoryHistory?.options.searchQuery).toBeUndefined();

      expect(detectFastPathAction('riwayat beli kopi 25rb')).toBeNull();
      expect(detectFastPathAction('history 25k')).toBeNull();
      expect(detectFastPathAction('riwayat belanja 50000')).toBeNull();
      expect(detectFastPathAction('history 10 20')).toBeNull();
      expect(detectFastPathAction('5 transaksi terakhir makanan')).toBeNull();
    });

    it('parses valid history syntax with options', () => {
      const validHistory25 = detectFastPathAction('history 25');
      expect((validHistory25 as any)?.options).toEqual({ limit: 25, page: undefined, sort: 'newest' });

      const validHistoryPage2 = detectFastPathAction('history page 2');
      expect((validHistoryPage2 as any)?.options).toEqual({ limit: undefined, page: 2, sort: 'newest' });

      const validHistory25Oldest = detectFastPathAction('history 25 oldest');
      expect((validHistory25Oldest as any)?.options).toEqual({ limit: 25, page: undefined, sort: 'oldest' });

      const validRiwayat5Hal2Terlama = detectFastPathAction('riwayat 5 hal 2 terlama');
      expect((validRiwayat5Hal2Terlama as any)?.options).toEqual({ limit: 5, page: 2, sort: 'oldest' });
    });

    it('preserves standard fast-path commands', () => {
      expect(detectFastPathAction('saldo')).toBe('CHECK_BALANCE');
      expect(detectFastPathAction('budget')).toBe('CHECK_BUDGET');
      expect(detectFastPathAction('menu')).toBe('HELP_MENU');
    });
  });

  describe('Suite 9: FastPathHandler Integration', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
      queryContext.setNextResponse({
        records: [
          {
            id: 'r1',
            accountId: 'acc-1',
            accountName: 'Cash',
            amount: -15000,
            currency: 'IDR',
            recordDate: '2026-09-11T12:00:00.000Z',
            recordType: 'expense',
            note: 'Kopi',
          },
        ],
        total: 1,
      });
    });

    it('dispatches transaction history fast path end-to-end', async () => {
      setActiveLanguage('id');
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: async (_channel: string, _chatId: string, message: string) => {
          sentMessages.push(message);
        },
      } as any;

      const handler = createTestFastPathHandler({
        walletMcpClient: queryContext.client,
        walletCacheService: queryContext.cache,
        messagingGateway: mockGateway,
        transactionHistoryService: queryContext.service,
      });

      const mockEvent = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'riwayat',
        rawMessageTimestamp: new Date(),
      };

      const action = detectFastPathAction('riwayat');
      const handled = await handler.handleFastPath(mockEvent, action, Date.now());

      expect(handled).toBe(true);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0]).toMatch(/Riwayat Transaksi/);
      expect(sentMessages[0]).toMatch(/Kopi/);
    });
  });
});
