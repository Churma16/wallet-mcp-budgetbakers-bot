import assert from 'node:assert';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  formatTransactionDate,
  getHumanReadableTimestamp,
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

console.log('\n[PASS] All humanResponseFormatter tests completed with assertions!');

