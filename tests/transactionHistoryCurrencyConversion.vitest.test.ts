import { describe, it, expect, vi } from 'vitest';
import {
  callGetRecords,
  fetchRecords,
  normalizeRawRecord,
  normalizeRawRecords,
  normalizeTransactionHistoryFilters,
  formatTransactionHistoryMessage,
  WALLET_MCP_TOOL_NAMES,
  type WalletToolCaller,
  type RawRecordItem,
  type TransactionHistoryPage,
  type TransactionHistoryQueryOptions,
} from '../src/wallet/index.js';
import { getTransactionSummary } from '../src/wallet/summary/summary.js';
import { validateSemanticHistoryQueryOptions } from '../src/brain/semantic/semanticBoundaryHistoryValidator.js';

describe('Transaction History On-Demand Currency Conversion (convertTo)', () => {
  describe('Raw Record Normalization', () => {
    it('extracts convertedAmount from raw record item', () => {
      const rawRecord: RawRecordItem = {
        id: 'record-123',
        accountId: 'account-usd',
        amount: -25.5,
        currency: 'USD',
        recordDate: '2026-10-31T12:00:00Z',
        convertedAmount: {
          value: -395250,
          ratio: 15500,
          currencyCode: 'IDR',
          conversionPair: 'USD:IDR',
        },
      };

      const normalized = normalizeRawRecord(rawRecord);

      expect(normalized.id).toBe('record-123');
      expect(normalized.amount).toBe(-25.5);
      expect(normalized.currency).toBe('USD');
      expect(normalized.convertedAmount).toBeDefined();
      expect(normalized.convertedAmount).toEqual({
        value: -395250,
        ratio: 15500,
        currencyCode: 'IDR',
        conversionPair: 'USD:IDR',
        error: undefined,
      });
    });

    it('extracts error string when upstream currency conversion rate is unavailable', () => {
      const rawRecord: RawRecordItem = {
        id: 'record-err',
        accountId: 'account-xyz',
        amount: -100,
        currency: 'XYZ',
        recordDate: '2026-10-31T12:00:00Z',
        convertedAmount: {
          currencyCode: 'IDR',
          error: 'Exchange rate unavailable for currency XYZ',
        },
      };

      const normalized = normalizeRawRecord(rawRecord);

      expect(normalized.convertedAmount).toBeDefined();
      expect(normalized.convertedAmount?.error).toBe('Exchange rate unavailable for currency XYZ');
      expect(normalized.convertedAmount?.currencyCode).toBe('IDR');
      expect(normalized.convertedAmount?.value).toBeUndefined();
      expect(normalized.convertedAmount?.ratio).toBeUndefined();
    });

    it('handles records without convertedAmount cleanly', () => {
      const rawRecord: RawRecordItem = {
        id: 'record-normal',
        accountId: 'account-idr',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-10-31T12:00:00Z',
      };

      const normalized = normalizeRawRecord(rawRecord);

      expect(normalized.convertedAmount).toBeUndefined();
    });

    it('processes batches through normalizeRawRecords preserving converted amounts', () => {
      const rawRecords: RawRecordItem[] = [
        {
          id: 'rec-1',
          accountId: 'acc-usd',
          amount: -10,
          currency: 'USD',
          recordDate: '2026-10-30T10:00:00Z',
          convertedAmount: {
            value: -155000,
            ratio: 15500,
            currencyCode: 'IDR',
            conversionPair: 'USD:IDR',
          },
        },
        {
          id: 'rec-2',
          accountId: 'acc-idr',
          amount: 500000,
          currency: 'IDR',
          recordDate: '2026-10-31T11:00:00Z',
        },
      ];

      const normalizedList = normalizeRawRecords(rawRecords);

      expect(normalizedList).toHaveLength(2);
      expect(normalizedList[0].convertedAmount?.value).toBe(-155000);
      expect(normalizedList[1].convertedAmount).toBeUndefined();
    });
  });

  describe('fetchRecords and Tool Dispatch', () => {
    it('dispatches convertTo to callGetRecords payload when option is supplied', async () => {
      const mockRecords: RawRecordItem[] = [
        {
          id: 'rec-conv-1',
          accountId: 'acc-sgd',
          amount: -12.5,
          currency: 'SGD',
          recordDate: '2026-10-30T15:00:00Z',
          convertedAmount: {
            value: -145000,
            ratio: 11600,
            currencyCode: 'IDR',
            conversionPair: 'SGD:IDR',
          },
        },
      ];

      let capturedPayload: Record<string, unknown> | undefined;
      const mockCaller: WalletToolCaller = {
        callMcpTool: vi.fn(async (toolName: string, args?: Record<string, unknown>) => {
          if (toolName === WALLET_MCP_TOOL_NAMES.GET_RECORDS) {
            capturedPayload = args;
            return { records: mockRecords, total: 1 };
          }
          return [];
        }),
      };

      const queryOptions: TransactionHistoryQueryOptions = {
        limit: 5,
        convertTo: 'base',
      };

      const pageResult = await fetchRecords(mockCaller, queryOptions);

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.convertTo).toBe('base');
      expect(capturedPayload?.limit).toBe(5);
      expect(pageResult.records).toHaveLength(1);
      expect(pageResult.records[0].convertedAmount?.value).toBe(-145000);
    });

    it('trims whitespace on convertTo before dispatching to upstream MCP', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const mockCaller: WalletToolCaller = {
        callMcpTool: vi.fn(async (_toolName: string, args?: Record<string, unknown>) => {
          capturedPayload = args;
          return { records: [], total: 0 };
        }),
      };

      await fetchRecords(mockCaller, {
        limit: 10,
        convertTo: '  IDR  ',
      });

      expect(capturedPayload?.convertTo).toBe('IDR');
    });
  });

  describe('Filter Normalization', () => {
    it('preserves and trims convertTo in normalizedOptions and appliedFilters', () => {
      const normalizationResult = normalizeTransactionHistoryFilters(
        {
          limit: 10,
          convertTo: '  EUR  ',
        },
        [],
        [],
        new Date('2026-10-31T00:00:00Z')
      );

      expect(normalizationResult.isValid).toBe(true);
      expect(normalizationResult.appliedFilters?.convertTo).toBe('EUR');
      expect(normalizationResult.normalizedOptions.convertTo).toBe('EUR');
    });

    it('omits convertTo when undefined or empty string', () => {
      const normalizationResult = normalizeTransactionHistoryFilters(
        {
          limit: 10,
          convertTo: '   ',
        },
        [],
        [],
        new Date('2026-10-31T00:00:00Z')
      );

      expect(normalizationResult.isValid).toBe(true);
      expect(normalizationResult.appliedFilters?.convertTo).toBeUndefined();
      expect(normalizationResult.normalizedOptions.convertTo).toBeUndefined();
    });
  });

  describe('Human Response Formatting', () => {
    it('formats converted amount and exchange rate alongside native amount in Indonesian (id)', () => {
      const page: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-1',
            accountId: 'acc-usd',
            accountName: 'Cash USD',
            amount: -20,
            currency: 'USD',
            recordDate: '2026-10-31T14:00:00Z',
            recordType: 'expense',
            note: 'Dinner abroad',
            category: { id: 'cat-food', name: 'Makanan & Minuman' },
            convertedAmount: {
              value: -310000,
              ratio: 15500,
              currencyCode: 'IDR',
              conversionPair: 'USD:IDR',
            },
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
          convertTo: 'IDR',
        },
      };

      const message = formatTransactionHistoryMessage(page, 'id');

      expect(message).toContain('Konversi: IDR');
      expect(message).toContain('1. Dinner abroad');
      expect(message).toContain('*-$20,00* (~-Rp310.000 • kurs 15.500) • Cash USD');
      expect(message).toContain('Makanan & Minuman');
    });

    it('formats converted amount and rate in English (en)', () => {
      const page: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-2',
            accountId: 'acc-usd',
            accountName: 'USD Wallet',
            amount: 100,
            currency: 'USD',
            recordDate: '2026-10-31T14:00:00Z',
            recordType: 'income',
            note: 'Consulting freelance',
            category: { id: 'cat-income', name: 'Salary' },
            convertedAmount: {
              value: 1550000,
              ratio: 15500,
              currencyCode: 'IDR',
              conversionPair: 'USD:IDR',
            },
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
          convertTo: 'IDR',
        },
      };

      const message = formatTransactionHistoryMessage(page, 'en');

      expect(message).toContain('Converted: IDR');
      expect(message).toContain('1. Consulting freelance');
      expect(message).toContain('*+$100.00* (~+Rp1,550,000 • rate 15,500) • USD Wallet');
    });

    it('displays error information when convertedAmount has an error', () => {
      const page: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-err',
            accountId: 'acc-crypto',
            accountName: 'Crypto Wallet',
            amount: -0.05,
            currency: 'BTC',
            recordDate: '2026-10-31T14:00:00Z',
            recordType: 'expense',
            note: 'Mining fee',
            convertedAmount: {
              currencyCode: 'IDR',
              error: 'Rate not found',
            },
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
      };

      const messageId = formatTransactionHistoryMessage(page, 'id');
      expect(messageId).toContain('(konversi tidak tersedia: Rate not found)');

      const messageEn = formatTransactionHistoryMessage(page, 'en');
      expect(messageEn).toContain('(conversion unavailable: Rate not found)');
    });

    it('does not display redundant conversion when currency is identical and ratio is 1', () => {
      const page: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-idr',
            accountId: 'acc-bca',
            accountName: 'BCA Utama',
            amount: -50000,
            currency: 'IDR',
            recordDate: '2026-10-31T14:00:00Z',
            recordType: 'expense',
            note: 'Makan Siang',
            convertedAmount: {
              value: -50000,
              ratio: 1,
              currencyCode: 'IDR',
              conversionPair: 'IDR:IDR',
            },
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
      };

      const message = formatTransactionHistoryMessage(page, 'id');
      expect(message).toContain('*-Rp50.000* • BCA Utama');
      expect(message).not.toContain('~-Rp50.000');
    });
  });

  describe('Summary Aggregation and Semantic Boundary', () => {
    it('passes convertTo to aggregationPayload in calculateTransactionSummary', async () => {
      let capturedPayload: Record<string, unknown> | undefined;
      const mockSummaryClient = {
        callMcpTool: vi.fn(),
        fetchRecordsAggregation: vi.fn(async (payload: any) => {
          capturedPayload = payload;
          return { results: [] };
        }),
      };

      await getTransactionSummary(
        mockSummaryClient as any,
        undefined,
        undefined,
        undefined,
        {
          convertTo: 'base',
        }
      );

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload?.convertTo).toBe('base');
    });

    it('accepts bounded convertTo in validateSemanticHistoryQueryOptions', () => {
      const validationResult = validateSemanticHistoryQueryOptions({
        accountName: 'BCA',
        convertTo: 'USD',
      });

      expect('accepted' in validationResult).toBe(false);
      const options = validationResult as TransactionHistoryQueryOptions;
      expect(options.convertTo).toBe('USD');
    });

    it('rejects malformed convertTo in validateSemanticHistoryQueryOptions', () => {
      const validationResult = validateSemanticHistoryQueryOptions({
        convertTo: 'A'.repeat(50),
      });

      expect('accepted' in validationResult).toBe(true);
      if ('accepted' in validationResult) {
        expect(validationResult.accepted).toBe(false);
        expect(validationResult.code).toBe('INVALID_ARGUMENTS');
      }
    });
  });
});
