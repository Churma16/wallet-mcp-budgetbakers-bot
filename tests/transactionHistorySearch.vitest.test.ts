import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  MAX_TRANSACTION_HISTORY_LIMIT,
} from '../src/services/walletMcpService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestFastPathHandler } from './fixtures/compositionFixtures.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import {
  matchesTransactionRecordSearch,
  MAX_SEARCH_QUERY_LENGTH,
} from '../src/utils/transactionSearchMatcher.js';
import { normalizeTransactionHistoryFilters } from '../src/utils/transactionHistoryFilterNormalizer.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import type { TransactionHistoryPage } from '../src/types/walletTypes.js';
import {
  CANONICAL_ACCOUNTS,
  CANONICAL_CATEGORIES,
  CANONICAL_REFERENCE_DATE,
  getCanonicalTransactions,
  createQueryExecutionContext,
  type QueryExecutionContext,
} from './fixtures/transactionFixtures.js';

describe('Transaction History Text Search Tests (Issue #102 & #177)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
  });

  describe('search matcher', () => {
    it('matches records based on counterparty and note keywords using pure fixtures', () => {
      const canonicalRecords = getCanonicalTransactions();

      expect(matchesTransactionRecordSearch(canonicalRecords[0], 'STARBUCKS')).toBe(true);
      expect(matchesTransactionRecordSearch(canonicalRecords[0], 'macchiato')).toBe(true);
      expect(matchesTransactionRecordSearch(canonicalRecords[2], 'nasi padang')).toBe(true);
      expect(matchesTransactionRecordSearch(canonicalRecords[3], 'starbucks')).toBe(false);
      expect(matchesTransactionRecordSearch(canonicalRecords[0], '   ')).toBe(false);
    });
  });

  describe('filter normalization', () => {
    it('validates and normalizes valid search query strings', () => {
      const validNormalization = normalizeTransactionHistoryFilters(
        { searchQuery: '  starbucks coffee  ' },
        CANONICAL_ACCOUNTS,
        CANONICAL_CATEGORIES,
        CANONICAL_REFERENCE_DATE
      );

      expect(validNormalization.isValid).toBe(true);
      expect(validNormalization.normalizedOptions.searchQuery).toBe('starbucks coffee');
      expect(validNormalization.appliedFilters.navigationTokens).toContain('cari "starbucks coffee"');
    });

    it('rejects empty or whitespace-only search query strings', () => {
      const emptyNormalization = normalizeTransactionHistoryFilters(
        { searchQuery: '   ' },
        CANONICAL_ACCOUNTS,
        CANONICAL_CATEGORIES,
        CANONICAL_REFERENCE_DATE
      );

      expect(emptyNormalization.isValid).toBe(false);
      expect(emptyNormalization.unresolvedFilters[0].filterKey).toBe('searchQuery');
      expect(emptyNormalization.unresolvedFilters[0].reason).toBe('INVALID_FORMAT');
    });

    it('rejects oversized search query strings exceeding character limit', () => {
      const oversizedNormalization = normalizeTransactionHistoryFilters(
        { searchQuery: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) },
        CANONICAL_ACCOUNTS,
        CANONICAL_CATEGORIES,
        CANONICAL_REFERENCE_DATE
      );

      expect(oversizedNormalization.isValid).toBe(false);
    });

    it('accepts search query strings matching exact maximum length limit', () => {
      const exactLimitNormalization = normalizeTransactionHistoryFilters(
        { searchQuery: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH) },
        CANONICAL_ACCOUNTS,
        CANONICAL_CATEGORIES,
        CANONICAL_REFERENCE_DATE
      );

      expect(exactLimitNormalization.isValid).toBe(true);
    });
  });

  describe('query execution', () => {
    let queryContext: QueryExecutionContext;

    beforeEach(() => {
      queryContext = createQueryExecutionContext();
    });

    it('returns matching records for merchant search', async () => {
      const result = await queryContext.service.getTransactionHistory({ searchQuery: 'sTaRbUcKs' });

      expect(result.records.map(record => record.id)).toEqual(['rec-1']);
    });

    it('returns matching records for note search', async () => {
      const result = await queryContext.service.getTransactionHistory({ searchQuery: 'PADANG' });

      expect(result.records.map(record => record.id)).toEqual(['rec-3']);
    });

    it('returns matching records for counterparty search', async () => {
      const result = await queryContext.service.getTransactionHistory({ searchQuery: 'Indomaret' });

      expect(result.records.map(record => record.id)).toEqual(['rec-2']);
      expect(result.appliedFilters?.searchQuery).toBe('Indomaret');
    });

    it('returns matching records for food search', async () => {
      const result = await queryContext.service.getTransactionHistory({ searchQuery: 'kopi' });

      expect(result.records.map(record => record.id)).toEqual(['rec-2']);
    });

    it('dispatches client search directly without upstream query parameter', async () => {
      const merchantResult = await queryContext.client.fetchRecords({ searchQuery: 'sTaRbUcKs' });
      expect(queryContext.capturedCalls[0].args.query).toBeUndefined();
      expect(merchantResult.records.map(record => record.id)).toEqual(['rec-1']);

      const noteResult = await queryContext.client.fetchRecords({ searchQuery: 'PADANG' });
      expect(noteResult.records.map(record => record.id)).toEqual(['rec-3']);
    });

    it('upstream query dispatch and query-specific error classification', async () => {
      queryContext.setNextResponse({ records: [queryContext.records[0]], total: 1 });
      const pageResult = await queryContext.service.getTransactionHistory({ searchQuery: 'Starbucks' });
      expect(queryContext.capturedCalls[0].args.query).toBeUndefined();
      expect(pageResult.records).toHaveLength(1);

      queryContext.setError(new Error('Wallet MCP Error: search query not supported by upstream data source'));
      const unsupportedResult = await queryContext.service.getTransactionHistory({ searchQuery: 'Unsupported Query' });
      expect(unsupportedResult.records).toHaveLength(0);
      expect(unsupportedResult.unresolvedFilters?.[0].reason).toBe('UNSUPPORTED');
      expect(unsupportedResult.unresolvedFilters?.[0].subType).toBe('unsupported_upstream_search');

      queryContext.setError(new Error('MCP Error: unknown parameter: query'));
      const unknownQueryResult = await queryContext.service.getTransactionHistory({ searchQuery: 'Unknown Query' });
      expect(unknownQueryResult.unresolvedFilters?.[0].reason).toBe('UNSUPPORTED');

      queryContext.setError(new Error('unsupported category filter'));
      await expect(
        queryContext.service.getTransactionHistory({ searchQuery: 'Category Error', categoryName: 'Makanan & Minuman' })
      ).rejects.toThrow(/unsupported category filter/);

      queryContext.setError(new Error('Network timeout: ECONNRESET'));
      await expect(
        queryContext.service.getTransactionHistory({ searchQuery: 'Network Error' })
      ).rejects.toThrow(/ECONNRESET/);
    });

    it('composes search with account, category, type, date, sort, and limit', async () => {
      queryContext.setNextResponse({ records: [], total: 0 });

      await queryContext.service.getTransactionHistory({ searchQuery: 'Starbucks', accountName: 'BCA' });
      expect(queryContext.capturedCalls[0].args.accountId).toBe('acc-bca');

      await queryContext.service.getTransactionHistory({ searchQuery: 'Indomaret', categoryName: 'Makanan & Minuman' });
      expect(queryContext.capturedCalls[1].args.categoryId).toEqual(['cat-food']);

      await queryContext.service.getTransactionHistory({ searchQuery: 'Bonus', recordType: 'income' });
      expect(queryContext.capturedCalls[2].args.recordType).toBe('income');

      await queryContext.service.getTransactionHistory(
        { searchQuery: 'Kopi', datePeriod: 'this_month' },
        CANONICAL_REFERENCE_DATE
      );
      expect(Array.isArray(queryContext.capturedCalls[3].args.recordDate)).toBe(true);

      const combinedResult = await queryContext.service.getTransactionHistory(
        {
          searchQuery: 'Gambir',
          accountName: 'Cash Dompet',
          categoryName: 'Transportasi',
          recordType: 'expense',
          startDate: '2026-09-01',
          endDate: '2026-09-10',
          limit: 20,
          sort: 'oldest',
        },
        CANONICAL_REFERENCE_DATE
      );

      const combinedArguments = queryContext.capturedCalls[4].args;
      expect(combinedArguments.query).toBeUndefined();
      expect(combinedArguments.accountId).toBe('acc-cash');
      expect(combinedArguments.categoryId).toEqual(['cat-transport']);
      expect(combinedArguments.recordType).toBe('expense');
      expect(combinedArguments.limit).toBe(20);
      expect(combinedArguments.sortBy).toEqual(['+recordDate', '+createdAt']);
      expect(combinedResult.appliedFilters?.searchQuery).toBe('Gambir');
    });

    it('enforces maximum history limit cap for search requests', async () => {
      queryContext.setNextResponse({ records: [], total: 0 });
      await queryContext.client.fetchRecords({ searchQuery: 'Starbucks', limit: 100 });
      expect(queryContext.capturedCalls[0].args.limit).toBe(MAX_TRANSACTION_HISTORY_LIMIT);
    });
  });

  describe('fast-path parsing', () => {
    it('fast-path search parsing preserves literals and structured modifiers', () => {
      expect((detectFastPathAction('cari starbucks') as any)?.options.searchQuery).toBe('starbucks');
      expect((detectFastPathAction('find supermarket') as any)?.options.searchQuery).toBe('supermarket');
      expect((detectFastPathAction('cari "Kopi Kenangan"') as any)?.options.searchQuery).toBe('Kopi Kenangan');
      expect((detectFastPathAction('riwayat cari starbucks') as any)?.options.searchQuery).toBe('starbucks');
      expect((detectFastPathAction('riwayat "starbucks"') as any)?.options.searchQuery).toBe('starbucks');

      const prefixedCategoryFallback = detectFastPathAction('riwayat starbucks') as any;
      expect(prefixedCategoryFallback?.type).toBe('TRANSACTION_HISTORY');
      expect(prefixedCategoryFallback?.options.categoryName).toBe('starbucks');
      expect(prefixedCategoryFallback?.options.searchQuery).toBeUndefined();

      const composedAction = detectFastPathAction('cari indomaret di bca bulan ini') as any;
      expect(composedAction?.options.searchQuery).toBe('indomaret');
      expect(composedAction?.options.accountName).toBe('bca');
      expect(composedAction?.options.datePeriod).toBe('this_month');

      const composedEnglishAction = detectFastPathAction('search coffee expense 5 page 2') as any;
      expect(composedEnglishAction?.options.searchQuery).toBe('coffee');
      expect(composedEnglishAction?.options.recordType).toBe('expense');
      expect(composedEnglishAction?.options.limit).toBe(5);
      expect(composedEnglishAction?.options.page).toBe(2);

      expect((detectFastPathAction('cari Kopi di Taman') as any)?.options.searchQuery).toBe('Kopi di Taman');
      expect((detectFastPathAction('search Coffee in Town') as any)?.options.searchQuery).toBe('Coffee in Town');

      expect(detectFastPathAction('beli kopi 25rb')).toBeNull();
      expect(detectFastPathAction('transfer 100000 ke bca')).toBeNull();
      expect(detectFastPathAction('cari')).toBeNull();
    });
  });

  describe('formatting', () => {
    it('formats pagination hints and verifies round-trip parsing', () => {
      const samplePage: TransactionHistoryPage = {
        records: [getCanonicalTransactions()[0]],
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
      const idMessage = formatTransactionHistoryMessage(samplePage);
      expect(idMessage).toMatch(/Cari: "Starbucks"/);
      expect(idMessage).toMatch(/riwayat cari "Starbucks" hal 2/);

      setActiveLanguage('en');
      const enMessage = formatTransactionHistoryMessage(samplePage);
      expect(enMessage).toMatch(/Search: "Starbucks"/);
      expect(enMessage).toMatch(/history search "Starbucks" page 2/);

      const roundTripAction = detectFastPathAction('history search "Starbucks" page 2');
      expect((roundTripAction as any)?.options.page).toBe(2);
      expect((roundTripAction as any)?.options.searchQuery).toBe('Starbucks');
    });

    it('formats empty search and unresolved search error states with proper localization', () => {
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
      expect(formatTransactionHistoryMessage(emptyPage)).toMatch(
        /Belum ada transaksi yang cocok dengan filter \[Cari: "Restoran Mewah"\]/
      );

      setActiveLanguage('en');
      expect(formatTransactionHistoryMessage(emptyPage)).toMatch(
        /No transactions match the filter \[Search: "Restoran Mewah"\]/
      );

      const unresolvedPage: TransactionHistoryPage = {
        ...emptyPage,
        unresolvedFilters: [{
          filterKey: 'searchQuery',
          rawValue: 'Starbucks',
          reason: 'UNSUPPORTED',
          message: 'Pencarian teks tidak didukung oleh sumber data upstream.',
        }],
      };
      const englishErrorMessage = formatTransactionHistoryMessage(unresolvedPage, 'en');
      expect(englishErrorMessage).toMatch(/Text search is not supported by the upstream data source/);
      expect(englishErrorMessage.toLowerCase().includes('pencarian')).toBe(false);
    });
  });

  describe('fast-path handler integration', () => {
    it('dispatches search end-to-end via FastPathHandler', async () => {
      setActiveLanguage('id');
      const queryContext = createQueryExecutionContext({
        records: [{
          ...getCanonicalTransactions()[0],
          accountName: 'BCA Tabungan',
          counterParty: 'Kopi Kenangan',
          note: 'Kopi Kenangan Mantan Regular',
        }],
      });

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
        textPayload: 'cari kopi',
        rawMessageTimestamp: new Date(),
      };

      const handled = await handler.handleFastPath(
        mockEvent,
        detectFastPathAction('cari kopi'),
        Date.now()
      );
      expect(handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toMatch(/Cari: "kopi"/);
      expect(sentMessages[0]).toMatch(/Kopi Kenangan/);
    });
  });
});
