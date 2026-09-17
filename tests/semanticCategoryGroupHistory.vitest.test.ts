import { describe, expect, it } from 'vitest';
import {
  WalletMcpClientService,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import {
  detectFastPathAction,
  FastPathTransactionHistoryAction,
} from '../src/utils/fastPathIntentDetector.js';
import {
  normalizeTransactionHistoryFilters,
  extractDynamicCategoryGroups,
  findMatchingDynamicCategoryGroup,
} from '../src/utils/transactionHistoryFilterNormalizer.js';
import {
  validateSemanticHistoryQueryOptions,
} from '../src/services/ai/semanticToolBoundary.js';
import {
  buildCompactSystemInstruction,
} from '../src/services/ai/aiPromptBuilder.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
} from '../src/types/walletTypes.js';

describe('Issue 160: Semantic Category Group Matching for History', () => {
  const MOCK_ACCOUNTS: WalletAccountItem[] = [
    { id: 'acc-bca', name: 'BCA Tabungan', currency: 'IDR' },
    { id: 'acc-jago', name: 'Bank Jago', currency: 'IDR' },
  ];

  const SYNTHETIC_CATEGORIES: WalletCategoryItem[] = [
    {
      id: 'cat-makan-hangout',
      name: 'Makan Hangout',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
    {
      id: 'cat-makan-nafsu',
      name: 'Makan Nafsu',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
    {
      id: 'cat-makan-pokok',
      name: 'Makan Pokok',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
    {
      id: 'cat-food',
      name: 'Food',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
    {
      id: 'cat-food-drinks',
      name: 'Food & Drinks',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
    {
      id: 'cat-internet',
      name: 'Internet',
      group: { id: 'communication', name: 'Communication, PC' },
    },
    {
      id: 'cat-loan',
      name: 'Loan, interests',
      group: { id: 'financial_expenses', name: 'Financial expenses' },
    },
    {
      id: 'cat-transport-fuel',
      name: 'Bensin & Tol',
      group: { id: 'transportation', name: 'Transportation' },
    },
    {
      id: 'cat-transport-taxi',
      name: 'Taksi & Ojol',
      group: { id: 'transportation', name: 'Transportation' },
    },
    {
      id: 'cat-belanja-bulanan',
      name: 'Belanja Bulanan',
      group: { id: 'shopping', name: 'Shopping' },
    },
    {
      id: 'cat-belanja-online',
      name: 'Belanja Online',
      group: { id: 'shopping', name: 'Shopping' },
    },
  ];

  const SYNTHETIC_RECORDS: WalletRecordItem[] = [
    {
      id: 'rec-hangout',
      accountId: 'acc-bca',
      categoryId: 'cat-makan-hangout',
      amount: -35000,
      recordDate: '2026-09-15T12:00:00Z',
      recordType: 'expense',
      note: 'Burger hangout sore',
    },
    {
      id: 'rec-nafsu',
      accountId: 'acc-bca',
      categoryId: 'cat-makan-nafsu',
      amount: -50000,
      recordDate: '2026-09-15T13:00:00Z',
      recordType: 'expense',
      note: 'Beli boba cheese',
    },
    {
      id: 'rec-pokok',
      accountId: 'acc-bca',
      categoryId: 'cat-makan-pokok',
      amount: -25000,
      recordDate: '2026-09-15T14:00:00Z',
      recordType: 'expense',
      note: 'Nasi padang ayam',
    },
    {
      id: 'rec-food',
      accountId: 'acc-bca',
      categoryId: 'cat-food',
      amount: -15000,
      recordDate: '2026-09-15T15:00:00Z',
      recordType: 'expense',
      note: 'Roti coklat',
    },
    {
      id: 'rec-drinks',
      accountId: 'acc-bca',
      categoryId: 'cat-food-drinks',
      amount: -20000,
      recordDate: '2026-09-15T16:00:00Z',
      recordType: 'expense',
      note: 'Es kopi susu',
    },
    {
      id: 'rec-internet',
      accountId: 'acc-bca',
      categoryId: 'cat-internet',
      amount: -350000,
      recordDate: '2026-09-15T10:00:00Z',
      recordType: 'expense',
      note: 'Wifi internet makan siang bareng tim kantor',
    },
    {
      id: 'rec-loan',
      accountId: 'acc-bca',
      categoryId: 'cat-loan',
      amount: -1000000,
      recordDate: '2026-09-15T09:00:00Z',
      recordType: 'expense',
      note: 'Cicilan utang makan kemarin',
    },
  ];

  function createMockWalletEnvironment(
    recordsToReturn: WalletRecordItem[] = SYNTHETIC_RECORDS,
    categoriesToReturn: WalletCategoryItem[] = SYNTHETIC_CATEGORIES
  ) {
    const client = new WalletMcpClientService('http://localhost:8080', 'mock-token');
    const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    client.callMcpTool = async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
      capturedCalls.push({ toolName, args });

      if (toolName === 'get_records') {
        const requestedCategoryIds = Array.isArray(args.categoryId)
          ? (args.categoryId as string[])
          : typeof args.categoryId === 'string'
            ? [args.categoryId]
            : null;

        const filtered = recordsToReturn.filter(record => {
          if (requestedCategoryIds && !requestedCategoryIds.includes(record.categoryId || '')) {
            return false;
          }
          if (args.accountId && record.accountId !== args.accountId) {
            return false;
          }
          return true;
        });

        return {
          records: filtered,
          total: filtered.length,
        } as unknown as T;
      }

      return { records: [], total: 0 } as unknown as T;
    };

    const cache = new WalletCacheService(client);
    (cache as unknown as { cachedAccountList: WalletAccountItem[] }).cachedAccountList = [...MOCK_ACCOUNTS];
    (cache as unknown as { cachedCategoryList: WalletCategoryItem[] }).cachedCategoryList = [...categoriesToReturn];
    (cache as unknown as { cachedLabelList: unknown[] }).cachedLabelList = [];

    const historyService = new TransactionHistoryService(client, cache);

    return { client, cache, historyService, capturedCalls };
  }

  describe('R1: Dynamic Category Group Extraction & Resolution', () => {
    it('extracts dynamic category groups from category metadata', () => {
      const groupMap = extractDynamicCategoryGroups(SYNTHETIC_CATEGORIES);

      expect(groupMap.has('food_and_drinks')).toBe(true);
      expect(groupMap.has('transportation')).toBe(true);
      expect(groupMap.has('communication')).toBe(true);
      expect(groupMap.has('financial_expenses')).toBe(true);
      expect(groupMap.has('shopping')).toBe(true);

      const foodGroup = groupMap.get('food_and_drinks');
      expect(foodGroup?.categoryIds).toHaveLength(5);
      expect(foodGroup?.categoryIds).toEqual([
        'cat-makan-hangout',
        'cat-makan-nafsu',
        'cat-makan-pokok',
        'cat-food',
        'cat-food-drinks',
      ]);
    });

    it('matches category group via Indonesian alias ("makan" -> food_and_drinks)', () => {
      const groupMap = extractDynamicCategoryGroups(SYNTHETIC_CATEGORIES);
      const matchedGroup = findMatchingDynamicCategoryGroup('makan', groupMap);

      expect(matchedGroup).toBeDefined();
      expect(matchedGroup?.id).toBe('food_and_drinks');
      expect(matchedGroup?.name).toBe('Food & Drinks');
      expect(matchedGroup?.categoryIds).toHaveLength(5);
    });

    it('matches custom category group from metadata without static alias', () => {
      const customCategories: WalletCategoryItem[] = [
        {
          id: 'cat-gym',
          name: 'Gym & Fitness',
          group: { id: 'custom_wellness', name: 'Kebugaran & Kesehatan' },
        },
        {
          id: 'cat-vitamin',
          name: 'Vitamin & Herbal',
          group: { id: 'custom_wellness', name: 'Kebugaran & Kesehatan' },
        },
      ];

      const groupMap = extractDynamicCategoryGroups(customCategories);
      expect(groupMap.has('custom_wellness')).toBe(true);

      // Matches via group name substring/tokens
      const matchedByGroupName = findMatchingDynamicCategoryGroup('kebugaran', groupMap);
      expect(matchedByGroupName).toBeDefined();
      expect(matchedByGroupName?.id).toBe('custom_wellness');
      expect(matchedByGroupName?.categoryIds).toEqual(['cat-gym', 'cat-vitamin']);
    });
  });

  describe('R2 & Synthetic Fixture: Native Multi-Category Query Execution', () => {
    it('includes all 5 food categories and excludes non-food even with food words in notes', async () => {
      const { historyService, capturedCalls } = createMockWalletEnvironment();

      const action = detectFastPathAction('riwayat makan semua');
      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');

      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('makan');
      expect(historyAction.options.isGroupQuery).toBe(true);

      const historyPage = await historyService.getTransactionHistory(historyAction.options);

      // Verify single native call was dispatched
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');

      // Verify categoryId passed as array with all 5 food category IDs
      const categoryIdArgument = capturedCalls[0].args.categoryId;
      expect(Array.isArray(categoryIdArgument)).toBe(true);
      expect(categoryIdArgument).toEqual([
        'cat-makan-hangout',
        'cat-makan-nafsu',
        'cat-makan-pokok',
        'cat-food',
        'cat-food-drinks',
      ]);

      // Verify categoryGroup is NOT passed when categoryId has multiple elements
      expect(capturedCalls[0].args.categoryGroup).toBeUndefined();

      // Verify results: all 5 food expense records are present
      expect(historyPage.records).toHaveLength(5);
      const returnedIds = historyPage.records.map(record => record.id);
      expect(returnedIds).toContain('rec-hangout');
      expect(returnedIds).toContain('rec-nafsu');
      expect(returnedIds).toContain('rec-pokok');
      expect(returnedIds).toContain('rec-food');
      expect(returnedIds).toContain('rec-drinks');

      // Crucial: non-food records with "makan" in note are strictly EXCLUDED
      expect(returnedIds).not.toContain('rec-internet');
      expect(returnedIds).not.toContain('rec-loan');
    });

    it('preserves limit, offset, and sort without local query fan-out', async () => {
      const { historyService, capturedCalls } = createMockWalletEnvironment();

      const pageResult = await historyService.getTransactionHistory({
        categoryName: 'makan',
        isGroupQuery: true,
        limit: 10,
        offset: 5,
        sort: 'oldest',
      });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');
      expect(capturedCalls[0].args.limit).toBe(10);
      expect(capturedCalls[0].args.offset).toBe(5);
      expect(capturedCalls[0].args.sortBy).toEqual(['+recordDate', '+createdAt']);
      expect(pageResult.sort).toBe('oldest');
      expect(Array.isArray(capturedCalls[0].args.categoryId)).toBe(true);
    });
  });

  describe('R3: Natural Intent Detection and Scope Parsing', () => {
    it.each([
      ['riwayat makan semua', 'makan', true],
      ['semua riwayat makan', 'makan', true],
      ['riwayat makan all', 'makan', true],
      ['riwayat makan semuanya', 'makan', true],
      ['all riwayat makan', 'makan', true],
      ['riwayat transport semua', 'transport', true],
    ])('detects group query for "%s"', (input, expectedCategory, expectedIsGroup) => {
      const action = detectFastPathAction(input);
      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');

      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe(expectedCategory);
      expect(historyAction.options.isGroupQuery).toBe(expectedIsGroup);
    });

    it('composes group query with temporal date period: "semua riwayat makan bulan ini"', () => {
      const action = detectFastPathAction('semua riwayat makan bulan ini');
      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');

      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('makan');
      expect(historyAction.options.isGroupQuery).toBe(true);
      expect(historyAction.options.datePeriod).toBe('this_month');
    });
  });

  describe('R3: Fail-Closed Ambiguity for Unscoped Queries', () => {
    it('fails closed and prompts clarification for ambiguous "history makan" without scope', () => {
      const action = detectFastPathAction('history makan');
      expect(action).not.toBeNull();
      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('makan');
      expect(historyAction.options.isGroupQuery).toBeFalsy();

      const normalized = normalizeTransactionHistoryFilters(
        historyAction.options,
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );

      expect(normalized.isValid).toBe(false);
      expect(normalized.upstreamCategoryId).toBeUndefined();
      expect(normalized.unresolvedFilters).toHaveLength(1);
      expect(normalized.unresolvedFilters[0]).toMatchObject({
        filterKey: 'category',
        rawValue: 'makan',
        reason: 'UNRESOLVED',
        candidates: ['Makan Hangout', 'Makan Nafsu', 'Makan Pokok'],
      });
    });

    it('fails closed for ambiguous "history belanja" without scope', () => {
      const action = detectFastPathAction('history belanja');
      expect(action).not.toBeNull();
      const historyAction = action as FastPathTransactionHistoryAction;

      const normalized = normalizeTransactionHistoryFilters(
        historyAction.options,
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );

      expect(normalized.isValid).toBe(false);
      expect(normalized.upstreamCategoryId).toBeUndefined();
      expect(normalized.unresolvedFilters[0]).toMatchObject({
        filterKey: 'category',
        rawValue: 'belanja',
        reason: 'UNRESOLVED',
        candidates: ['Belanja Bulanan', 'Belanja Online'],
      });
    });

    it('resolves unambiguously when specific category name is provided', () => {
      const action = detectFastPathAction('history makan hangout');
      expect(action).not.toBeNull();
      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('makan hangout');

      const normalized = normalizeTransactionHistoryFilters(
        historyAction.options,
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryId).toEqual(['cat-makan-hangout']);
      expect(normalized.unresolvedFilters).toHaveLength(0);
    });
  });

  describe('Search Command Isolation', () => {
    it('preserves dedicated search command "cari makan padang" without hijacking', () => {
      const action = detectFastPathAction('cari makan padang');
      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');

      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.searchQuery).toBe('makan padang');
      expect(historyAction.options.categoryName).toBeUndefined();
    });

    it('preserves "history cari makan" as note/merchant search', () => {
      const action = detectFastPathAction('history cari makan');
      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');

      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.searchQuery).toBe('makan');
      expect(historyAction.options.categoryName).toBeUndefined();
    });
  });

  describe('Filter Composition & Normalization', () => {
    it('composes group query with account, date period, and sort', () => {
      const normalized = normalizeTransactionHistoryFilters(
        {
          categoryName: 'makan',
          isGroupQuery: true,
          accountName: 'bca',
          datePeriod: 'this_month',
          sort: 'newest',
        },
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamAccountId).toBe('acc-bca');
      expect(normalized.upstreamCategoryId).toEqual([
        'cat-makan-hangout',
        'cat-makan-nafsu',
        'cat-makan-pokok',
        'cat-food',
        'cat-food-drinks',
      ]);
      expect(normalized.upstreamCategoryGroup).toBe('food_and_drinks');
      expect(normalized.appliedFilters.account?.id).toBe('acc-bca');
      expect(normalized.appliedFilters.categoryGroup).toBe('food_and_drinks');
    });

    it('handles explicit categoryGroup option directly', () => {
      const normalized = normalizeTransactionHistoryFilters(
        { categoryGroup: 'food_and_drinks' },
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );

      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryGroup).toBe('food_and_drinks');
      expect(normalized.upstreamCategoryId).toHaveLength(5);
    });
  });

  describe('Semantic Tool Boundary Validation', () => {
    it('accepts the exact full trusted group array', () => {
      const fullFoodCategoryIds = [
        'cat-makan-hangout',
        'cat-makan-nafsu',
        'cat-makan-pokok',
        'cat-food',
        'cat-food-drinks',
      ];
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryId: fullFoodCategoryIds,
          isGroupQuery: true,
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(false);
      const validOptions = result as { categoryId: string[]; isGroupQuery: boolean; categoryGroup?: string };
      expect(validOptions.categoryId).toEqual(fullFoodCategoryIds);
      expect(validOptions.isGroupQuery).toBe(true);
      expect(validOptions.categoryGroup).toBe('food_and_drinks');
    });

    it('rejects a partial 2-of-5 group category array to prevent incomplete history', () => {
      const partialFoodCategoryIds = ['cat-makan-hangout', 'cat-food'];
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryId: partialFoodCategoryIds,
          isGroupQuery: true,
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string; reason: string };
      expect(rejection.code).toBe('INVALID_ENTITY_REFERENCE');
      expect(rejection.reason).toContain('does not represent a complete trusted category group');
    });

    it('rejects a mixed cross-group category array (e.g. food + loan)', () => {
      const mixedCategoryIds = ['cat-makan-hangout', 'cat-loan'];
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryId: mixedCategoryIds,
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string; reason: string };
      expect(rejection.code).toBe('INVALID_ENTITY_REFERENCE');
      expect(rejection.reason).toContain('multiple distinct groups');
    });

    it('rejects proposal containing unknown category IDs in array', () => {
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryId: ['cat-makan-hangout', 'unknown-category-id'],
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ENTITY_REFERENCE');
    });

    it('resolves categoryGroup reference to the complete trusted category IDs deterministically', () => {
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'food_and_drinks',
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(false);
      const validOptions = result as { categoryId: string[]; categoryGroup: string; isGroupQuery: boolean };
      expect(validOptions.categoryGroup).toBe('food_and_drinks');
      expect(validOptions.isGroupQuery).toBe(true);
      expect(validOptions.categoryId).toEqual([
        'cat-makan-hangout',
        'cat-makan-nafsu',
        'cat-makan-pokok',
        'cat-food',
        'cat-food-drinks',
      ]);
    });

    it('rejects categoryGroup when group reference is not present in Wallet metadata', () => {
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'non_existent_group',
        },
        SYNTHETIC_CATEGORIES
      );

      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ENTITY_REFERENCE');
    });

    it('rejects when isGroupQuery is not a boolean', () => {
      const result = validateSemanticHistoryQueryOptions(
        {
          isGroupQuery: 'true' as unknown as boolean,
        },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ARGUMENTS');
    });

    it('rejects when categoryGroup is empty string', () => {
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: '   ',
        },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ARGUMENTS');
    });

    it('rejects when categoryGroup is ambiguous in Wallet metadata', () => {
      const ambiguousCategories: WalletCategoryItem[] = [
        { id: 'cat-h1', name: 'Gym', group: { id: 'health_wellness', name: 'Health Wellness' } },
        { id: 'cat-h2', name: 'BPJS', group: { id: 'health_insurance', name: 'Health Insurance' } },
      ];
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'health',
        },
        ambiguousCategories
      );
      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ENTITY_REFERENCE');
    });

    it('rejects when categoryGroup exceeds maximum limit of 50 categories', () => {
      const oversizedCategories: WalletCategoryItem[] = Array.from({ length: 55 }, (_, i) => ({
        id: `cat-over-${i}`,
        name: `Over ${i}`,
        group: { id: 'oversized_group', name: 'Oversized Group' },
      }));
      const result = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'oversized_group',
        },
        oversizedCategories
      );
      expect('accepted' in result && !result.accepted).toBe(true);
      const rejection = result as { accepted: false; code: string };
      expect(rejection.code).toBe('INVALID_ARGUMENTS');
    });

    it('validates matching categoryId array alongside categoryGroup and rejects mismatch', () => {
      // 1. Non-array categoryId
      const nonArray = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', categoryId: 'cat-food' as unknown as string[] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in nonArray && !nonArray.accepted).toBe(true);

      // 2. Mismatch length
      const mismatchLength = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', categoryId: ['cat-food'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in mismatchLength && !mismatchLength.accepted).toBe(true);

      // 3. Category outside group
      const outsideGroup = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', categoryId: ['cat-makan-hangout', 'cat-makan-nafsu', 'cat-makan-pokok', 'cat-food', 'cat-loan'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in outsideGroup && !outsideGroup.accepted).toBe(true);

      // 4. Exact matching array
      const exactMatch = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', categoryId: ['cat-makan-hangout', 'cat-makan-nafsu', 'cat-makan-pokok', 'cat-food', 'cat-food-drinks'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in exactMatch && !exactMatch.accepted).toBe(false);

      // 5. Duplicate-filled array with the same length as trusted group
      const duplicateArrayWithGroup = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', categoryId: ['cat-food', 'cat-food', 'cat-food', 'cat-food', 'cat-food'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in duplicateArrayWithGroup && !duplicateArrayWithGroup.accepted).toBe(true);

      // 6. Complete trusted group in a different (reversed) order
      const reversedMatch = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'food_and_drinks',
          categoryId: ['cat-food-drinks', 'cat-food', 'cat-makan-pokok', 'cat-makan-nafsu', 'cat-makan-hangout'],
        },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in reversedMatch && !reversedMatch.accepted).toBe(false);
    });

    it('rejects duplicate-filled categoryId array and accepts complete group in any order without categoryGroup', () => {
      // 1. Duplicate-filled array matching group length
      const duplicateResult = validateSemanticHistoryQueryOptions(
        { categoryId: ['cat-food', 'cat-food', 'cat-food', 'cat-food', 'cat-food'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in duplicateResult && !duplicateResult.accepted).toBe(true);
      const duplicateRejection = duplicateResult as { accepted: false; code: string };
      expect(duplicateRejection.code).toBe('INVALID_ARGUMENTS');

      // 2. Complete trusted group in reversed order
      const reversedResult = validateSemanticHistoryQueryOptions(
        { categoryId: ['cat-food-drinks', 'cat-food', 'cat-makan-pokok', 'cat-makan-nafsu', 'cat-makan-hangout'] },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in reversedResult && !reversedResult.accepted).toBe(false);
      const validReversed = reversedResult as { categoryId: string[]; categoryGroup: string; isGroupQuery: boolean };
      expect(validReversed.categoryGroup).toBe('food_and_drinks');
      expect(validReversed.isGroupQuery).toBe(true);
    });

    it('requires a resolvable trusted group identity for isGroupQuery: true', () => {
      // 1. Standalone isGroupQuery: true without categoryGroup
      const standalone = validateSemanticHistoryQueryOptions(
        { isGroupQuery: true },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in standalone && !standalone.accepted).toBe(true);
      const standaloneRejection = standalone as { accepted: false; code: string };
      expect(standaloneRejection.code).toBe('INVALID_ARGUMENTS');

      // 2. Single categoryId paired with isGroupQuery: true
      const singleWithGroup = validateSemanticHistoryQueryOptions(
        { categoryId: 'cat-food', isGroupQuery: true },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in singleWithGroup && !singleWithGroup.accepted).toBe(true);
      const singleRejection = singleWithGroup as { accepted: false; code: string };
      expect(singleRejection.code).toBe('INVALID_ARGUMENTS');

      // 3. Valid trusted categoryGroup expanding to complete member set
      const trustedGroup = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks' },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in trustedGroup && !trustedGroup.accepted).toBe(false);
      const validGroup = trustedGroup as { categoryId: string[]; categoryGroup: string; isGroupQuery: boolean };
      expect(validGroup.isGroupQuery).toBe(true);
      expect(validGroup.categoryId).toHaveLength(5);

      // 4. Valid trusted categoryGroup explicitly paired with isGroupQuery: true
      const trustedGroupWithFlag = validateSemanticHistoryQueryOptions(
        { categoryGroup: 'food_and_drinks', isGroupQuery: true },
        SYNTHETIC_CATEGORIES
      );
      expect('accepted' in trustedGroupWithFlag && !trustedGroupWithFlag.accepted).toBe(false);
      const validGroupWithFlag = trustedGroupWithFlag as { categoryId: string[]; categoryGroup: string; isGroupQuery: boolean };
      expect(validGroupWithFlag.isGroupQuery).toBe(true);
      expect(validGroupWithFlag.categoryId).toHaveLength(5);
    });

    it('rejects semantic multi-category arrays when trusted group metadata is unavailable, keeping single category valid', () => {
      const categoriesWithoutGroup: WalletCategoryItem[] = [
        { id: 'cat-a', name: 'Kategori A' },
        { id: 'cat-b', name: 'Kategori B' },
      ];

      // Multi-category array proposal without group metadata must fail closed
      const multiResult = validateSemanticHistoryQueryOptions(
        { categoryId: ['cat-a', 'cat-b'] },
        categoriesWithoutGroup
      );
      expect('accepted' in multiResult && !multiResult.accepted).toBe(true);
      const multiRejection = multiResult as { accepted: false; code: string; reason: string };
      expect(multiRejection.code).toBe('INVALID_ENTITY_REFERENCE');
      expect(multiRejection.reason).toContain('trusted category group metadata');

      // Single-category proposal remains completely valid
      const singleResult = validateSemanticHistoryQueryOptions(
        { categoryId: 'cat-a' },
        categoriesWithoutGroup
      );
      expect('accepted' in singleResult && !singleResult.accepted).toBe(false);
      const validSingle = singleResult as { categoryId: string };
      expect(validSingle.categoryId).toBe('cat-a');
    });

    it('rejects categoryId array when empty, oversized, or contains untrusted entries', () => {
      // Empty array
      const emptyResult = validateSemanticHistoryQueryOptions({ categoryId: [] }, SYNTHETIC_CATEGORIES);
      expect('accepted' in emptyResult && !emptyResult.accepted).toBe(true);

      // Non-string or too large ID
      const invalidIdResult = validateSemanticHistoryQueryOptions({ categoryId: [123 as unknown as string] }, SYNTHETIC_CATEGORIES);
      expect('accepted' in invalidIdResult && !invalidIdResult.accepted).toBe(true);

      // Category not in any group
      const categoriesWithGroup: WalletCategoryItem[] = [
        { id: 'cat-in-group', name: 'In Group', group: { id: 'grp-1', name: 'Group 1' } },
        { id: 'cat-orphan', name: 'Orphan' },
      ];
      const orphanResult = validateSemanticHistoryQueryOptions({ categoryId: ['cat-orphan'] }, categoriesWithGroup);
      expect('accepted' in orphanResult && !orphanResult.accepted).toBe(true);
    });

    it('formats category groups in system instructions correctly for both object and string groups', () => {
      const categoriesWithGroups: WalletCategoryItem[] = [
        { id: 'cat-1', name: 'Nasi Goreng', group: { id: 'food', name: 'Makanan & Minuman' } },
        { id: 'cat-2', name: 'Bensin', group: 'transport' },
        { id: 'cat-3', name: 'Tanpa Grup' },
      ];
      const accounts: WalletAccountItem[] = [
        { id: 'acc-1', name: 'BCA', currency: 'IDR' },
      ];
      const instruction = buildCompactSystemInstruction(accounts, categoriesWithGroups, []);
      expect(instruction).toContain('CATEGORY GROUPS (ID: Name):');
      expect(instruction).toContain('food: "Makanan & Minuman"');
      expect(instruction).toContain('transport: "transport"');
      expect(instruction).toContain('Nasi Goreng (Group: Makanan & Minuman)');
    });
  });

  describe('Adversarial & Open Issues Ledger Verification', () => {
    it('handles category phrases containing symbols and connectors: "&", "-", "/"', () => {
      const foodAndDrinksAction = detectFastPathAction('riwayat food & drinks semua');
      expect(foodAndDrinksAction).not.toBeNull();
      expect((foodAndDrinksAction as FastPathTransactionHistoryAction).options.categoryName).toBe('food & drinks');
      expect((foodAndDrinksAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);

      const fuelAction = detectFastPathAction('riwayat bensin & tol semua');
      expect(fuelAction).not.toBeNull();
      expect((fuelAction as FastPathTransactionHistoryAction).options.categoryName).toBe('bensin & tol');
      expect((fuelAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);

      const gymAction = detectFastPathAction('riwayat gym - fitness semua');
      expect(gymAction).not.toBeNull();
      expect((gymAction as FastPathTransactionHistoryAction).options.categoryName).toBe('gym - fitness');
      expect((gymAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);

      const coffeeAction = detectFastPathAction('riwayat kopi/teh semua');
      expect(coffeeAction).not.toBeNull();
      expect((coffeeAction as FastPathTransactionHistoryAction).options.categoryName).toBe('kopi/teh');
      expect((coffeeAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);
    });

    it('strips conversational trailing punctuation like "?", "!", "."', () => {
      const questionAction = detectFastPathAction('riwayat makan semua?');
      expect(questionAction).not.toBeNull();
      expect((questionAction as FastPathTransactionHistoryAction).options.categoryName).toBe('makan');
      expect((questionAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);

      const exclamationAction = detectFastPathAction('riwayat makan semua!');
      expect(exclamationAction).not.toBeNull();
      expect((exclamationAction as FastPathTransactionHistoryAction).options.categoryName).toBe('makan');
      expect((exclamationAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);

      const dotAction = detectFastPathAction('riwayat makan semua.');
      expect(dotAction).not.toBeNull();
      expect((dotAction as FastPathTransactionHistoryAction).options.categoryName).toBe('makan');
      expect((dotAction as FastPathTransactionHistoryAction).options.isGroupQuery).toBe(true);
    });

    it('resolves compound Indonesian and English group aliases ("makanan & minuman", "makan dan minum")', () => {
      const groupMap = extractDynamicCategoryGroups(SYNTHETIC_CATEGORIES);

      const compound1 = findMatchingDynamicCategoryGroup('makanan & minuman', groupMap);
      expect(compound1).toBeDefined();
      expect(compound1?.id).toBe('food_and_drinks');

      const compound2 = findMatchingDynamicCategoryGroup('makanan dan minuman', groupMap);
      expect(compound2).toBeDefined();
      expect(compound2?.id).toBe('food_and_drinks');

      const compound3 = findMatchingDynamicCategoryGroup('makan & minum', groupMap);
      expect(compound3).toBeDefined();
      expect(compound3?.id).toBe('food_and_drinks');

      const compound4 = findMatchingDynamicCategoryGroup('food and drinks', groupMap);
      expect(compound4).toBeDefined();
      expect(compound4?.id).toBe('food_and_drinks');
    });

    it('[R1-4] handles category vs group name collision: resolves exact category without group scope, unions with group scope', () => {
      const collidingCategories: WalletCategoryItem[] = [
        {
          id: 'cat-food-exact',
          name: 'Food',
          group: { id: 'food_and_drinks', name: 'Food' },
        },
        {
          id: 'cat-drinks-exact',
          name: 'Drinks',
          group: { id: 'food_and_drinks', name: 'Food' },
        },
      ];

      // Case A: Query without group scope -> resolves to exact category "Food"
      const singleNormalized = normalizeTransactionHistoryFilters(
        { categoryName: 'food', isGroupQuery: false },
        MOCK_ACCOUNTS,
        collidingCategories
      );
      expect(singleNormalized.isValid).toBe(true);
      expect(singleNormalized.upstreamCategoryId).toEqual(['cat-food-exact']);
      expect(singleNormalized.appliedFilters.category?.id).toBe('cat-food-exact');

      // Case B: Query with group scope -> resolves to group union
      const groupNormalized = normalizeTransactionHistoryFilters(
        { categoryName: 'food', isGroupQuery: true },
        MOCK_ACCOUNTS,
        collidingCategories
      );
      expect(groupNormalized.isValid).toBe(true);
      expect(groupNormalized.upstreamCategoryId).toEqual(['cat-food-exact', 'cat-drinks-exact']);
    });

    it('[R1-5] gracefully handles malformed or missing group metadata without crashing', () => {
      const malformedCategories: WalletCategoryItem[] = [
        { id: 'cat-no-group', name: 'No Group Cat' },
        { id: 'cat-empty-group', name: 'Empty Group', group: { id: '', name: '' } },
        { id: 'cat-string-group', name: 'String Group', group: 'custom_wellness' as unknown as { id: string; name: string } },
        { id: 'cat-valid', name: 'Valid Group', group: { id: 'custom_wellness', name: 'Wellness' } },
      ];

      const groupMap = extractDynamicCategoryGroups(malformedCategories);
      expect(groupMap.has('custom_wellness')).toBe(true);
      const wellnessGroup = groupMap.get('custom_wellness');
      expect(wellnessGroup?.categoryIds).toContain('cat-string-group');
      expect(wellnessGroup?.categoryIds).toContain('cat-valid');
      expect(wellnessGroup?.categoryIds).not.toContain('cat-no-group');
      expect(wellnessGroup?.categoryIds).not.toContain('cat-empty-group');
    });

    it('prevents false-positive substring matches (e.g. category "IT" matching "digital")', () => {
      const testingCategories: WalletCategoryItem[] = [
        { id: 'cat-digital', name: 'Digital Services', group: { id: 'communication', name: 'Communication' } },
        { id: 'cat-it', name: 'IT', group: { id: 'communication', name: 'Communication' } },
      ];

      // Query "digital" should resolve cleanly to "Digital Services" without ambiguity with "IT"
      const normalized = normalizeTransactionHistoryFilters(
        { categoryName: 'digital' },
        MOCK_ACCOUNTS,
        testingCategories
      );
      expect(normalized.isValid).toBe(true);
      expect(normalized.upstreamCategoryId).toEqual(['cat-digital']);
      expect(normalized.unresolvedFilters).toHaveLength(0);
    });

    it('fails closed when category group exceeds 50 categories rather than silently truncating', () => {
      const manyCategories: WalletCategoryItem[] = Array.from({ length: 65 }, (_, index) => ({
        id: `cat-many-${index}`,
        name: `Sub Category ${index}`,
        group: { id: 'large_group', name: 'Large Group' },
      }));

      const normalized = normalizeTransactionHistoryFilters(
        { categoryName: 'large group', isGroupQuery: true },
        MOCK_ACCOUNTS,
        manyCategories
      );

      // Must fail closed rather than silently querying a partial 50 categories!
      expect(normalized.isValid).toBe(false);
      expect(normalized.upstreamCategoryId).toBeUndefined();
      expect(normalized.unresolvedFilters).toHaveLength(1);
      expect(normalized.unresolvedFilters[0]).toMatchObject({
        filterKey: 'category',
        reason: 'UNSUPPORTED',
      });
      expect(normalized.unresolvedFilters[0].message).toContain('melebihi batas maksimal 50 kategori');
    });

    it('fails closed when fuzzy group matching has multiple candidates regardless of fixture order', () => {
      const groupA: WalletCategoryItem = {
        id: 'cat-health-gym',
        name: 'Gym',
        group: { id: 'health_wellness', name: 'Health & Wellness' },
      };
      const groupB: WalletCategoryItem = {
        id: 'cat-health-ins',
        name: 'BPJS',
        group: { id: 'health_insurance', name: 'Health Insurance' },
      };

      const orderNormalCategories = [groupA, groupB];
      const orderReversedCategories = [groupB, groupA];

      // Test with normal fixture order
      const normalNormalized = normalizeTransactionHistoryFilters(
        { categoryName: 'health', isGroupQuery: true },
        MOCK_ACCOUNTS,
        orderNormalCategories
      );

      expect(normalNormalized.isValid).toBe(false);
      expect(normalNormalized.upstreamCategoryId).toBeUndefined();
      expect(normalNormalized.unresolvedFilters).toHaveLength(1);
      expect(normalNormalized.unresolvedFilters[0]).toMatchObject({
        filterKey: 'category',
        reason: 'UNRESOLVED',
        candidates: ['Health & Wellness', 'Health Insurance'],
      });

      // Test with reversed fixture order -> must produce identical candidates and fail closed
      const reversedNormalized = normalizeTransactionHistoryFilters(
        { categoryName: 'health', isGroupQuery: true },
        MOCK_ACCOUNTS,
        orderReversedCategories
      );

      expect(reversedNormalized.isValid).toBe(false);
      expect(reversedNormalized.upstreamCategoryId).toBeUndefined();
      expect(reversedNormalized.unresolvedFilters).toHaveLength(1);
      expect(reversedNormalized.unresolvedFilters[0]).toMatchObject({
        filterKey: 'category',
        reason: 'UNRESOLVED',
        candidates: ['Health & Wellness', 'Health Insurance'],
      });
    });

    it('semantic fallback resolves natural group phrase to full trusted group and dispatches single native get_records', async () => {
      const customCategories: WalletCategoryItem[] = [
        {
          id: 'cat-gym',
          name: 'Gym Membership',
          group: { id: 'custom_wellness', name: 'Kebugaran & Kesehatan' },
        },
        {
          id: 'cat-vitamin',
          name: 'Vitamin & Supplements',
          group: { id: 'custom_wellness', name: 'Kebugaran & Kesehatan' },
        },
      ];

      const recordsToReturn: WalletRecordItem[] = [
        {
          id: 'rec-gym',
          accountId: 'acc-bca',
          categoryId: 'cat-gym',
          amount: -500000,
          recordDate: '2026-09-15T10:00:00Z',
          recordType: 'expense',
        },
        {
          id: 'rec-vit',
          accountId: 'acc-bca',
          categoryId: 'cat-vitamin',
          amount: -150000,
          recordDate: '2026-09-15T11:00:00Z',
          recordType: 'expense',
        },
      ];

      const { historyService, capturedCalls } = createMockWalletEnvironment(recordsToReturn, customCategories);

      // Model proposes categoryGroup: 'custom_wellness' during semantic fallback
      const boundaryResult = validateSemanticHistoryQueryOptions(
        {
          categoryGroup: 'custom_wellness',
        },
        customCategories
      );

      expect('accepted' in boundaryResult && !boundaryResult.accepted).toBe(false);
      const queryOptions = boundaryResult as TransactionHistoryQueryOptions;
      expect(queryOptions.isGroupQuery).toBe(true);
      expect(queryOptions.categoryId).toEqual(['cat-gym', 'cat-vitamin']);

      const historyResult = await historyService.getTransactionHistory(queryOptions);

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');
      expect(capturedCalls[0].args.categoryId).toEqual(['cat-gym', 'cat-vitamin']);
      expect(historyResult.records).toHaveLength(2);
      expect(historyResult.records.map(record => record.id)).toEqual(['rec-gym', 'rec-vit']);
    });

    it('handles direct rawCategoryGroup options including ambiguous, oversized, and not found groups', () => {
      // Ambiguous rawCategoryGroup
      const ambiguousCategories: WalletCategoryItem[] = [
        { id: 'cat-h1', name: 'Gym', group: { id: 'health_wellness', name: 'Health Wellness' } },
        { id: 'cat-h2', name: 'BPJS', group: { id: 'health_insurance', name: 'Health Insurance' } },
      ];
      const ambig = normalizeTransactionHistoryFilters({ categoryGroup: 'health' }, MOCK_ACCOUNTS, ambiguousCategories);
      expect(ambig.isValid).toBe(false);
      expect(ambig.unresolvedFilters[0].reason).toBe('UNRESOLVED');

      // Oversized rawCategoryGroup
      const oversizedCategories: WalletCategoryItem[] = Array.from({ length: 55 }, (_, i) => ({
        id: `cat-over-${i}`,
        name: `Over ${i}`,
        group: { id: 'oversized_group', name: 'Oversized Group' },
      }));
      const over = normalizeTransactionHistoryFilters({ categoryGroup: 'oversized_group' }, MOCK_ACCOUNTS, oversizedCategories);
      expect(over.isValid).toBe(false);
      expect(over.unresolvedFilters[0].reason).toBe('UNSUPPORTED');

      // Not found rawCategoryGroup
      const notFound = normalizeTransactionHistoryFilters({ categoryGroup: 'mystery_group' }, MOCK_ACCOUNTS, SYNTHETIC_CATEGORIES);
      expect(notFound.isValid).toBe(false);
      expect(notFound.unresolvedFilters[0].reason).toBe('NOT_FOUND');

      // Valid rawCategoryId array
      const validArray = normalizeTransactionHistoryFilters(
        { categoryId: ['cat-food', 'cat-food-drinks'] },
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );
      expect(validArray.isValid).toBe(true);
      expect(validArray.upstreamCategoryId).toEqual(['cat-food', 'cat-food-drinks']);

      // Oversized rawCategoryId array
      const overArray = normalizeTransactionHistoryFilters(
        { categoryId: Array.from({ length: 55 }, (_, i) => `cat-${i}`) },
        MOCK_ACCOUNTS,
        SYNTHETIC_CATEGORIES
      );
      expect(overArray.isValid).toBe(false);
      expect(overArray.unresolvedFilters[0].reason).toBe('UNSUPPORTED');
    });

    it('handles backward compatibility and substring matches in resolveCategoryGroupFilter', () => {
      // dynamicGroupMap.size === 0 with alias group slug
      const noGroups: WalletCategoryItem[] = [
        { id: 'cat-f1', name: 'Makanan Tradisional' },
        { id: 'cat-f2', name: 'Makanan Cepat Saji' },
      ];
      const compatAlias = normalizeTransactionHistoryFilters({ categoryName: 'makan', isGroupQuery: true }, MOCK_ACCOUNTS, noGroups);
      expect(compatAlias.isValid).toBe(true);
      expect(compatAlias.upstreamCategoryGroup).toBe('food_and_drinks');

      // Substring match with isGroupQuery when dynamicGroupMap has no matching group
      const withCustomCategories: WalletCategoryItem[] = [
        { id: 'cat-sw-1', name: 'Software IntelliJ', group: { id: 'tech', name: 'Technology' } },
        { id: 'cat-sw-2', name: 'Software Copilot', group: { id: 'tech', name: 'Technology' } },
      ];
      const subMatch = normalizeTransactionHistoryFilters({ categoryName: 'software', isGroupQuery: true }, MOCK_ACCOUNTS, withCustomCategories);
      expect(subMatch.isValid).toBe(true);
      expect(subMatch.upstreamCategoryId).toEqual(['cat-sw-1', 'cat-sw-2']);

      // Substring match exceeds MAX_GROUP_CATEGORIES_LIMIT
      const manySoftware: WalletCategoryItem[] = Array.from({ length: 55 }, (_, i) => ({
        id: `cat-sw-${i}`,
        name: `Software Tool ${i}`,
        group: { id: 'tech', name: 'Technology' },
      }));
      const overSub = normalizeTransactionHistoryFilters({ categoryName: 'software', isGroupQuery: true }, MOCK_ACCOUNTS, manySoftware);
      expect(overSub.isValid).toBe(false);
      expect(overSub.unresolvedFilters[0].reason).toBe('UNSUPPORTED');
    });
  });
});

