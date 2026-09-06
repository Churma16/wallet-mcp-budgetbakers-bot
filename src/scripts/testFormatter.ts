import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
} from '../utils/humanResponseFormatter.js';

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
