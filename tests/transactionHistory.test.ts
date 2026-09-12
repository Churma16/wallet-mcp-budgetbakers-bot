import assert from 'node:assert';
import {
  WalletMcpClientService,
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  TransactionHistoryPage,
  WalletAccountItem,
  WalletCategoryItem,
} from '../src/types/walletTypes.js';

console.log('[TEST] Starting Transaction History Pagination & Sorting Tests (Issue #100)...');

// Helper to create a mock client with stubbed callMcpTool
function createMockClient() {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let nextResponse: any = { records: [], total: 0 };

  client.callMcpTool = async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    capturedCalls.push({ toolName, args });
    return nextResponse as T;
  };

  return {
    client,
    capturedCalls,
    setNextResponse: (response: any) => {
      nextResponse = response;
    },
  };
}

// -----------------------------------------------------------------------------
// Suite 1: Configurable Limits & Safe Upper Bound
// -----------------------------------------------------------------------------
console.log('\n[Suite 1] Testing Configurable Limits & Safe Upper Bound...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();

  // 1.1 Default limit is 10
  setNextResponse({ records: [], total: 0 });
  await client.fetchRecords();
  assert.strictEqual(capturedCalls.length, 1);
  assert.strictEqual(capturedCalls[0].toolName, 'get_records');
  assert.strictEqual(capturedCalls[0].args.limit, DEFAULT_TRANSACTION_HISTORY_LIMIT);
  assert.strictEqual(capturedCalls[0].args.limit, 10);

  // 1.2 Custom valid limit
  await client.fetchRecords({ limit: 25 });
  assert.strictEqual(capturedCalls[1].args.limit, 25);

  // 1.3 Maximum limit cap at 50
  await client.fetchRecords({ limit: 100 });
  assert.strictEqual(capturedCalls[2].args.limit, MAX_TRANSACTION_HISTORY_LIMIT);
  assert.strictEqual(capturedCalls[2].args.limit, 50);

  // 1.4 Limits <= 0 or invalid normalized to default limit
  await client.fetchRecords({ limit: 0 });
  assert.strictEqual(capturedCalls[3].args.limit, DEFAULT_TRANSACTION_HISTORY_LIMIT);

  await client.fetchRecords({ limit: -10 });
  assert.strictEqual(capturedCalls[4].args.limit, DEFAULT_TRANSACTION_HISTORY_LIMIT);

  await client.fetchRecords({ limit: NaN });
  assert.strictEqual(capturedCalls[5].args.limit, DEFAULT_TRANSACTION_HISTORY_LIMIT);

  // 1.5 Fractional limit floored
  await client.fetchRecords({ limit: 15.8 });
  assert.strictEqual(capturedCalls[6].args.limit, 15);

  console.log('  [PASS] Limits conform to configurable default (10) and hard safety cap (50).');
}

// -----------------------------------------------------------------------------
// Suite 2: Offset & Page-Based Pagination
// -----------------------------------------------------------------------------
console.log('\n[Suite 2] Testing Offset & Page-Based Pagination...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  setNextResponse({ records: [], total: 0 });

  // 2.1 Default offset is 0
  await client.fetchRecords();
  assert.strictEqual(capturedCalls[0].args.offset, 0);

  // 2.2 Explicit offset
  await client.fetchRecords({ offset: 20 });
  assert.strictEqual(capturedCalls[1].args.offset, 20);

  // 2.3 Negative offset normalized to 0
  await client.fetchRecords({ offset: -5 });
  assert.strictEqual(capturedCalls[2].args.offset, 0);

  // 2.4 Page calculation: page 1 -> offset 0
  await client.fetchRecords({ page: 1 });
  assert.strictEqual(capturedCalls[3].args.offset, 0);

  // 2.5 Page calculation: page 2 with default limit (10) -> offset 10
  await client.fetchRecords({ page: 2 });
  assert.strictEqual(capturedCalls[4].args.offset, 10);

  // 2.6 Page calculation: page 3 with limit 5 -> offset 10
  await client.fetchRecords({ page: 3, limit: 5 });
  assert.strictEqual(capturedCalls[5].args.offset, 10);

  // 2.7 Explicit offset takes precedence when provided
  await client.fetchRecords({ offset: 15, page: 4 });
  assert.strictEqual(capturedCalls[6].args.offset, 15);

  console.log('  [PASS] Offset and page-based pagination calculations verified.');
}

// -----------------------------------------------------------------------------
// Suite 3: Deterministic Sorting
// -----------------------------------------------------------------------------
console.log('\n[Suite 3] Testing Deterministic Sorting...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  setNextResponse({ records: [], total: 0 });

  // 3.1 Default sort is newest-first with createdAt tie-breaker
  await client.fetchRecords();
  assert.deepStrictEqual(capturedCalls[0].args.sortBy, ['-recordDate', '-createdAt']);

  // 3.2 Explicit newest-first
  await client.fetchRecords({ sort: 'newest' });
  assert.deepStrictEqual(capturedCalls[1].args.sortBy, ['-recordDate', '-createdAt']);

  // 3.3 Explicit oldest-first
  await client.fetchRecords({ sort: 'oldest' });
  assert.deepStrictEqual(capturedCalls[2].args.sortBy, ['+recordDate', '+createdAt']);

  console.log('  [PASS] Deterministic sorting orders verified for newest and oldest.');
}

// -----------------------------------------------------------------------------
// Suite 4: Pagination Metadata & Multi-Page Navigation
// -----------------------------------------------------------------------------
console.log('\n[Suite 4] Testing Pagination Metadata & Multi-Page Navigation...');
{
  const { client, setNextResponse } = createMockClient();

  const sampleRawRecords = Array.from({ length: 10 }, (_, index) => ({
    id: `rec-${index + 1}`,
    accountId: 'acc-1',
    accountName: 'BCA Prioritas',
    amount: { value: -25000 * (index + 1), currencyCode: 'IDR' },
    recordDate: '2026-09-11T10:00:00.000Z',
    recordType: 'expense',
    note: `Belanja item ${index + 1}`,
  }));

  // 4.1 Page 1 of 5 (total 45, limit 10, offset 0)
  setNextResponse({
    records: sampleRawRecords,
    total: 45,
    nextOffset: 10,
  });

  const page1 = await client.fetchRecords({ limit: 10, offset: 0 });
  assert.strictEqual(page1.records.length, 10);
  assert.strictEqual(page1.total, 45);
  assert.strictEqual(page1.page, 1);
  assert.strictEqual(page1.totalPages, 5);
  assert.strictEqual(page1.hasMore, true);
  assert.strictEqual(page1.nextOffset, 10);

  // 4.2 Page 2 of 5 (total 45, limit 10, offset 10)
  setNextResponse({
    records: sampleRawRecords,
    total: 45,
    nextOffset: 20,
  });

  const page2 = await client.fetchRecords({ limit: 10, offset: 10 });
  assert.strictEqual(page2.page, 2);
  assert.strictEqual(page2.totalPages, 5);
  assert.strictEqual(page2.hasMore, true);
  assert.strictEqual(page2.nextOffset, 20);

  // 4.3 Last Page (offset 40, 5 records, total 45)
  setNextResponse({
    records: sampleRawRecords.slice(0, 5),
    total: 45,
    nextOffset: null,
  });

  const lastPage = await client.fetchRecords({ limit: 10, offset: 40 });
  assert.strictEqual(lastPage.records.length, 5);
  assert.strictEqual(lastPage.page, 5);
  assert.strictEqual(lastPage.totalPages, 5);
  assert.strictEqual(lastPage.hasMore, false);
  assert.strictEqual(lastPage.nextOffset, null);

  // 4.4 Response with records + nextOffset but no total (Issue #105 review)
  setNextResponse({
    records: sampleRawRecords,
    nextOffset: 10,
  });

  const pageWithoutTotal = await client.fetchRecords({ limit: 10, offset: 0 });
  assert.strictEqual(pageWithoutTotal.records.length, 10);
  assert.strictEqual(pageWithoutTotal.total, undefined);
  assert.strictEqual(pageWithoutTotal.totalPages, undefined);
  assert.strictEqual(pageWithoutTotal.hasMore, true);
  assert.strictEqual(pageWithoutTotal.nextOffset, 10);

  // Formatter displays navigation hint based on hasMore
  setActiveLanguage('id');
  const formattedWithoutTotalId = formatTransactionHistoryMessage(pageWithoutTotal);
  assert.match(formattedWithoutTotalId, /riwayat hal 2/);

  setActiveLanguage('en');
  const formattedWithoutTotalEn = formatTransactionHistoryMessage(pageWithoutTotal);
  assert.match(formattedWithoutTotalEn, /history page 2/);

  // 4.5 Last-page case with no nextOffset and no total
  setNextResponse({
    records: sampleRawRecords.slice(0, 5),
  });

  const lastPageWithoutTotal = await client.fetchRecords({ limit: 10, offset: 10 });
  assert.strictEqual(lastPageWithoutTotal.records.length, 5);
  assert.strictEqual(lastPageWithoutTotal.total, undefined);
  assert.strictEqual(lastPageWithoutTotal.totalPages, undefined);
  assert.strictEqual(lastPageWithoutTotal.hasMore, false);
  assert.strictEqual(lastPageWithoutTotal.nextOffset, null);

  // Formatter omits navigation hint when hasMore is false
  const formattedLastPageWithoutTotal = formatTransactionHistoryMessage(lastPageWithoutTotal);
  assert.doesNotMatch(formattedLastPageWithoutTotal, /riwayat hal/);

  console.log('  [PASS] Pagination navigation and metadata calculations verified.');
}

// -----------------------------------------------------------------------------
// Suite 5: Empty Pages & End-of-History Behavior
// -----------------------------------------------------------------------------
console.log('\n[Suite 5] Testing Empty Pages & End-of-History Behavior...');
{
  const { client, setNextResponse } = createMockClient();

  // 5.1 Empty history (total 0)
  setNextResponse({ records: [], total: 0 });
  const emptyResult = await client.fetchRecords();
  assert.strictEqual(emptyResult.records.length, 0);
  assert.strictEqual(emptyResult.total, 0);
  assert.strictEqual(emptyResult.hasMore, false);
  assert.strictEqual(emptyResult.nextOffset, null);

  setActiveLanguage('id');
  const emptyFormattedId = formatTransactionHistoryMessage(emptyResult);
  assert.match(emptyFormattedId, /Belum ada transaksi yang tercatat/);

  setActiveLanguage('en');
  const emptyFormattedEn = formatTransactionHistoryMessage(emptyResult);
  assert.match(emptyFormattedEn, /No transactions recorded yet/);

  // 5.2 Out-of-bounds offset (offset >= total)
  setNextResponse({ records: [], total: 20 });
  const outOfBoundsResult = await client.fetchRecords({ offset: 30, limit: 10 });
  assert.strictEqual(outOfBoundsResult.records.length, 0);
  assert.strictEqual(outOfBoundsResult.hasMore, false);
  assert.strictEqual(outOfBoundsResult.nextOffset, null);

  setActiveLanguage('id');
  const outOfBoundsFormattedId = formatTransactionHistoryMessage(outOfBoundsResult);
  assert.match(outOfBoundsFormattedId, /Halaman ini melebihi jumlah transaksi/);

  setActiveLanguage('en');
  const outOfBoundsFormattedEn = formatTransactionHistoryMessage(outOfBoundsResult);
  assert.match(outOfBoundsFormattedEn, /This page exceeds available transactions/);

  console.log('  [PASS] Empty states and out-of-bounds page handling verified.');
}

// -----------------------------------------------------------------------------
// Suite 6: Data Normalization & Cache Enrichment
// -----------------------------------------------------------------------------
console.log('\n[Suite 6] Testing Data Normalization & Cache Enrichment...');
{
  const { client, setNextResponse } = createMockClient();

  const mockCachedAccounts: WalletAccountItem[] = [
    { id: 'acc-uuid-1', name: 'Bank Jago Main', currency: 'IDR', balance: 1000000 },
  ];
  const mockCachedCategories: WalletCategoryItem[] = [
    { id: 'cat-uuid-1', name: 'Kebutuhan Harian' },
  ];

  const mockCacheService = {
    getAccounts: () => mockCachedAccounts,
    getCategories: () => mockCachedCategories,
  } as unknown as WalletCacheService;

  const historyService = new TransactionHistoryService(client, mockCacheService);

  // Upstream returns raw record without accountName and with category ID only
  setNextResponse({
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

  const enrichedResult = await historyService.getTransactionHistory();
  assert.strictEqual(enrichedResult.records.length, 1);
  const record = enrichedResult.records[0];

  assert.strictEqual(record.accountName, 'Bank Jago Main', 'Account name must be enriched from cache');
  assert.strictEqual(record.category?.name, 'Kebutuhan Harian', 'Category name must be enriched from cache');
  assert.strictEqual(record.amount, -50000);
  assert.strictEqual(record.labels?.[0]?.name, 'groceries');

  console.log('  [PASS] Record normalization and cache enrichment verified.');
}

// -----------------------------------------------------------------------------
// Suite 7: Human-Facing Response Formatting (i18n)
// -----------------------------------------------------------------------------
console.log('\n[Suite 7] Testing Human-Facing Response Formatting (i18n)...');
{
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

  // Indonesian
  setActiveLanguage('id');
  const formattedId = formatTransactionHistoryMessage(samplePage);
  assert.match(formattedId, /Riwayat Transaksi/);
  assert.match(formattedId, /Hal\. 1\/2 • 2 item/);
  assert.match(formattedId, /1\. Nasi Goreng/);
  assert.match(formattedId, /\*-Rp25\.000\* • BCA Prioritas/);
  assert.match(formattedId, /2\. Bonus Freelance/);
  assert.match(formattedId, /\*\+Rp500\.000\* • BCA Prioritas/);
  assert.match(formattedId, /#lunch/);
  assert.doesNotMatch(formattedId, /[💸💰🔄🏷️🔖]/u);
  assert.match(formattedId, /riwayat hal 2/);

  // English
  setActiveLanguage('en');
  const formattedEn = formatTransactionHistoryMessage(samplePage);
  assert.match(formattedEn, /Transaction History/);
  assert.match(formattedEn, /Page 1\/2 • 2 items/);
  assert.match(formattedEn, /1\. Nasi Goreng/);
  assert.match(formattedEn, /\*-Rp25,000\* • BCA Prioritas/);
  assert.match(formattedEn, /2\. Bonus Freelance/);
  assert.match(formattedEn, /\*\+Rp500,000\* • BCA Prioritas/);
  assert.match(formattedEn, /history page 2/);

  // Oldest sort indicator
  const oldestPage: TransactionHistoryPage = {
    ...samplePage,
    sort: 'oldest',
  };

  setActiveLanguage('id');
  assert.match(formatTransactionHistoryMessage(oldestPage), /\[Terlama\]/);

  setActiveLanguage('en');
  assert.match(formatTransactionHistoryMessage(oldestPage), /\[Oldest\]/);

  // 7.4 Preservation of query options in navigation hints
  const customQueryPage: TransactionHistoryPage = {
    ...samplePage,
    limit: 5,
    sort: 'oldest',
  };

  // Indonesian: starts from { limit: 5, sort: 'oldest' }
  setActiveLanguage('id');
  const formattedCustomId = formatTransactionHistoryMessage(customQueryPage);
  const idMatch = formattedCustomId.match(/_Ketik \*(.+?)\* untuk halaman selanjutnya\._/);
  assert.ok(idMatch, 'Indonesian next-page hint must exist');
  const idNextCommand = idMatch[1];
  assert.strictEqual(idNextCommand, 'riwayat 5 hal 2 terlama');

  const parsedIdAction = detectFastPathAction(idNextCommand);
  assert.strictEqual(typeof parsedIdAction, 'object');
  assert.strictEqual((parsedIdAction as any)?.type, 'TRANSACTION_HISTORY');
  assert.deepStrictEqual((parsedIdAction as any)?.options, {
    limit: 5,
    page: 2,
    sort: 'oldest',
  });

  // English: starts from { limit: 5, sort: 'oldest' }
  setActiveLanguage('en');
  const formattedCustomEn = formatTransactionHistoryMessage(customQueryPage);
  const enMatch = formattedCustomEn.match(/_Type \*(.+?)\* for the next page\._/);
  assert.ok(enMatch, 'English next-page hint must exist');
  const enNextCommand = enMatch[1];
  assert.strictEqual(enNextCommand, 'history 5 page 2 oldest');

  const parsedEnAction = detectFastPathAction(enNextCommand);
  assert.strictEqual(typeof parsedEnAction, 'object');
  assert.strictEqual((parsedEnAction as any)?.type, 'TRANSACTION_HISTORY');
  assert.deepStrictEqual((parsedEnAction as any)?.options, {
    limit: 5,
    page: 2,
    sort: 'oldest',
  });

  console.log('  [PASS] Human-facing response formatters verified in Indonesian and English.');
}

// -----------------------------------------------------------------------------
// Suite 8: Fast-Path Intent Detection
// -----------------------------------------------------------------------------
console.log('\n[Suite 8] Testing Fast-Path Intent Detection...');
{
  // 8.1 Basic keywords
  const action1 = detectFastPathAction('riwayat');
  assert.strictEqual(typeof action1, 'object');
  assert.strictEqual((action1 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((action1 as any)?.options.sort, 'newest');

  const action2 = detectFastPathAction('history');
  assert.strictEqual((action2 as any)?.type, 'TRANSACTION_HISTORY');

  const action3 = detectFastPathAction('transaksi terakhir');
  assert.strictEqual((action3 as any)?.type, 'TRANSACTION_HISTORY');

  const action4 = detectFastPathAction('recent transactions');
  assert.strictEqual((action4 as any)?.type, 'TRANSACTION_HISTORY');

  // 8.2 Parameterized limit
  const actionLimit1 = detectFastPathAction('riwayat 5');
  assert.strictEqual((actionLimit1 as any)?.options.limit, 5);

  const actionLimit2 = detectFastPathAction('history 20');
  assert.strictEqual((actionLimit2 as any)?.options.limit, 20);

  const actionLimit3 = detectFastPathAction('10 transaksi terakhir');
  assert.strictEqual((actionLimit3 as any)?.options.limit, 10);

  const actionLimit4 = detectFastPathAction('5 recent transactions');
  assert.strictEqual((actionLimit4 as any)?.options.limit, 5);

  // 8.3 Parameterized page
  const actionPage1 = detectFastPathAction('riwayat hal 2');
  assert.strictEqual((actionPage1 as any)?.options.page, 2);

  const actionPage2 = detectFastPathAction('history page 3');
  assert.strictEqual((actionPage2 as any)?.options.page, 3);

  // 8.4 Combined limit and page
  const actionCombined = detectFastPathAction('riwayat 5 hal 2');
  assert.strictEqual((actionCombined as any)?.options.limit, 5);
  assert.strictEqual((actionCombined as any)?.options.page, 2);

  // 8.5 Sorting
  const actionSort1 = detectFastPathAction('riwayat terlama');
  assert.strictEqual((actionSort1 as any)?.options.sort, 'oldest');

  const actionSort2 = detectFastPathAction('history oldest');
  assert.strictEqual((actionSort2 as any)?.options.sort, 'oldest');

  const actionSort3 = detectFastPathAction('riwayat 5 terlama');
  assert.strictEqual((actionSort3 as any)?.options.limit, 5);
  assert.strictEqual((actionSort3 as any)?.options.sort, 'oldest');

  const actionSort4 = detectFastPathAction('10 transaksi terakhir terlama');
  assert.strictEqual((actionSort4 as any)?.options.limit, 10);
  assert.strictEqual((actionSort4 as any)?.options.sort, 'oldest');

  // 8.6 Negative cases: transaction recordings and unsupported trailing text must NOT produce TRANSACTION_HISTORY
  assert.strictEqual(detectFastPathAction('beli kopi 25rb'), null);
  assert.strictEqual(detectFastPathAction('tambah saldo 50k'), null);
  assert.strictEqual(detectFastPathAction('catat riwayat belanja 50rb'), null);
  assert.strictEqual(detectFastPathAction('transfer 100k ke bca'), null);

  // Exact regressions requested by review:
  assert.strictEqual(detectFastPathAction('history coffee'), null);
  assert.strictEqual(detectFastPathAction('riwayat beli kopi 25rb'), null);
  assert.strictEqual(detectFastPathAction('history 25k'), null);
  assert.strictEqual(detectFastPathAction('riwayat belanja 50000'), null);
  assert.strictEqual(detectFastPathAction('history 10 20'), null);
  assert.strictEqual(detectFastPathAction('5 transaksi terakhir makanan'), null);

  // 8.7 Valid history syntax remains valid:
  const validHistory25 = detectFastPathAction('history 25');
  assert.deepStrictEqual((validHistory25 as any)?.options, { limit: 25, page: undefined, sort: 'newest' });

  const validHistoryPage2 = detectFastPathAction('history page 2');
  assert.deepStrictEqual((validHistoryPage2 as any)?.options, { limit: undefined, page: 2, sort: 'newest' });

  const validHistory25Oldest = detectFastPathAction('history 25 oldest');
  assert.deepStrictEqual((validHistory25Oldest as any)?.options, { limit: 25, page: undefined, sort: 'oldest' });

  const validRiwayat5Hal2Terlama = detectFastPathAction('riwayat 5 hal 2 terlama');
  assert.deepStrictEqual((validRiwayat5Hal2Terlama as any)?.options, { limit: 5, page: 2, sort: 'oldest' });

  // 8.8 Standard fast-path commands must not regress
  assert.strictEqual(detectFastPathAction('saldo'), 'CHECK_BALANCE');
  assert.strictEqual(detectFastPathAction('budget'), 'CHECK_BUDGET');
  assert.strictEqual(detectFastPathAction('menu'), 'HELP_MENU');

  console.log('  [PASS] Fast-path intent detection verified for all syntax variations.');
}

// -----------------------------------------------------------------------------
// Suite 9: FastPathHandler Integration
// -----------------------------------------------------------------------------
console.log('\n[Suite 9] Testing FastPathHandler Integration...');
{
  setActiveLanguage('id');
  const { client, setNextResponse } = createMockClient();
  setNextResponse({
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

  const sentMessages: string[] = [];
  const mockGateway = {
    sendMessage: async (_channel: string, _chatId: string, message: string) => {
      sentMessages.push(message);
    },
  } as any;

  const mockCache = {
    getAccounts: () => [],
    getCategories: () => [],
    refreshAccounts: async () => [],
  } as any;

  const handler = new FastPathHandler(client, mockCache, mockGateway);

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

  assert.strictEqual(handled, true, 'FastPathHandler must return true for handled action');
  assert.strictEqual(sentMessages.length, 1, 'FastPathHandler must send reply message');
  assert.match(sentMessages[0], /Riwayat Transaksi/);
  assert.match(sentMessages[0], /Kopi/);

  console.log('  [PASS] FastPathHandler integration verified end-to-end.');
}

console.log('\n[SUCCESS] All Transaction History tests passed cleanly!\n');
