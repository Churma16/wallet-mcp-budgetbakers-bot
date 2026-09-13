import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
  formatPendingCancellationMessage,
  formatErrorMessageForHuman,
  formatCurrencyAmount,
} from '../src/utils/humanResponseFormatter.js';
import { detectFastPathAction, detectPendingConfirmationAction } from '../src/utils/fastPathIntentDetector.js';
import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload, WalletBudgetItem } from '../src/types/walletTypes.js';
import { PendingTransactionItem } from '../src/services/pendingTransactionService.js';

function collectDeepKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    keys.push(fullPath);
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof value !== 'function') {
      keys.push(...collectDeepKeys(value as Record<string, unknown>, fullPath));
    }
  }
  return keys.sort();
}

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-1', name: 'BCA Prioritas', currency: 'IDR', balance: 5000000 },
  { id: 'acc-2', name: 'Cash Dompet', currency: 'IDR', balance: 250000 },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-1', name: 'Makanan & Minuman' },
  { id: 'cat-2', name: 'Transportasi' },
];

const fixedNow = new Date('2026-09-13T06:00:00.000Z');
const mockSingleRecord: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-1',
    categoryId: 'cat-1',
    amount: -45000,
    note: 'Nasi Goreng Spesial',
    recordDate: fixedNow.toISOString(),
  },
];

const mockMultipleRecords: CreateRecordInputPayload[] = [
  {
    accountId: 'acc-1',
    categoryId: 'cat-1',
    amount: -25000,
    note: 'Kopi Susu',
    recordDate: fixedNow.toISOString(),
  },
  {
    accountId: 'acc-2',
    categoryId: 'cat-2',
    amount: -15000,
    note: 'Parkir Gedung',
    recordDate: fixedNow.toISOString(),
  },
];

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

const originalTimezone = process.env.APP_TIMEZONE;

describe('response dictionaries and localized formatting', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterAll(() => {
    vi.useRealTimers();
    setActiveLanguage('id');
    if (originalTimezone === undefined) {
      delete process.env.APP_TIMEZONE;
    } else {
      process.env.APP_TIMEZONE = originalTimezone;
    }
  });

  it('keeps Indonesian and English dictionary key structures in 100% parity', () => {
    expect(collectDeepKeys(indonesianDictionary as unknown as Record<string, unknown>)).toEqual(
      collectDeepKeys(englishDictionary as unknown as Record<string, unknown>)
    );
  });

  it('switches the active language and resolved dictionary', () => {
    setActiveLanguage('id');
    expect(getActiveLanguage()).toBe('id');
    expect(getDictionary().languageCode).toBe('id');

    setActiveLanguage('en');
    expect(getActiveLanguage()).toBe('en');
    expect(getDictionary().languageCode).toBe('en');
  });

  it('formats single records, multiple records, and balances in Indonesian and English', () => {
    setActiveLanguage('id');
    const idSingle = formatRecordSuccessMessage(mockSingleRecord, mockAccounts, mockCategories);
    const idMultiple = formatRecordSuccessMessage(mockMultipleRecords, mockAccounts, mockCategories);
    const idBalance = formatBalanceSummaryMessage(mockAccounts);
    expect(idSingle).toContain('berhasil dicatat!');
    expect(idSingle).toContain('Rp 45.000');
    expect(idMultiple).toContain('2 transaksi* berhasil dicatat!');
    expect(idBalance).toContain('Saldo Rekening');
    expect(idBalance).toContain('Total: Rp 5.250.000');

    setActiveLanguage('en');
    const enSingle = formatRecordSuccessMessage(mockSingleRecord, mockAccounts, mockCategories);
    const enMultiple = formatRecordSuccessMessage(mockMultipleRecords, mockAccounts, mockCategories);
    const enBalance = formatBalanceSummaryMessage(mockAccounts);
    expect(enSingle).toContain('recorded successfully!');
    expect(enSingle).toContain('Nasi Goreng Spesial');
    expect(enMultiple).toContain('2 transactions* recorded successfully!');
    expect(enBalance).toContain('Account Balances');
    expect(enBalance.includes('Total: Rp 5,250,000') || enBalance.includes('Total: Rp 5.250.000')).toBe(true);
  });

  it('formats active and overspent budgets while excluding closed budgets', () => {
    setActiveLanguage('id');
    const idOutput = formatBudgetSummaryMessage(mockBudgets);
    expect(idOutput).toContain('Status Anggaran');
    expect(idOutput).toContain('Jajan Semuanya');
    expect(idOutput).toContain('Rp 81.400 / Rp 700.000');
    expect(idOutput).toContain('sisa Rp 618.600');
    expect(idOutput).toContain('Belanja Bulanan');
    expect(idOutput).toContain('lebih Rp 100.000');
    expect(idOutput).not.toContain('Makan Lama (2023)');

    setActiveLanguage('en');
    const enOutput = formatBudgetSummaryMessage(mockBudgets);
    expect(enOutput).toContain('Budget Status');
    expect(enOutput).toContain('left');
    expect(enOutput).toContain('over');
    expect(enOutput).not.toContain('Makan Lama (2023)');

    const allClosedBudgets: WalletBudgetItem[] = [
      { id: 'b-closed', name: 'Closed Budget', spentAmount: 0, limitAmount: 100000, isClosed: true },
    ];
    expect(formatBudgetSummaryMessage(allClosedBudgets)).toContain(englishDictionary.budget.emptyState);
  });

  it('formats pending email notifications, confirmation receipts, and cancellation messages bilingually', () => {
    const pending: PendingTransactionItem = {
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
      recordDate: fixedNow.toISOString(),
      referenceNumber: 'REF123456789',
      createdAt: fixedNow,
      expiresAt: new Date(fixedNow.getTime() + 86400000),
    };

    setActiveLanguage('id');
    expect(formatPendingEmailTransactionNotification(pending, 1)).toContain('Transaksi Email Baru Terdeteksi (#101)');
    expect(formatPendingEmailTransactionNotification(pending, 1)).toContain('Balas *Ya* atau *Catat*');
    expect(formatPendingConfirmationSuccess(pending)).toContain('Transaksi Dicatat ke Wallet!');
    expect(formatPendingCancellationMessage(pending)).toContain('Dibatalkan');

    setActiveLanguage('en');
    expect(formatPendingEmailTransactionNotification(pending, 1)).toContain('New Email Transaction Detected (#101)');
    expect(formatPendingEmailTransactionNotification(pending, 1)).toContain('Reply *Yes* or *Record*');
    expect(formatPendingConfirmationSuccess(pending)).toContain('Transaction Recorded to Wallet!');
    expect(formatPendingCancellationMessage(pending)).toContain('Cancelled');
  });

  it('localizes AI busy errors', () => {
    setActiveLanguage('id');
    expect(formatErrorMessageForHuman(new Error('503 Service Unavailable'))).toContain('Layanan AI lagi ramai');

    setActiveLanguage('en');
    expect(formatErrorMessageForHuman(new Error('503 Service Unavailable'))).toContain('AI service is currently busy');
  });

  it('detects bilingual fast-path and pending-confirmation commands', () => {
    expect(detectFastPathAction('saldo')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('cek saldo')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('balance')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('check balance')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('my balance')).toBe('CHECK_BALANCE');
    expect(detectFastPathAction('budget')).toBe('CHECK_BUDGET');
    expect(detectFastPathAction('cek budget')).toBe('CHECK_BUDGET');
    expect(detectFastPathAction('check budget')).toBe('CHECK_BUDGET');
    expect(detectFastPathAction('budget status')).toBe('CHECK_BUDGET');
    expect(detectFastPathAction('halo')).toBe('HELP_MENU');
    expect(detectFastPathAction('help')).toBe('HELP_MENU');
    expect(detectFastPathAction('menu')).toBe('HELP_MENU');
    expect(detectFastPathAction('guide')).toBe('HELP_MENU');

    expect(detectPendingConfirmationAction('ya')).toEqual({ actionType: 'CONFIRM', targetScope: 'LATEST' });
    expect(detectPendingConfirmationAction('yes')).toEqual({ actionType: 'CONFIRM', targetScope: 'LATEST' });
    expect(detectPendingConfirmationAction('confirm')).toEqual({ actionType: 'CONFIRM', targetScope: 'LATEST' });
    expect(detectPendingConfirmationAction('yes all')).toEqual({ actionType: 'CONFIRM', targetScope: 'ALL' });
    expect(detectPendingConfirmationAction('cancel all')).toEqual({ actionType: 'REJECT', targetScope: 'ALL' });
    expect(detectPendingConfirmationAction('cancel 101')).toEqual({ actionType: 'REJECT', targetScope: 101 });
    expect(detectPendingConfirmationAction('yes 101')).toEqual({ actionType: 'CONFIRM', targetScope: 101 });
  });

  it('formats account-aware currencies, decimal precision, multi-currency batches, and timezone-specific receipts', () => {
    expect(formatCurrencyAmount(-5.75, 'USD', 'en')).toBe('$5.75');
    expect(formatCurrencyAmount(-5, 'USD', 'en')).toBe('$5.00');
    expect(formatCurrencyAmount(-35000, 'IDR', 'id')).toBe('Rp 35.000');
    expect(formatCurrencyAmount(-12.5, 'EUR', 'en')).toBe('€12.50');
    expect(formatCurrencyAmount(-1000, 'JPY', 'en')).toBe('¥1,000');
    expect(formatCurrencyAmount(-8.2, 'GBP', 'en')).toBe('£8.20');

    const usAccounts: WalletAccountItem[] = [
      { id: 'acc-chase', name: 'Chase Checking', currency: 'USD' },
      { id: 'acc-bca', name: 'BCA Prioritas', currency: 'IDR' },
    ];
    const usdRecord: CreateRecordInputPayload[] = [
      {
        accountId: 'acc-chase',
        categoryId: 'cat-1',
        amount: -5.75,
        note: 'Pizza Slice',
        recordDate: fixedNow.toISOString(),
      },
    ];
    const usdReceipt = formatRecordSuccessMessage(usdRecord, usAccounts, mockCategories, 'en');
    expect(usdReceipt).toContain('$5.75');
    expect(usdReceipt).toContain('Chase Checking');

    const batch: CreateRecordInputPayload[] = [
      { accountId: 'acc-chase', amount: -15.5, note: 'Uber Ride', recordDate: fixedNow.toISOString() },
      { accountId: 'acc-bca', amount: -45000, note: 'Lunch Warteg', recordDate: fixedNow.toISOString() },
    ];
    const batchReceipt = formatRecordSuccessMessage(batch, usAccounts, mockCategories, 'en');
    expect(batchReceipt).toContain('$15.50');
    expect(batchReceipt).toContain('Rp 45');

    process.env.APP_TIMEZONE = 'America/New_York';
    const nyReceipt = formatRecordSuccessMessage(usdRecord, usAccounts, mockCategories, 'en');
    expect(
      nyReceipt.includes('EDT') || nyReceipt.includes('EST') || nyReceipt.includes('GMT-4') || nyReceipt.includes('UTC-4')
    ).toBe(true);
  });
});
