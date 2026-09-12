import assert from 'node:assert';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionSummaryMessage } from '../src/utils/transactionSummaryFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  TransactionHistoryPage,
  TransactionHistoryQueryOptions,
  WalletRecordItem,
} from '../src/types/walletTypes.js';

console.log('[TEST] Starting Transaction Summary & Breakdown Tests (Issue #103)...');

function createRecord(overrides: Partial<WalletRecordItem> = {}): WalletRecordItem {
  return {
    id: 'record-default',
    accountId: 'acc-bca',
    accountName: 'BCA',
    amount: -100000,
    currency: 'IDR',
    recordDate: '2026-09-12T01:00:00.000Z',
    recordType: 'expense',
    category: { id: 'cat-food', name: 'Food' },
    ...overrides,
  };
}

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

console.log('\n[Suite 1] Aggregates totals across paginated history and excludes transfers...');
{
  const capturedOptions: TransactionHistoryQueryOptions[] = [];
  const referenceDates: Date[] = [];
  const referenceDate = new Date('2026-09-12T09:30:00.000Z');

  const firstPageRecords = [
    createRecord({ id: 'expense-food', amount: -100000 }),
    createRecord({
      id: 'income-salary',
      amount: 500000,
      recordType: 'income',
      category: { id: 'cat-salary', name: 'Salary' },
    }),
  ];
  const secondPageRecords = [
    createRecord({
      id: 'expense-transport',
      accountId: 'acc-cash',
      accountName: 'Cash',
      amount: -50000,
      category: { id: 'cat-transport', name: 'Transport' },
    }),
    createRecord({
      id: 'transfer-1',
      amount: -20000,
      transfer: { type: 'outgoing', transferId: 'transfer-pair-1' },
    }),
  ];

  const mockHistoryService = {
    getTransactionHistory: async (
      options: TransactionHistoryQueryOptions,
      receivedReferenceDate: Date
    ): Promise<TransactionHistoryPage> => {
      capturedOptions.push(options);
      referenceDates.push(receivedReferenceDate);
      if ((options.offset || 0) === 0) {
        return createHistoryPage(firstPageRecords, {
          total: 4,
          nextOffset: 2,
          hasMore: true,
          appliedFilters: {
            category: { id: 'cat-food', name: 'Food' },
            dateRange: { label: 'Bulan ini', selector: 'bulan ini' },
          },
        });
      }
      return createHistoryPage(secondPageRecords, {
        total: 4,
        offset: 2,
        page: 2,
      });
    },
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary(
    { categoryName: 'food', datePeriod: 'this_month', groupBy: 'category' },
    referenceDate
  );

  assert.strictEqual(capturedOptions.length, 2);
  assert.strictEqual(capturedOptions[0].categoryName, 'food');
  assert.strictEqual(capturedOptions[0].datePeriod, 'this_month');
  assert.strictEqual(capturedOptions[0].limit, 50);
  assert.strictEqual(capturedOptions[0].offset, 0);
  assert.strictEqual(capturedOptions[1].offset, 2);
  assert.strictEqual(referenceDates[0], referenceDate);
  assert.strictEqual(referenceDates[1], referenceDate);

  assert.strictEqual(result.transactionCount, 3);
  assert.strictEqual(result.excludedTransferCount, 1);
  assert.strictEqual(result.isComplete, true);
  assert.strictEqual(result.totals.length, 1);
  assert.deepStrictEqual(result.totals[0], {
    currency: 'IDR',
    income: 500000,
    expense: 150000,
    net: 350000,
    transactionCount: 3,
  });
  assert.strictEqual(result.breakdown.length, 3);
  assert.strictEqual(result.breakdown[0].name, 'Food');
  assert.strictEqual(result.breakdown[0].totals[0].expense, 100000);

  console.log('  [PASS] Pagination, totals, transfer exclusion, and category breakdown verified.');
}

console.log('\n[Suite 2] Filtered totals preserve history filter semantics...');
{
  const capturedOptions: TransactionHistoryQueryOptions[] = [];
  const mockHistoryService = {
    getTransactionHistory: async (options: TransactionHistoryQueryOptions): Promise<TransactionHistoryPage> => {
      capturedOptions.push(options);
      const records = options.recordType === 'income'
        ? [createRecord({ id: 'income-only', amount: 750000, recordType: 'income' })]
        : [];
      return createHistoryPage(records, {
        appliedFilters: {
          account: { id: 'acc-bca', name: 'BCA' },
          recordType: options.recordType,
          dateRange: { label: 'Hari ini', selector: 'hari ini' },
        },
      });
    },
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary({
    accountName: 'bca',
    recordType: 'income',
    datePeriod: 'today',
  });

  assert.strictEqual(capturedOptions[0].accountName, 'bca');
  assert.strictEqual(capturedOptions[0].recordType, 'income');
  assert.strictEqual(capturedOptions[0].datePeriod, 'today');
  assert.strictEqual(result.totals[0].income, 750000);
  assert.strictEqual(result.totals[0].expense, 0);
  assert.strictEqual(result.totals[0].net, 750000);

  console.log('  [PASS] Account, type, and date filters are delegated unchanged to transaction history.');
}

console.log('\n[Suite 3] Multi-currency totals remain isolated...');
{
  const mockHistoryService = {
    getTransactionHistory: async (): Promise<TransactionHistoryPage> => createHistoryPage([
      createRecord({ id: 'idr-expense', amount: -100000, currency: 'IDR' }),
      createRecord({ id: 'usd-expense', amount: -10, currency: 'USD' }),
      createRecord({ id: 'usd-income', amount: 20, currency: 'USD', recordType: 'income' }),
    ]),
  } as unknown as TransactionHistoryService;

  const service = new TransactionSummaryService(mockHistoryService);
  const result = await service.getTransactionSummary({ groupBy: 'account' });

  assert.strictEqual(result.isMultiCurrency, true);
  assert.strictEqual(result.totals.length, 2);
  assert.deepStrictEqual(result.totals.map(item => item.currency), ['IDR', 'USD']);
  assert.strictEqual(result.totals.find(item => item.currency === 'IDR')?.expense, 100000);
  assert.strictEqual(result.totals.find(item => item.currency === 'USD')?.expense, 10);
  assert.strictEqual(result.totals.find(item => item.currency === 'USD')?.income, 20);
  assert.strictEqual(result.breakdown.length, 1);
  assert.strictEqual(result.breakdown[0].totals.length, 2);

  setActiveLanguage('en');
  const formatted = formatTransactionSummaryMessage(result);
  assert.match(formatted, /Currencies are shown separately/);
  assert.match(formatted, /\*IDR\*/);
  assert.match(formatted, /\*USD\*/);

  console.log('  [PASS] Cross-currency values are never silently combined.');
}

console.log('\n[Suite 4] Empty and unresolved results fail clearly...');
{
  const emptyHistoryService = {
    getTransactionHistory: async (): Promise<TransactionHistoryPage> => createHistoryPage([]),
  } as unknown as TransactionHistoryService;

  const emptyService = new TransactionSummaryService(emptyHistoryService);
  const emptyResult = await emptyService.getTransactionSummary();
  assert.strictEqual(emptyResult.transactionCount, 0);
  assert.deepStrictEqual(emptyResult.totals, []);
  assert.strictEqual(emptyResult.isComplete, true);

  setActiveLanguage('id');
  assert.match(formatTransactionSummaryMessage(emptyResult), /Tidak ada transaksi/);

  const unresolvedHistoryService = {
    getTransactionHistory: async (): Promise<TransactionHistoryPage> => createHistoryPage([], {
      unresolvedFilters: [{
        filterKey: 'account',
        rawValue: 'does-not-exist',
        reason: 'NOT_FOUND',
        message: 'Akun tidak ditemukan.',
      }],
    }),
  } as unknown as TransactionHistoryService;

  const unresolvedService = new TransactionSummaryService(unresolvedHistoryService);
  const unresolvedResult = await unresolvedService.getTransactionSummary({ accountName: 'does-not-exist' });
  assert.strictEqual(unresolvedResult.isComplete, false);
  assert.strictEqual(unresolvedResult.transactionCount, 0);
  assert.strictEqual(unresolvedResult.unresolvedFilters?.length, 1);

  console.log('  [PASS] Empty data and unresolved filters produce deterministic no-data results.');
}

console.log('\n[Suite 5] Fast-path summary intents reuse history-style filters...');
{
  const expenseAction = detectFastPathAction('total pengeluaran bulan ini');
  assert.strictEqual(typeof expenseAction, 'object');
  assert.strictEqual((expenseAction as any)?.type, 'TRANSACTION_SUMMARY');
  assert.strictEqual((expenseAction as any)?.options.recordType, 'expense');
  assert.strictEqual((expenseAction as any)?.options.datePeriod, 'this_month');

  const categoryAction = detectFastPathAction('summary by category this month');
  assert.strictEqual((categoryAction as any)?.type, 'TRANSACTION_SUMMARY');
  assert.strictEqual((categoryAction as any)?.options.groupBy, 'category');
  assert.strictEqual((categoryAction as any)?.options.datePeriod, 'this_month');

  const accountAction = detectFastPathAction('pengeluaran per akun bulan ini');
  assert.strictEqual((accountAction as any)?.type, 'TRANSACTION_SUMMARY');
  assert.strictEqual((accountAction as any)?.options.groupBy, 'account');
  assert.strictEqual((accountAction as any)?.options.recordType, 'expense');

  const filteredAction = detectFastPathAction('ringkasan makanan bulan ini');
  assert.strictEqual((filteredAction as any)?.type, 'TRANSACTION_SUMMARY');
  assert.strictEqual((filteredAction as any)?.options.categoryName, 'makanan');
  assert.strictEqual((filteredAction as any)?.options.datePeriod, 'this_month');

  assert.strictEqual(detectFastPathAction('bayar 50rb makan siang'), null);

  console.log('  [PASS] Indonesian and English summary commands route through deterministic fast-path parsing.');
}

setActiveLanguage('id');
console.log('\n[SUCCESS] All Transaction Summary tests passed.');
