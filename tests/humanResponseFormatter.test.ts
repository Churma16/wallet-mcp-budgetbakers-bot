import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  formatTransactionDate,
  getHumanReadableTimestamp,
} from '../src/utils/humanResponseFormatter.js';
import { formatConciseErrorMessage } from '../src/utils/logger.js';

console.log('=== TEST 1A: TODAY SINGLE RECORD ===');
console.log(formatRecordSuccessMessage(
  [{ accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' }],
  [{ id: 'acc1', name: 'Gopay' }],
  [{ id: 'cat1', name: 'Makanan & Minuman' }]
));

console.log('\n=== TEST 1B: PAST DATE TRANSACTION (e.g. 3 Sep 2026, 17:15 WIB) ===');
console.log(formatRecordSuccessMessage(
  [{
    accountId: 'acc2',
    amount: -5000,
    recordDate: '2026-09-03T10:15:00.000Z',
    categoryId: 'cat3',
    note: 'Insufficient Funds Fee (Visa payment failed)',
  }],
  [{ id: 'acc2', name: 'Jago Expense' }],
  [{ id: 'cat3', name: 'Charges, fees' }]
));

console.log('\n=== TEST 2: MULTI RECORDS ===');
console.log(formatRecordSuccessMessage(
  [
    { accountId: 'acc1', amount: -35000, recordDate: new Date().toISOString(), categoryId: 'cat1', note: 'Makan siang' },
    { accountId: 'acc1', amount: -5000, recordDate: new Date().toISOString(), categoryId: 'cat2', note: 'Parkir' }
  ],
  [{ id: 'acc1', name: 'Gopay' }],
  [{ id: 'cat1', name: 'Makanan & Minuman' }, { id: 'cat2', name: 'Transportasi' }]
));

console.log('\n=== TEST 3: BALANCE SUMMARY ===');
console.log(formatBalanceSummaryMessage([
  { id: '1', name: 'Cash', balance: 150000, currency: 'IDR' },
  { id: '2', name: 'Dana', balance: 50000, currency: 'IDR' },
  { id: '3', name: 'Gopay', balance: 350000, currency: 'IDR' },
  { id: '4', name: 'Mandiri Debit', balance: 2500000, currency: 'IDR' }
]));

console.log('\n=== TEST 4: ERROR - 503 AI BUSY ===');
console.log(formatErrorMessageForHuman(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}')));

console.log('\n=== TEST 5: ERROR - MCP SCHEMA VALIDATION ===');
console.log(formatErrorMessageForHuman(new Error('[error] MCP Tool create_records failed: schema validation failed at /records/0: unexpected additional properties')));

console.log('\n=== TEST 6: ERROR - NETWORK TIMEOUT ===');
console.log(formatErrorMessageForHuman(new Error('connect ETIMEDOUT 104.26.12.31:443')));

console.log('\n=== TEST 7: CONCISE ERROR - 429 QUOTA EXCEEDED ===');
const sampleQuotaError = `{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash\\nPlease retry in 37.417182623s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.Help","links":[{"description":"Learn more about Gemini API quotas","url":"https://ai.google.dev/gemini-api/docs/rate-limits"}]}]}}`;
console.log('Concise:', formatConciseErrorMessage(sampleQuotaError));

console.log('\n=== TEST 8: CONCISE ERROR - 503 UNAVAILABLE ===');
const sampleUnavailableError = `{"error":{"code":503,"message":"This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.","status":"UNAVAILABLE"}}`;
console.log('Concise:', formatConciseErrorMessage(sampleUnavailableError));

console.log('\n=== TEST 9: FORMAT TRANSACTION DATE INVALID DATES ===');
const invalidStringFormatted = formatTransactionDate('not-a-valid-date');
console.log('Invalid string date formatted:', invalidStringFormatted);
const invalidDateObjectFormatted = formatTransactionDate(new Date('invalid'));
console.log('Invalid Date object formatted:', invalidDateObjectFormatted);
const emptyDateFormatted = formatTransactionDate(undefined);
console.log('Empty date formatted:', emptyDateFormatted);

