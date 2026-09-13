import { beforeEach, describe, expect, it } from 'vitest';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  formatAccountSelectionCancellation,
  formatAccountSelectionProcessing,
  formatAccountSelectionPrompt,
  formatAccountSelectionRetry,
  formatAccountSelectionUnknownDismissal,
  formatAccountSelectionUnknownOutcome,
} from '../src/utils/accountClarificationFormatter.js';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: 41,
    channel: 'whatsapp',
    chatIdentifier: '+6281234567890',
    senderIdentifier: 'coverage-user',
    records: [{
      accountId: '',
      amount: -12500,
      recordDate: '2026-09-13',
      categoryId: 'food-id',
      note: 'Lunch',
    }],
    pendingRecordIndex: 0,
    candidateAccounts: [
      { id: 'a1', name: 'BCA', currency: 'idr' },
      { id: 'a2', name: 'Cash', currency: 'IDR' },
    ],
    createdAt: new Date('2026-09-13T00:00:00.000Z'),
    expiresAt: new Date('2026-09-13T01:00:00.000Z'),
    ...overrides,
  } as any;
}

const categories = [
  { id: 'food-id', name: 'Food' },
  { id: 'transport-id', name: 'Transport' },
] as any;

describe('PR #155 account clarification formatter changed branches', () => {
  beforeEach(() => setActiveLanguage('id'));

  it('covers Indonesian prompt with invalid selection, batch line, candidate currency suffixes, and exact category id', () => {
    const value = formatAccountSelectionPrompt(
      draft({
        records: [
          { accountId: '', amount: -12500, recordDate: '2026-09-13', categoryId: 'food-id', note: 'Lunch' },
          { accountId: '', amount: -5000, recordDate: '2026-09-13', categoryId: 'transport-id', note: 'Bus' },
        ],
        candidateAccounts: [
          { id: 'a1', name: 'BCA', currency: 'idr' },
          { id: 'a2', name: 'Cash' },
        ],
      }),
      categories,
      'rekening-yang-sangat-panjang-'.repeat(5)
    );

    expect(value).toContain('Pilihan akun');
    expect(value).toContain('Item 1 dari 2');
    expect(value).toContain('1. BCA (IDR)');
    expect(value).toContain('2. Cash');
    expect(value).toContain('Kategori:* Food');
    expect(value).toContain('batal #41');
  });

  it('covers English prompt, exact category name, counterparty description, and mixed-currency amount fallback', () => {
    setActiveLanguage('en');
    const value = formatAccountSelectionPrompt(
      draft({
        records: [{
          accountId: '',
          amount: 1234.5,
          recordDate: '2026-09-13',
          categoryId: 'transport',
          counterParty: 'Metro',
        }],
        candidateAccounts: [
          { id: 'a1', name: 'Checking', currency: 'USD' },
          { id: 'a2', name: 'Cash', currency: 'IDR' },
        ],
      }),
      categories
    );

    expect(value).toContain('Choose Transaction Account');
    expect(value).toContain('Note:* Metro');
    expect(value).toContain('Category:* Transport');
    expect(value).toContain('currency follows the selected account');
    expect(value).not.toContain('Item 1 of');
    expect(value).toContain('cancel #41');
  });

  it('covers numeric category lookup, missing category fallback, and shared candidate currency resolution', () => {
    const indexed = formatAccountSelectionPrompt(
      draft({
        records: [{ accountId: '', amount: -5000, recordDate: '2026-09-13', categoryId: '2' }],
      }),
      categories
    );
    expect(indexed).toContain('Kategori:* Transport');
    expect(indexed).toContain('Catatan:* Transaksi');
    expect(indexed).toContain('Rp');

    const missing = formatAccountSelectionPrompt(
      draft({
        records: [{ accountId: '', amount: 'not-a-number', recordDate: '2026-09-13' }],
        candidateAccounts: [],
      }),
      categories
    );
    expect(missing).toContain('mata uang mengikuti akun yang dipilih');
    expect(missing).toContain('0');
  });

  it('covers explicit record currency even when candidate account currencies are incomplete', () => {
    const value = formatAccountSelectionPrompt(
      draft({
        records: [{
          accountId: '',
          amount: -7500,
          currency: 'IDR',
          recordDate: '2026-09-13',
          categoryId: 'unknown-category',
        }],
        candidateAccounts: [
          { id: 'a1', name: 'BCA', currency: 'IDR' },
          { id: 'a2', name: 'Mystery' },
        ],
      }),
      categories
    );
    expect(value).toContain('unknown-category');
    expect(value).toContain('BCA (IDR)');
    expect(value).toContain('2. Mystery');
  });

  it('covers UNKNOWN outcome note/account-hint precedence and unnumbered single-item protocol in both languages', () => {
    const withHints = draft({ accountHint: 'Primary Card' });
    const id = formatAccountSelectionUnknownOutcome(withHints, 1);
    expect(id).toContain('Lunch (#41)');
    expect(id).toContain('Akun: Primary Card');
    expect(id).toContain('• *Sudah ada*');
    expect(id).toContain('• *Belum ada*');
    expect(id).not.toContain('Sudah ada #41');

    setActiveLanguage('en');
    const en = formatAccountSelectionUnknownOutcome(withHints, 1);
    expect(en).toContain('Lunch (#41)');
    expect(en).toContain('Account: Primary Card');
    expect(en).toContain('• *Already exists*');
    expect(en).toContain('• *Not there*');
  });

  it('covers UNKNOWN candidate-account and default-label fallbacks plus ticket qualification', () => {
    const candidateFallback = draft({
      records: [{ accountId: '', amount: -9000, recordDate: '2026-09-13', counterParty: 'Store' }],
      candidateAccounts: [{ id: 'a1', name: 'Cash', currency: 'IDR' }],
      accountHint: undefined,
    });
    const candidate = formatAccountSelectionUnknownOutcome(candidateFallback, 2);
    expect(candidate).toContain('Store (#41)');
    expect(candidate).toContain('Akun: Cash');
    expect(candidate).toContain('Sudah ada #41');
    expect(candidate).toContain('Belum ada #41');

    const defaultFallback = draft({
      records: [{ accountId: '', amount: -9000, recordDate: '2026-09-13' }],
      candidateAccounts: [],
      accountHint: undefined,
    });
    expect(formatAccountSelectionUnknownOutcome(defaultFallback)).toContain('Akun: Akun');

    setActiveLanguage('en');
    expect(formatAccountSelectionUnknownOutcome(defaultFallback)).toContain('Account: Account');
  });

  it('covers localized terminal formatter branches', () => {
    const value = draft();
    expect(formatAccountSelectionCancellation(value)).toContain('dibatalkan');
    expect(formatAccountSelectionProcessing(value)).toContain('sedang diproses');
    expect(formatAccountSelectionRetry(value)).toContain('belum berhasil dicatat');
    expect(formatAccountSelectionUnknownDismissal(value)).toContain('Status transaksi #41 ditutup');

    setActiveLanguage('en');
    expect(formatAccountSelectionCancellation(value)).toContain('cancelled');
    expect(formatAccountSelectionProcessing(value)).toContain('being processed');
    expect(formatAccountSelectionRetry(value)).toContain('was not recorded');
    expect(formatAccountSelectionUnknownDismissal(value)).toContain('Transaction #41 status closed');
  });
});
