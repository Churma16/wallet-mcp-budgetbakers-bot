import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';
import {
  WalletMcpClientService,
  DEFAULT_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestFastPathHandler } from './fixtures/compositionFixtures.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import {
  normalizeTransactionHistoryFilters,
  isValidCalendarDateString,
} from '../src/utils/transactionHistoryFilterNormalizer.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { buildCompactSystemInstruction } from '../src/services/ai/aiPromptBuilder.js';
import { SemanticToolBoundary } from '../src/services/ai/semanticToolBoundary.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../src/types/walletTypes.js';
import {
  CANONICAL_FILTER_ACCOUNTS as MOCK_ACCOUNTS,
  CANONICAL_FILTER_CATEGORIES as MOCK_CATEGORIES,
  CANONICAL_REFERENCE_DATE as FIXED_TEST_REFERENCE_DATE,
  createQueryExecutionContext,
  type QueryExecutionContext,
} from './fixtures/transactionFixtures.js';

describe('Composable Transaction History Filters Tests (Issue #101 & #177)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
  });

  describe('Suite 1: Account Filtering & Resolution', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('resolves IDs, names, digits, and enforces fail-closed safety', async () => {
      // 1.1 Account filter by exact ID
      const byIdPage = await queryContext.service.getTransactionHistory({ accountId: 'acc-bca' });
      assert.strictEqual(byIdPage.records.length, 4);
      assert.deepStrictEqual(byIdPage.records.map(record => record.id), ['rec-1', 'rec-3', 'rec-4', 'rec-5']);
      assert.strictEqual(byIdPage.records[0].accountName, 'BCA Tabungan');
      assert.strictEqual(queryContext.capturedCalls[0].args.accountId, 'acc-bca');

      // 1.2 Account filter by name (exact match, case-insensitive)
      const byNamePage = await queryContext.service.getTransactionHistory({ accountName: 'bca tabungan' });
      assert.strictEqual(queryContext.capturedCalls[1].args.accountId, 'acc-bca');
      assert.strictEqual(byNamePage.appliedFilters?.account?.id, 'acc-bca');
      assert.deepStrictEqual(byNamePage.records.map(record => record.id), ['rec-1', 'rec-3', 'rec-4', 'rec-5']);

      // 1.3 Account filter by name (substring match)
      const bySubPage = await queryContext.service.getTransactionHistory({ accountName: 'Mandiri' });
      assert.strictEqual(queryContext.capturedCalls[2].args.accountId, 'acc-mandiri');
      assert.strictEqual(bySubPage.appliedFilters?.account?.id, 'acc-mandiri');
      assert.strictEqual(bySubPage.records.length, 0);

      // 1.4 Account filter by bank account number digits
      const byDigitsPage = await queryContext.service.getTransactionHistory({ accountName: '7890' });
      assert.strictEqual(queryContext.capturedCalls[3].args.accountId, 'acc-bca');
      assert.deepStrictEqual(byDigitsPage.records.map(record => record.id), ['rec-1', 'rec-3', 'rec-4', 'rec-5']);

      // 1.5 Fail-closed: unresolvable account produces explicit error and skips MCP call
      const callCountBefore = queryContext.capturedCalls.length;
      const unresolvedPage = await queryContext.service.getTransactionHistory({ accountName: 'CryptoWalletNonExistent' });
      assert.strictEqual(queryContext.capturedCalls.length, callCountBefore); // No MCP call made!
      assert.strictEqual(unresolvedPage.records.length, 0);
      assert.strictEqual(unresolvedPage.unresolvedFilters?.length, 1);
      assert.strictEqual(unresolvedPage.unresolvedFilters[0].filterKey, 'account');
      assert.strictEqual(unresolvedPage.unresolvedFilters[0].reason, 'NOT_FOUND');
    });
  });

  describe('Suite 2: Category Filtering & Resolution', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('resolves IDs, names, groups, and enforces fail-closed safety', async () => {
      // 2.1 Category filter by ID
      const byIdResult = await queryContext.service.getTransactionHistory({ categoryId: 'cat-food' });
      assert.deepStrictEqual(queryContext.capturedCalls[0].args.categoryId, ['cat-food']);
      assert.deepStrictEqual(byIdResult.records.map(record => record.id), ['rec-1', 'rec-2', 'rec-3']);

      // 2.2 Category filter by name (exact name match)
      const byNameResult = await queryContext.service.getTransactionHistory({ categoryName: 'Makanan & Minuman' });
      assert.deepStrictEqual(queryContext.capturedCalls[1].args.categoryId, ['cat-food']);
      assert.strictEqual(byNameResult.appliedFilters?.category?.id, 'cat-food');
      assert.deepStrictEqual(byNameResult.records.map(record => record.id), ['rec-1', 'rec-2', 'rec-3']);

      // 2.3 Category filter by name (substring match)
      const bySubResult = await queryContext.service.getTransactionHistory({ categoryName: 'listrik' });
      assert.deepStrictEqual(queryContext.capturedCalls[2].args.categoryId, ['cat-bills']);
      assert.strictEqual(bySubResult.records.length, 0);

      // 2.4 Category filter by group slug enum
      const byGroupResult = await queryContext.service.getTransactionHistory({ categoryGroup: 'food_and_drinks' });
      assert.strictEqual(queryContext.capturedCalls[3].args.categoryGroup, 'food_and_drinks');
      assert.strictEqual(byGroupResult.appliedFilters?.categoryGroup, 'food_and_drinks');
      assert.deepStrictEqual(byGroupResult.records.map(record => record.id), ['rec-1', 'rec-2', 'rec-3']);

      // 2.5 Fail-closed: unresolvable category skips MCP call
      const callCountBefore = queryContext.capturedCalls.length;
      const unresolvedCategoryPage = await queryContext.service.getTransactionHistory({ categoryName: 'KategoriFiktif' });
      assert.strictEqual(queryContext.capturedCalls.length, callCountBefore);
      assert.strictEqual(unresolvedCategoryPage.records.length, 0);
      assert.strictEqual(unresolvedCategoryPage.unresolvedFilters?.length, 1);
      assert.strictEqual(unresolvedCategoryPage.unresolvedFilters[0].filterKey, 'category');
      assert.strictEqual(unresolvedCategoryPage.unresolvedFilters[0].reason, 'NOT_FOUND');

      // 2.6 Fail-closed: ambiguous category substring match produces explicit UNRESOLVED error listing candidates
      const ambiguousCategories: WalletCategoryItem[] = [
        { id: 'cat-bills-electric', name: 'Tagihan Listrik' },
        { id: 'cat-bills-water', name: 'Tagihan Air' },
        { id: 'cat-bills-inet', name: 'Tagihan Internet' },
      ];
      const ambiguousContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: ambiguousCategories,
      });
      const callsBeforeAmbiguousCategory = ambiguousContext.capturedCalls.length;
      const ambiguousResult = await ambiguousContext.service.getTransactionHistory({ categoryName: 'tagihan' });

      assert.strictEqual(ambiguousContext.capturedCalls.length, callsBeforeAmbiguousCategory); // No MCP call made!
      assert.strictEqual(ambiguousResult.records.length, 0);
      assert.strictEqual(ambiguousResult.unresolvedFilters?.length, 1);
      assert.strictEqual(ambiguousResult.unresolvedFilters[0].filterKey, 'category');
      assert.strictEqual(ambiguousResult.unresolvedFilters[0].reason, 'UNRESOLVED');
      assert.strictEqual(
        ambiguousResult.unresolvedFilters[0].message,
        'Kategori "tagihan" ambigu. Kandidat: Tagihan Air, Tagihan Internet, Tagihan Listrik.'
      );

      // 2.7 Determinism invariant: reordering cached categories must not alter the ambiguous fail-closed outcome
      const reorderedCategories: WalletCategoryItem[] = [
        { id: 'cat-bills-water', name: 'Tagihan Air' },
        { id: 'cat-bills-electric', name: 'Tagihan Listrik' },
        { id: 'cat-bills-inet', name: 'Tagihan Internet' },
      ];
      const reorderedContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: reorderedCategories,
      });
      const reorderedResult = await reorderedContext.service.getTransactionHistory({ categoryName: 'tagihan' });

      assert.strictEqual(reorderedContext.capturedCalls.length, 0); // Still no MCP call!
      assert.deepStrictEqual(ambiguousResult.unresolvedFilters, reorderedResult.unresolvedFilters);

      // 2.8 Exact name match takes precedence over ambiguous substrings
      const withExactMatchCategories: WalletCategoryItem[] = [
        { id: 'cat-exact', name: 'Tagihan' },
        { id: 'cat-bills-electric', name: 'Tagihan Listrik' },
        { id: 'cat-bills-water', name: 'Tagihan Air' },
      ];
      const exactContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: withExactMatchCategories,
      });
      const exactResult = await exactContext.service.getTransactionHistory({ categoryName: 'tagihan' });
      assert.strictEqual(exactContext.capturedCalls.length, 1); // 1 MCP call made!
      assert.deepStrictEqual(exactContext.capturedCalls[0].args.categoryId, ['cat-exact']);
      assert.strictEqual(exactResult.appliedFilters?.category?.id, 'cat-exact');

      // 2.9 Multiple categories sharing identical exact name fail closed
      const duplicateExactCategories: WalletCategoryItem[] = [
        { id: 'cat-dup-1', name: 'Tagihan' },
        { id: 'cat-dup-2', name: 'Tagihan' },
      ];
      const duplicateExactContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: duplicateExactCategories,
      });
      const dupResult = await duplicateExactContext.service.getTransactionHistory({ categoryName: 'Tagihan' });
      assert.strictEqual(duplicateExactContext.capturedCalls.length, 0); // No MCP call!
      assert.strictEqual(dupResult.unresolvedFilters?.[0].reason, 'UNRESOLVED');
    });
  });

  describe('Suite 3: Record Type Filtering', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('correctly filters expense/income and accepts synonyms', async () => {
      // 3.1 Standard expense
      const expenseResult = await queryContext.service.getTransactionHistory({ recordType: 'expense' });
      assert.strictEqual(queryContext.capturedCalls[0].args.recordType, 'expense');
      assert.deepStrictEqual(expenseResult.records.map(record => record.id), ['rec-1', 'rec-2', 'rec-3', 'rec-5']);

      // 3.2 Standard income
      const incomeResult = await queryContext.service.getTransactionHistory({ recordType: 'income' });
      assert.strictEqual(queryContext.capturedCalls[1].args.recordType, 'income');
      assert.deepStrictEqual(incomeResult.records.map(record => record.id), ['rec-4']);

      // 3.3 Indonesian synonym: pengeluaran -> expense
      const pengeluaranResult = await queryContext.service.getTransactionHistory({ recordType: 'pengeluaran' as any });
      assert.strictEqual(queryContext.capturedCalls[2].args.recordType, 'expense');
      assert.deepStrictEqual(pengeluaranResult.records.map(record => record.id), ['rec-1', 'rec-2', 'rec-3', 'rec-5']);

      // 3.4 Indonesian synonym: pemasukan -> income
      const pemasukanResult = await queryContext.service.getTransactionHistory({ recordType: 'pemasukan' as any });
      assert.strictEqual(queryContext.capturedCalls[3].args.recordType, 'income');
      assert.deepStrictEqual(pemasukanResult.records.map(record => record.id), ['rec-4']);

      // 3.5 Fail-closed: invalid record type rejects before MCP call
      const callCountBefore = queryContext.capturedCalls.length;
      const invalidTypePage = await queryContext.service.getTransactionHistory({ recordType: 'invalid_type' as any });
      assert.strictEqual(queryContext.capturedCalls.length, callCountBefore);
      assert.strictEqual(invalidTypePage.unresolvedFilters?.[0].filterKey, 'recordType');
      assert.strictEqual(invalidTypePage.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');
    });
  });

  describe('Suite 4: Date & Date Range Filtering', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('verifies timezone UTC boundaries, calendar validation, and boundary handling', async () => {
      // 4.1 Explicit dateRange array with operator prefixes (resolved to local timezone half-open UTC boundaries)
      await queryContext.service.getTransactionHistory({ dateRange: ['gte.2024-01-01', 'lte.2024-06-30'] });
      assert.deepStrictEqual(queryContext.capturedCalls[0].args.recordDate, [
        'gte.2023-12-31T17:00:00.000Z',
        'lt.2024-06-30T17:00:00.000Z',
      ]);

      // 4.2 Start date and end date normalization and execution against canonical records
      const deterministicDatePage = await queryContext.service.getTransactionHistory({
        startDate: '2026-09-01',
        endDate: '2026-09-10',
      });
      assert.deepStrictEqual(queryContext.capturedCalls[1].args.recordDate, [
        'gte.2026-08-31T17:00:00.000Z',
        'lt.2026-09-10T17:00:00.000Z',
      ]);
      assert.deepStrictEqual(
        deterministicDatePage.records.map(record => record.id),
        ['rec-2', 'rec-3', 'rec-4']
      );

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

      // 4.6.1 Explicit single date vs 'today' equivalence regression test (Item 1)
      // Explicit 2026-09-11 must resolve to the EXACT SAME half-open interval as 'today' on 2026-09-11 WIB
      const explicitSingleDateNormal = normalizeTransactionHistoryFilters(
        { dateRange: ['eq.2026-09-11'] },
        [],
        [],
        fixedRefDate
      );
      assert.strictEqual(explicitSingleDateNormal.isValid, true);
      assert.deepStrictEqual(explicitSingleDateNormal.upstreamRecordDate, todayNormal.upstreamRecordDate);
      assert.deepStrictEqual(explicitSingleDateNormal.upstreamRecordDate, [
        'gte.2026-09-10T17:00:00.000Z',
        'lt.2026-09-11T17:00:00.000Z',
      ]);
      assert.strictEqual(explicitSingleDateNormal.appliedFilters.dateRange?.selector, '2026-09-11');
      assert.strictEqual(explicitSingleDateNormal.appliedFilters.dateRange?.label, '2026-09-11');

      // Verify explicit date also includes 00:30 and 23:30 WIB and excludes next day
      const [explicitLower, explicitUpper] = explicitSingleDateNormal.upstreamRecordDate!;
      const explicitLowerTs = Date.parse(explicitLower.replace('gte.', ''));
      const explicitUpperTs = Date.parse(explicitUpper.replace('lt.', ''));
      const isIncludedInExplicitDate = (utcIso: string): boolean => {
        const ts = Date.parse(utcIso);
        return ts >= explicitLowerTs && ts < explicitUpperTs;
      };
      assert.strictEqual(isIncludedInExplicitDate('2026-09-10T17:30:00.000Z'), true); // 00:30 WIB
      assert.strictEqual(isIncludedInExplicitDate('2026-09-11T16:30:00.000Z'), true); // 23:30 WIB
      assert.strictEqual(isIncludedInExplicitDate('2026-09-11T17:05:00.000Z'), false); // 00:05 WIB next day

      // 4.7 Date boundary: startDate > endDate fails closed before MCP
      const callsBeforeReversedDates = queryContext.capturedCalls.length;
      const invalidRangePage = await queryContext.service.getTransactionHistory({
        startDate: '2024-12-31',
        endDate: '2024-01-01',
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeReversedDates); // No MCP call!
      assert.strictEqual(invalidRangePage.unresolvedFilters?.[0].filterKey, 'dateRange');
      assert.strictEqual(invalidRangePage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

      // 4.8 Array dateRange: reversed bounds fails closed before MCP
      const callsBeforeArrayReversed = queryContext.capturedCalls.length;
      const arrayReversedPage = await queryContext.service.getTransactionHistory({
        dateRange: ['gte.2026-09-30', 'lte.2026-09-01'],
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeArrayReversed); // No MCP call!
      assert.strictEqual(arrayReversedPage.records.length, 0);
      assert.strictEqual(arrayReversedPage.unresolvedFilters?.[0].filterKey, 'dateRange');
      assert.strictEqual(arrayReversedPage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

      // 4.9 Fast-path reversed bounds: fails closed before MCP
      const fastPathReversedAction = detectFastPathAction('history 2026-09-30 2026-09-01');
      assert.ok(fastPathReversedAction);
      assert.strictEqual((fastPathReversedAction as any).type, 'TRANSACTION_HISTORY');
      const callsBeforeFpReversed = queryContext.capturedCalls.length;
      const fpReversedPage = await queryContext.service.getTransactionHistory((fastPathReversedAction as any).options);
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeFpReversed); // No MCP call!
      assert.strictEqual(fpReversedPage.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

      // 4.10 Array dateRange: impossible calendar dates fail closed before MCP
      const callsBeforeImpossibleDate = queryContext.capturedCalls.length;
      const impossibleDatePage = await queryContext.service.getTransactionHistory({
        dateRange: ['eq.2024-02-30'],
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeImpossibleDate); // No MCP call!
      assert.strictEqual(impossibleDatePage.records.length, 0);
      assert.strictEqual(impossibleDatePage.unresolvedFilters?.[0].filterKey, 'dateRange');
      assert.strictEqual(impossibleDatePage.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

      // 4.11 Start date with impossible calendar date (2026-04-31) fails closed before MCP
      const callsBeforeImpossibleApr31 = queryContext.capturedCalls.length;
      const impossibleApr31Page = await queryContext.service.getTransactionHistory({
        startDate: '2026-04-31',
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeImpossibleApr31); // No MCP call!
      assert.strictEqual(impossibleApr31Page.unresolvedFilters?.[0].reason, 'INVALID_FORMAT');

      // 4.12 Non-leap year Feb 29 (2025-02-29) fails closed before MCP
      const callsBeforeNonLeapFeb29 = queryContext.capturedCalls.length;
      const nonLeapFeb29Page = await queryContext.service.getTransactionHistory({
        startDate: '2025-02-29',
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeNonLeapFeb29); // No MCP call!
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

      // 4.14 Object dateRange { from, to } valid normalization (timezone-aware UTC boundaries)
      const validObjRange = normalizeTransactionHistoryFilters({ dateRange: { from: '2026-05-01', to: '2026-05-31' } });
      assert.strictEqual(validObjRange.isValid, true);
      assert.deepStrictEqual(validObjRange.upstreamRecordDate, [
        'gte.2026-04-30T17:00:00.000Z',
        'lt.2026-05-31T17:00:00.000Z',
      ]);
      assert.strictEqual(validObjRange.appliedFilters.dateRange?.selector, '2026-05-01 2026-05-31');

      // 4.15 Object dateRange { from, to } with invalid 'to' fails closed before MCP
      const callsBeforeObjInvalidTo = queryContext.capturedCalls.length;
      const objInvalidToPage = await queryContext.service.getTransactionHistory({
        dateRange: { from: '2026-05-01', to: '2026-02-30' },
      });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeObjInvalidTo);
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

      // 4.17 Category group navigation token propagation (grammar-safe canonical selector)
      const categoryGroupNorm = normalizeTransactionHistoryFilters({ categoryGroup: 'food_and_drinks' });
      assert.strictEqual(categoryGroupNorm.isValid, true);
      assert.strictEqual(categoryGroupNorm.appliedFilters.navigationTokens?.[0], 'kategori "food_and_drinks"');

      // 4.18 Datetime precision preservation: 1-hour same-day ISO range must preserve exact 1-hour interval
      const oneHourStart = '2026-09-11T12:00:00.000Z';
      const oneHourEnd = '2026-09-11T13:00:00.000Z';
      const oneHourResult = normalizeTransactionHistoryFilters(
        { startDate: oneHourStart, endDate: oneHourEnd },
        [],
        [],
        fixedRefDate
      );
      assert.strictEqual(oneHourResult.isValid, true);
      assert.deepStrictEqual(oneHourResult.upstreamRecordDate, [
        `gte.${oneHourStart}`,
        `lte.${oneHourEnd}`,
      ]);
      const startTimestamp = Date.parse(oneHourStart);
      const endTimestamp = Date.parse(oneHourEnd);
      assert.strictEqual(endTimestamp - startTimestamp, 3600000); // Exactly 1 hour, not 24 hours (86400000)
      assert.strictEqual(oneHourResult.appliedFilters.dateRange?.from, oneHourStart);
      assert.strictEqual(oneHourResult.appliedFilters.dateRange?.to, oneHourEnd);

      // Verify MCP call passes exact 1-hour ISO strings through service
      const callsBeforeOneHour = queryContext.capturedCalls.length;
      await queryContext.service.getTransactionHistory({ startDate: oneHourStart, endDate: oneHourEnd });
      assert.strictEqual(queryContext.capturedCalls.length, callsBeforeOneHour + 1);
      assert.deepStrictEqual(queryContext.capturedCalls[queryContext.capturedCalls.length - 1].args.recordDate, [
        `gte.${oneHourStart}`,
        `lte.${oneHourEnd}`,
      ]);

  // 4.19 Array format with full ISO timestamps also preserves exact precision
  const arrayIsoResult = normalizeTransactionHistoryFilters(
    { dateRange: [`gte.${oneHourStart}`, `lte.${oneHourEnd}`] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(arrayIsoResult.isValid, true);
  assert.deepStrictEqual(arrayIsoResult.upstreamRecordDate, [
    `gte.${oneHourStart}`,
    `lte.${oneHourEnd}`,
  ]);

  // 4.20 Date-only gt calendar semantics: strictly after 2026-09-11 starts at midnight of Sep 12 WIB
  // Sep 11 in WIB: 2026-09-10T17:00:00.000Z to 2026-09-11T17:00:00.000Z
  // Next local day (Sep 12 WIB): starts at 2026-09-11T17:00:00.000Z
  const gtDateOnlyResult = normalizeTransactionHistoryFilters(
    { dateRange: ['gt.2026-09-11'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(gtDateOnlyResult.isValid, true);
  assert.deepStrictEqual(gtDateOnlyResult.upstreamRecordDate, ['gte.2026-09-11T17:00:00.000Z']);
  assert.strictEqual(gtDateOnlyResult.appliedFilters.dateRange?.selector, '> 2026-09-11');
  assert.strictEqual(gtDateOnlyResult.appliedFilters.dateRange?.label, '> 2026-09-11');

  // Verify exclusion of Sep 11 and inclusion of Sep 12 for gt
  const gtLowerBound = Date.parse(gtDateOnlyResult.upstreamRecordDate![0].replace('gte.', ''));
  assert.strictEqual(Date.parse('2026-09-11T16:30:00.000Z') >= gtLowerBound, false); // 23:30 WIB Sep 11 EXCLUDED
  assert.strictEqual(Date.parse('2026-09-11T17:30:00.000Z') >= gtLowerBound, true);  // 00:30 WIB Sep 12 INCLUDED

  // 4.21 Date-only gte calendar semantics: on or after 2026-09-11 starts at midnight of Sep 11 WIB
  const gteDateOnlyResult = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-11'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(gteDateOnlyResult.isValid, true);
  assert.deepStrictEqual(gteDateOnlyResult.upstreamRecordDate, ['gte.2026-09-10T17:00:00.000Z']);
  assert.strictEqual(gteDateOnlyResult.appliedFilters.dateRange?.selector, '>= 2026-09-11');
  assert.strictEqual(gteDateOnlyResult.appliedFilters.dateRange?.label, '>= 2026-09-11');
  const gteLowerBound = Date.parse(gteDateOnlyResult.upstreamRecordDate![0].replace('gte.', ''));
  assert.strictEqual(Date.parse('2026-09-10T17:30:00.000Z') >= gteLowerBound, true); // 00:30 WIB Sep 11 INCLUDED
  assert.strictEqual(Date.parse('2026-09-10T16:30:00.000Z') >= gteLowerBound, false); // 23:30 WIB Sep 10 EXCLUDED

  // 4.22 Date-only lt calendar semantics: strictly before 2026-09-11 ends at midnight of Sep 11 WIB
  const ltDateOnlyResult = normalizeTransactionHistoryFilters(
    { dateRange: ['lt.2026-09-11'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(ltDateOnlyResult.isValid, true);
  assert.deepStrictEqual(ltDateOnlyResult.upstreamRecordDate, ['lt.2026-09-10T17:00:00.000Z']);
  assert.strictEqual(ltDateOnlyResult.appliedFilters.dateRange?.selector, '< 2026-09-11');
  assert.strictEqual(ltDateOnlyResult.appliedFilters.dateRange?.label, '< 2026-09-11');
  const ltUpperBound = Date.parse(ltDateOnlyResult.upstreamRecordDate![0].replace('lt.', ''));
  assert.strictEqual(Date.parse('2026-09-10T16:30:00.000Z') < ltUpperBound, true);  // 23:30 WIB Sep 10 INCLUDED
  assert.strictEqual(Date.parse('2026-09-10T17:30:00.000Z') < ltUpperBound, false); // 00:30 WIB Sep 11 EXCLUDED

  // 4.23 Date-only lte calendar semantics: on or before 2026-09-11 ends at midnight of Sep 12 WIB
  const lteDateOnlyResult = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-11'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(lteDateOnlyResult.isValid, true);
  assert.deepStrictEqual(lteDateOnlyResult.upstreamRecordDate, ['lt.2026-09-11T17:00:00.000Z']);
  assert.strictEqual(lteDateOnlyResult.appliedFilters.dateRange?.selector, '<= 2026-09-11');
  assert.strictEqual(lteDateOnlyResult.appliedFilters.dateRange?.label, '<= 2026-09-11');
  const lteUpperBound = Date.parse(lteDateOnlyResult.upstreamRecordDate![0].replace('lt.', ''));
  assert.strictEqual(Date.parse('2026-09-11T16:30:00.000Z') < lteUpperBound, true);  // 23:30 WIB Sep 11 INCLUDED
  assert.strictEqual(Date.parse('2026-09-11T17:30:00.000Z') < lteUpperBound, false); // 00:30 WIB Sep 12 EXCLUDED

  // 4.24 Mixed date-only start and datetime end normalized independently
  // startDate=2026-09-11 (date-only) + endDate=2026-09-11T13:00:00Z (datetime)
  // In Asia/Jakarta (UTC+7): 2026-09-11 starts at 2026-09-10T17:00:00.000Z (00:00 WIB)
  const mixedStartResult = normalizeTransactionHistoryFilters(
    { startDate: '2026-09-11', endDate: '2026-09-11T13:00:00Z' },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(mixedStartResult.isValid, true);
  assert.deepStrictEqual(mixedStartResult.upstreamRecordDate, [
    'gte.2026-09-10T17:00:00.000Z',
    'lte.2026-09-11T13:00:00.000Z',
  ]);
  assert.strictEqual(mixedStartResult.appliedFilters.dateRange?.from, '2026-09-11');
  assert.strictEqual(mixedStartResult.appliedFilters.dateRange?.to, '2026-09-11T13:00:00.000Z');
  assert.strictEqual(mixedStartResult.appliedFilters.dateRange?.selector, '2026-09-11 2026-09-11T13:00:00.000Z');
  // Verify transactions between 00:00 and 06:59 WIB on Sep 11 are included (e.g. 01:00 WIB = 2026-09-10T18:00:00Z)
  const mixedStartLowerTimestamp = Date.parse('2026-09-10T17:00:00.000Z');
  const earlyMorningWibTimestamp = Date.parse('2026-09-10T18:00:00.000Z');
  assert.strictEqual(earlyMorningWibTimestamp >= mixedStartLowerTimestamp, true);

  // 4.25 Mixed datetime start and date-only end normalized independently
  // startDate=2026-09-11T10:00:00Z (datetime) + endDate=2026-09-11 (date-only)
  // In Asia/Jakarta (UTC+7): 2026-09-11 ends at 2026-09-11T17:00:00.000Z (24:00 WIB)
  const mixedEndResult = normalizeTransactionHistoryFilters(
    { startDate: '2026-09-11T10:00:00Z', endDate: '2026-09-11' },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(mixedEndResult.isValid, true);
  assert.deepStrictEqual(mixedEndResult.upstreamRecordDate, [
    'gte.2026-09-11T10:00:00.000Z',
    'lt.2026-09-11T17:00:00.000Z',
  ]);
  assert.strictEqual(mixedEndResult.appliedFilters.dateRange?.from, '2026-09-11T10:00:00.000Z');
  assert.strictEqual(mixedEndResult.appliedFilters.dateRange?.to, '2026-09-11');
  assert.strictEqual(mixedEndResult.appliedFilters.dateRange?.selector, '2026-09-11T10:00:00.000Z 2026-09-11');
  // Verify transactions up to 23:59 WIB on Sep 11 are included (e.g. 23:00 WIB = 2026-09-11T16:00:00Z)
  const mixedEndUpperTimestamp = Date.parse('2026-09-11T17:00:00.000Z');
  const lateNightWibTimestamp = Date.parse('2026-09-11T16:00:00.000Z');
  assert.strictEqual(lateNightWibTimestamp < mixedEndUpperTimestamp, true);

  // 4.26 Mixed bounds in array format
  const mixedArrayResult = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-11', 'lte.2026-09-11T13:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(mixedArrayResult.isValid, true);
  assert.deepStrictEqual(mixedArrayResult.upstreamRecordDate, [
    'gte.2026-09-10T17:00:00.000Z',
    'lte.2026-09-11T13:00:00.000Z',
  ]);

  // 4.27 Mixed bounds with datetime start and date-only end in array format
  const mixedArrayResult2 = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-11T10:00:00Z', 'lte.2026-09-11'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(mixedArrayResult2.isValid, true);
  assert.deepStrictEqual(mixedArrayResult2.upstreamRecordDate, [
    'gte.2026-09-11T10:00:00.000Z',
    'lt.2026-09-11T17:00:00.000Z',
  ]);

  // 4.28 Duplicate upper bounds in both orders preserve conjunction AND semantics
  const duplicateUpperOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-15', 'lte.2026-09-30'] },
    [],
    [],
    fixedRefDate
  );
  const duplicateUpperOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-30', 'lte.2026-09-15'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(duplicateUpperOrderA.isValid, true);
  assert.strictEqual(duplicateUpperOrderB.isValid, true);
  assert.deepStrictEqual(duplicateUpperOrderA.upstreamRecordDate, ['lt.2026-09-15T17:00:00.000Z']);
  assert.deepStrictEqual(duplicateUpperOrderA.upstreamRecordDate, duplicateUpperOrderB.upstreamRecordDate);
  assert.strictEqual(duplicateUpperOrderA.appliedFilters.dateRange?.to, '2026-09-15');
  assert.strictEqual(duplicateUpperOrderA.appliedFilters.dateRange?.selector, '<= 2026-09-15');
  assert.deepStrictEqual(duplicateUpperOrderA.appliedFilters.dateRange, duplicateUpperOrderB.appliedFilters.dateRange);

  // Duplicate upper bounds with ISO datetime in both orders
  const duplicateUpperDatetimeOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-15T12:00:00Z', 'lte.2026-09-15T18:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  const duplicateUpperDatetimeOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-15T18:00:00Z', 'lte.2026-09-15T12:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(duplicateUpperDatetimeOrderA.isValid, true);
  assert.strictEqual(duplicateUpperDatetimeOrderB.isValid, true);
  assert.deepStrictEqual(duplicateUpperDatetimeOrderA.upstreamRecordDate, ['lte.2026-09-15T12:00:00.000Z']);
  assert.deepStrictEqual(duplicateUpperDatetimeOrderA.upstreamRecordDate, duplicateUpperDatetimeOrderB.upstreamRecordDate);
  assert.deepStrictEqual(duplicateUpperDatetimeOrderA.appliedFilters.dateRange, duplicateUpperDatetimeOrderB.appliedFilters.dateRange);

  // 4.29 Duplicate lower bounds in both orders preserve conjunction AND semantics
  const duplicateLowerOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-01', 'gte.2026-09-10'] },
    [],
    [],
    fixedRefDate
  );
  const duplicateLowerOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-10', 'gte.2026-09-01'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(duplicateLowerOrderA.isValid, true);
  assert.strictEqual(duplicateLowerOrderB.isValid, true);
  assert.deepStrictEqual(duplicateLowerOrderA.upstreamRecordDate, ['gte.2026-09-09T17:00:00.000Z']);
  assert.deepStrictEqual(duplicateLowerOrderA.upstreamRecordDate, duplicateLowerOrderB.upstreamRecordDate);
  assert.strictEqual(duplicateLowerOrderA.appliedFilters.dateRange?.from, '2026-09-10');
  assert.strictEqual(duplicateLowerOrderA.appliedFilters.dateRange?.selector, '>= 2026-09-10');
  assert.deepStrictEqual(duplicateLowerOrderA.appliedFilters.dateRange, duplicateLowerOrderB.appliedFilters.dateRange);

  // Duplicate lower bounds with ISO datetime in both orders
  const duplicateLowerDatetimeOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-10T08:00:00Z', 'gte.2026-09-10T14:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  const duplicateLowerDatetimeOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-10T14:00:00Z', 'gte.2026-09-10T08:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(duplicateLowerDatetimeOrderA.isValid, true);
  assert.strictEqual(duplicateLowerDatetimeOrderB.isValid, true);
  assert.deepStrictEqual(duplicateLowerDatetimeOrderA.upstreamRecordDate, ['gte.2026-09-10T14:00:00.000Z']);
  assert.deepStrictEqual(duplicateLowerDatetimeOrderA.upstreamRecordDate, duplicateLowerDatetimeOrderB.upstreamRecordDate);
  assert.deepStrictEqual(duplicateLowerDatetimeOrderA.appliedFilters.dateRange, duplicateLowerDatetimeOrderB.appliedFilters.dateRange);

  // 4.30 eq + compatible bound in both orders resolves to deterministic intersection
  const eqCompatibleLowerOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'gte.2026-09-15'] },
    [],
    [],
    fixedRefDate
  );
  const eqCompatibleLowerOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-15', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqCompatibleLowerOrderA.isValid, true);
  assert.strictEqual(eqCompatibleLowerOrderB.isValid, true);
  assert.deepStrictEqual(eqCompatibleLowerOrderA.upstreamRecordDate, [
    'gte.2026-09-19T17:00:00.000Z',
    'lt.2026-09-20T17:00:00.000Z',
  ]);
  assert.deepStrictEqual(eqCompatibleLowerOrderA.upstreamRecordDate, eqCompatibleLowerOrderB.upstreamRecordDate);
  assert.strictEqual(eqCompatibleLowerOrderA.appliedFilters.dateRange?.selector, '2026-09-20');
  assert.deepStrictEqual(eqCompatibleLowerOrderA.appliedFilters.dateRange, eqCompatibleLowerOrderB.appliedFilters.dateRange);

  // eq + compatible upper bound in both orders
  const eqCompatibleUpperOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'lte.2026-09-25'] },
    [],
    [],
    fixedRefDate
  );
  const eqCompatibleUpperOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-25', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqCompatibleUpperOrderA.isValid, true);
  assert.strictEqual(eqCompatibleUpperOrderB.isValid, true);
  assert.deepStrictEqual(eqCompatibleUpperOrderA.upstreamRecordDate, eqCompatibleUpperOrderB.upstreamRecordDate);
  assert.deepStrictEqual(eqCompatibleUpperOrderA.appliedFilters.dateRange, eqCompatibleUpperOrderB.appliedFilters.dateRange);

  // eq + compatible datetime bound in both orders
  const eqCompatibleDatetimeOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20T12:00:00Z', 'gte.2026-09-20T10:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  const eqCompatibleDatetimeOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-20T10:00:00Z', 'eq.2026-09-20T12:00:00Z'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqCompatibleDatetimeOrderA.isValid, true);
  assert.strictEqual(eqCompatibleDatetimeOrderB.isValid, true);
  assert.deepStrictEqual(eqCompatibleDatetimeOrderA.upstreamRecordDate, [
    'gte.2026-09-20T12:00:00.000Z',
    'lte.2026-09-20T12:00:00.000Z',
  ]);
  assert.deepStrictEqual(eqCompatibleDatetimeOrderA.upstreamRecordDate, eqCompatibleDatetimeOrderB.upstreamRecordDate);
  assert.deepStrictEqual(eqCompatibleDatetimeOrderA.appliedFilters.dateRange, eqCompatibleDatetimeOrderB.appliedFilters.dateRange);

  // 4.31 eq + contradictory bound in both orders fails closed
  const eqContradictoryOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'lt.2026-09-15'] },
    [],
    [],
    fixedRefDate
  );
  const eqContradictoryOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['lt.2026-09-15', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqContradictoryOrderA.isValid, false);
  assert.strictEqual(eqContradictoryOrderB.isValid, false);
  assert.strictEqual(eqContradictoryOrderA.unresolvedFilters?.[0].filterKey, 'dateRange');
  assert.strictEqual(eqContradictoryOrderA.unresolvedFilters?.[0].reason, 'INVALID_RANGE');
  assert.strictEqual(eqContradictoryOrderA.unresolvedFilters?.[0].subType, 'start_after_end');
  assert.strictEqual(eqContradictoryOrderB.unresolvedFilters?.[0].filterKey, 'dateRange');
  assert.strictEqual(eqContradictoryOrderB.unresolvedFilters?.[0].reason, 'INVALID_RANGE');
  assert.strictEqual(eqContradictoryOrderB.unresolvedFilters?.[0].subType, 'start_after_end');

  // eq + contradictory future bound in both orders
  const eqContradictoryFutureOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'gt.2026-09-25'] },
    [],
    [],
    fixedRefDate
  );
  const eqContradictoryFutureOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['gt.2026-09-25', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqContradictoryFutureOrderA.isValid, false);
  assert.strictEqual(eqContradictoryFutureOrderB.isValid, false);
  assert.strictEqual(eqContradictoryFutureOrderA.unresolvedFilters?.[0].reason, 'INVALID_RANGE');
  assert.strictEqual(eqContradictoryFutureOrderB.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // eq + contradictory strict bound on same day in both orders
  const eqContradictorySameDayStrictA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'lt.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  const eqContradictorySameDayStrictB = normalizeTransactionHistoryFilters(
    { dateRange: ['lt.2026-09-20', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqContradictorySameDayStrictA.isValid, false);
  assert.strictEqual(eqContradictorySameDayStrictB.isValid, false);
  assert.strictEqual(eqContradictorySameDayStrictA.unresolvedFilters?.[0].reason, 'INVALID_RANGE');
  assert.strictEqual(eqContradictorySameDayStrictB.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // Two different eq conditions fail closed as contradictory in both orders
  const eqDifferentDatesOrderA = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-20', 'eq.2026-09-25'] },
    [],
    [],
    fixedRefDate
  );
  const eqDifferentDatesOrderB = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-25', 'eq.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(eqDifferentDatesOrderA.isValid, false);
  assert.strictEqual(eqDifferentDatesOrderB.isValid, false);
  assert.strictEqual(eqDifferentDatesOrderA.unresolvedFilters?.[0].reason, 'INVALID_RANGE');
  assert.strictEqual(eqDifferentDatesOrderB.unresolvedFilters?.[0].reason, 'INVALID_RANGE');

  // 4.32 Reordered standard bounds produce 100% identical outputs
  const standardReorderedA = normalizeTransactionHistoryFilters(
    { dateRange: ['gte.2026-09-10', 'lte.2026-09-20'] },
    [],
    [],
    fixedRefDate
  );
  const standardReorderedB = normalizeTransactionHistoryFilters(
    { dateRange: ['lte.2026-09-20', 'gte.2026-09-10'] },
    [],
    [],
    fixedRefDate
  );
  assert.strictEqual(standardReorderedA.isValid, true);
  assert.strictEqual(standardReorderedB.isValid, true);
  assert.deepStrictEqual(standardReorderedA.upstreamRecordDate, standardReorderedB.upstreamRecordDate);
  assert.deepStrictEqual(standardReorderedA.appliedFilters.dateRange, standardReorderedB.appliedFilters.dateRange);

  console.log('  [PASS] Timezone UTC boundaries, strict calendar validation, and reversed bounds verified.');

    });
  });

  describe('Suite 5: Composable Multi-Filter Queries', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('accurately combines all dimensions simultaneously', async () => {
      // Combine account + category + recordType + dateRange + limit + sort
      const comboResult = await queryContext.service.getTransactionHistory({
        accountName: 'BCA',
        categoryName: 'Makanan',
        recordType: 'expense',
        startDate: '2026-09-01',
        endDate: '2026-09-30',
        limit: 5,
        sort: 'oldest',
      });

      assert.strictEqual(queryContext.capturedCalls.length, 1);
      const mcpArgs = queryContext.capturedCalls[0].args;
      assert.strictEqual(mcpArgs.accountId, 'acc-bca');
      assert.deepStrictEqual(mcpArgs.categoryId, ['cat-food']);
      assert.strictEqual(mcpArgs.recordType, 'expense');
      assert.deepStrictEqual(mcpArgs.recordDate, [
        'gte.2026-08-31T17:00:00.000Z',
        'lt.2026-09-30T17:00:00.000Z',
      ]);
      assert.strictEqual(mcpArgs.limit, 5);
      assert.deepStrictEqual(mcpArgs.sortBy, ['+recordDate', '+createdAt']);

      assert.strictEqual(comboResult.records.length, 2);
      assert.deepStrictEqual(comboResult.records.map(r => r.id), ['rec-3', 'rec-1']);
      assert.strictEqual(comboResult.records[0].accountName, 'BCA Tabungan');
      assert.strictEqual(comboResult.appliedFilters?.account?.name, 'BCA Tabungan');
      assert.strictEqual(comboResult.appliedFilters?.account?.selector, 'bca');
      assert.strictEqual(comboResult.appliedFilters?.category?.name, 'Makanan & Minuman');
      assert.strictEqual(comboResult.appliedFilters?.category?.selector, 'makanan');
      assert.strictEqual(comboResult.appliedFilters?.recordType, 'expense');

      console.log('  [PASS] Composable multi-filter query accurately combines all dimensions simultaneously.');
    });
  });

  describe('Suite 6: Empty Matches & Filtered State Handling', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
    });

    it('renders non-misleading filtered empty state', async () => {
      const emptyFilteredPage = await queryContext.service.getTransactionHistory({
        accountName: 'Mandiri',
        categoryName: 'Makanan',
      });

      assert.strictEqual(emptyFilteredPage.records.length, 0);
      assert.strictEqual(emptyFilteredPage.total, 0);

      const formattedEmpty = formatTransactionHistoryMessage(emptyFilteredPage, 'id');
      assert.match(formattedEmpty, /Belum ada transaksi yang cocok dengan filter/);
      assert.match(formattedEmpty, /Mandiri Utama/);

      console.log('  [PASS] Empty results with active filters render non-misleading filtered empty state.');
    });
  });

  describe('Suite 7: Human-Facing Response Formatting & i18n', () => {
    it('formats localized headers, badges, warnings, and navigation hints properly', () => {

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
  assert.strictEqual(fullExtractedCommandEn, 'history bca food expense this month 5 page 2 oldest');

  const parsedFullEn = detectFastPathAction(fullExtractedCommandEn);
  assert.ok(parsedFullEn);
  assert.strictEqual((parsedFullEn as any).type, 'TRANSACTION_HISTORY');
  assert.strictEqual((parsedFullEn as any).options.page, 2);
  assert.strictEqual((parsedFullEn as any).options.limit, 5);
  assert.strictEqual((parsedFullEn as any).options.sort, 'oldest');
  assert.strictEqual((parsedFullEn as any).options.accountName, 'bca');
  assert.strictEqual((parsedFullEn as any).options.categoryName, 'food');
  assert.strictEqual((parsedFullEn as any).options.recordType, 'expense');
  assert.strictEqual((parsedFullEn as any).options.datePeriod, 'this_month');

  // 7.6 Explicit single-date pagination round-trip regression test (Item 2)
  const singleDatePageNormalized = normalizeTransactionHistoryFilters(
    { dateRange: ['eq.2026-09-11'] },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(singleDatePageNormalized.appliedFilters.dateRange?.selector, '2026-09-11');
  const singleDateHistPage: any = {
    records: samplePage.records,
    total: 20,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 2,
    nextOffset: 10,
    hasMore: true,
    sort: 'newest',
    appliedFilters: singleDatePageNormalized.appliedFilters,
  };
  const singleDateHintId = formatTransactionHistoryMessage(singleDateHistPage, 'id');
  assert.match(singleDateHintId, /riwayat 2026-09-11 hal 2/);
  const parsedSingleDateActionId = detectFastPathAction('riwayat 2026-09-11 hal 2');
  assert.ok(parsedSingleDateActionId);
  assert.strictEqual((parsedSingleDateActionId as any).options.page, 2);
  assert.deepStrictEqual((parsedSingleDateActionId as any).options.dateRange, ['eq.2026-09-11']);

  const singleDateHintEn = formatTransactionHistoryMessage(singleDateHistPage, 'en');
  assert.match(singleDateHintEn, /history 2026-09-11 page 2/);
  const parsedSingleDateActionEn = detectFastPathAction('history 2026-09-11 page 2');
  assert.ok(parsedSingleDateActionEn);
  assert.strictEqual((parsedSingleDateActionEn as any).options.page, 2);
  assert.deepStrictEqual((parsedSingleDateActionEn as any).options.dateRange, ['eq.2026-09-11']);

  // 7.7 Explicit date-range pagination round-trip regression test (Item 2)
  const rangeDatePageNormalized = normalizeTransactionHistoryFilters(
    { startDate: '2026-09-01', endDate: '2026-09-30' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(rangeDatePageNormalized.appliedFilters.dateRange?.selector, '2026-09-01 2026-09-30');
  const rangeDateHistPage: any = {
    records: samplePage.records,
    total: 30,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 3,
    nextOffset: 10,
    hasMore: true,
    sort: 'newest',
    appliedFilters: rangeDatePageNormalized.appliedFilters,
  };
  const rangeDateHintId = formatTransactionHistoryMessage(rangeDateHistPage, 'id');
  assert.match(rangeDateHintId, /riwayat 2026-09-01 2026-09-30 hal 2/);
  const parsedRangeActionId = detectFastPathAction('riwayat 2026-09-01 2026-09-30 hal 2');
  assert.ok(parsedRangeActionId);
  assert.strictEqual((parsedRangeActionId as any).options.page, 2);
  assert.deepStrictEqual((parsedRangeActionId as any).options.dateRange, [
    'gte.2026-09-01',
    'lte.2026-09-30',
  ]);

  // 7.7.1 Round-trip open-ended date operators (gt, gte, lt, lte) through formatter -> parser -> normalizer
  for (const testCase of [
    { op: 'gt', symbol: '>', selector: '> 2026-09-11', expectedUpstream: ['gte.2026-09-11T17:00:00.000Z'] },
    { op: 'gte', symbol: '>=', selector: '>= 2026-09-11', expectedUpstream: ['gte.2026-09-10T17:00:00.000Z'] },
    { op: 'lt', symbol: '<', selector: '< 2026-09-11', expectedUpstream: ['lt.2026-09-10T17:00:00.000Z'] },
    { op: 'lte', symbol: '<=', selector: '<= 2026-09-11', expectedUpstream: ['lt.2026-09-11T17:00:00.000Z'] },
  ]) {
    const normalized = normalizeTransactionHistoryFilters(
      { dateRange: [`${testCase.op}.2026-09-11`] },
      MOCK_ACCOUNTS,
      MOCK_CATEGORIES,
      FIXED_TEST_REFERENCE_DATE
    );
    assert.strictEqual(normalized.appliedFilters.dateRange?.selector, testCase.selector);
    assert.deepStrictEqual(normalized.upstreamRecordDate, testCase.expectedUpstream);

    const histPage: any = {
      records: samplePage.records,
      total: 20,
      limit: 10,
      offset: 0,
      page: 1,
      totalPages: 2,
      hasMore: true,
      sort: 'newest',
      appliedFilters: normalized.appliedFilters,
    };

    // 1. Formatter generates navigation command with operator
    const hintId = formatTransactionHistoryMessage(histPage, 'id');
    const navCommand = `riwayat ${testCase.symbol} 2026-09-11 hal 2`;
    assert.ok(hintId.includes(navCommand), `Expected hintId to include "${navCommand}"`);

    // 2. Parser recovers the operator and page number
    const parsedAction = detectFastPathAction(navCommand);
    assert.ok(parsedAction, `Failed to parse ${navCommand}`);
    assert.strictEqual((parsedAction as any).options.page, 2);
    assert.deepStrictEqual((parsedAction as any).options.dateRange, [`${testCase.op}.2026-09-11`]);

    // 3. Normalizer re-evaluates to the EXACT same upstream UTC interval
    const reNormalized = normalizeTransactionHistoryFilters(
      (parsedAction as any).options,
      MOCK_ACCOUNTS,
      MOCK_CATEGORIES,
      FIXED_TEST_REFERENCE_DATE
    );
    assert.deepStrictEqual(reNormalized.upstreamRecordDate, testCase.expectedUpstream);
    assert.strictEqual(reNormalized.appliedFilters.dateRange?.selector, testCase.selector);
  }

  // 7.8 Quoted multiword navigation round-trip for accountId, categoryId, and categoryGroup (Item 3)
  // Account ID -> BCA Tabungan -> akun "BCA Tabungan"
  const accountIdNormalized = normalizeTransactionHistoryFilters(
    { accountId: 'acc-bca' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(accountIdNormalized.appliedFilters.account?.name, 'BCA Tabungan');
  assert.strictEqual(accountIdNormalized.appliedFilters.account?.selector, 'akun "BCA Tabungan"');

  const accountIdHistPage: any = {
    records: samplePage.records,
    total: 20,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 2,
    hasMore: true,
    sort: 'newest',
    appliedFilters: accountIdNormalized.appliedFilters,
  };
  const accountIdHintId = formatTransactionHistoryMessage(accountIdHistPage, 'id');
  assert.match(accountIdHintId, /riwayat akun "BCA Tabungan" hal 2/);
  const parsedAccountIdAction = detectFastPathAction('riwayat akun "BCA Tabungan" hal 2');
  assert.ok(parsedAccountIdAction);
  assert.strictEqual((parsedAccountIdAction as any).options.page, 2);
  assert.strictEqual((parsedAccountIdAction as any).options.accountName, 'bca tabungan');
  // Re-normalizing parsed options resolves to the exact same accountId
  const reNormalizedAccount = normalizeTransactionHistoryFilters(
    (parsedAccountIdAction as any).options,
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(reNormalizedAccount.upstreamAccountId, 'acc-bca');

  // Category ID -> Makanan & Minuman -> kategori "Makanan & Minuman"
  const categoryIdNormalized = normalizeTransactionHistoryFilters(
    { categoryId: 'cat-food' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(categoryIdNormalized.appliedFilters.category?.name, 'Makanan & Minuman');
  assert.strictEqual(categoryIdNormalized.appliedFilters.category?.selector, 'kategori "Makanan & Minuman"');

  const categoryIdHistPage: any = {
    records: samplePage.records,
    total: 20,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 2,
    hasMore: true,
    sort: 'newest',
    appliedFilters: categoryIdNormalized.appliedFilters,
  };
  const categoryIdHintId = formatTransactionHistoryMessage(categoryIdHistPage, 'id');
  assert.match(categoryIdHintId, /riwayat kategori "Makanan & Minuman" hal 2/);
  const parsedCategoryIdAction = detectFastPathAction('riwayat kategori "Makanan & Minuman" hal 2');
  assert.ok(parsedCategoryIdAction);
  assert.strictEqual((parsedCategoryIdAction as any).options.page, 2);
  assert.strictEqual((parsedCategoryIdAction as any).options.categoryName, 'makanan & minuman');
  const reNormalizedCategory = normalizeTransactionHistoryFilters(
    (parsedCategoryIdAction as any).options,
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.deepStrictEqual(reNormalizedCategory.upstreamCategoryId, ['cat-food']);

  // Category Group -> food_and_drinks -> kategori "food_and_drinks"
  const groupNormalized = normalizeTransactionHistoryFilters(
    { categoryGroup: 'food_and_drinks' },
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(groupNormalized.appliedFilters.categoryGroup, 'food_and_drinks');
  assert.strictEqual(groupNormalized.appliedFilters.category?.selector, 'kategori "food_and_drinks"');

  const groupHistPage: any = {
    records: samplePage.records,
    total: 20,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 2,
    hasMore: true,
    sort: 'newest',
    appliedFilters: groupNormalized.appliedFilters,
  };
  const groupHintId = formatTransactionHistoryMessage(groupHistPage, 'id');
  assert.match(groupHintId, /riwayat kategori "food_and_drinks" hal 2/);
  const parsedGroupAction = detectFastPathAction('riwayat kategori "food_and_drinks" hal 2');
  assert.ok(parsedGroupAction);
  assert.strictEqual((parsedGroupAction as any).options.page, 2);
  assert.strictEqual((parsedGroupAction as any).options.categoryName, 'food_and_drinks');
  const reNormalizedGroup = normalizeTransactionHistoryFilters(
    (parsedGroupAction as any).options,
    MOCK_ACCOUNTS,
    MOCK_CATEGORIES
  );
  assert.strictEqual(reNormalizedGroup.upstreamCategoryGroup, 'food_and_drinks');

  // Multiword combo in English: history account "BCA Tabungan" category "Makanan & Minuman" page 2
  const multiwordComboPage: any = {
    records: samplePage.records,
    total: 20,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 2,
    hasMore: true,
    sort: 'newest',
    appliedFilters: {
      account: accountIdNormalized.appliedFilters.account,
      category: categoryIdNormalized.appliedFilters.category,
      navigationTokens: [
        accountIdNormalized.appliedFilters.account!.selector!,
        categoryIdNormalized.appliedFilters.category!.selector!,
      ],
    },
  };
  const multiwordEnHint = formatTransactionHistoryMessage(multiwordComboPage, 'en');
  assert.match(multiwordEnHint, /history account "BCA Tabungan" category "Makanan & Minuman" page 2/);
  const parsedMultiwordEn = detectFastPathAction(
    'history account "BCA Tabungan" category "Makanan & Minuman" page 2'
  );
  assert.ok(parsedMultiwordEn);
  assert.strictEqual((parsedMultiwordEn as any).options.page, 2);
  assert.strictEqual((parsedMultiwordEn as any).options.accountName, 'bca tabungan');
  assert.strictEqual((parsedMultiwordEn as any).options.categoryName, 'makanan & minuman');

  // 7.9 Request start instant anchoring regression test (Item 4)
  // Request started at 23:59:55 WIB on Sep 11 (2026-09-11T16:59:55.000Z)
  const requestStartInstant = new Date('2026-09-11T16:59:55.000Z');
  // Simulated processing delay crossing into 00:00:05 WIB on Sep 12 (2026-09-11T17:00:05.000Z)
  const afterMidnightInstant = new Date('2026-09-11T17:00:05.000Z');

  // Anchored request must evaluate 'today' relative to the request start (Sep 11)
  const anchoredToday = normalizeTransactionHistoryFilters(
    { datePeriod: 'today' },
    [],
    [],
    requestStartInstant
  );
  assert.strictEqual(anchoredToday.appliedFilters.dateRange?.from, '2026-09-11');
  assert.strictEqual(anchoredToday.appliedFilters.dateRange?.to, '2026-09-11');
  assert.deepStrictEqual(anchoredToday.upstreamRecordDate, [
    'gte.2026-09-10T17:00:00.000Z',
    'lt.2026-09-11T17:00:00.000Z',
  ]);

  // If unanchored (using after-midnight instant), it would have evaluated to Sep 12
  const unanchoredToday = normalizeTransactionHistoryFilters(
    { datePeriod: 'today' },
    [],
    [],
    afterMidnightInstant
  );
  assert.strictEqual(unanchoredToday.appliedFilters.dateRange?.from, '2026-09-12');
  assert.notDeepStrictEqual(anchoredToday.upstreamRecordDate, unanchoredToday.upstreamRecordDate);

  // Verify anchored request 'yesterday' resolves to Sep 10, not Sep 11
  const anchoredYesterday = normalizeTransactionHistoryFilters(
    { datePeriod: 'yesterday' },
    [],
    [],
    requestStartInstant
  );
  assert.strictEqual(anchoredYesterday.appliedFilters.dateRange?.from, '2026-09-10');
  assert.deepStrictEqual(anchoredYesterday.upstreamRecordDate, [
    'gte.2026-09-09T17:00:00.000Z',
    'lt.2026-09-10T17:00:00.000Z',
  ]);

  // 7.10 Unresolved filter error messages localization in English mode
  // English responses must contain 0 Indonesian words and properly format structured issues
  const enAccountNotFoundPage: any = {
    records: [],
    total: 0,
    page: 1,
    unresolvedFilters: [
      {
        filterKey: 'account',
        rawValue: 'NonExistentBank',
        reason: 'NOT_FOUND',
        message: 'Akun "NonExistentBank" tidak ditemukan dalam daftar akun Wallet Anda.',
      },
    ],
  };
  const enAccountNotFoundText = formatTransactionHistoryMessage(enAccountNotFoundPage, 'en');
  assert.match(enAccountNotFoundText, /Transaction History Filter Not Found/);
  assert.match(enAccountNotFoundText, /Account "NonExistentBank" was not found in your Wallet accounts list\./);
  assert.strictEqual(/\b(tidak ditemukan|akun|daftar akun)\b/i.test(enAccountNotFoundText), false);

  const enAmbiguousCandidatesPage: any = {
    records: [],
    total: 0,
    page: 1,
    unresolvedFilters: [
      {
        filterKey: 'account',
        rawValue: 'BCA',
        reason: 'UNRESOLVED',
        candidates: ['BCA Tabungan', 'BCA Giro'],
        subType: 'name',
        message: 'Akun "BCA" ambigu. Kandidat: BCA Tabungan, BCA Giro.',
      },
      {
        filterKey: 'category',
        rawValue: 'Food',
        reason: 'UNRESOLVED',
        candidates: ['Food & Drink', 'Fast Food'],
        subType: 'name',
        message: 'Kategori "Food" ambigu. Kandidat: Food & Drink, Fast Food.',
      },
    ],
  };
  const enAmbiguousText = formatTransactionHistoryMessage(enAmbiguousCandidatesPage, 'en');
  assert.match(enAmbiguousText, /Account "BCA" is ambiguous\. Candidates: BCA Tabungan, BCA Giro\./);
  assert.match(enAmbiguousText, /Category "Food" is ambiguous\. Candidates: Food & Drink, Fast Food\./);
  assert.strictEqual(/\b(ambigu|kandidat|kategori|akun|daftar akun)\b/i.test(enAmbiguousText), false);

  const enDateErrorsPage: any = {
    records: [],
    total: 0,
    page: 1,
    unresolvedFilters: [
      {
        filterKey: 'dateRange',
        rawValue: 'bad_date',
        reason: 'INVALID_FORMAT',
        subType: 'operator_prefix',
        message: 'Format filter tanggal "bad_date" tidak valid.',
      },
      {
        filterKey: 'dateRange',
        rawValue: '2026-09-15 2026-09-10',
        reason: 'INVALID_RANGE',
        subType: 'start_after_end',
        message: 'Rentang tanggal tidak valid: batas awal tidak boleh lebih besar dari batas akhir.',
      },
    ],
  };
  const enDateErrorsText = formatTransactionHistoryMessage(enDateErrorsPage, 'en');
  assert.match(enDateErrorsText, /Date filter format "bad_date" is invalid\. Use operator prefix: eq\., gt\., gte\., lt\., or lte\./);
  assert.match(enDateErrorsText, /Invalid date range: start boundary cannot be greater than end boundary\./);
  assert.strictEqual(/\b(rentang|tanggal|batas|tidak valid)\b/i.test(enDateErrorsText), false);

  // Indonesian mode preserves original Indonesian strings
  const idFormattedUnresolved = formatTransactionHistoryMessage(enAccountNotFoundPage, 'id');
  assert.match(idFormattedUnresolved, /Filter Riwayat Tidak Ditemukan/);
  assert.match(idFormattedUnresolved, /Akun "NonExistentBank" tidak ditemukan/);

  console.log('  [PASS] Localized headers, badges, warnings, and navigation hints formatted properly.');

    });
  });

  describe('Suite 8: Fast-Path Intent Detection with Composable Filters', () => {
    it('correctly identifies composable history filter commands and preserves datetime across pagination', () => {

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

  // 8.6 Datetime filter preservation across pagination round-trip (Indonesian & English)
  const dtPage1Options = {
    dateRange: ['gte.2026-09-11T12:00:00.000Z', 'lte.2026-09-11T13:00:00.000Z'],
  };
  const dtPage1Norm = normalizeTransactionHistoryFilters(dtPage1Options, [], []);
  assert.strictEqual(dtPage1Norm.isValid, true);
  assert.strictEqual(dtPage1Norm.appliedFilters.dateRange?.selector, '2026-09-11T12:00:00.000Z 2026-09-11T13:00:00.000Z');

  const dtPage1History = {
    records: [
      {
        id: 'rec-dt-1',
        accountId: 'acc-1',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-09-11T12:30:00.000Z',
        recordType: 'expense',
        note: 'Coffee',
      },
    ],
    total: 25,
    limit: 10,
    offset: 0,
    page: 1,
    totalPages: 3,
    nextOffset: 10,
    hasMore: true,
    sort: 'newest' as const,
    appliedFilters: dtPage1Norm.appliedFilters,
  };

  // Indonesian round-trip
  const dtPage1MsgId = formatTransactionHistoryMessage(dtPage1History, 'id');
  const matchIdCmd = dtPage1MsgId.match(/\*([^*]+hal\s+2[^*]*)\*/i);
  assert.ok(matchIdCmd, 'Should generate navigation command with hal 2 in Indonesian');
  const extractedIdCmd = matchIdCmd[1];
  const parsedIdAction = detectFastPathAction(extractedIdCmd);
  assert.ok(parsedIdAction, 'Fast-path detector must parse generated page 2 command');
  assert.strictEqual((parsedIdAction as any).options.page, 2);
  const page2NormId = normalizeTransactionHistoryFilters((parsedIdAction as any).options, [], []);
  assert.strictEqual(page2NormId.isValid, true);
  assert.deepStrictEqual(page2NormId.upstreamRecordDate, dtPage1Norm.upstreamRecordDate);

  // English round-trip
  const dtPage1MsgEn = formatTransactionHistoryMessage(dtPage1History, 'en');
  const matchEnCmd = dtPage1MsgEn.match(/\*([^*]+page\s+2[^*]*)\*/i);
  assert.ok(matchEnCmd, 'Should generate navigation command with page 2 in English');
  const extractedEnCmd = matchEnCmd[1];
  const parsedEnAction = detectFastPathAction(extractedEnCmd);
  assert.ok(parsedEnAction, 'Fast-path detector must parse generated page 2 English command');
  assert.strictEqual((parsedEnAction as any).options.page, 2);
  const page2NormEn = normalizeTransactionHistoryFilters((parsedEnAction as any).options, [], []);
  assert.strictEqual(page2NormEn.isValid, true);
  assert.deepStrictEqual(page2NormEn.upstreamRecordDate, dtPage1Norm.upstreamRecordDate);

  // 8.7 Mixed date-only and datetime preservation across pagination round-trip
  const mixedPage1Options = {
    startDate: '2026-09-11',
    endDate: '2026-09-11T13:00:00.000Z',
  };
  const mixedPage1Norm = normalizeTransactionHistoryFilters(mixedPage1Options, [], []);
  assert.strictEqual(mixedPage1Norm.isValid, true);
  assert.strictEqual(mixedPage1Norm.appliedFilters.dateRange?.selector, '2026-09-11 2026-09-11T13:00:00.000Z');

  const mixedPage1History = {
    ...dtPage1History,
    appliedFilters: mixedPage1Norm.appliedFilters,
  };
  const mixedPage1Msg = formatTransactionHistoryMessage(mixedPage1History, 'id');
  const matchMixedCmd = mixedPage1Msg.match(/\*([^*]+hal\s+2[^*]*)\*/i);
  assert.ok(matchMixedCmd);
  const extractedMixedCmd = matchMixedCmd[1];
  const parsedMixedAction = detectFastPathAction(extractedMixedCmd);
  assert.ok(parsedMixedAction);
  assert.strictEqual((parsedMixedAction as any).options.page, 2);
  const page2NormMixed = normalizeTransactionHistoryFilters((parsedMixedAction as any).options, [], []);
  assert.strictEqual(page2NormMixed.isValid, true);
  assert.deepStrictEqual(page2NormMixed.upstreamRecordDate, mixedPage1Norm.upstreamRecordDate);

  console.log('  [PASS] Fast-path intent detector correctly identifies composable history filter commands.');

    });
  });

  describe('Suite 9: FastPathHandler Integration with Filters', () => {
    it('verifies FastPathHandler integration with filters end-to-end', async () => {
      const queryContext = createQueryExecutionContext({
        accounts: MOCK_ACCOUNTS,
        categories: MOCK_CATEGORIES,
      });
      const sentMessages: Array<{ channel: string; text: string }> = [];

      const mockGateway: any = {
        sendMessage: async (channel: string, target: string, text: string) => {
          sentMessages.push({ channel, text });
          return true;
        },
      };

      const handler = createTestFastPathHandler({
        walletMcpClient: queryContext.client,
        walletCacheService: queryContext.cache,
        messagingGateway: mockGateway,
        transactionHistoryService: queryContext.service,
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
      assert.match(sentMessages[0].text, /Caramel Macchiato/);

      console.log('  [PASS] FastPathHandler integration with filters verified end-to-end.');
    });

    it('verifies Issue #148 scope grammar and semantic tool boundary coverage', () => {

  const actionAll = detectFastPathAction('riwayat makan semua');
  assert.ok(actionAll);
  if (actionAll.type === 'TRANSACTION_HISTORY') {
    assert.strictEqual(actionAll.options.categoryName, 'makan');
  }

  const prompt = buildCompactSystemInstruction(MOCK_ACCOUNTS, MOCK_CATEGORIES, '2026-09-14');
  assert.match(prompt, /cat-food: Makanan & Minuman/);

  const boundary = new SemanticToolBoundary();
  const evaluation = boundary.evaluate({
    proposal: { tool: 'get_transaction_history', arguments: { categoryId: 'cat-food' } },
    authorization: { isAuthorized: true, source: 'test-policy' },
    event: {
      channel: 'whatsapp',
      chatIdentifier: 'test-chat',
      senderIdentifier: 'test-sender',
      messageType: 'text',
      textPayload: 'riwayat makan',
    },
    availableAccountList: MOCK_ACCOUNTS,
    availableCategoryList: MOCK_CATEGORIES,
  });
  assert.strictEqual(evaluation.accepted, true);

  const duplicateCategories: WalletCategoryItem[] = [
    { id: 'cat-food-001', name: 'Food' },
    { id: 'cat-food-002', name: 'Food' },
    { id: 'cat-health-001', name: 'Health' },
  ];
  const evaluateDuplicateName = (argumentsValue: Record<string, unknown>) => boundary.evaluate({
    proposal: { tool: 'get_transaction_history', arguments: argumentsValue },
    authorization: { isAuthorized: true, source: 'test-policy' },
    event: {
      channel: 'whatsapp',
      chatIdentifier: 'test-chat',
      senderIdentifier: 'test-sender',
      messageType: 'text',
      textPayload: 'riwayat kategori food',
    },
    availableAccountList: MOCK_ACCOUNTS,
    availableCategoryList: duplicateCategories,
  });

  assert.strictEqual(evaluateDuplicateName({ categoryName: 'Food' }).accepted, false);
  const selectedDuplicate = evaluateDuplicateName({
    categoryId: 'cat-food-002',
    categoryName: 'Food',
  });
  assert.strictEqual(selectedDuplicate.accepted, true);
  if (selectedDuplicate.accepted && selectedDuplicate.context.action === 'TRANSACTION_HISTORY') {
    assert.strictEqual(selectedDuplicate.context.queryOptions?.categoryId, 'cat-food-002');
  }
  assert.strictEqual(evaluateDuplicateName({
    categoryId: 'cat-health-001',
    categoryName: 'Food',
  }).accepted, false);

    });
  });
});
