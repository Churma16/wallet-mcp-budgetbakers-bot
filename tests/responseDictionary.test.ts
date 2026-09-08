import assert from 'node:assert';
import {
  getDictionary,
  setActiveLanguage,
  getActiveLanguage,
  indonesianDictionary,
  englishDictionary,
} from '../src/i18n/index.js';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatPendingEmailTransactionNotification,
  formatPendingConfirmationSuccess,
  formatBulkPendingConfirmationSuccess,
  formatPendingCancellationMessage,
  formatErrorMessageForHuman,
  formatTransactionDate,
  formatCurrencyAmount,
} from '../src/utils/humanResponseFormatter.js';
import { detectFastPathAction, detectPendingConfirmationAction } from '../src/utils/fastPathIntentDetector.js';
import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload, WalletBudgetItem } from '../src/types/walletTypes.js';
import { PendingTransactionItem } from '../src/services/pendingTransactionManager.js';

console.log('[TEST] Starting Response Dictionary & Multi-Language Formatting Tests...');

// 1. Verify Dictionary Key Parity
console.log('\n[1] Testing Key Parity between ID and EN dictionaries...');

function collectDeepKeys(obj: Record<string, any>, prefix: string = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    keys.push(fullPath);
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value !== 'function') {
      keys.push(...collectDeepKeys(value, fullPath));
    }
  }
  return keys.sort();
}

const indonesianKeys = collectDeepKeys(indonesianDictionary as any);
const englishKeys = collectDeepKeys(englishDictionary as any);

assert.deepStrictEqual(indonesianKeys, englishKeys, 'Key structure between ID and EN dictionaries must match 100%');
console.log(`[PASS] Key parity verified: ${indonesianKeys.length} matching keys across both dictionaries.`);

// 2. Test Language Switcher
console.log('\n[2] Testing Language Switcher (setActiveLanguage / getActiveLanguage)...');
setActiveLanguage('id');
assert.strictEqual(getActiveLanguage(), 'id');
assert.strictEqual(getDictionary().languageCode, 'id');

setActiveLanguage('en');
assert.strictEqual(getActiveLanguage(), 'en');
assert.strictEqual(getDictionary().languageCode, 'en');
console.log('[PASS] Language switching operates as expected.');

// 3. Test Formatter Outputs in Indonesian and English
console.log('\n[3] Testing Formatter Outputs for both languages...');

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-1', name: 'BCA Prioritas', currency: 'IDR', balance: 5000000 },
  { id: 'acc-2', name: 'Cash Dompet', currency: 'IDR', balance: 250000 },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-1', name: 'Makanan & Minuman' },
  { id: 'cat-2', name: 'Transportasi' },
];

const mockSingleRecord: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-1',
    categoryId: 'cat-1',
    amount: -45000,
    note: 'Nasi Goreng Spesial',
    recordDate: new Date().toISOString(),
  },
];

const mockMultipleRecords: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-1',
    categoryId: 'cat-1',
    amount: -25000,
    note: 'Kopi Susu',
    recordDate: new Date().toISOString(),
  },
  {
    accountId: 'acc-2',
    categoryId: 'cat-2',
    amount: -15000,
    note: 'Parkir Gedung',
    recordDate: new Date().toISOString(),
  },
];

// Indonesian Output Checks
setActiveLanguage('id');
const idSingleRecordOutput = formatRecordSuccessMessage(mockSingleRecord, mockAccounts, mockCategories);
assert(idSingleRecordOutput.includes('berhasil dicatat!'), 'ID single record should contain "berhasil dicatat!"');
assert(idSingleRecordOutput.includes('Rp 45.000'), 'ID single record should format currency with Rp and dot');

const idMultipleRecordsOutput = formatRecordSuccessMessage(mockMultipleRecords, mockAccounts, mockCategories);
assert(idMultipleRecordsOutput.includes('2 transaksi* berhasil dicatat!'), 'ID multiple records should show count and success');

const idBalanceOutput = formatBalanceSummaryMessage(mockAccounts);
assert(idBalanceOutput.includes('Saldo Rekening'), 'ID balance should show "Saldo Rekening"');
assert(idBalanceOutput.includes('Total: Rp 5.250.000'), 'ID balance should show correct grand total');

// English Output Checks
setActiveLanguage('en');
const enSingleRecordOutput = formatRecordSuccessMessage(mockSingleRecord, mockAccounts, mockCategories);
assert(enSingleRecordOutput.includes('recorded successfully!'), 'EN single record should contain "recorded successfully!"');
assert(enSingleRecordOutput.includes('Nasi Goreng Spesial'), 'EN single record should retain transaction title');

const enMultipleRecordsOutput = formatRecordSuccessMessage(mockMultipleRecords, mockAccounts, mockCategories);
assert(enMultipleRecordsOutput.includes('2 transactions* recorded successfully!'), 'EN multiple records should show count and success in English');

const enBalanceOutput = formatBalanceSummaryMessage(mockAccounts);
assert(enBalanceOutput.includes('Account Balances'), 'EN balance should show "Account Balances"');
assert(enBalanceOutput.includes('Total: Rp 5,250,000') || enBalanceOutput.includes('Total: Rp 5.250.000'), 'EN balance should show total');

console.log('[PASS] Single and multiple record formatters produce accurate localized strings.');

// 4. Test Budget Summary
console.log('\n[4] Testing Budget Summary Formatter...');
const mockBudgets: WalletBudgetItem[] = [
  {
    id: 'b-1',
    name: 'Jajan Semuanya',
    spentAmount: 81400,
    limitAmount: 700000,
    remainingAmount: 618600,
    currency: 'IDR',
    isClosed: false,
    period: '2026-W37',
  },
  {
    id: 'b-2',
    name: 'Belanja Bulanan',
    spentAmount: 1100000,
    limitAmount: 1000000,
    remainingAmount: -100000,
    isOverspent: true,
    currency: 'IDR',
    isClosed: false,
  },
  {
    id: 'b-3',
    name: 'Makan Lama (2023)',
    spentAmount: 50000,
    limitAmount: 500000,
    currency: 'IDR',
    isClosed: true,
  },
];

setActiveLanguage('id');
const idBudgetOutput = formatBudgetSummaryMessage(mockBudgets);
assert(idBudgetOutput.includes('Status Anggaran'), 'ID budget output contains "Status Anggaran"');
assert(idBudgetOutput.includes('Jajan Semuanya'), 'ID budget output contains active budget name');
assert(idBudgetOutput.includes('Rp 81.400 / Rp 700.000'), 'ID budget output shows formatted spent and limit');
assert(idBudgetOutput.includes('sisa Rp 618.600'), 'ID budget output shows correct remaining amount');
assert(idBudgetOutput.includes('Belanja Bulanan'), 'ID budget output contains overspent budget');
assert(idBudgetOutput.includes('lebih Rp 100.000'), 'ID budget output shows overspent warning and amount');
assert(!idBudgetOutput.includes('Makan Lama (2023)'), 'ID budget output excludes closed budgets');

setActiveLanguage('en');
const enBudgetOutput = formatBudgetSummaryMessage(mockBudgets);
assert(enBudgetOutput.includes('Budget Status'), 'EN budget output contains "Budget Status"');
assert(enBudgetOutput.includes('left'), 'EN budget output contains "left"');
assert(enBudgetOutput.includes('over'), 'EN budget output contains "over"');
assert(!enBudgetOutput.includes('Makan Lama (2023)'), 'EN budget output excludes closed budgets');

// Test empty state when all budgets are closed
const allClosedBudgets: WalletBudgetItem[] = [
  { id: 'b-closed', name: 'Closed Budget', spentAmount: 0, limitAmount: 100000, isClosed: true },
];
const emptyClosedOutput = formatBudgetSummaryMessage(allClosedBudgets);
assert(emptyClosedOutput.includes(englishDictionary.budget.emptyState), 'Empty state when all budgets are closed');
console.log('[PASS] Budget status formatter produces localized output, excludes closed budgets, and formats overspent states.');

// 5. Test Pending Email Transaction & Confirmation Messages
console.log('\n[5] Testing Pending Email Transaction & Confirmation Messages...');
const mockPendingItem: PendingTransactionItem = {
  ticketId: 101,
  sourceType: 'EMAIL',
  bankDisplayName: 'BCA',
  accountNameHint: 'BCA Prioritas',
  counterParty: 'Starbucks Coffee',
  amount: -65000,
  transactionType: 'EXPENSE',
  matchedAccountId: 'acc-1',
  matchedCategoryName: 'Makanan & Minuman',
  note: 'Pembayaran QRIS Starbucks',
  recordDate: new Date().toISOString(),
  referenceNumber: 'REF123456789',
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86400000),
};

setActiveLanguage('id');
const idEmailNotification = formatPendingEmailTransactionNotification(mockPendingItem, 1);
assert(idEmailNotification.includes('Transaksi Email Baru Terdeteksi (#101)'), 'ID email notification header');
assert(idEmailNotification.includes('Balas *Ya* atau *Catat*'), 'ID reply instructions');

const idConfirmationSuccess = formatPendingConfirmationSuccess(mockPendingItem);
assert(idConfirmationSuccess.includes('Transaksi Dicatat ke Wallet!'), 'ID confirmation receipt');

const idCancellation = formatPendingCancellationMessage(mockPendingItem);
assert(idCancellation.includes('Dibatalkan'), 'ID cancellation');

setActiveLanguage('en');
const enEmailNotification = formatPendingEmailTransactionNotification(mockPendingItem, 1);
assert(enEmailNotification.includes('New Email Transaction Detected (#101)'), 'EN email notification header');
assert(enEmailNotification.includes('Reply *Yes* or *Record*'), 'EN reply instructions');

const enConfirmationSuccess = formatPendingConfirmationSuccess(mockPendingItem);
assert(enConfirmationSuccess.includes('Transaction Recorded to Wallet!'), 'EN confirmation receipt');

const enCancellation = formatPendingCancellationMessage(mockPendingItem);
assert(enCancellation.includes('Cancelled'), 'EN cancellation');

console.log('[PASS] Email pending notifications and confirmation receipts format correctly in both languages.');

// 6. Test Error Formatter
console.log('\n[6] Testing Error Formatter...');
setActiveLanguage('id');
const idBusyError = formatErrorMessageForHuman(new Error('503 Service Unavailable'));
assert(idBusyError.includes('Layanan AI lagi ramai'), 'ID 503 error message');

setActiveLanguage('en');
const enBusyError = formatErrorMessageForHuman(new Error('503 Service Unavailable'));
assert(enBusyError.includes('AI service is currently busy'), 'EN 503 error message');
console.log('[PASS] Error messages localize properly.');

// 7. Test Fast-Path Intent Detector (Bilingual commands)
console.log('\n[7] Testing Fast-Path Intent Detector in Indonesian & English...');
// Balance
assert.strictEqual(detectFastPathAction('saldo'), 'CHECK_BALANCE');
assert.strictEqual(detectFastPathAction('cek saldo'), 'CHECK_BALANCE');
assert.strictEqual(detectFastPathAction('balance'), 'CHECK_BALANCE');
assert.strictEqual(detectFastPathAction('check balance'), 'CHECK_BALANCE');
assert.strictEqual(detectFastPathAction('my balance'), 'CHECK_BALANCE');

// Budget
assert.strictEqual(detectFastPathAction('budget'), 'CHECK_BUDGET');
assert.strictEqual(detectFastPathAction('cek budget'), 'CHECK_BUDGET');
assert.strictEqual(detectFastPathAction('check budget'), 'CHECK_BUDGET');
assert.strictEqual(detectFastPathAction('budget status'), 'CHECK_BUDGET');

// Help
assert.strictEqual(detectFastPathAction('halo'), 'HELP_MENU');
assert.strictEqual(detectFastPathAction('help'), 'HELP_MENU');
assert.strictEqual(detectFastPathAction('menu'), 'HELP_MENU');
assert.strictEqual(detectFastPathAction('guide'), 'HELP_MENU');

// Confirmation
assert.deepStrictEqual(detectPendingConfirmationAction('ya'), { actionType: 'CONFIRM', targetScope: 'LATEST' });
assert.deepStrictEqual(detectPendingConfirmationAction('yes'), { actionType: 'CONFIRM', targetScope: 'LATEST' });
assert.deepStrictEqual(detectPendingConfirmationAction('confirm'), { actionType: 'CONFIRM', targetScope: 'LATEST' });
assert.deepStrictEqual(detectPendingConfirmationAction('yes all'), { actionType: 'CONFIRM', targetScope: 'ALL' });
assert.deepStrictEqual(detectPendingConfirmationAction('cancel all'), { actionType: 'REJECT', targetScope: 'ALL' });
assert.deepStrictEqual(detectPendingConfirmationAction('cancel 101'), { actionType: 'REJECT', targetScope: 101 });
assert.deepStrictEqual(detectPendingConfirmationAction('yes 101'), { actionType: 'CONFIRM', targetScope: 101 });

console.log('[PASS] Fast-path intent detection handles all Indonesian & English command phrases.');

// 8. Test Account-Aware Multi-Currency & Decimal Precision Formatting
console.log('\n[8] Testing Account-Aware Multi-Currency & Decimal Precision Formatting...');

// A. Unit tests for formatCurrencyAmount
assert.strictEqual(formatCurrencyAmount(-5.75, 'USD', 'en'), '$5.75', 'USD decimal cents formatting');
assert.strictEqual(formatCurrencyAmount(-5, 'USD', 'en'), '$5.00', 'USD whole number with 2 decimals');
assert.strictEqual(formatCurrencyAmount(-35000, 'IDR', 'id'), 'Rp 35.000', 'IDR zero-decimal formatting');
assert.strictEqual(formatCurrencyAmount(-12.5, 'EUR', 'en'), '€12.50', 'EUR decimal cents formatting');
assert.strictEqual(formatCurrencyAmount(-1000, 'JPY', 'en'), '¥1,000', 'JPY zero-decimal formatting');
assert.strictEqual(formatCurrencyAmount(-8.2, 'GBP', 'en'), '£8.20', 'GBP decimal formatting');

// B. Account-aware single record formatting
const mockUsAccounts: WalletAccountItem[] = [
  { id: 'acc-chase', name: 'Chase Checking', currency: 'USD' },
  { id: 'acc-bca', name: 'BCA Prioritas', currency: 'IDR' },
];

const mockUsdRecord: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-chase',
    categoryId: 'cat-1',
    amount: -5.75,
    note: 'Pizza Slice',
    recordDate: new Date().toISOString(),
  },
];

const usdReceiptOutput = formatRecordSuccessMessage(mockUsdRecord, mockUsAccounts, mockCategories, 'en');
assert(usdReceiptOutput.includes('$5.75'), `Expected receipt to display '$5.75', got: ${usdReceiptOutput}`);
assert(usdReceiptOutput.includes('Chase Checking'), 'Expected receipt to mention Chase Checking');

// C. Multi-currency batch formatting
const mockMultiCurrencyBatch: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-chase',
    amount: -15.5,
    note: 'Uber Ride',
    recordDate: new Date().toISOString(),
  },
  {
    accountId: 'acc-bca',
    amount: -45000,
    note: 'Lunch Warteg',
    recordDate: new Date().toISOString(),
  },
];

const batchReceiptOutput = formatRecordSuccessMessage(mockMultiCurrencyBatch, mockUsAccounts, mockCategories, 'en');
assert(batchReceiptOutput.includes('$15.50'), `Expected batch receipt to display '$15.50', got: ${batchReceiptOutput}`);
assert(batchReceiptOutput.includes('Rp 45'), `Expected batch receipt to display 'Rp 45,000' or 'Rp 45.000', got: ${batchReceiptOutput}`);

// D. Timezone adaptation test
const originalTimezone = process.env.APP_TIMEZONE;
process.env.APP_TIMEZONE = 'America/New_York';
const nyReceiptOutput = formatRecordSuccessMessage(mockUsdRecord, mockUsAccounts, mockCategories, 'en');
assert(nyReceiptOutput.includes('EDT') || nyReceiptOutput.includes('EST') || nyReceiptOutput.includes('GMT-4') || nyReceiptOutput.includes('UTC-4'), 'Expected NY timezone receipt to include EDT/EST abbreviation');
process.env.APP_TIMEZONE = originalTimezone;

console.log('[PASS] Multi-currency account resolution and timezone adaptation operate accurately.');

console.log('\n--- Sample English USD Receipt Output ---');
console.log(usdReceiptOutput);
console.log('\n--- Sample Multi-Currency Batch Receipt Output ---');
console.log(batchReceiptOutput);

console.log('\n[SUCCESS] ALL RESPONSE DICTIONARY & MULTI-CURRENCY TESTS PASSED!');

