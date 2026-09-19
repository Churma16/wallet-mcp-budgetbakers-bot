import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestFastPathHandler } from './fixtures/compositionFixtures.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import type {
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordAggregationQueryPayload,
  WalletRecordAggregationResponse,
} from '../src/types/walletTypes.js';

describe('Transaction Summary Fast-Path Handler Tests (Issue #103 & #140)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  afterEach(() => {
    setActiveLanguage('id');
    vi.restoreAllMocks();
  });

  describe('Suite 1: FastPathHandler dispatches transaction summaries end-to-end', () => {
    it('handles summary dispatch and formats outbound message', async () => {
      setActiveLanguage('en');

      const capturedOptions: TransactionSummaryQueryOptions[] = [];
      const capturedReferenceDates: Date[] = [];
      const summaryResult: TransactionSummaryResult = {
        transactionCount: 1,
        excludedTransferCount: 0,
        totals: [{
          currency: 'IDR',
          income: 0,
          expense: 125000,
          net: -125000,
          transactionCount: 1,
        }],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
        isComplete: true,
        appliedFilters: {
          recordType: 'expense',
          dateRange: { label: 'This month', selector: 'this month' },
        },
      };

      const mockSummaryService = {
        getTransactionSummary: async (
          options: TransactionSummaryQueryOptions,
          referenceDate: Date
        ): Promise<TransactionSummaryResult> => {
          capturedOptions.push(options);
          capturedReferenceDates.push(referenceDate);
          return summaryResult;
        },
      } as unknown as TransactionSummaryService;

      const sentMessages: Array<{ channel: string; chatIdentifier: string; message: string }> = [];
      const mockGateway = {
        sendMessage: async (channel: string, chatIdentifier: string, message: string) => {
          sentMessages.push({ channel, chatIdentifier, message });
        },
      } as any;

      const handler = createTestFastPathHandler({
        messagingGateway: mockGateway,
        transactionSummaryService: mockSummaryService,
      });

      const action = detectFastPathAction('total pengeluaran bulan ini');
      expect(typeof action).toBe('object');
      expect((action as any)?.type).toBe('TRANSACTION_SUMMARY');

      const processingStartTimestamp = Date.parse('2026-09-12T10:00:00.000Z');
      const event = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'total pengeluaran bulan ini',
        rawMessageTimestamp: new Date(processingStartTimestamp),
      };

      const handled = await handler.handleFastPath(event, action, processingStartTimestamp);

      expect(handled).toBe(true);
      expect(capturedOptions.length).toBe(1);
      expect(capturedOptions[0].recordType).toBe('expense');
      expect(capturedOptions[0].datePeriod).toBe('this_month');
      expect(capturedOptions[0].groupBy).toBe('none');
      expect(capturedReferenceDates.length).toBe(1);
      expect(capturedReferenceDates[0].toISOString()).toBe('2026-09-12T10:00:00.000Z');

      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].channel).toBe('whatsapp');
      expect(sentMessages[0].chatIdentifier).toBe('123456@s.whatsapp.net');
      expect(sentMessages[0].message).toMatch(/Transaction Summary/);
      expect(sentMessages[0].message).toMatch(/Expenses/);
      expect(sentMessages[0].message).not.toMatch(/Income:/);
      expect(sentMessages[0].message).not.toMatch(/Net:/);
    });
  });

  describe('Suite 2: FastPathHandler handles empty summary results gracefully', () => {
    it('formats and sends empty-state response when no transactions match', async () => {
      setActiveLanguage('id');

      const emptySummaryResult: TransactionSummaryResult = {
        transactionCount: 0,
        excludedTransferCount: 0,
        totals: [],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
        isComplete: true,
      };

      const mockSummaryService = {
        getTransactionSummary: async (): Promise<TransactionSummaryResult> => emptySummaryResult,
      } as unknown as TransactionSummaryService;

      const sentMessages: Array<{ channel: string; chatIdentifier: string; message: string }> = [];
      const mockGateway = {
        sendMessage: async (channel: string, chatIdentifier: string, message: string) => {
          sentMessages.push({ channel, chatIdentifier, message });
        },
      } as any;

      const handler = createTestFastPathHandler({
        messagingGateway: mockGateway,
        transactionSummaryService: mockSummaryService,
      });

      const action = detectFastPathAction('total pengeluaran bulan ini');
      const processingStartTimestamp = Date.now();
      const event = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'total pengeluaran bulan ini',
        rawMessageTimestamp: new Date(processingStartTimestamp),
      };

      const handled = await handler.handleFastPath(event, action, processingStartTimestamp);

      expect(handled).toBe(true);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toMatch(/Tidak ada transaksi/);
    });
  });

  describe('Suite 3: FastPathHandler handles unresolved summary filters', () => {
    it('formats and sends unresolved filter warnings without throwing', async () => {
      setActiveLanguage('id');

      const unresolvedSummaryResult: TransactionSummaryResult = {
        transactionCount: 0,
        excludedTransferCount: 0,
        totals: [],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: false,
        isComplete: false,
        unresolvedFilters: [
          {
            filterKey: 'account',
            rawValue: 'bank-xyz',
            reason: 'NOT_FOUND',
            message: 'Akun tidak ditemukan.',
          },
        ],
      };

      const mockSummaryService = {
        getTransactionSummary: async (): Promise<TransactionSummaryResult> => unresolvedSummaryResult,
      } as unknown as TransactionSummaryService;

      const sentMessages: Array<{ channel: string; chatIdentifier: string; message: string }> = [];
      const mockGateway = {
        sendMessage: async (channel: string, chatIdentifier: string, message: string) => {
          sentMessages.push({ channel, chatIdentifier, message });
        },
      } as any;

      const handler = createTestFastPathHandler({
        messagingGateway: mockGateway,
        transactionSummaryService: mockSummaryService,
      });

      const action = detectFastPathAction('total pengeluaran bulan ini');
      const processingStartTimestamp = Date.now();
      const event = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'total pengeluaran bulan ini',
        rawMessageTimestamp: new Date(processingStartTimestamp),
      };

      const handled = await handler.handleFastPath(event, action, processingStartTimestamp);

      expect(handled).toBe(true);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toMatch(/tidak ditemukan/i);
    });
  });

  describe('Suite 4: FastPathHandler formats multi-currency summary breakdown', () => {
    it('formats multi-currency summaries with isolated currency blocks', async () => {
      setActiveLanguage('en');

      const multiCurrencyResult: TransactionSummaryResult = {
        transactionCount: 2,
        excludedTransferCount: 0,
        totals: [
          {
            currency: 'IDR',
            income: 0,
            expense: 50000,
            net: -50000,
            transactionCount: 1,
          },
          {
            currency: 'USD',
            income: 100,
            expense: 0,
            net: 100,
            transactionCount: 1,
          },
        ],
        breakdown: [],
        groupBy: 'none',
        isMultiCurrency: true,
        isComplete: true,
      };

      const mockSummaryService = {
        getTransactionSummary: async (): Promise<TransactionSummaryResult> => multiCurrencyResult,
      } as unknown as TransactionSummaryService;

      const sentMessages: Array<{ channel: string; chatIdentifier: string; message: string }> = [];
      const mockGateway = {
        sendMessage: async (channel: string, chatIdentifier: string, message: string) => {
          sentMessages.push({ channel, chatIdentifier, message });
        },
      } as any;

      const handler = createTestFastPathHandler({
        messagingGateway: mockGateway,
        transactionSummaryService: mockSummaryService,
      });

      const action = detectFastPathAction('total pengeluaran bulan ini');
      const processingStartTimestamp = Date.now();
      const event = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'total pengeluaran bulan ini',
        rawMessageTimestamp: new Date(processingStartTimestamp),
      };

      const handled = await handler.handleFastPath(event, action, processingStartTimestamp);

      expect(handled).toBe(true);
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].message).toMatch(/Currencies are shown separately/);
      expect(sentMessages[0].message).toMatch(/IDR/);
      expect(sentMessages[0].message).toMatch(/USD/);
    });
  });

  describe('Suite 5: FastPathHandler native integration executes without invoking history pagination', () => {
    it('dispatches native aggregation through FastPathHandler and never calls getTransactionHistory', async () => {
      setActiveLanguage('en');

      const cachedAccounts: WalletAccountItem[] = [
        { id: 'acc-bca', name: 'BCA Account', currency: 'IDR' },
      ];
      const cachedCategories: WalletCategoryItem[] = [];

      const mockCache: WalletCacheService = {
        getAccounts: () => cachedAccounts,
        getCategories: () => cachedCategories,
        getLabels: () => [],
        getBudgets: () => [],
        refreshCache: async () => {},
        isCacheValid: () => true,
      } as unknown as WalletCacheService;

      const capturedAggregationPayloads: WalletRecordAggregationQueryPayload[] = [];
      const mockMcpClient = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      vi.spyOn(mockMcpClient, 'fetchRecordsAggregation').mockImplementation(async (payload) => {
        capturedAggregationPayloads.push(payload);
        if (payload.isTransfer === true) {
          return { results: [{ count: 0 }], limit: 1000, offset: 0 };
        }
        return {
          results: [
            {
              currency: 'IDR',
              recordType: 'expense',
              count: 1,
              'amount:sum': -200000,
            },
          ],
          limit: 1000,
          offset: 0,
        };
      });

      const mockHistoryService = {
        getTransactionHistory: vi.fn(),
      } as unknown as TransactionHistoryService;

      const summaryService = new TransactionSummaryService(
        mockMcpClient,
        mockCache,
        mockHistoryService
      );

      const sentMessages: Array<{ channel: string; chatIdentifier: string; message: string }> = [];
      const mockGateway = {
        sendMessage: async (channel: string, chatIdentifier: string, message: string) => {
          sentMessages.push({ channel, chatIdentifier, message });
        },
      } as any;

      const handler = createTestFastPathHandler({
        walletMcpClient: mockMcpClient,
        walletCacheService: mockCache,
        messagingGateway: mockGateway,
        transactionHistoryService: mockHistoryService,
        transactionSummaryService: summaryService,
      });

      const action = detectFastPathAction('total pengeluaran bulan ini');
      const processingStartTimestamp = Date.now();
      const event = {
        channel: 'whatsapp' as const,
        chatIdentifier: '123456@s.whatsapp.net',
        senderIdentifier: '123456',
        messageType: 'text' as const,
        textPayload: 'total pengeluaran bulan ini',
        rawMessageTimestamp: new Date(processingStartTimestamp),
      };

      const handled = await handler.handleFastPath(event, action, processingStartTimestamp);

      expect(handled).toBe(true);

      // Verify native aggregation was invoked
      expect(capturedAggregationPayloads.length).toBe(2);
      expect(capturedAggregationPayloads[0]).toMatchObject({
        groupBy: ['currency', 'recordType'],
        compute: ['amount:sum'],
        isTransfer: false,
      });

      // REQUIRED REGRESSION TEST: getTransactionHistory was NOT called
      expect(mockHistoryService.getTransactionHistory).not.toHaveBeenCalled();

      // Verify outbound message was delivered
      expect(sentMessages.length).toBe(1);
      expect(sentMessages[0].channel).toBe('whatsapp');
      expect(sentMessages[0].message).toMatch(/Transaction Summary/);
      expect(sentMessages[0].message).toMatch(/Expenses/);
    });
  });
});
