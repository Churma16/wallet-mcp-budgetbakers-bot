import assert from 'node:assert';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  TransactionHistoryPage,
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
  WalletRecordItem,
} from '../src/types/walletTypes.js';

console.log('[TEST] Starting Transaction Summary Fast-Path Handler Tests (Issue #103)...');

function createHistoryPage(
  records: WalletRecordItem[],
  overrides: Partial<TransactionHistoryPage> = {}
): TransactionHistoryPage {
  return {
    records,
    total: records.length,
    limit: 50,
    offset: 0,
    page: 1,
    totalPages: 1,
    nextOffset: null,
    hasMore: false,
    sort: 'newest',
    ...overrides,
  };
}

console.log('\n[Suite 1] FastPathHandler dispatches transaction summaries end-to-end...');
{
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

  const handler = new FastPathHandler(
    {} as any,
    {} as any,
    mockGateway,
    {} as unknown as TransactionHistoryService,
    mockSummaryService
  );

  const action = detectFastPathAction('total pengeluaran bulan ini');
  assert.strictEqual(typeof action, 'object');
  assert.strictEqual((action as any)?.type, 'TRANSACTION_SUMMARY');

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

  assert.strictEqual(handled, true);
  assert.strictEqual(capturedOptions.length, 1);
  assert.strictEqual(capturedOptions[0].recordType, 'expense');
  assert.strictEqual(capturedOptions[0].datePeriod, 'this_month');
  assert.strictEqual(capturedOptions[0].groupBy, 'none');
  assert.strictEqual(capturedReferenceDates.length, 1);
  assert.strictEqual(capturedReferenceDates[0].toISOString(), '2026-09-12T10:00:00.000Z');

  assert.strictEqual(sentMessages.length, 1);
  assert.strictEqual(sentMessages[0].channel, 'whatsapp');
  assert.strictEqual(sentMessages[0].chatIdentifier, '123456@s.whatsapp.net');
  assert.match(sentMessages[0].message, /Transaction Summary/);
  assert.match(sentMessages[0].message, /Expenses/);
  assert.doesNotMatch(sentMessages[0].message, /Income:/);
  assert.doesNotMatch(sentMessages[0].message, /Net:/);
}

console.log('\n[Suite 2] Duplicate pages stop safely and preserve fallback category/currency buckets...');
{
  const duplicateRecord: WalletRecordItem = {
    id: 'duplicate-record',
    accountId: 'acc-unknown',
    amount: -10000,
    currency: '   ',
    recordDate: '2026-09-12T01:00:00.000Z',
    recordType: 'expense',
  };
  let callCount = 0;
  const mockHistoryService = {
    getTransactionHistory: async (): Promise<TransactionHistoryPage> => {
      callCount += 1;
      return callCount === 1
        ? createHistoryPage([duplicateRecord], { hasMore: true, nextOffset: 1 })
        : createHistoryPage([duplicateRecord], { offset: 1, page: 2, hasMore: true, nextOffset: 2 });
    },
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary({ groupBy: 'category' });

  assert.strictEqual(callCount, 2);
  assert.strictEqual(result.isComplete, false);
  assert.strictEqual(result.transactionCount, 1);
  assert.strictEqual(result.totals[0].currency, 'UNKNOWN');
  assert.strictEqual(result.breakdown[0].key, '__uncategorized__');
  assert.strictEqual(result.breakdown[0].name, undefined);
}

console.log('\n[Suite 3] Missing nextOffset falls back to the consumed record count...');
{
  const offsets: number[] = [];
  const record: WalletRecordItem = {
    id: 'fallback-offset',
    accountId: 'acc-bca',
    accountName: 'BCA',
    amount: -20000,
    currency: 'IDR',
    recordDate: '2026-09-12T02:00:00.000Z',
    recordType: 'expense',
  };
  const mockHistoryService = {
    getTransactionHistory: async (options: { offset?: number }): Promise<TransactionHistoryPage> => {
      offsets.push(options.offset || 0);
      return offsets.length === 1
        ? createHistoryPage([record], { hasMore: true, nextOffset: null })
        : createHistoryPage([], { offset: 1, page: 2 });
    },
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary();

  assert.deepStrictEqual(offsets, [0, 1]);
  assert.strictEqual(result.isComplete, true);
  assert.strictEqual(result.transactionCount, 1);
}

console.log('\n[Suite 4] Unknown continuation metadata probes another offset and preserves unknown account grouping...');
{
  const offsets: number[] = [];
  const record: WalletRecordItem = {
    id: 'unknown-continuation',
    accountId: '   ',
    accountName: '   ',
    amount: 30000,
    currency: 'idr',
    recordDate: '2026-09-12T03:00:00.000Z',
    recordType: 'income',
  };
  const mockHistoryService = {
    getTransactionHistory: async (options: { offset?: number }): Promise<TransactionHistoryPage> => {
      offsets.push(options.offset || 0);
      return offsets.length === 1
        ? createHistoryPage([record], { continuationUnknown: true })
        : createHistoryPage([], { offset: 1, page: 2 });
    },
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary({ groupBy: 'account' });

  assert.deepStrictEqual(offsets, [0, 1]);
  assert.strictEqual(result.isComplete, true);
  assert.strictEqual(result.totals[0].currency, 'IDR');
  assert.strictEqual(result.breakdown[0].key, '__unknown_account__');
  assert.strictEqual(result.breakdown[0].name, undefined);
}

console.log('\n[Suite 5] Non-advancing pagination offsets stop with a partial result...');
{
  const record: WalletRecordItem = {
    id: 'non-advancing',
    accountId: 'acc-bca',
    accountName: 'BCA',
    amount: -40000,
    currency: 'IDR',
    recordDate: '2026-09-12T04:00:00.000Z',
    recordType: 'expense',
  };
  const mockHistoryService = {
    getTransactionHistory: async (): Promise<TransactionHistoryPage> => createHistoryPage(
      [record],
      { hasMore: true, nextOffset: 0 }
    ),
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary();

  assert.strictEqual(result.transactionCount, 1);
  assert.strictEqual(result.isComplete, false);
}

setActiveLanguage('id');
console.log('[SUCCESS] Transaction Summary Fast-Path Handler and coverage regression tests passed.');
