import assert from 'node:assert';
import test from 'node:test';
import {
  WalletMcpClientService,
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import {
  matchesTransactionRecordSearch,
  MAX_SEARCH_QUERY_LENGTH,
} from '../src/utils/transactionSearchMatcher.js';
import { normalizeTransactionHistoryFilters } from '../src/utils/transactionHistoryFilterNormalizer.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
  TransactionHistoryPage,
} from '../src/types/walletTypes.js';

const ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca', name: 'BCA Tabungan', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash Dompet', currency: 'IDR' },
];

const CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Makanan & Minuman' },
  { id: 'cat-transport', name: 'Transportasi' },
];

const REFERENCE_DATE = new Date('2026-09-11T12:00:00Z');

function createMockClient() {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const calls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let response: any = { records: [], total: 0 };
  let error: Error | null = null;

  client.callMcpTool = async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    calls.push({ toolName, args });
    if (error) throw error;
    return response as T;
  };

  return {
    client,
    calls,
    setResponse(value: any) {
      response = value;
      error = null;
    },
    setError(value: Error) {
      error = value;
    },
  };
}

function createCache(client: WalletMcpClientService): WalletCacheService {
  const cache = new WalletCacheService(client);
  (cache as any).cachedAccountList = [...ACCOUNTS];
  (cache as any).cachedCategoryList = [...CATEGORIES];
  (cache as any).cachedLabelList = [];
  return cache;
}

const RECORDS: WalletRecordItem[] = [
  {
    id: 'rec-1',
    accountId: 'acc-bca',
    amount: -45000,
    currency: 'IDR',
    recordDate: '2026-09-11T10:00:00Z',
    recordType: 'expense',
    counterParty: 'Starbucks Reserve',
    note: 'Caramel Macchiato',
  },
  {
    id: 'rec-2',
    accountId: 'acc-cash',
    amount: -15000,
    currency: 'IDR',
    recordDate: '2026-09-11T11:00:00Z',
    recordType: 'expense',
    counterParty: 'Indomaret Point',
  },
  {
    id: 'rec-3',
    accountId: 'acc-bca',
    amount: -30000,
    currency: 'IDR',
    recordDate: '2026-09-11T12:00:00Z',
    recordType: 'expense',
    note: 'Beli nasi padang rendang',
  },
  {
    id: 'rec-4',
    accountId: 'acc-bca',
    amount: 1000000,
    currency: 'IDR',
    recordDate: '2026-09-11T13:00:00Z',
    recordType: 'income',
  },
];

test('Suite 1: search matcher and production pipeline semantics', async () => {
  assert.strictEqual(matchesTransactionRecordSearch(RECORDS[0], 'STARBUCKS'), true);
  assert.strictEqual(matchesTransactionRecordSearch(RECORDS[0], 'macchiato'), true);
  assert.strictEqual(matchesTransactionRecordSearch(RECORDS[2], 'nasi padang'), true);
  assert.strictEqual(matchesTransactionRecordSearch(RECORDS[3], 'starbucks'), false);
  assert.strictEqual(matchesTransactionRecordSearch(RECORDS[0], '   '), false);

  const { client, calls, setResponse } = createMockClient();
  setResponse({ records: RECORDS, total: RECORDS.length });

  const merchant = await client.fetchRecords({ searchQuery: 'sTaRbUcKs' });
  assert.strictEqual(calls[0].args.query, 'sTaRbUcKs');
  assert.deepStrictEqual(merchant.records.map(item => item.id), ['rec-1']);

  const note = await client.fetchRecords({ searchQuery: 'PADANG' });
  assert.deepStrictEqual(note.records.map(item => item.id), ['rec-3']);

  const service = new TransactionHistoryService(client, createCache(client));
  const serviceResult = await service.getTransactionHistory({ searchQuery: 'Indomaret' });
  assert.deepStrictEqual(serviceResult.records.map(item => item.id), ['rec-2']);
  assert.strictEqual(serviceResult.appliedFilters?.searchQuery, 'Indomaret');
});

test('Suite 2: search query normalization validates empty and oversized values', () => {
  const valid = normalizeTransactionHistoryFilters(
    { searchQuery: '  starbucks coffee  ' },
    ACCOUNTS,
    CATEGORIES,
    REFERENCE_DATE
  );
  assert.strictEqual(valid.isValid, true);
  assert.strictEqual(valid.normalizedOptions.searchQuery, 'starbucks coffee');
  assert.ok(valid.appliedFilters.navigationTokens?.includes('cari "starbucks coffee"'));

  const empty = normalizeTransactionHistoryFilters(
    { searchQuery: '   ' },
    ACCOUNTS,
    CATEGORIES,
    REFERENCE_DATE
  );
  assert.strictEqual(empty.isValid, false);
  assert.strictEqual(empty.unresolvedFilters[0].filterKey, 'searchQuery');
  assert.strictEqual(empty.unresolvedFilters[0].reason, 'INVALID_FORMAT');

  const tooLong = normalizeTransactionHistoryFilters(
    { searchQuery: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) },
    ACCOUNTS,
    CATEGORIES,
    REFERENCE_DATE
  );
  assert.strictEqual(tooLong.isValid, false);

  const exactMax = normalizeTransactionHistoryFilters(
    { searchQuery: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH) },
    ACCOUNTS,
    CATEGORIES,
    REFERENCE_DATE
  );
  assert.strictEqual(exactMax.isValid, true);
});

test('Suite 3: upstream query dispatch and query-specific error classification', async () => {
  const { client, calls, setResponse, setError } = createMockClient();
  const service = new TransactionHistoryService(client, createCache(client));

  setResponse({ records: [RECORDS[0]], total: 1 });
  const page = await service.getTransactionHistory({ searchQuery: 'Starbucks' });
  assert.strictEqual(calls[0].args.query, 'Starbucks');
  assert.strictEqual(page.records.length, 1);

  setError(new Error('Wallet MCP Error: search query not supported by upstream data source'));
  const unsupported = await service.getTransactionHistory({ searchQuery: 'Unsupported Query' });
  assert.strictEqual(unsupported.records.length, 0);
  assert.strictEqual(unsupported.unresolvedFilters?.[0].reason, 'UNSUPPORTED');
  assert.strictEqual(unsupported.unresolvedFilters?.[0].subType, 'unsupported_upstream_search');

  setError(new Error('MCP Error: unknown parameter: query'));
  const unknownQuery = await service.getTransactionHistory({ searchQuery: 'Unknown Query' });
  assert.strictEqual(unknownQuery.unresolvedFilters?.[0].reason, 'UNSUPPORTED');

  setError(new Error('unsupported category filter'));
  await assert.rejects(
    service.getTransactionHistory({ searchQuery: 'Category Error', categoryName: 'Makanan & Minuman' }),
    /unsupported category filter/
  );

  setError(new Error('Network timeout: ECONNRESET'));
  await assert.rejects(
    service.getTransactionHistory({ searchQuery: 'Network Error' }),
    /ECONNRESET/
  );
});

test('Suite 4: search composes with account, category, type, date, sort, and limit', async () => {
  const { client, calls, setResponse } = createMockClient();
  const service = new TransactionHistoryService(client, createCache(client));
  setResponse({ records: [], total: 0 });

  await service.getTransactionHistory({ searchQuery: 'Starbucks', accountName: 'BCA' });
  assert.strictEqual(calls[0].args.accountId, 'acc-bca');

  await service.getTransactionHistory({ searchQuery: 'Indomaret', categoryName: 'Makanan & Minuman' });
  assert.deepStrictEqual(calls[1].args.categoryId, ['cat-food']);

  await service.getTransactionHistory({ searchQuery: 'Bonus', recordType: 'income' });
  assert.strictEqual(calls[2].args.recordType, 'income');

  await service.getTransactionHistory(
    { searchQuery: 'Kopi', datePeriod: 'this_month' },
    REFERENCE_DATE
  );
  assert.ok(Array.isArray(calls[3].args.recordDate));

  const combined = await service.getTransactionHistory(
    {
      searchQuery: 'Pertamax',
      accountName: 'Cash Dompet',
      categoryName: 'Transportasi',
      recordType: 'expense',
      startDate: '2026-09-01',
      endDate: '2026-09-10',
      limit: 20,
      sort: 'oldest',
    },
    REFERENCE_DATE
  );
  const args = calls[4].args;
  assert.strictEqual(args.query, 'Pertamax');
  assert.strictEqual(args.accountId, 'acc-cash');
  assert.deepStrictEqual(args.categoryId, ['cat-transport']);
  assert.strictEqual(args.recordType, 'expense');
  assert.strictEqual(args.limit, 20);
  assert.deepStrictEqual(args.sortBy, ['+recordDate', '+createdAt']);
  assert.strictEqual(combined.appliedFilters?.searchQuery, 'Pertamax');
});

test('Suite 5: pagination hints round-trip and search limit stays capped', async () => {
  const sample: TransactionHistoryPage = {
    records: [RECORDS[0]],
    total: 25,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 3,
    nextOffset: 10,
    hasMore: true,
    sort: 'newest',
    appliedFilters: {
      searchQuery: 'Starbucks',
      navigationTokens: ['cari "Starbucks"'],
    },
  };

  setActiveLanguage('id');
  const idMessage = formatTransactionHistoryMessage(sample);
  assert.match(idMessage, /Cari: "Starbucks"/);
  assert.match(idMessage, /riwayat cari "Starbucks" hal 2/);

  setActiveLanguage('en');
  const enMessage = formatTransactionHistoryMessage(sample);
  assert.match(enMessage, /Search: "Starbucks"/);
  assert.match(enMessage, /history search "Starbucks" page 2/);

  const roundTrip = detectFastPathAction('history search "Starbucks" page 2');
  assert.strictEqual((roundTrip as any)?.options.page, 2);
  assert.strictEqual((roundTrip as any)?.options.searchQuery, 'Starbucks');

  const { client, calls, setResponse } = createMockClient();
  setResponse({ records: [], total: 0 });
  await client.fetchRecords({ searchQuery: 'Starbucks', limit: 100 });
  assert.strictEqual(calls[0].args.limit, MAX_TRANSACTION_HISTORY_LIMIT);
});

test('Suite 6: fast-path search parsing preserves literals and structured modifiers', () => {
  assert.strictEqual((detectFastPathAction('cari starbucks') as any)?.options.searchQuery, 'starbucks');
  assert.strictEqual((detectFastPathAction('find supermarket') as any)?.options.searchQuery, 'supermarket');
  assert.strictEqual((detectFastPathAction('cari "Kopi Kenangan"') as any)?.options.searchQuery, 'Kopi Kenangan');
  assert.strictEqual((detectFastPathAction('riwayat cari starbucks') as any)?.options.searchQuery, 'starbucks');
  assert.strictEqual((detectFastPathAction('riwayat "starbucks"') as any)?.options.searchQuery, 'starbucks');
  assert.strictEqual(detectFastPathAction('riwayat starbucks'), null);

  const composed = detectFastPathAction('cari indomaret di bca bulan ini') as any;
  assert.strictEqual(composed?.options.searchQuery, 'indomaret');
  assert.strictEqual(composed?.options.accountName, 'bca');
  assert.strictEqual(composed?.options.datePeriod, 'this_month');

  const composedEn = detectFastPathAction('search coffee expense 5 page 2') as any;
  assert.strictEqual(composedEn?.options.searchQuery, 'coffee');
  assert.strictEqual(composedEn?.options.recordType, 'expense');
  assert.strictEqual(composedEn?.options.limit, 5);
  assert.strictEqual(composedEn?.options.page, 2);

  assert.strictEqual((detectFastPathAction('cari Kopi di Taman') as any)?.options.searchQuery, 'Kopi di Taman');
  assert.strictEqual((detectFastPathAction('search Coffee in Town') as any)?.options.searchQuery, 'Coffee in Town');

  assert.strictEqual(detectFastPathAction('beli kopi 25rb'), null);
  assert.strictEqual(detectFastPathAction('transfer 100000 ke bca'), null);
  assert.strictEqual(detectFastPathAction('cari'), null);
});

test('Suite 7: empty search and unresolved search errors are localized', () => {
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
    appliedFilters: { searchQuery: 'Restoran Mewah' },
  };

  setActiveLanguage('id');
  assert.match(
    formatTransactionHistoryMessage(emptyPage),
    /Belum ada transaksi yang cocok dengan filter \[Cari: "Restoran Mewah"\]/
  );

  setActiveLanguage('en');
  assert.match(
    formatTransactionHistoryMessage(emptyPage),
    /No transactions match the filter \[Search: "Restoran Mewah"\]/
  );

  const unresolved: TransactionHistoryPage = {
    ...emptyPage,
    unresolvedFilters: [{
      filterKey: 'searchQuery',
      rawValue: 'Starbucks',
      reason: 'UNSUPPORTED',
      message: 'Pencarian teks tidak didukung oleh sumber data upstream.',
    }],
  };
  const englishError = formatTransactionHistoryMessage(unresolved, 'en');
  assert.match(englishError, /Text search is not supported by the upstream data source/);
  assert.strictEqual(englishError.toLowerCase().includes('pencarian'), false);
});

test('Suite 8: FastPathHandler dispatches search end-to-end', async () => {
  setActiveLanguage('id');
  const { client, setResponse } = createMockClient();
  setResponse({
    records: [{
      ...RECORDS[0],
      accountName: 'BCA Tabungan',
      counterParty: 'Kopi Kenangan',
      note: 'Kopi Kenangan Mantan Regular',
    }],
    total: 1,
  });

  const sent: string[] = [];
  const gateway = {
    sendMessage: async (_channel: string, _chatId: string, message: string) => {
      sent.push(message);
    },
  } as any;
  const cache = {
    getAccounts: () => ACCOUNTS,
    getCategories: () => CATEGORIES,
    refreshAccounts: async () => ACCOUNTS,
  } as any;

  const handler = new FastPathHandler(client, cache, gateway);
  const event = {
    channel: 'whatsapp' as const,
    chatIdentifier: '123456@s.whatsapp.net',
    senderIdentifier: '123456',
    messageType: 'text' as const,
    textPayload: 'cari kopi',
    rawMessageTimestamp: new Date(),
  };

  const handled = await handler.handleFastPath(
    event,
    detectFastPathAction('cari kopi'),
    Date.now()
  );
  assert.strictEqual(handled, true);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0], /Cari: "kopi"/);
  assert.match(sent[0], /Kopi Kenangan/);
});

console.log('[SUCCESS] Transaction History Text Search tests passed.');
