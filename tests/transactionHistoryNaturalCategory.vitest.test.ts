import { describe, expect, it } from 'vitest';
import {
  detectFastPathAction,
  FastPathTransactionHistoryAction,
} from '../src/utils/fastPathIntentDetector.js';
import { normalizeTransactionHistoryFilters } from '../src/utils/transactionHistoryFilterNormalizer.js';
import { WalletCategoryItem } from '../src/types/walletTypes.js';

const CATEGORY_FIXTURES: WalletCategoryItem[] = [
  { id: 'cat-hangout', name: 'Makan Hangout' },
  { id: 'cat-nafsu', name: 'Makan Nafsu' },
  { id: 'cat-pokok', name: 'Makan Pokok' },
  { id: 'cat-daily', name: 'Kebutuhan Harian' },
];

function expectHistoryAction(input: string): FastPathTransactionHistoryAction {
  const action = detectFastPathAction(input);

  expect(action).not.toBeNull();
  expect(typeof action).toBe('object');
  expect((action as FastPathTransactionHistoryAction).type).toBe('TRANSACTION_HISTORY');

  return action as FastPathTransactionHistoryAction;
}

describe('natural transaction-history category routing', () => {
  it('keeps a partial category fail-closed and deterministic when it is ambiguous', () => {
    const action = expectHistoryAction('history makan');
    expect(action.options.categoryName).toBe('makan');

    const normalized = normalizeTransactionHistoryFilters(
      action.options,
      [],
      CATEGORY_FIXTURES
    );

    expect(normalized.isValid).toBe(false);
    expect(normalized.upstreamCategoryId).toBeUndefined();
    expect(normalized.unresolvedFilters).toEqual([
      expect.objectContaining({
        filterKey: 'category',
        rawValue: 'makan',
        reason: 'UNRESOLVED',
        candidates: ['Makan Hangout', 'Makan Nafsu', 'Makan Pokok'],
      }),
    ]);
  });

  it.each([
    ['history makan hangout', 'makan hangout', 'cat-hangout'],
    ['riwayat makan nafsu', 'makan nafsu', 'cat-nafsu'],
    ['history makan pokok', 'makan pokok', 'cat-pokok'],
    ['history kebutuhan harian', 'kebutuhan harian', 'cat-daily'],
  ])('preserves the full bare category phrase for %s', (input, expectedName, expectedId) => {
    const action = expectHistoryAction(input);
    expect(action.options.categoryName).toBe(expectedName);
    expect(action.options.searchQuery).toBeUndefined();

    const normalized = normalizeTransactionHistoryFilters(
      action.options,
      [],
      CATEGORY_FIXTURES
    );

    expect(normalized.isValid).toBe(true);
    expect(normalized.upstreamCategoryId).toEqual([expectedId]);
    expect(normalized.unresolvedFilters).toEqual([]);
  });

  it('keeps canonical quoted category syntax working', () => {
    const action = expectHistoryAction('history kategori "Makan Hangout"');

    expect(action.options.categoryName).toBe('makan hangout');
    expect(action.options.searchQuery).toBeUndefined();
  });

  it.each([
    ['semua history makan', 'makan'],
    ['all history makan hangout', 'makan hangout'],
    ['semua riwayat kategori "Makan Pokok"', 'makan pokok'],
  ])('recognizes natural all-history wrapper: %s', (input, expectedCategoryName) => {
    const action = expectHistoryAction(input);

    expect(action.options.categoryName).toBe(expectedCategoryName);
    expect(action).not.toBe('CHECK_BUDGET');
  });

  it.each([
    ['riwayat makan semuanya', 'makan'],
    ['riwayat makan semua', 'makan'],
    ['riwayat makan all', 'makan'],
  ])('removes trailing scope grammar from a category hint: %s', (input, expectedCategoryName) => {
    const action = expectHistoryAction(input);

    expect(action.options.categoryName).toBe(expectedCategoryName);
    expect(action.options.searchQuery).toBeUndefined();
  });

  it('composes a multi-word category with existing structural filters', () => {
    const action = expectHistoryAction('history bca makan hangout bulan ini terbaru');

    expect(action.options).toEqual(
      expect.objectContaining({
        accountName: 'bca',
        categoryName: 'makan hangout',
        datePeriod: 'this_month',
        sort: 'newest',
      })
    );
  });

  it.each(['history starbucks', 'history coffee', 'riwayat starbucks'])(
    'keeps an explicit prefixed history request deterministic even when the category is unknown: %s',
    input => {
      const expectedCategoryName = input.split(/\s+/).at(-1);
      const action = expectHistoryAction(input);

      expect(action.options.categoryName).toBe(expectedCategoryName);
      expect(action.options.searchQuery).toBeUndefined();

      const normalized = normalizeTransactionHistoryFilters(
        action.options,
        [],
        CATEGORY_FIXTURES
      );

      expect(normalized.isValid).toBe(false);
      expect(normalized.upstreamCategoryId).toBeUndefined();
      expect(normalized.unresolvedFilters).toEqual([
        expect.objectContaining({
          filterKey: 'category',
          rawValue: expectedCategoryName,
          reason: 'NOT_FOUND',
        }),
      ]);
    }
  );

  it('continues requiring explicit search syntax for merchant or note text', () => {
    const dedicatedSearch = expectHistoryAction('search starbucks');
    expect(dedicatedSearch.options.searchQuery).toBe('starbucks');
    expect(dedicatedSearch.options.categoryName).toBeUndefined();

    const historySearch = expectHistoryAction('history cari starbucks');
    expect(historySearch.options.searchQuery).toBe('starbucks');
    expect(historySearch.options.categoryName).toBeUndefined();
  });

  it('does not weaken transaction-creation collision protection', () => {
    expect(detectFastPathAction('beli makan hangout 25rb')).toBeNull();
    expect(detectFastPathAction('catat history makan hangout 50k')).toBeNull();
  });
});
