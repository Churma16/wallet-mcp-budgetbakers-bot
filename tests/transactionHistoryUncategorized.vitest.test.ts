import { describe, expect, it, vi } from 'vitest';
import { detectFastPathAction, FastPathTransactionHistoryAction } from '../src/brain/index.js';
import {
  extractDynamicCategoryGroups,
  findMatchingDynamicCategoryGroup,
  isUnknownCategoryQuery,
  matchDynamicCategoryGroup,
  NATIVE_UNKNOWN_CATEGORY_FILTER,
} from '../src/wallet/history/categoryGroupResolver.js';
import { normalizeTransactionHistoryFilters } from '../src/wallet/history/transactionHistoryFilterNormalizer.js';
import {
  callGetRecords,
  TransactionHistoryService,
  WALLET_MCP_TOOL_NAMES,
  WalletCategoryItem,
  WalletToolCaller,
} from '../src/wallet/index.js';

const MOCK_SYSTEM_UNKNOWN_CATEGORIES: WalletCategoryItem[] = [
  {
    id: 'cat-sys-unknown-exp',
    name: 'Unknown expense',
    group: { id: 'unknown_records', name: 'Unknown Records' },
  },
  {
    id: 'cat-sys-unknown-inc',
    name: 'Unknown income',
    group: { id: 'unknown_records', name: 'Unknown Records' },
  },
  {
    id: 'cat-sys-uncategorized',
    name: 'Uncategorized',
    group: { id: 'unknown_records', name: 'Unknown Records' },
  },
  {
    id: 'cat-food',
    name: 'Food & Drinks',
    group: { id: 'food_and_drinks', name: 'Food & Drinks' },
  },
];

describe('Issue 262: Native categoryId "unknown" Filter for Uncategorized Queries', () => {
  describe('Part 1: Natural-Language Fast-Path Intent Detection', () => {
    it.each([
      ['history belum dikategorikan', 'belum dikategorikan'],
      ['history tanpa kategori', 'tanpa kategori'],
      ['history uncategorized', 'uncategorized'],
      ['history unknown', 'unknown'],
      ['transaksi belum dikategorikan', 'belum dikategorikan'],
      ['transaksi tanpa kategori', 'tanpa kategori'],
      ['transaksi uncategorized', 'uncategorized'],
      ['transaksi unknown', 'unknown'],
      ['riwayat transaksi belum dikategorikan', 'belum dikategorikan'],
      ['riwayat transaksi tanpa kategori', 'tanpa kategori'],
      ['daftar transaksi belum dikategorikan', 'belum dikategorikan'],
      ['cek transaksi belum dikategorikan', 'belum dikategorikan'],
      ['lihat transaksi tanpa kategori', 'tanpa kategori'],
      ['show uncategorized transactions', 'uncategorized'],
      ['uncategorized transactions', 'uncategorized'],
      ['check unknown transactions', 'unknown'],
      ['unknown transactions', 'unknown'],
      ['view uncategorized records', 'uncategorized'],
      ['list unknown records', 'unknown'],
    ])('recognizes natural uncategorized intent: %s', (prompt, expectedCategoryName) => {
      const action = detectFastPathAction(prompt);

      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');
      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe(expectedCategoryName);
    });

    it('composes uncategorized query with date period', () => {
      const action = detectFastPathAction('transaksi belum dikategorikan bulan ini');

      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');
      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('belum dikategorikan');
      expect(historyAction.options.datePeriod).toBe('this_month');
    });

    it('composes English uncategorized query with date period', () => {
      const action = detectFastPathAction('uncategorized transactions this month');

      expect(action).not.toBeNull();
      expect(action?.type).toBe('TRANSACTION_HISTORY');
      const historyAction = action as FastPathTransactionHistoryAction;
      expect(historyAction.options.categoryName).toBe('uncategorized');
      expect(historyAction.options.datePeriod).toBe('this_month');
    });
  });

  describe('Part 2: Category Group Resolver Unknown Delegation', () => {
    it.each([
      'unknown',
      'uncategorized',
      'unknown_records',
      'unknown records',
      'tanpa kategori',
      'tanpa_kategori',
      'belum dikategorikan',
      'belum_dikategorikan',
      'belum ada kategori',
      'tidak ada kategori',
      'transaksi belum dikategorikan',
      'transaksi tanpa kategori',
      'uncategorized transactions',
      'uncategorized transaction',
      'unknown transactions',
      'unknown transaction',
      'uncategorized records',
      'uncategorized record',
    ])('isUnknownCategoryQuery matches alias: %s', (alias) => {
      expect(isUnknownCategoryQuery(alias)).toBe(true);
    });

    it('extracts dynamic category groups without client-side ID expansion for unknown_records', () => {
      const groupMap = extractDynamicCategoryGroups(MOCK_SYSTEM_UNKNOWN_CATEGORIES);

      expect(groupMap.has('unknown_records')).toBe(true);
      const unknownGroup = groupMap.get('unknown_records');
      expect(unknownGroup?.categoryIds).toEqual([NATIVE_UNKNOWN_CATEGORY_FILTER]);
      expect(unknownGroup?.categories).toHaveLength(3);
    });

    it.each([
      'unknown_records',
      'unknown',
      'uncategorized',
      'tanpa kategori',
      'belum dikategorikan',
    ])('matchDynamicCategoryGroup delegates %s to native unknown filter', (hint) => {
      const groupMap = extractDynamicCategoryGroups(MOCK_SYSTEM_UNKNOWN_CATEGORIES);
      const matchResult = matchDynamicCategoryGroup(hint, groupMap);

      expect(matchResult.status).toBe('EXACT_MATCH');
      expect(matchResult.group?.categoryIds).toEqual(['unknown']);
    });

    it('findMatchingDynamicCategoryGroup returns unknown group even when dynamic map is empty', () => {
      const emptyGroupMap = new Map();
      const matchedGroup = findMatchingDynamicCategoryGroup('belum dikategorikan', emptyGroupMap);

      expect(matchedGroup).toBeDefined();
      expect(matchedGroup?.categoryIds).toEqual(['unknown']);
    });
  });

  describe('Part 3: Transaction History Filter Normalization', () => {
    it.each([
      'belum dikategorikan',
      'tanpa kategori',
      'uncategorized',
      'unknown',
      'transaksi belum dikategorikan',
      'transaksi tanpa kategori',
      'uncategorized transactions',
      'uncategorized transaction',
      'unknown transactions',
      'unknown transaction',
      'uncategorized records',
      'uncategorized record',
    ])('normalizes categoryName "%s" to upstream categoryId ["unknown"]', (categoryHint) => {
      const result = normalizeTransactionHistoryFilters(
        { categoryName: categoryHint },
        [],
        MOCK_SYSTEM_UNKNOWN_CATEGORIES
      );

      expect(result.isValid).toBe(true);
      expect(result.unresolvedFilters).toEqual([]);
      expect(result.upstreamCategoryId).toEqual(['unknown']);
      expect(result.appliedFilters.category?.id).toBe('unknown');
      expect(result.appliedFilters.category?.name).toBe('Tanpa Kategori');
    });

    it.each([
      'unknown_records',
      'unknown',
      'uncategorized',
      'tanpa kategori',
      'belum dikategorikan',
    ])('normalizes categoryGroup "%s" to upstream categoryId ["unknown"] without expansion', (groupHint) => {
      const result = normalizeTransactionHistoryFilters(
        { categoryGroup: groupHint },
        [],
        MOCK_SYSTEM_UNKNOWN_CATEGORIES
      );

      expect(result.isValid).toBe(true);
      expect(result.unresolvedFilters).toEqual([]);
      expect(result.upstreamCategoryId).toEqual(['unknown']);
      expect(result.upstreamCategoryGroup).toBeUndefined();
      expect(result.appliedFilters.categoryGroup).toBe('unknown');
    });

    it('normalizes categoryId literal "unknown" directly', () => {
      const result = normalizeTransactionHistoryFilters(
        { categoryId: 'unknown' },
        [],
        MOCK_SYSTEM_UNKNOWN_CATEGORIES
      );

      expect(result.isValid).toBe(true);
      expect(result.upstreamCategoryId).toEqual(['unknown']);
      expect(result.appliedFilters.category?.id).toBe('unknown');
    });

    it('normalizes categoryId array ["unknown"] directly', () => {
      const result = normalizeTransactionHistoryFilters(
        { categoryId: ['unknown'] },
        [],
        MOCK_SYSTEM_UNKNOWN_CATEGORIES
      );

      expect(result.isValid).toBe(true);
      expect(result.upstreamCategoryId).toEqual(['unknown']);
      expect(result.appliedFilters.category?.id).toBe('unknown');
    });

    it('normalizes group scoped query "semua transaksi belum dikategorikan"', () => {
      const result = normalizeTransactionHistoryFilters(
        { categoryName: 'belum dikategorikan', isGroupQuery: true },
        [],
        MOCK_SYSTEM_UNKNOWN_CATEGORIES
      );

      expect(result.isValid).toBe(true);
      expect(result.upstreamCategoryId).toEqual(['unknown']);
      expect(result.appliedFilters.categoryGroup).toBe('unknown');
    });
  });

  describe('Part 4: Upstream MCP Serialization in TransactionHistoryService', () => {
    it('serializes categoryId: "unknown" as string literal when querying uncategorized transactions', async () => {
      const capturedToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

      const mockToolCaller: WalletToolCaller = {
        callMcpTool: vi.fn().mockImplementation(async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
          capturedToolCalls.push({ toolName, args });
          return {
            records: [
              {
                id: 'rec-uncat-1',
                accountId: 'acc-1',
                amount: -50000,
                recordDate: '2026-11-01',
                recordType: 'expense',
                category: { id: 'cat-sys-uncategorized', name: 'Uncategorized' },
              },
            ],
            total: 1,
          } as unknown as T;
        }),
      };

      const historyService = new TransactionHistoryService(mockToolCaller);

      const historyResult = await historyService.getTransactionHistory({
        categoryId: 'unknown',
        categoryGroup: 'unknown_records',
        limit: 10,
      });

      expect(historyResult.records).toHaveLength(1);
      expect(capturedToolCalls).toHaveLength(1);
      expect(capturedToolCalls[0].toolName).toBe(WALLET_MCP_TOOL_NAMES.GET_RECORDS);
      expect(capturedToolCalls[0].args.categoryId).toBe('unknown');
      expect(capturedToolCalls[0].args.categoryGroup).toBeUndefined();
    });

    it('serializes categoryId: "unknown" when categoryId is passed as array ["unknown"]', async () => {
      const capturedToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

      const mockToolCaller: WalletToolCaller = {
        callMcpTool: vi.fn().mockImplementation(async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
          capturedToolCalls.push({ toolName, args });
          return { records: [], total: 0 } as unknown as T;
        }),
      };

      const historyService = new TransactionHistoryService(mockToolCaller);

      await historyService.getTransactionHistory({
        categoryId: ['unknown'],
        limit: 20,
      });

      expect(capturedToolCalls).toHaveLength(1);
      expect(capturedToolCalls[0].args.categoryId).toBe('unknown');
    });

    it('handles uppercase and mixed-case categoryId and categoryGroup without leaking categoryGroup', async () => {
      const capturedToolCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

      const mockToolCaller: WalletToolCaller = {
        callMcpTool: vi.fn().mockImplementation(async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
          capturedToolCalls.push({ toolName, args });
          return { records: [], total: 0 } as unknown as T;
        }),
      };

      const historyService = new TransactionHistoryService(mockToolCaller);

      await historyService.getTransactionHistory({
        categoryId: 'UNKNOWN',
        categoryGroup: 'UNKNOWN_RECORDS',
        limit: 10,
      });

      expect(capturedToolCalls).toHaveLength(1);
      expect(capturedToolCalls[0].args.categoryId).toBe('unknown');
      expect(capturedToolCalls[0].args.categoryGroup).toBeUndefined();
    });

    it('callGetRecords wrapper serializes categoryId: "unknown" cleanly', async () => {
      const mockCaller: WalletToolCaller = {
        callMcpTool: vi.fn().mockResolvedValue({ records: [], total: 0 }),
      };

      await callGetRecords(mockCaller, {
        limit: 15,
        categoryId: 'unknown',
      });

      expect(mockCaller.callMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_RECORDS,
        expect.objectContaining({
          limit: 15,
          categoryId: 'unknown',
        })
      );
    });
  });
});
