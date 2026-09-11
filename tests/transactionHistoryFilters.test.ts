import assert from 'node:assert';
import {
  WalletMcpClientService,
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import {
  normalizeTransactionHistoryFilters,
  isValidCalendarDateString,
} from '../src/utils/transactionHistoryFilterNormalizer.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../src/types/walletTypes.js';

console.log('[TEST] Starting Composable Transaction History Filters Tests (Issue #101)...');

// Mock data
const MOCK_ACCOUNTS: WalletAccountItem[] = [
  { id: 'acc-bca-001', name: 'BCA Tabungan', currency: 'IDR', bankAccountNumber: '1234567890' },
  { id: 'acc-mandiri-002', name: 'Mandiri Utama', currency: 'IDR', bankAccountNumber: '9876543210' },
  { id: 'acc-cash-003', name: 'Cash Dompet', currency: 'IDR' },
  { id: 'acc-jago-004', name: 'Bank Jago', currency: 'IDR', bankAccountNumber: '55551234' },
];

const MOCK_CATEGORIES: WalletCategoryItem[] = [
  { id: 'cat-food-001', name: 'Makanan & Minuman' },
  { id: 'cat-transport-002', name: 'Transportasi' },
  { id: 'cat-salary-003', name: 'Gaji' },
  { id: 'cat-bills-004', name: 'Tagihan Listrik' },
];

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

function createSeededCacheService(client: WalletMcpClientService): WalletCacheService {
  const cache = new WalletCacheService(client);
  (cache as any).cachedAccountList = [...MOCK_ACCOUNTS];
  (cache as any).cachedCategoryList = [...MOCK_CATEGORIES];
  (cache as any).cachedLabelList = [];
  return cache;
}

// -----------------------------------------------------------------------------
// Suite 1: Account Filtering & Resolution
// -----------------------------------------------------------------------------
console.log('\n[Suite 1] Testing Account Filtering & Resolution...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({
    records: [
      { id: 'rec-1', accountId: 'acc-bca-001', amount: -25000, recordDate: '2026-09-01T10:00:00Z', recordType: 'expense' },
    ],
    total: 1,
  });

  // 1.1 Account filter by exact ID
  const byIdPage = await service.getTransactionHistory({ accountId: 'acc-bca-001' });
  assert.strictEqual(byIdPage.records.length, 1);
  assert.strictEqual(byIdPage.records[0].accountName, 'BCA Tabungan');
  assert.strictEqual(capturedCalls[0].args.accountId, 'acc-bca-001');

  // 1.2 Account filter by name (exact match, case-insensitive)
  const byNamePage = await service.getTransactionHistory({ accountName: 'bca tabungan' });
  assert.strictEqual(capturedCalls[1].args.accountId, 'acc-bca-001');
  assert.strictEqual(byNamePage.appliedFilters?.account?.id, 'acc-bca-001');

  // 1.3 Account filter by name (substring match)
  const bySubPage = await service.getTransactionHistory({ accountName: 'Mandiri' });
  assert.strictEqual(capturedCalls[2].args.accountId, 'acc-mandiri-002');
  assert.strictEqual(bySubPage.appliedFilters?.account?.id, 'acc-mandiri-002');

  // 1.4 Account filter by bank account number digits
  const byDigitsPage = await service.getTransactionHistory({ accountName: '7890' });
  assert.strictEqual(capturedCalls[3].args.accountId, 'acc-bca-001');

  // 1.5 Fail-closed: unresolvable account produces explicit error and skips MCP call
  const callCountBefore = capturedCalls.length;
  const unresolvedPage = await service.getTransactionHistory({ accountName: 'CryptoWalletNonExistent' });
  assert.strictEqual(capturedCalls.length, callCountBefore); // No MCP call made!
  assert.strictEqual(unresolvedPage.records.length, 0);
  assert.strictEqual(unresolvedPage.unresolvedFilters?.length, 1);
  assert.strictEqual(unresolvedPage.unresolvedFilters[0].filterKey, 'account');
  assert.strictEqual(unresolvedPage.unresolvedFilters[0].reason, 'NOT_FOUND');

  console.log('  [PASS] Account filtering resolves IDs, names, digits, and enforces fail-closed safety.');
}

// -----------------------------------------------------------------------------
// Suite 2: Category Filtering & Resolution
// -----------------------------------------------------------------------------
console.log('\n[Suite 2] Testing Category Filtering & Resolution...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({ records: [], total: 0 });

  // 2.1 Category filter by ID
  await service.getTransactionHistory({ categoryId: 'cat-food-001' });
  assert.deepStrictEqual(capturedCalls[0].args.categoryId, ['cat-food-001']);

  // 2.2 Category filter by name (exact name match)
  const byNameResult = await service.getTransactionHistory({ categoryName: 'Makanan & Minuman' });
  assert.deepStrictEqual(capturedCalls[1].args.categoryId, ['cat-food-001']);
  assert.strictEqual(byNameResult.appliedFilters?.category?.id, 'cat-food-001');

  // 2.3 Category filter by name (substring match)
  await service.getTransactionHistory({ categoryName: 'listrik' });
  assert.deepStrictEqual(capturedCalls[2].args.categoryId, ['cat-bills-004']);

  // 2.4 Category filter by group slug enum
  const byGroupResult = await service.getTransactionHistory({ categoryGroup: 'food_and_drinks' });
  assert.strictEqual(capturedCalls[3].args.categoryGroup, 'food_and_drinks');
  assert.strictEqual(byGroupResult.appliedFilters?.categoryGroup, 'food_and_drinks');

  // 2.5 Fail-closed: unresolvable category skips MCP call
  const callCountBefore = capturedCalls.length;
  const unresolvedCategoryPage = await service.getTransactionHistory({ categoryName: 'KategoriFiktif' });
  assert.strictEqual(capturedCalls.length, callCountBefore);
  assert.strictEqual(unresolvedCategoryPage.records.length, 0);
  assert.strictEqual(unresolvedCategoryPage.unresolvedFilters?.length, 1);
  assert.strictEqual(unresolvedCategoryPage.unresolvedFilters[0].filterKey, 'category');
  assert.strictEqual(unresolvedCategoryPage.unresolvedFilters[0].reason, 'NOT_FOUND');

  console.log('  [PASS] Category filtering resolves IDs, names, groups, and enforces fail-closed safety.');
}

// -----------------------------------------------------------------------------
// Suite 3: Record Type Filtering (Expense vs Income)
// -----------------------------------------------------------------------------
console.log('\n[Suite 3] Testing Record Type Filtering...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({ records: [], total: 0 });

  // 3.1 Standard expense
  await service.getTransactionHistory({ recordType: 'expense' });
  assert.strictEqual(capturedCalls[0].args.recordType, 'expense');

  // 3.2 Standard income
  await service.getTransactionHistory({ recordType: 'income' });
  assert.strictEqual(capturedCalls[1].args.recordType, 'income');

  // 3.3 Indonesian synonym: pengeluaran -> expense
  await service.getTransactionHistory({ recordType: 'pengeluaran' as any });
  assert.strictEqual(capturedCalls[2].args.recordType, 'expense');

  // 3.4 Indonesian synonym: pemasukan -> income
  await service.getTransactionHistory({ recordType: 'pemasukan' as any });
  assert.strictEqual(capturedCalls[3].args.recordType, 'income');

  // 3.5 Fail-closed: invalid record type rejects before MCP call
  const callCountBefore = capturedCalls.length;
  const invalidTypePage = await service.getTransactionHistory({ recordType: 'invalid_type' as any });
  assert.strictEqual(capturedCalls.length, callCountBefore);
  assert.strictEqual(invalidTypePage.unresolvedFilters?.[0].filterKey, 'recordType');
  assert.strictEqual(invalidTypePage.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

  console.log('  [PASS] Record type correctly filters expense/income and accepts synonyms.');
}

// -----------------------------------------------------------------------------
// Suite 4: Date & Date Range Filtering
// -----------------------------------------------------------------------------
console.log('\n[Suite 4] Testing Date & Date Range Filtering...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({ records: [], total: 0 });

  // 4.1 Explicit dateRange array with operator prefixes
  await service.getTransactionHistory({ dateRange: ['gte.2024-01-01', 'lte.2024-06-30'] });
  assert.deepStrictEqual(capturedCalls[0].args.recordDate, ['gte.2024-01-01', 'lte.2024-06-30']);

  // 4.2 Start date and end date normalization
  await service.getTransactionHistory({ startDate: '2024-03-01', endDate: '2024-03-31' });
  assert.deepStrictEqual(capturedCalls[1].args.recordDate, ['gte.2024-03-01', 'lte.2024-03-31']);

  // 4.3 Relative date periods: this_month with timezone-aware half-open UTC ISO boundaries
  // Sep 11, 2026 12:00:00 UTC = Sep 11, 2026 19:00:00 WIB
  const fixedRefDate = new Date('2026-09-11T12:00:00Z');
  const monthNormal = normalizeTransactionHistoryFilters({ datePeriod: 'this_month' }, [], [], fixedRefDate);
  assert.strictEqual(monthNormal.isValid, true);
  // Start: 2026-09-01 00:00 WIB -> 2026-08-31T17:00:00.000Z. Next: 2026-10-01 00:00 WIB -> 2026-09-30T17:00:00.000Z
  assert.deepStrictEqual(monthNormal.upstreamRecordDate, ['gte.2026-08-31T17:00:00.000Z', 'lt.2026-09-30T17:00:00.000Z']);
  assert.strictEqual(monthNormal.appliedFilters.dateRange?.label, 'Bulan ini');
  assert.strictEqual(monthNormal.appliedFilters.dateRange?.selector, 'bulan ini');

  // 4.4 Relative date periods: today (half-open UTC interval for Asia/Jakarta)
  // Start: 2026-09-11 00:00 WIB -> 2026-09-10T17:00:00.000Z. Next: 2026-09-12 00:00 WIB -> 2026-09-11T17:00:00.000Z
  const todayNormal = normalizeTransactionHistoryFilters({ datePeriod: 'today' }, [], [], fixedRefDate);
  assert.strictEqual(todayNormal.isValid, true);
  assert.deepStrictEqual(todayNormal.upstreamRecordDate, ['gte.2026-09-10T17:00:00.000Z', 'lt.2026-09-11T17:00:00.000Z']);
  assert.strictEqual(todayNormal.appliedFilters.dateRange?.label, 'Hari ini');
  assert.strictEqual(todayNormal.appliedFilters.dateRange?.selector, 'hari ini');

  // 4.5 Relative date periods: yesterday (half-open UTC interval for Asia/Jakarta)
  // Start: 2026-09-10 00:00 WIB -> 2026-09-09T17:00:00.000Z. Next: 2026-09-11 00:00 WIB -> 2026-09-10T17:00:00.000Z
  const yesterdayNormal = normalizeTransactionHistoryFilters({ datePeriod: 'yesterday' }, [], [], fixedRefDate);
  assert.strictEqual(yesterdayNormal.isValid, true);
  assert.deepStrictEqual(yesterdayNormal.upstreamRecordDate, ['gte.2026-09-09T17:00:00.000Z', 'lt.2026-09-10T17:00:00.000Z']);
  assert.strictEqual(yesterdayNormal.appliedFilters.dateRange?.label, 'Kemarin');
  assert.strictEqual(yesterdayNormal.appliedFilters.dateRange?.selector, 'kemarin');

  // 4.6 Timezone boundary transaction matching regression test (Asia/Jakarta UTC+7)
  // Today = 2026-09-11 WIB (Interval: [2026-09-10T17:00:00.000Z, 2026-09-11T17:00:00.000Z))
  const [lowerBoundOp, upperBoundOp] = todayNormal.upstreamRecordDate!;
  const lowerTimestamp = Date.parse(lowerBoundOp.replace('gte.', ''));
  const upperTimestamp = Date.parse(upperBoundOp.replace('lt.', ''));

  const isIncludedInToday = (utcIsoString: string): boolean => {
    const ts = Date.parse(utcIsoString);
    return ts >= lowerTimestamp && ts < upperTimestamp;
  };

  // Transaction 1: 00:30 WIB on Sep 11 (2026-09-10T17:30:00.000Z) -> INCLUDED
  assert.strictEqual(isIncludedInToday('2026-09-10T17:30:00.000Z'), true);
  // Transaction 2: 23:30 WIB on Sep 11 (2026-09-11T16:30:00.000Z) -> INCLUDED
  assert.strictEqual(isIncludedInToday('2026-09-11T16:30:00.000Z'), true);
  // Transaction 3: 00:05 WIB on Sep 12 (2026-09-11T17:05:00.000Z) -> EXCLUDED (next local midnight)
  assert.strictEqual(isIncludedInToday('2026-09-11T17:05:00.000Z'), false);
  // Transaction 4: 23:55 WIB on Sep 10 (2026-09-10T16:55:00.000Z) -> EXCLUDED (before local midnight)
  assert.strictEqual(isIncludedInToday('2026-09-10T16:55:00.000Z'), false);

  // 4.7 Date boundary: startDate > endDate fails closed before MCP
  const callsBeforeReversedDates = capturedCalls.length;
  const invalidRangePage = await service.getTransactionHistory({
    startDate: '2024-12-31',
    endDate: '2024-01-01',
  });
  assert.strictEqual(capturedCalls.length, callsBeforeReversedDates); // No MCP call!
  assert.strictEqual(invalidRangePage.unresolvedFilters?.[0].filterKey, 'dateRange');
  assert.strictEqual(invalidRangePage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // 4.8 Array dateRange: reversed bounds fails closed before MCP
  const callsBeforeArrayReversed = capturedCalls.length;
  const arrayReversedPage = await service.getTransactionHistory({
    dateRange: ['gte.2026-09-30', 'lte.2026-09-01'],
  });
  assert.strictEqual(capturedCalls.length, callsBeforeArrayReversed); // No MCP call!
  assert.strictEqual(arrayReversedPage.records.length, 0);
  assert.strictEqual(arrayReversedPage.unresolvedFilters?.[0].filterKey, 'dateRange');
  assert.strictEqual(arrayReversedPage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // 4.9 Fast-path reversed bounds: fails closed before MCP
  const fastPathReversedAction = detectFastPathAction('history 2026-09-30 2026-09-01');
  assert.ok(fastPathReversedAction);
  assert.strictEqual((fastPathReversedAction as any).type, 'TRANSACTION_HISTORY');
  const callsBeforeFpReversed = capturedCalls.length;
  const fpReversedPage = await service.getTransactionHistory((fastPathReversedAction as any).options);
  assert.strictEqual(capturedCalls.length, callsBeforeFpReversed); // No MCP call!
  assert.strictEqual(fpReversedPage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // 4.10 Array dateRange: impossible calendar dates fail closed before MCP
  const callsBeforeImpossibleDate = capturedCalls.length;
  const impossibleDatePage = await service.getTransactionHistory({
    dateRange: ['eq.2024-02-30'],
  });
  assert.strictEqual(capturedCalls.length, callsBeforeImpossibleDate); // No MCP call!
  assert.strictEqual(impossibleDatePage.records.length, 0);
  assert.strictEqual(impossibleDatePage.unresolvedFilters?.[0].filterKey, 'dateRange');
  assert.strictEqual(impossibleDatePage.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

  // 4.11 Start date with impossible calendar date (2026-04-31) fails closed before MCP
  const callsBeforeImpossibleApr31 = capturedCalls.length;
  const impossibleApr31Page = await service.getTransactionHistory({
    startDate: '2026-04-31',
  });
  assert.strictEqual(capturedCalls.length, callsBeforeImpossibleApr31); // No MCP call!
  assert.strictEqual(impossibleApr31Page.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

  // 4.12 Non-leap year Feb 29 (2025-02-29) fails closed before MCP
  const callsBeforeNonLeapFeb29 = capturedCalls.length;
  const nonLeapFeb29Page = await service.getTransactionHistory({
    startDate: '2025-02-29',
  });
  assert.strictEqual(capturedCalls.length, callsBeforeNonLeapFeb29); // No MCP call!
  assert.strictEqual(nonLeapFeb29Page.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

  // 4.13 Remaining relative date periods: this_week, last_week, last_month, this_year
  const thisWeekResult = normalizeTransactionHistoryFilters({ datePeriod: 'this_week' }, [], [], fixedRefDate);
  assert.strictEqual(thisWeekResult.isValid, true);
  assert.strictEqual(thisWeekResult.appliedFilters.dateRange?.label, 'Minggu ini');
  assert.strictEqual(thisWeekResult.appliedFilters.dateRange?.selector, 'minggu ini');
  assert.strictEqual(thisWeekResult.upstreamRecordDate?.length, 2);

  const lastWeekResult = normalizeTransactionHistoryFilters({ datePeriod: 'last_week' }, [], [], fixedRefDate);
  assert.strictEqual(lastWeekResult.isValid, true);
  assert.strictEqual(lastWeekResult.appliedFilters.dateRange?.label, 'Minggu lalu');
  assert.strictEqual(lastWeekResult.appliedFilters.dateRange?.selector, 'minggu lalu');
  assert.strictEqual(lastWeekResult.upstreamRecordDate?.length, 2);

  const lastMonthResult = normalizeTransactionHistoryFilters({ datePeriod: 'last_month' }, [], [], fixedRefDate);
  assert.strictEqual(lastMonthResult.isValid, true);
  assert.strictEqual(lastMonthResult.appliedFilters.dateRange?.label, 'Bulan lalu');
  assert.strictEqual(lastMonthResult.appliedFilters.dateRange?.selector, 'bulan lalu');
  assert.strictEqual(lastMonthResult.upstreamRecordDate?.length, 2);

  const thisYearResult = normalizeTransactionHistoryFilters({ datePeriod: 'this_year' }, [], [], fixedRefDate);
  assert.strictEqual(thisYearResult.isValid, true);
  assert.strictEqual(thisYearResult.appliedFilters.dateRange?.label, 'Tahun ini');
  assert.strictEqual(thisYearResult.appliedFilters.dateRange?.selector, 'tahun ini');
  assert.strictEqual(thisYearResult.upstreamRecordDate?.length, 2);

  // 4.14 Object dateRange { from, to } valid normalization
  const validObjRange = normalizeTransactionHistoryFilters({ dateRange: { from: '2026-05-01', to: '2026-05-31' } });
  assert.strictEqual(validObjRange.isValid, true);
  assert.deepStrictEqual(validObjRange.upstreamRecordDate, ['gte.2026-05-01', 'lte.2026-05-31']);

  // 4.15 Object dateRange { from, to } with invalid 'to' fails closed before MCP
  const callsBeforeObjInvalidTo = capturedCalls.length;
  const objInvalidToPage = await service.getTransactionHistory({
    dateRange: { from: '2026-05-01', to: '2026-02-30' },
  });
  assert.strictEqual(capturedCalls.length, callsBeforeObjInvalidTo);
  assert.strictEqual(objInvalidToPage.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

  // 4.16 Direct unit tests for strict calendar validator function isValidCalendarDateString
  assert.strictEqual(isValidCalendarDateString('2024-02-29'), true); // Leap year valid
  assert.strictEqual(isValidCalendarDateString('2024-02-30'), false); // Leap year Feb 30 impossible
  assert.strictEqual(isValidCalendarDateString('2025-02-29'), false); // Non-leap year Feb 29 impossible
  assert.strictEqual(isValidCalendarDateString('2026-04-31'), false); // April has 30 days
  assert.strictEqual(isValidCalendarDateString('2026-13-01'), false); // Invalid month 13
  assert.strictEqual(isValidCalendarDateString('2026-00-10'), false); // Invalid month 0
  assert.strictEqual(isValidCalendarDateString('2026-01-32'), false); // Invalid day 32
  assert.strictEqual(isValidCalendarDateString('2026-01-00'), false); // Invalid day 0
  assert.strictEqual(isValidCalendarDateString('not-a-date'), false);
  assert.strictEqual(isValidCalendarDateString(12345 as any), false);
  assert.strictEqual(isValidCalendarDateString('2026-09-10T17:00:00.000Z'), true);
  assert.strictEqual(isValidCalendarDateString('2026-09-10T17:00:00+07:00'), true);
  assert.strictEqual(isValidCalendarDateString('2026-02-30T17:00:00.000Z'), false);
  assert.strictEqual(isValidCalendarDateString('2026-09-10T25:00:00.000Z'), false);
  assert.strictEqual(isValidCalendarDateString('2026-09-10T12:60:00.000Z'), false);

  // 4.17 Category group navigation token propagation
  const categoryGroupNorm = normalizeTransactionHistoryFilters({ categoryGroup: 'food_and_drinks' });
  assert.strictEqual(categoryGroupNorm.isValid, true);
  assert.strictEqual(categoryGroupNorm.appliedFilters.navigationTokens?.[0], 'food_and_drinks');

  console.log('  [PASS] Timezone UTC boundaries, strict calendar validation, and reversed bounds verified.');
}

// -----------------------------------------------------------------------------
// Suite 5: Composable Multi-Filter Queries
// -----------------------------------------------------------------------------
console.log('\n[Suite 5] Testing Composable Multi-Filter Queries...');
{
  const { client, capturedCalls, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({
    records: [
      {
        id: 'rec-combo-1',
        accountId: 'acc-bca-001',
        amount: -45000,
        currency: 'IDR',
        recordDate: '2026-09-05T12:00:00Z',
        recordType: 'expense',
        category: { id: 'cat-food-001', name: 'Makanan & Minuman' },
        note: 'Makan Siang Soto',
      },
    ],
    total: 1,
  });

  // Combine account + category + recordType + dateRange + limit + sort
  const comboResult = await service.getTransactionHistory({
    accountName: 'BCA',
    categoryName: 'Makanan',
    recordType: 'expense',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    limit: 5,
    sort: 'oldest',
  });

  assert.strictEqual(capturedCalls.length, 1);
  const mcpArgs = capturedCalls[0].args;
  assert.strictEqual(mcpArgs.accountId, 'acc-bca-001');
  assert.deepStrictEqual(mcpArgs.categoryId, ['cat-food-001']);
  assert.strictEqual(mcpArgs.recordType, 'expense');
  assert.deepStrictEqual(mcpArgs.recordDate, ['gte.2026-09-01', 'lte.2026-09-30']);
  assert.strictEqual(mcpArgs.limit, 5);
  assert.deepStrictEqual(mcpArgs.sortBy, ['+recordDate', '+createdAt']);

  assert.strictEqual(comboResult.records.length, 1);
  assert.strictEqual(comboResult.records[0].accountName, 'BCA Tabungan');
  assert.strictEqual(comboResult.appliedFilters?.account?.name, 'BCA Tabungan');
  assert.strictEqual(comboResult.appliedFilters?.account?.selector, 'bca');
  assert.strictEqual(comboResult.appliedFilters?.category?.name, 'Makanan & Minuman');
  assert.strictEqual(comboResult.appliedFilters?.category?.selector, 'makanan');
  assert.strictEqual(comboResult.appliedFilters?.recordType, 'expense');

  console.log('  [PASS] Composable multi-filter query accurately combines all dimensions simultaneously.');
}

// -----------------------------------------------------------------------------
// Suite 6: Empty Matches & Filtered State Handling
// -----------------------------------------------------------------------------
console.log('\n[Suite 6] Testing Empty Matches & Filtered State Handling...');
{
  const { client, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const service = new TransactionHistoryService(client, cache);

  setNextResponse({ records: [], total: 0 });

  const emptyFilteredPage = await service.getTransactionHistory({
    accountName: 'BCA',
    categoryName: 'Makanan',
  });

  assert.strictEqual(emptyFilteredPage.records.length, 0);
  assert.strictEqual(emptyFilteredPage.total, 0);

  const formattedEmpty = formatTransactionHistoryMessage(emptyFilteredPage, 'id');
  assert.match(formattedEmpty, /Belum ada transaksi yang cocok dengan filter/);
  assert.match(formattedEmpty, /BCA Tabungan/);

  console.log('  [PASS] Empty results with active filters render non-misleading filtered empty state.');
}

// -----------------------------------------------------------------------------
// Suite 7: Human-Facing Response Formatting & i18n
// -----------------------------------------------------------------------------
console.log('\n[Suite 7] Testing Human-Facing Response Formatting & i18n...');
{
  // 7.1 Filter badges in Indonesian header
  const samplePage: any = {
    records: [
      {
        id: 'rec-1',
        accountId: 'acc-1',
        accountName: 'BCA',
        amount: -25000,
        currency: 'IDR',
        recordDate: '2026-09-11T10:00:00Z',
        recordType: 'expense',
        category: { id: 'cat-1', name: 'Makanan' },
        note: 'Bakso',
      },
    ],
    total: 1,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 1,
    nextOffset: null,
    hasMore: false,
    sort: 'newest',
    appliedFilters: {
      account: { id: 'acc-1', name: 'BCA' },
      category: { id: 'cat-1', name: 'Makanan' },
      recordType: 'expense',
      dateRange: { label: 'Bulan ini' },
    },
  };

  const idFormatted = formatTransactionHistoryMessage(samplePage, 'id');
  assert.match(idFormatted, /Riwayat Transaksi/);
  assert.match(idFormatted, /Pengeluaran • Makanan • BCA • Bulan ini/);
  assert.match(idFormatted, /Bakso/);

  // 7.2 Filter badges in English header
  const enFormatted = formatTransactionHistoryMessage(samplePage, 'en');
  assert.match(enFormatted, /Transaction History/);
  assert.match(enFormatted, /Expense • Makanan • BCA • Bulan ini/);

  // 7.3 Unresolved filter explanation formatting
  const failClosedPage: any = {
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
      { filterKey: 'account', rawValue: 'XYZ', reason: 'NOT_FOUND', message: 'Akun "XYZ" tidak ditemukan dalam daftar akun Wallet Anda.' },
    ],
  };

  const failClosedFormattedId = formatTransactionHistoryMessage(failClosedPage, 'id');
  assert.match(failClosedFormattedId, /Filter Riwayat Tidak Ditemukan/);
  assert.match(failClosedFormattedId, /Akun "XYZ" tidak ditemukan/);

  const failClosedFormattedEn = formatTransactionHistoryMessage(failClosedPage, 'en');
  assert.match(failClosedFormattedEn, /Transaction History Filter Not Found/);

  // 7.4 Next-page command round-trip regression test (Issue #101 Review)
  // Normalize query with 'bca' (which maps to 'BCA Tabungan') and 'makanan' (which maps to 'Makanan & Minuman')
  const roundTripNormalized = normalizeTransactionHistoryFilters(
    { accountName: 'bca', categoryName: 'makanan' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(roundTripNormalized.isValid, true);
  assert.strictEqual(roundTripNormalized.appliedFilters.account?.name, 'BCA Tabungan');
  assert.strictEqual(roundTripNormalized.appliedFilters.account?.selector, 'bca');
  assert.strictEqual(roundTripNormalized.appliedFilters.category?.name, 'Makanan & Minuman');
  assert.strictEqual(roundTripNormalized.appliedFilters.category?.selector, 'makanan');

  const roundTripPage: any = {
    records: samplePage.records,
    total: 25,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 3,
    nextOffset: 10,
    hasMore: true,
    sort: 'newest',
    appliedFilters: roundTripNormalized.appliedFilters,
  };

  const formattedRoundTrip = formatTransactionHistoryMessage(roundTripPage, 'id');
  // Command hint must use parser-safe selectors 'bca' and 'makanan', NOT 'bca tabungan' or 'makanan & minuman'
  assert.match(formattedRoundTrip, /riwayat bca makanan hal 2/);
  assert.doesNotMatch(formattedRoundTrip, /tabungan/);
  assert.doesNotMatch(formattedRoundTrip, /minuman/);

  // Extract the exact generated command from the markdown
  const commandMatch = formattedRoundTrip.match(/_Ketik \*(riwayat .+?)\* untuk halaman selanjutnya\._/);
  assert.ok(commandMatch, 'Next page command hint must be present');
  const extractedCommand = commandMatch[1];
  assert.strictEqual(extractedCommand, 'riwayat bca makanan hal 2');

  // Parse that exact hint command back through detectFastPathAction
  const parsedBackAction = detectFastPathAction(extractedCommand);
  assert.ok(parsedBackAction, 'detectFastPathAction must parse the generated navigation hint command');
  assert.strictEqual((parsedBackAction as any).type, 'TRANSACTION_HISTORY');
  assert.strictEqual((parsedBackAction as any).options.page, 2);
  assert.strictEqual((parsedBackAction as any).options.accountName, 'bca');
  assert.strictEqual((parsedBackAction as any).options.categoryName, 'makanan');

  // 7.5 Full multi-filter navigation hint round-trip (Account + Category + Type + Period + Limit + Sort)
  const fullComboNormalized = normalizeTransactionHistoryFilters(
    {
      accountName: 'bca',
      categoryName: 'makanan',
      recordType: 'expense',
      datePeriod: 'this_month',
      limit: 5,
      sort: 'oldest',
    },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  const fullComboPage: any = {
    records: samplePage.records,
    total: 50,
    limit: 5,
    offset: 0,
    page: 1,
    totalPages: 10,
    nextOffset: 5,
    hasMore: true,
    sort: 'oldest',
    appliedFilters: fullComboNormalized.appliedFilters,
  };

  const fullComboFormattedId = formatTransactionHistoryMessage(fullComboPage, 'id');
  const fullComboMatchId = fullComboFormattedId.match(/_Ketik \*(riwayat .+?)\* untuk halaman selanjutnya\._/);
  assert.ok(fullComboMatchId);
  const fullExtractedCommandId = fullComboMatchId[1];
  assert.strictEqual(fullExtractedCommandId, 'riwayat bca makanan pengeluaran bulan ini 5 hal 2 terlama');

  const parsedFullId = detectFastPathAction(fullExtractedCommandId);
  assert.ok(parsedFullId);
  assert.strictEqual((parsedFullId as any).type, 'TRANSACTION_HISTORY');
  assert.strictEqual((parsedFullId as any).options.page, 2);
  assert.strictEqual((parsedFullId as any).options.limit, 5);
  assert.strictEqual((parsedFullId as any).options.sort, 'oldest');
  assert.strictEqual((parsedFullId as any).options.accountName, 'bca');
  assert.strictEqual((parsedFullId as any).options.categoryName, 'makanan');
  assert.strictEqual((parsedFullId as any).options.recordType, 'expense');
  assert.strictEqual((parsedFullId as any).options.datePeriod, 'this_month');

  // English full combo round-trip
  const fullComboFormattedEn = formatTransactionHistoryMessage(fullComboPage, 'en');
  const fullComboMatchEn = fullComboFormattedEn.match(/_Type \*(history .+?)\* for the next page\._/);
  assert.ok(fullComboMatchEn);
  const fullExtractedCommandEn = fullComboMatchEn[1];
  assert.strictEqual(fullExtractedCommandEn, 'history bca makanan expense this month 5 page 2 oldest');

  const parsedFullEn = detectFastPathAction(fullExtractedCommandEn);
  assert.ok(parsedFullEn);
  assert.strictEqual((parsedFullEn as any).type, 'TRANSACTION_HISTORY');
  assert.strictEqual((parsedFullEn as any).options.page, 2);
  assert.strictEqual((parsedFullEn as any).options.limit, 5);
  assert.strictEqual((parsedFullEn as any).options.sort, 'oldest');
  assert.strictEqual((parsedFullEn as any).options.accountName, 'bca');
  assert.strictEqual((parsedFullEn as any).options.categoryName, 'makanan');
  assert.strictEqual((parsedFullEn as any).options.recordType, 'expense');
  assert.strictEqual((parsedFullEn as any).options.datePeriod, 'this_month');

  console.log('  [PASS] Localized headers, badges, warnings, and navigation hints formatted properly.');
}

// -----------------------------------------------------------------------------
// Suite 8: Fast-Path Intent Detection with Composable Filters
// -----------------------------------------------------------------------------
console.log('\n[Suite 8] Testing Fast-Path Intent Detection with Composable Filters...');
{
  // 8.1 Single filters
  const actionExpense = detectFastPathAction('riwayat pengeluaran');
  assert.strictEqual((actionExpense as any)?.type, 'TRANSACTION_HISTORY');
  assert.strictEqual((actionExpense as any)?.options.recordType, 'expense');

  const actionIncome = detectFastPathAction('riwayat pemasukan');
  assert.strictEqual((actionIncome as any)?.options.recordType, 'income');

  const actionAccount = detectFastPathAction('riwayat bca');
  assert.strictEqual((actionAccount as any)?.options.accountName, 'bca');

  const actionCategory = detectFastPathAction('riwayat makanan');
  assert.strictEqual((actionCategory as any)?.options.categoryName, 'makanan');

  const actionPeriod = detectFastPathAction('riwayat bulan ini');
  assert.strictEqual((actionPeriod as any)?.options.datePeriod, 'this_month');

  // 8.2 Composable combinations
  const actionCombo1 = detectFastPathAction('riwayat pengeluaran makanan bulan ini');
  assert.strictEqual((actionCombo1 as any)?.options.recordType, 'expense');
  assert.strictEqual((actionCombo1 as any)?.options.categoryName, 'makanan');
  assert.strictEqual((actionCombo1 as any)?.options.datePeriod, 'this_month');

  const actionCombo2 = detectFastPathAction('riwayat bca kemarin');
  assert.strictEqual((actionCombo2 as any)?.options.accountName, 'bca');
  assert.strictEqual((actionCombo2 as any)?.options.datePeriod, 'yesterday');

  const actionCombo3 = detectFastPathAction('riwayat pengeluaran bca 5 terlama');
  assert.strictEqual((actionCombo3 as any)?.options.recordType, 'expense');
  assert.strictEqual((actionCombo3 as any)?.options.accountName, 'bca');
  assert.strictEqual((actionCombo3 as any)?.options.limit, 5);
  assert.strictEqual((actionCombo3 as any)?.options.sort, 'oldest');

  // 8.3 English commands
  const actionEn = detectFastPathAction('history food expense this month');
  assert.strictEqual((actionEn as any)?.options.categoryName, 'food');
  assert.strictEqual((actionEn as any)?.options.recordType, 'expense');
  assert.strictEqual((actionEn as any)?.options.datePeriod, 'this_month');

  // 8.4 Explicit prefix syntax
  const actionExplicit = detectFastPathAction('riwayat akun jago kategori tagihan');
  assert.strictEqual((actionExplicit as any)?.options.accountName, 'jago');
  assert.strictEqual((actionExplicit as any)?.options.categoryName, 'tagihan');

  // 8.5 Safety regressions
  assert.strictEqual(detectFastPathAction('beli kopi 25rb'), null);
  assert.strictEqual(detectFastPathAction('riwayat belanja 50000'), null);
  assert.strictEqual(detectFastPathAction('catat bensin 30k pakai bca'), null);

  console.log('  [PASS] Fast-path intent detector correctly identifies composable history filter commands.');
}

// -----------------------------------------------------------------------------
// Suite 9: FastPathHandler Integration with Filters
// -----------------------------------------------------------------------------
console.log('\n[Suite 9] Testing FastPathHandler Integration with Filters...');
{
  const { client, setNextResponse } = createMockClient();
  const cache = createSeededCacheService(client);
  const sentMessages: Array<{ channel: string; text: string }> = [];

  const mockGateway: any = {
    sendMessage: async (channel: string, target: string, text: string) => {
      sentMessages.push({ channel, text });
      return true;
    },
  };

  const handler = new FastPathHandler(client, cache, mockGateway);

  setNextResponse({
    records: [
      {
        id: 'rec-101',
        accountId: 'acc-bca-001',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-09-10T15:00:00Z',
        recordType: 'expense',
        note: 'Pizza Hut',
      },
    ],
    total: 1,
  });

  const fastPathAction = detectFastPathAction('riwayat bca');
  assert.ok(fastPathAction);

  const handled = await handler.handleFastPath(
    {
      channel: 'whatsapp',
      chatIdentifier: '628123456789@s.whatsapp.net',
      messageType: 'text',
      textPayload: 'riwayat bca',
    },
    fastPathAction,
    Date.now()
  );

  assert.strictEqual(handled, true);
  assert.strictEqual(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Riwayat Transaksi/);
  assert.match(sentMessages[0].text, /BCA Tabungan/);
  assert.match(sentMessages[0].text, /Pizza Hut/);

  console.log('  [PASS] FastPathHandler integration with filters verified end-to-end.');
}

console.log('\n[SUCCESS] All Composable Transaction History Filter tests passed cleanly!');
