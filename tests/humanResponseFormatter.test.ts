import assert from 'node:assert';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  formatTransactionDate,
  getHumanReadableTimestamp,
  formatTransactionHistoryMessage,
  truncateTransactionTitle,
  formatCompactTransactionDate,
  formatCompactTransactionAmount,
  MAX_TRANSACTION_HISTORY_TITLE_LENGTH,
} from '../src/utils/humanResponseFormatter.js';
import { formatConciseErrorMessage } from '../src/utils/logger.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';

console.log('=== TEST 1A: TODAY SINGLE RECORD ===');
const singleRecordMsg = formatRecordSuccessMessage(
  [{ accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' }],
  [{ id: 'acc1', name: 'Gopay' }],
  [{ id: 'cat1', name: 'Makanan & Minuman' }]
);
console.log(singleRecordMsg);
assert.ok(singleRecordMsg.includes('Makan siang'), 'Single record message includes note');
assert.ok(singleRecordMsg.includes('Gopay'), 'Single record message includes account');

console.log('\n=== TEST 1B: PAST DATE TRANSACTION (e.g. 3 Sep 2026, 17:15 WIB) ===');
const pastRecordMsg = formatRecordSuccessMessage(
  [{
    accountId: 'acc2',
    amount: -5000,
    recordDate: '2026-09-03T10:15:00.000Z',
    categoryId: 'cat3',
    note: 'Insufficient Funds Fee (Visa payment failed)',
  }],
  [{ id: 'acc2', name: 'Jago Expense' }],
  [{ id: 'cat3', name: 'Charges, fees' }]
);
console.log(pastRecordMsg);
assert.ok(pastRecordMsg.includes('Jago Expense'), 'Past record message includes account');

console.log('\n=== TEST 2: MULTI RECORDS ===');
const multiRecordMsg = formatRecordSuccessMessage(
  [
    { accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' },
    { accountId: 'acc1', amount: -5000, recordDate: new Date().toISOString(), categoryId: 'cat2', note: 'Parkir' }
  ],
  [{ id: 'acc1', name: 'Gopay' }],
  [{ id: 'cat1', name: 'Makanan & Minuman' }, { id: 'cat2', name: 'Transportasi' }]
);
console.log(multiRecordMsg);
assert.ok(multiRecordMsg.includes('Makan siang') && multiRecordMsg.includes('Parkir'), 'Multi record includes all items');

console.log('\n=== TEST 3: BALANCE SUMMARY ===');
const balanceSummaryMsg = formatBalanceSummaryMessage([
  { id: '1', name: 'Cash', balance: 150000, currency: 'IDR' },
  { id: '2', name: 'Dana', balance: 50000, currency: 'IDR' },
  { id: '3', name: 'Gopay', balance: 350000, currency: 'IDR' },
  { id: '4', name: 'Mandiri Debit', balance: 2500000, currency: 'IDR' }
]);
console.log(balanceSummaryMsg);
assert.ok(balanceSummaryMsg.includes('Mandiri Debit'), 'Balance summary contains accounts');

console.log('\n=== TEST 4: ERROR - 503 AI BUSY ===');
const aiBusyMsg = formatErrorMessageForHuman(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'));
console.log(aiBusyMsg);
assert.ok(aiBusyMsg.includes('Layanan AI lagi ramai'), 'AI busy error returns aiBusy response');

console.log('\n=== TEST 5: ERROR - MCP SCHEMA VALIDATION ===');
const schemaValidationMsg = formatErrorMessageForHuman(new Error('[error] MCP Tool create_records failed: schema validation failed at /records/0: unexpected additional properties'));
console.log(schemaValidationMsg);
assert.ok(schemaValidationMsg.includes('format datanya kurang pas'), 'True schema validation returns schemaValidation error');

console.log('\n=== TEST 5B: ERROR - DOWNSTREAM CREATE_RECORDS MCP FAILURE ===');
const downstreamCreateRecordsMsg = formatErrorMessageForHuman(new Error("[error] MCP Tool 'create_records' rejected 1 record(s) with definitive failure"));
console.log(downstreamCreateRecordsMsg);
assert.ok(
  !downstreamCreateRecordsMsg.includes('format datanya kurang pas'),
  'Downstream create_records failure must not be misclassified as bad user schema formatting'
);
assert.ok(
  downstreamCreateRecordsMsg.includes('Ada kendala saat memproses pesanmu'),
  'Downstream create_records failure classifies as generic system processing error'
);

console.log('\n=== TEST 6: ERROR - NETWORK TIMEOUT ===');
const networkTimeoutMsg = formatErrorMessageForHuman(new Error('connect ETIMEDOUT 104.26.12.31:443'));
console.log(networkTimeoutMsg);
assert.ok(networkTimeoutMsg.includes('Koneksi ke server lagi gangguan'), 'Network timeout error returns networkConnection response');

console.log('\n=== TEST 6B: ERROR - RECEIPT VISION EXTRACTION FAILURE (IMAGE CONTEXT) ===');
const receiptParseErrorMsgId = formatErrorMessageForHuman(
  new AiResponseParseError('No valid JSON object structure found in AI response', 'Some raw OCR text'),
  undefined,
  'id',
  { isImageMessage: true }
);
console.log(receiptParseErrorMsgId);
assert.ok(
  receiptParseErrorMsgId.includes('Foto struk belum berhasil dibaca'),
  'Receipt parse error in Indonesian returns receiptExtractionFailed response'
);

const receiptParseErrorMsgEn = formatErrorMessageForHuman(
  new AiResponseParseError('Unable to parse JSON from AI response', 'Malformed text'),
  undefined,
  'en',
  { isImageMessage: true }
);
console.log(receiptParseErrorMsgEn);
assert.ok(
  receiptParseErrorMsgEn.includes('Could not clearly read the receipt image'),
  'Receipt parse error in English returns receiptExtractionFailed response'
);

console.log('\n=== TEST 6C: ERROR - DOWNSTREAM MCP JSON-RPC ERROR IN IMAGE CONTEXT ===');
const downstreamImageJsonRpcMsg = formatErrorMessageForHuman(
  new Error('[error] MCP JSON-RPC Error: tool execution failed'),
  undefined,
  'id',
  { isImageMessage: true }
);
console.log(downstreamImageJsonRpcMsg);
assert.ok(
  !downstreamImageJsonRpcMsg.includes('Foto struk belum berhasil dibaca'),
  'Downstream JSON-RPC failure in image message must not be misclassified as receipt extraction failure'
);
assert.ok(
  downstreamImageJsonRpcMsg.includes('Ada kendala saat memproses pesanmu'),
  'Downstream JSON-RPC failure in image message resolves to generic system error'
);

console.log('\n=== TEST 7: CONCISE ERROR - 429 QUOTA EXCEEDED ===');
const sampleQuotaError = `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\\nPlease retry in 37.417182623s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.Help","links":[{"description":"Learn more about Gemini API quotas","url":"https://ai.google.dev/gemini-api/docs/rate-limits"}]}]}}`;
const conciseQuota = formatConciseErrorMessage(sampleQuotaError);
console.log('Concise:', conciseQuota);
assert.ok(conciseQuota.length > 0, 'Concise quota error formatted');

console.log('\n=== TEST 8: CONCISE ERROR - 503 UNAVAILABLE ===');
const sampleUnavailableError = `{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}`;
const conciseUnavailable = formatConciseErrorMessage(sampleUnavailableError);
console.log('Concise:', conciseUnavailable);
assert.ok(conciseUnavailable.length > 0, 'Concise unavailable error formatted');

console.log('\n=== TEST 9: FORMAT TRANSACTION DATE INVALID DATES ===');
const invalidStringFormatted = formatTransactionDate('not-a-valid-date');
console.log('Invalid string date formatted:', invalidStringFormatted);
const invalidDateObjectFormatted = formatTransactionDate(new Date('invalid'));
console.log('Invalid Date object formatted:', invalidDateObjectFormatted);
const emptyDateFormatted = formatTransactionDate(undefined);
console.log('Empty date formatted:', emptyDateFormatted);

console.log('\n=== TEST 10: COMPACT TRANSACTION HISTORY FORMATTING (ISSUE #115) ===');

// 10.1 Title truncation tests
const shortTitle = 'Biaya admin tf';
assert.strictEqual(truncateTransactionTitle(shortTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH), shortTitle, 'Short title is not truncated');

const exactLengthTitle = 'A'.repeat(MAX_TRANSACTION_HISTORY_TITLE_LENGTH);
assert.strictEqual(truncateTransactionTitle(exactLengthTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH), exactLengthTitle, 'Exact length title is not truncated');

const longTitle = 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN REPUBLIK INDONESIA';
const truncatedTitle = truncateTransactionTitle(longTitle, MAX_TRANSACTION_HISTORY_TITLE_LENGTH);
assert.strictEqual(truncatedTitle, 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2...', 'Long title is deterministically truncated with ellipsis at 43 chars');
assert.strictEqual(longTitle.startsWith('Pengkreditan otomatis'), true, 'Original title data is not mutated');

// 10.2 Compact signed amount formatting tests
const idrExpense = formatCompactTransactionAmount(-20895, 'expense', 'IDR', 'id');
assert.strictEqual(idrExpense, '-Rp20.895', 'IDR expense amount is formatted with minus prefix and no whitespace');

const idrIncome = formatCompactTransactionAmount(5729876, 'income', 'IDR', 'id');
assert.strictEqual(idrIncome, '+Rp5.729.876', 'IDR income amount is formatted with plus prefix and no whitespace');

const usdExpense = formatCompactTransactionAmount(-25, 'expense', 'USD', 'en');
assert.strictEqual(usdExpense, '-$25.00', 'USD expense amount is formatted with minus prefix and two decimals');

const usdIncome = formatCompactTransactionAmount(100.5, 'income', 'USD', 'en');
assert.strictEqual(usdIncome, '+$100.50', 'USD income amount is formatted with plus prefix and two decimals');

// 10.3 Compact transaction date formatting tests
const sampleDateCurrentYear = new Date();
sampleDateCurrentYear.setHours(13, 52, 0, 0);
const compactDateCurrentYear = formatCompactTransactionDate(sampleDateCurrentYear, 'id');
assert.doesNotMatch(compactDateCurrentYear, new RegExp(String(sampleDateCurrentYear.getFullYear())), 'Current year should be omitted from compact date');
assert.match(compactDateCurrentYear, /13:52/, 'Time HH:mm should be preserved in compact date');

const sampleDatePastYear = new Date('2024-05-10T10:15:00.000Z');
const compactDatePastYear = formatCompactTransactionDate(sampleDatePastYear, 'id');
assert.match(compactDatePastYear, /2024/, 'Past year should be included in compact date');

// 10.4 3-line item layout, lighter header, bold amount, and emoji-free items
const sampleHistoryPage = {
  records: [
    {
      id: 'rec-1',
      accountId: 'acc-1',
      accountName: 'Cash',
      amount: -1000,
      currency: 'IDR',
      recordDate: '2026-09-11T06:53:00.000Z',
      recordType: 'expense' as const,
      note: 'Biaya admin tf',
      category: { id: 'cat-1', name: 'Charges, fees' },
    },
    {
      id: 'rec-2',
      accountId: 'acc-2',
      accountName: 'Gopay',
      amount: -20895,
      currency: 'IDR',
      recordDate: '2026-09-11T06:52:00.000Z',
      recordType: 'expense' as const,
      note: 'Pembayaran ke Nodus Digital Store',
      category: { id: 'cat-2', name: 'Pengeluaran Digital' },
    },
    {
      id: 'rec-3',
      accountId: 'acc-3',
      accountName: 'Mandiri Debit Card',
      amount: 5729876,
      currency: 'IDR',
      recordDate: '2026-09-10T14:31:00.000Z',
      recordType: 'income' as const,
      note: 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN',
      category: { id: 'cat-3', name: 'Wage, invoices' },
      labels: [{ id: 'lbl-1', name: 'salary' }],
    },
  ],
  total: 3741,
  limit: 10,
  offset: 0,
  page: 1,
  totalPages: 375,
  nextOffset: 10,
  hasMore: true,
  sort: 'newest' as const,
};

const historyFormattedId = formatTransactionHistoryMessage(sampleHistoryPage, 'id');
console.log('Formatted Indonesian History (Issue #115):\n', historyFormattedId);

// Verify lighter header
assert.match(historyFormattedId, /^📋 \*Riwayat Transaksi\*\nHal\. 1\/375 • 3 item/m, 'Header has lighter 2-line layout with item count');

// Verify 3-line layout without indentation
assert.match(historyFormattedId, /1\. Biaya admin tf\n\*-Rp1\.000\* • Cash\nCharges, fees • \d+ Sep \d\d:\d\d/m, 'Item 1 matches 3-line non-indented layout with bold amount');
assert.match(historyFormattedId, /2\. Pembayaran ke Nodus Digital Store\n\*-Rp20\.895\* • Gopay\nPengeluaran Digital • \d+ Sep \d\d:\d\d/m, 'Item 2 matches 3-line layout');
assert.match(historyFormattedId, /3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5\.729\.876\* • Mandiri Debit Card\nWage, invoices • \d+ Sep \d\d:\d\d • #salary/m, 'Item 3 is truncated at 42 chars and displays bold positive amount');

// Verify exactly one blank line between items
assert.ok(historyFormattedId.includes('\n\n1. Biaya admin tf'), 'Blank line before first item');
assert.ok(historyFormattedId.includes('\n\n2. Pembayaran ke Nodus Digital Store'), 'Blank line between item 1 and 2');
assert.ok(historyFormattedId.includes('\n\n3. Pengkreditan otomatis'), 'Blank line between item 2 and 3');

// Verify zero decorative per-item emojis
const itemsBodyOnly = historyFormattedId.split('\n\n').slice(1, -1).join('\n\n');
assert.doesNotMatch(itemsBodyOnly, /[💸💰🔄🏷️🔖]/u, 'Items body must not contain decorative emojis');

// Verify English symmetry
const historyFormattedEn = formatTransactionHistoryMessage(sampleHistoryPage, 'en');
console.log('\nFormatted English History (Issue #115):\n', historyFormattedEn);
assert.match(historyFormattedEn, /^📋 \*Transaction History\*\nPage 1\/375 • 3 items/m, 'English header has lighter 2-line layout with plural items');
assert.match(historyFormattedEn, /1\. Biaya admin tf\n\*-Rp1,000\* • Cash/m, 'English item 1 formatted with comma thousands separator');
assert.match(historyFormattedEn, /3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5,729,876\* • Mandiri Debit Card/m, 'English item 3 formatted with comma thousands separator');

// 10.5 Missing optional fields fallback
const fallbackHistoryPage = {
  records: [
    {
      id: 'rec-fallback',
      amount: -15000,
      currency: 'IDR',
      recordDate: '2026-09-11T10:00:00.000Z',
    },
  ],
  total: 1,
  limit: 10,
  offset: 0,
  page: 1,
  totalPages: 1,
  nextOffset: null,
  hasMore: false,
  sort: 'newest' as const,
};
const fallbackFormattedId = formatTransactionHistoryMessage(fallbackHistoryPage, 'id');
assert.match(fallbackFormattedId, /1\. Pengeluaran\n\*-Rp15\.000\* • Akun\nUmum • \d+ Sep \d\d:\d\d/m, 'Missing note, account, and category resolve to defaults');

console.log('\n[PASS] All humanResponseFormatter tests completed with assertions!');


