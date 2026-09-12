import assert from 'node:assert';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  TransactionSummaryQueryOptions,
  TransactionSummaryResult,
} from '../src/types/walletTypes.js';

console.log('[TEST] Starting Transaction Summary Fast-Path Handler Tests (Issue #103)...');

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

setActiveLanguage('id');
console.log('[SUCCESS] Transaction Summary Fast-Path Handler tests passed.');
