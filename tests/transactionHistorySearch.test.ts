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

console.log('[TEST] Starting Transaction History Text Search Tests (Issue #102)...');

// Mock accounts & categories
const MOCK_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca-001', name: 'BCA Tabungan', currency: 'IDR', bankAccountNumber: '1234567890' },
  { id: 'acc-mandiri-002', name: 'Mandiri Utama', currency: 'IDR', bankAccountNumber: '9876543210' },
  { id: 'acc-cash-003', name: 'Cash Dompet', currency: 'IDR' },
];

const MOCK_CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food-001', name: 'Makanan & Minuman' },
  { id: 'cat-transport-002', name: 'Transportasi' },
  { id: 'cat-bills-003', name: 'Tagihan Listrik' },
];

const FIXED_TEST_REFERENCE_DATE = new Date('2026-09-11T12:00:00Z');

function createMockClient() {
  const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
  const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];
  let nextResponse: any = { records: [], total: 0 };
  let shouldThrowError: Error | null = null;

  client.callMcpTool = async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
    capturedCalls.push({ toolName, args });
    if (shouldThrowError) {
      throw shouldThrowError;
    }
    return nextResponse as T;
  };

  return {
    client,
    capturedCalls,
    setNextResponse: (response: any) => {
      nextResponse = response;
      shouldThrowError = null;
    },
    setThrowError: (error: Error) => {
      shouldThrowError = error;
    },
  };
}

function createSeededCacheService(client: WalletMcpClientService): WalletCacheService {
  const cache = new WalletCacheService(client);
  (cache as any).cachedAccountList = [...MOCK_ACCOUNTS];
  (cache as any).cachedCategoryList = [...MOCK_CATEGORIES];
  (cache as any).cachedLabelList = [];
  return cache;
}

// -----------------------------------------------------------------------------
// Suite 1: Search Matcher Unit Semantics (Payee, Note, Case & Partial Matching)
// -----------------------------------------------------------------------------
console.log('\n[Suite 1] Testing Search Matcher Unit Semantics...');
{
  const sampleRecordWithPayeeAndNote: WalletRecordItem = {
    id: 'rec-1',
    accountId: 'acc-bca-001',
    amount: -45000,
    currency: 'IDR',
    recordDate: '2026-09-11T10:00:00Z',
    recordType: 'expense',
    counterParty: 'Starbucks Reserve',
    note: 'Caramel Macchiato with Oat Milk',
  };

  const sampleRecordWithPayeeOnly: WalletRecordItem = {
    id: 'rec-2',
    accountId: 'acc-cash-003',
    amount: -15000,
    currency: 'IDR',
    recordDate: '2026-09-11T11:00:00Z',
    recordType: 'expense',
    counterParty: 'Indomaret Point',
  };

  const sampleRecordWithNoteOnly: WalletRecordItem = {
    id: 'rec-3',
    accountId: 'acc-bca-001',
    amount: -30000,
    currency: 'IDR',
    recordDate: '2026-09-11T12:00:00Z',
    recordType: 'expense',
    note: 'Beli nasi padang rendang',
  };

  const sampleRecordWithNeither: WalletRecordItem = {
    id: 'rec-4',
    accountId: 'acc-mandiri-002',
    amount: 1000000,
    currency: 'IDR',
    recordDate: '2026-09-11T13:00:00Z',
    recordType: 'income',
  };

  // 1.1 Exact match on counterParty / merchant
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'Starbucks Reserve'),
    true,
    'Exact match on counterParty must return true'
  );

  // 1.2 Substring / partial match on counterParty
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'starbucks'),
    true,
    'Partial match on counterParty must return true'
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeOnly, 'indomaret'),
    true,
    'Partial match on counterParty must return true'
  );

  // 1.3 Exact match on note
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'Caramel Macchiato with Oat Milk'),
    true,
    'Exact match on note must return true'
  );

  // 1.4 Substring / partial match on note
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'macchiato'),
    true,
    'Partial match on note must return true'
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithNoteOnly, 'nasi padang'),
    true,
    'Partial match on note must return true'
  );

  // 1.5 Case-insensitivity (uppercase, lowercase, mixed case)
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'STARBUCKS'),
    true,
    'Uppercase query must match mixed-case merchant'
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'oat milk'),
    true,
    'Lowercase query must match mixed-case note'
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'StArBuCkS'),
    true,
    'Alternating case query must match'
  );

  // 1.6 Record with payee only correctly matches payee and rejects unmatched note
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeOnly, 'indomaret'),
    true
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeOnly, 'kopi'),
    false
  );

  // 1.7 Record with note only correctly matches note and rejects unmatched payee
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithNoteOnly, 'rendang'),
    true
  );
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithNoteOnly, 'starbucks'),
    false
  );

  // 1.8 Record without payee or note returns false
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithNeither, 'starbucks'),
    false,
    'Record without payee or note must return false'
  );

  // 1.9 Non-matching query returns false
  assert.strictEqual(
    matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, 'mcdonalds'),
    false
  );

  // 1.10 Empty or whitespace-only search query returns false
  assert.strictEqual(matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, ''), false);
  assert.strictEqual(matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, '   '), false);
  assert.strictEqual(matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, null as any), false);
  assert.strictEqual(matchesTransactionRecordSearch(sampleRecordWithPayeeAndNote, undefined as any), false);

  console.log('  [PASS] Search matcher semantics verified (exact, partial, case-insensitive, field safety).');
}

// -----------------------------------------------------------------------------
// Suite 2: Normalizer & Validation (Trimming, Length, Empty, Fail-Closed)
// -----------------------------------------------------------------------------
console.log('\n[Suite 2] Testing Filter Normalizer Search Query Validation...');
{
  // 2.1 Valid search query trimmed and populated
  const validResult = normalizeTransactionHistoryFilters(
    { searchQuery: '   Starbucks Coffee   ' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES,
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(validResult.isValid, true);
  assert.strictEqual(validResult.normalizedOptions.searchQuery, 'Starbucks Coffee');
  assert.strictEqual(validResult.appliedFilters.searchQuery, 'Starbucks Coffee');
  assert.strictEqual(validResult.upstreamSearchQuery, 'Starbucks Coffee');
  assert.deepStrictEqual(validResult.appliedFilters.navigationTokens, ['cari "Starbucks Coffee"']);

  // 2.2 Empty string explicitly provided fails closed with INVALID_FORMAT
  const emptyResult = normalizeTransactionHistoryFilters(
    { searchQuery: '' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES,
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(emptyResult.isValid, false);
  assert.strictEqual(emptyResult.unresolvedFilters.length, 1);
  assert.strictEqual(emptyResult.unresolvedFilters[0].filterKey, 'searchQuery');
  assert.strictEqual(emptyResult.unresolvedFilters[0].reason, 'INVALID_FORMAT');

  // 2.3 Whitespace-only string fails closed with INVALID_FORMAT
  const whitespaceResult = normalizeTransactionHistoryFilters(
    { searchQuery: '    ' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES,
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(whitespaceResult.isValid, false);
  assert.strictEqual(whitespaceResult.unresolvedFilters[0].reason, 'INVALID_FORMAT');

  // 2.4 Query exceeding maximum allowed length (100 chars) fails closed
  const excessivelyLongQuery = 'a'.repeat(MAX_SEARCH_QUERY_LENGTH + 1);
  const tooLongResult = normalizeTransactionHistoryFilters(
    { searchQuery: excessivelyLongQuery },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES,
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(tooLongResult.isValid, false);
  assert.strictEqual(tooLongResult.unresolvedFilters[0].filterKey, 'searchQuery');
  assert.strictEqual(tooLongResult.unresolvedFilters[0].reason, 'INVALID_FORMAT');

  // 2.5 Query at exactly max length (100 chars) is valid
  const exactMaxQuery = 'b'.repeat(MAX_SEARCH_QUERY_LENGTH);
  const exactMaxResult = normalizeTransactionHistoryFilters(
    { searchQuery: exactMaxQuery },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES,
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(exactMaxResult.isValid, true);
  assert.strictEqual(exactMaxResult.normalizedOptions.searchQuery, exactMaxQuery);

  console.log('  [PASS] Search query validation and normalization verified.');
}

// -----------------------------------------------------------------------------
// Suite 3: Upstream MCP Dispatch & Unsupported Search Error Handling
// -----------------------------------------------------------------------------
console.log('\n[Suite 3] Testing Upstream MCP Dispatch & Error Handling...');
{
  const { client, capturedCalls, setNextResponse, setThrowError } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({
    records: [
      {
        id: 'rec-1',
        accountId: 'acc-bca-001',
        amount: -35000,
        currency: 'IDR',
        recordDate: '2026-09-11T10:00:00Z',
        recordType: 'expense',
        counterParty: 'Starbucks',
        note: 'Cold Brew',
      },
    ],
    total: 1,
  });

  // 3.1 query parameter dispatched to Wallet MCP get_records
  const historyPage = await service.getTransactionHistory({ searchQuery: 'Starbucks' });
  assert.strictEqual(capturedCalls.length, 1);
  assert.strictEqual(capturedCalls[0].toolName, 'get_records');
  assert.strictEqual(capturedCalls[0].args.query, 'Starbucks');
  assert.strictEqual(historyPage.records.length, 1);
  assert.strictEqual(historyPage.records[0].counterParty, 'Starbucks');
  assert.strictEqual(historyPage.appliedFilters?.searchQuery, 'Starbucks');

  // 3.2 Unsupported upstream search error surfaced explicitly as unresolvedFilters
  setThrowError(new Error('Wallet MCP Error: search query not supported by upstream data source'));
  const unsupportedPage = await service.getTransactionHistory({ searchQuery: 'Starbucks' });
  assert.strictEqual(unsupportedPage.records.length, 0);
  assert.strictEqual(unsupportedPage.unresolvedFilters?.length, 1);
  assert.strictEqual(unsupportedPage.unresolvedFilters[0].filterKey, 'searchQuery');
  assert.strictEqual(unsupportedPage.unresolvedFilters[0].reason, 'UNSUPPORTED');
  assert.strictEqual(unsupportedPage.unresolvedFilters[0].subType, 'unsupported_upstream_search');

  // 3.3 Generic / transport error without search unsupported keyword re-throws
  setThrowError(new Error('Network timeout: ECONNRESET'));
  let didThrowNetworkError = false;
  try {
    await service.getTransactionHistory({ searchQuery: 'Starbucks' });
  } catch (error: any) {
    didThrowNetworkError = true;
    assert.match(error.message, /ECONNRESET/);
  }
  assert.strictEqual(didThrowNetworkError, true, 'Standard network transport error must re-throw');

  console.log('  [PASS] Upstream MCP query argument dispatch and unsupported search safety verified.');
}

// -----------------------------------------------------------------------------
// Suite 4: Composable Combinations (Search + Account + Category + Type + Date)
// -----------------------------------------------------------------------------
console.log('\n[Suite 4] Testing Search Composed with Shared Query Filters...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({ records: [], total: 0 });

  // 4.1 Search + Account filter
  await service.getTransactionHistory({
    searchQuery: 'Starbucks',
    accountName: 'BCA',
  });
  assert.strictEqual(capturedCalls[0].args.query, 'Starbucks');
  assert.strictEqual(capturedCalls[0].args.accountId, 'acc-bca-001');

  // 4.2 Search + Category filter
  await service.getTransactionHistory({
    searchQuery: 'Indomaret',
    categoryName: 'Makanan & Minuman',
  });
  assert.strictEqual(capturedCalls[1].args.query, 'Indomaret');
  assert.deepStrictEqual(capturedCalls[1].args.categoryId, ['cat-food-001']);

  // 4.3 Search + Record type filter
  await service.getTransactionHistory({
    searchQuery: 'Bonus',
    recordType: 'income',
  });
  assert.strictEqual(capturedCalls[2].args.query, 'Bonus');
  assert.strictEqual(capturedCalls[2].args.recordType, 'income');

  // 4.4 Search + Date period filter (this_month)
  await service.getTransactionHistory(
    {
      searchQuery: 'Kopi',
      datePeriod: 'this_month',
    },
    FIXED_TEST_REFERENCE_DATE
  );
  assert.strictEqual(capturedCalls[3].args.query, 'Kopi');
  assert.ok(Array.isArray(capturedCalls[3].args.recordDate));
  assert.strictEqual((capturedCalls[3].args.recordDate as string[]).length, 2);

  // 4.5 Search + ALL dimensions combined (Account + Category + Type + Date Range + Sort + Limit)
  const fullyFilteredPage = await service.getTransactionHistory(
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
    FIXED_TEST_REFERENCE_DATE
  );

  const lastCallArgs = capturedCalls[4].args;
  assert.strictEqual(lastCallArgs.query, 'Pertamax');
  assert.strictEqual(lastCallArgs.accountId, 'acc-cash-003');
  assert.deepStrictEqual(lastCallArgs.categoryId, ['cat-transport-002']);
  assert.strictEqual(lastCallArgs.recordType, 'expense');
  assert.strictEqual(lastCallArgs.limit, 20);
  assert.deepStrictEqual(lastCallArgs.sortBy, ['+recordDate', '+createdAt']);
  assert.strictEqual(fullyFilteredPage.appliedFilters?.searchQuery, 'Pertamax');
  assert.strictEqual(fullyFilteredPage.appliedFilters?.account?.name, 'Cash Dompet');
  assert.strictEqual(fullyFilteredPage.appliedFilters?.category?.name, 'Transportasi');
  assert.strictEqual(fullyFilteredPage.appliedFilters?.recordType, 'expense');

  console.log('  [PASS] Composable filter conjunctions verified across all dimensions.');
}

// -----------------------------------------------------------------------------
// Suite 5: Pagination, Sorting & Navigation Hint Round-Tripping
// -----------------------------------------------------------------------------
console.log('\n[Suite 5] Testing Search Pagination, Sorting & Navigation Hints...');
{
  const samplePageWithSearch: TransactionHistoryPage = {
    records: [
      {
        id: 'rec-1',
        accountId: 'acc-bca-001',
        accountName: 'BCA Tabungan',
        amount: -45000,
        currency: 'IDR',
        recordDate: '2026-09-11T10:00:00Z',
        recordType: 'expense',
        counterParty: 'Starbucks',
        note: 'Cold Brew',
      },
    ],
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

  // 5.1 Indonesian response format includes search badge and localized navigation hint
  setActiveLanguage('id');
  const formattedId = formatTransactionHistoryMessage(samplePageWithSearch);
  assert.match(formattedId, /\[Cari: "Starbucks"\]/);
  assert.match(formattedId, /riwayat cari "Starbucks" hal 2/);

  // 5.2 English response format includes localized search badge and navigation hint
  setActiveLanguage('en');
  const formattedEn = formatTransactionHistoryMessage(samplePageWithSearch);
  assert.match(formattedEn, /\[Search: "Starbucks"\]/);
  assert.match(formattedEn, /history search "Starbucks" page 2/);

  // 5.3 Round-trip: Navigation hint parsed by fast-path into page 2 with exact search query
  const roundTripIdAction = detectFastPathAction('riwayat cari "Starbucks" hal 2');
  assert.strictEqual(typeof roundTripIdAction, 'object');
  assert.strictEqual((roundTripIdAction as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((roundTripIdAction as any)?.options.page, 2);
  assert.strictEqual((roundTripIdAction as any)?.options.searchQuery, 'Starbucks');

  const roundTripEnAction = detectFastPathAction('history search "Starbucks" page 2');
  assert.strictEqual(typeof roundTripEnAction, 'object');
  assert.strictEqual((roundTripEnAction as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((roundTripEnAction as any)?.options.page, 2);
  assert.strictEqual((roundTripEnAction as any)?.options.searchQuery, 'Starbucks');

  // 5.4 Limit cap at 50 enforced when searching
  const { client, capturedCalls, setNextResponse } = createMockClient();
  setNextResponse({ records: [], total: 0 });
  await client.fetchRecords({ searchQuery: 'Starbucks', limit: 100 });
  assert.strictEqual(capturedCalls[0].args.limit, MAX_TRANSACTION_HISTORY_LIMIT);
  assert.strictEqual(capturedCalls[0].args.limit, 50);
  assert.strictEqual(capturedCalls[0].args.query, 'Starbucks');

  console.log('  [PASS] Pagination bounds, sorting, and navigation hint round-tripping verified.');
}

// -----------------------------------------------------------------------------
// Suite 6: Fast-Path Intent Detection (Dedicated & History Search Syntax)
// -----------------------------------------------------------------------------
console.log('\n[Suite 6] Testing Fast-Path Intent Detection for Search...');
{
  // 6.1 Dedicated Indonesian search commands
  const searchId1 = detectFastPathAction('cari starbucks');
  assert.strictEqual((searchId1 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchId1 as any)?.options.searchQuery, 'starbucks');

  const searchId2 = detectFastPathAction('cari transaksi indomaret');
  assert.strictEqual((searchId2 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchId2 as any)?.options.searchQuery, 'indomaret');

  const searchId3 = detectFastPathAction('cari riwayat kopi');
  assert.strictEqual((searchId3 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchId3 as any)?.options.searchQuery, 'kopi');

  // 6.2 Dedicated English search commands
  const searchEn1 = detectFastPathAction('search coffee');
  assert.strictEqual((searchEn1 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchEn1 as any)?.options.searchQuery, 'coffee');

  const searchEn2 = detectFastPathAction('search transactions starbucks');
  assert.strictEqual((searchEn2 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchEn2 as any)?.options.searchQuery, 'starbucks');

  const searchEn3 = detectFastPathAction('find supermarket');
  assert.strictEqual((searchEn3 as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((searchEn3 as any)?.options.searchQuery, 'supermarket');

  // 6.3 Quoted search strings preserve internal spaces
  const searchQuoted = detectFastPathAction('cari "Kopi Kenangan"');
  assert.strictEqual((searchQuoted as any)?.options.searchQuery, 'Kopi Kenangan');

  const searchSingleQuoted = detectFastPathAction("search 'Warung Padang'");
  assert.strictEqual((searchSingleQuoted as any)?.options.searchQuery, 'Warung Padang');

  // 6.4 History command with search prefix
  const historySearch1 = detectFastPathAction('riwayat cari starbucks');
  assert.strictEqual((historySearch1 as any)?.options.searchQuery, 'starbucks');

  const historySearch2 = detectFastPathAction('history search coffee');
  assert.strictEqual((historySearch2 as any)?.options.searchQuery, 'coffee');

  // 6.5 History command with quoted search term and fail-safe for bare unknown words
  const historySearchQuoted = detectFastPathAction('riwayat "starbucks"');
  assert.strictEqual((historySearchQuoted as any)?.options.searchQuery, 'starbucks');
  assert.strictEqual(detectFastPathAction('riwayat starbucks'), null);

  // 6.6 Multi-filter natural language queries
  const multiFilterQuery = detectFastPathAction('cari indomaret di bca bulan ini');
  assert.strictEqual((multiFilterQuery as any)?.options.searchQuery, 'indomaret');
  assert.strictEqual((multiFilterQuery as any)?.options.accountName, 'bca');
  assert.strictEqual((multiFilterQuery as any)?.options.datePeriod, 'this_month');

  const multiFilterQuery2 = detectFastPathAction('search coffee expense 5 page 2');
  assert.strictEqual((multiFilterQuery2 as any)?.options.searchQuery, 'coffee');
  assert.strictEqual((multiFilterQuery2 as any)?.options.recordType, 'expense');
  assert.strictEqual((multiFilterQuery2 as any)?.options.limit, 5);
  assert.strictEqual((multiFilterQuery2 as any)?.options.page, 2);

  const multiFilterQuery3 = detectFastPathAction('cari starbucks terlama');
  assert.strictEqual((multiFilterQuery3 as any)?.options.searchQuery, 'starbucks');
  assert.strictEqual((multiFilterQuery3 as any)?.options.sort, 'oldest');

  // 6.7 Safety: Financial transactions with amounts are NEVER intercepted
  assert.strictEqual(detectFastPathAction('beli kopi 25rb'), null);
  assert.strictEqual(detectFastPathAction('catat starbucks 50k'), null);
  assert.strictEqual(detectFastPathAction('transfer 100000 ke bca'), null);
  assert.strictEqual(detectFastPathAction('bayar indomaret 75.000'), null);

  // 6.8 Bare 'cari' without terms returns null
  assert.strictEqual(detectFastPathAction('cari'), null);
  assert.strictEqual(detectFastPathAction('search'), null);

  console.log('  [PASS] Fast-path intent detection for all search command patterns verified.');
}

// -----------------------------------------------------------------------------
// Suite 7: Empty Results & Localization (Clean Error and No-Match Formatting)
// -----------------------------------------------------------------------------
console.log('\n[Suite 7] Testing Empty Results & Localization Formatting...');
{
  // 7.1 Empty search result formatting in Indonesian
  setActiveLanguage('id');
  const emptySearchPageId: TransactionHistoryPage = {
    records: [],
    total: 0,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 0,
    nextOffset: null,
    hasMore: false,
    sort: 'newest',
    appliedFilters: {
      searchQuery: 'Restoran Mewah',
    },
  };
  const emptyFormattedId = formatTransactionHistoryMessage(emptySearchPageId);
  assert.match(emptyFormattedId, /Belum ada transaksi yang cocok dengan filter \[Cari: "Restoran Mewah"\]/);

  // 7.2 Empty search result formatting in English
  setActiveLanguage('en');
  const emptyFormattedEn = formatTransactionHistoryMessage(emptySearchPageId);
  assert.match(emptyFormattedEn, /No transactions match the filter \[Search: "Restoran Mewah"\]/);

  // 7.3 Unresolved filter error formatting in English contains ZERO Indonesian words
  const unresolvedSearchPageEn: TransactionHistoryPage = {
    records: [],
    total: 0,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 0,
    nextOffset: null,
    hasMore: false,
    sort: 'newest',
    unresolvedFilters: [
      {
        filterKey: 'searchQuery',
        rawValue: 'Starbucks',
        reason: 'UNSUPPORTED',
        message: 'Pencarian teks tidak didukung oleh sumber data upstream.',
      },
      {
        filterKey: 'searchQuery',
        rawValue: '',
        reason: 'INVALID_FORMAT',
        message: 'Kata kunci pencarian tidak boleh kosong.',
      },
      {
        filterKey: 'searchQuery',
        rawValue: 'x'.repeat(120),
        reason: 'INVALID_FORMAT',
        message: 'Kata kunci pencarian terlalu panjang.',
      },
    ],
  };

  setActiveLanguage('en');
  const unresolvedFormattedEn = formatTransactionHistoryMessage(unresolvedSearchPageEn);
  assert.match(unresolvedFormattedEn, /Text search is not supported by the upstream data source/);
  assert.match(unresolvedFormattedEn, /Search keyword cannot be empty/);
  assert.match(unresolvedFormattedEn, /Search keyword ".*" is invalid or exceeds the maximum length of 100 characters/);

  // Assert zero Indonesian words in English unresolved error message
  const FORBIDDEN_INDONESIAN_WORDS = ['pencarian', 'didukung', 'sumber', 'kata', 'kunci', 'kosong', 'terlalu', 'panjang'];
  for (const forbiddenWord of FORBIDDEN_INDONESIAN_WORDS) {
    assert.strictEqual(
      unresolvedFormattedEn.toLowerCase().includes(forbiddenWord),
      false,
      `English unresolved error must not contain Indonesian word "${forbiddenWord}"`
    );
  }

  // 7.4 Unresolved filter error formatting in Indonesian
  setActiveLanguage('id');
  const unresolvedFormattedId = formatTransactionHistoryMessage(unresolvedSearchPageEn);
  assert.match(unresolvedFormattedId, /Pencarian teks tidak didukung oleh sumber data upstream/);
  assert.match(unresolvedFormattedId, /Kata kunci pencarian tidak boleh kosong/);
  assert.match(unresolvedFormattedId, /Kata kunci pencarian ".*" tidak valid atau melebihi batas 100 karakter/);

  console.log('  [PASS] Empty results and localized error formatting verified with zero language leakage.');
}

// -----------------------------------------------------------------------------
// Suite 8: FastPathHandler Integration Test (End-to-End Search Query Dispatch)
// -----------------------------------------------------------------------------
console.log('\n[Suite 8] Testing FastPathHandler Integration...');
{
  setActiveLanguage('id');
  const { client, setNextResponse } = createMockClient();
  setNextResponse({
    records: [
      {
        id: 'rec-1',
        accountId: 'acc-bca-001',
        accountName: 'BCA Tabungan',
        amount: -28000,
        currency: 'IDR',
        recordDate: '2026-09-11T14:00:00Z',
        recordType: 'expense',
        counterParty: 'Kopi Kenangan',
        note: 'Kopi Kenangan Mantan Regular',
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
    getAccounts: () => MOCK_ACCOUNTS,
    getCategories: () => MOCK_CATEGORIES,
    refreshAccounts: async () => MOCK_ACCOUNTS,
  } as any;

  const handler = new FastPathHandler(client, mockCache, mockGateway);

  const mockEvent = {
    channel: 'whatsapp' as const,
    chatIdentifier: '123456@s.whatsapp.net',
    senderIdentifier: '123456',
    messageType: 'text' as const,
    textPayload: 'cari kopi',
    rawMessageTimestamp: new Date(),
  };

  const action = detectFastPathAction('cari kopi');
  const handled = await handler.handleFastPath(mockEvent, action, Date.now());

  assert.strictEqual(handled, true, 'FastPathHandler must return true for search action');
  assert.strictEqual(sentMessages.length, 1, 'FastPathHandler must send reply message');
  assert.match(sentMessages[0], /Riwayat Transaksi/);
  assert.match(sentMessages[0], /Cari: "kopi"/);
  assert.match(sentMessages[0], /Kopi Kenangan/);

  console.log('  [PASS] FastPathHandler search integration verified end-to-end.');
}

console.log('\n[SUCCESS] All Transaction History Text Search tests passed cleanly!\n');
