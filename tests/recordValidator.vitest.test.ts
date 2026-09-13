import { describe, expect, it } from 'vitest';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { indonesianDictionary, englishDictionary } from '../src/i18n/index.js';
import { CreateRecordInputPayload, WalletAccountItem } from '../src/types/walletTypes.js';

const accounts: WalletAccountItem[] = [
  { id: 'acc-bca-personal', name: 'BCA Personal', bankAccountNumber: '1234567890' },
  { id: 'acc-bca-business', name: 'BCA Business', bankAccountNumber: '9876567890' },
  { id: 'acc-cash', name: 'Cash' },
];

function createRecord(accountId: string): CreateRecordInputPayload {
  return {
    accountId,
    amount: -50_000,
    recordDate: '2026-09-10T12:00:00Z',
  };
}

function validate(accountId: string, accountList: WalletAccountItem[] = accounts) {
  return validateAndSanitizeFinancialRecords([createRecord(accountId)], accountList, []);
}

describe('record validator account resolution', () => {
  it('fails closed for an unresolved account hint', () => {
    const result = validate('missing-account');

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues).toEqual([
      {
        recordIndex: 0,
        accountHint: 'missing-account',
        reason: 'UNRESOLVED',
        candidates: [],
      },
    ]);
  });

  it('fails closed when a partial account name is ambiguous', () => {
    const result = validate('BCA');

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues).toHaveLength(1);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-bca-personal',
      'acc-bca-business',
    ]);
  });

  it('fails closed for duplicate exact account names', () => {
    const duplicateNameAccounts: WalletAccountItem[] = [
      { id: 'acc-cash-primary', name: 'Cash' },
      { id: 'acc-cash-secondary', name: 'Cash' },
    ];
    const result = validate('cash', duplicateNameAccounts);

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-cash-primary',
      'acc-cash-secondary',
    ]);
  });

  it('fails closed when a numeric hint collides between index and account number', () => {
    const numericCollisionAccounts: WalletAccountItem[] = [
      { id: 'acc-one', name: 'One' },
      { id: 'acc-index-two', name: 'Index Two' },
      { id: 'acc-bank-match', name: 'Bank Match', bankAccountNumber: '99880002' },
    ];
    const result = validate('0002', numericCollisionAccounts);

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-index-two',
      'acc-bank-match',
    ]);
  });

  it('fails closed when partial-name and bank-number strategies collide', () => {
    const collisionAccounts: WalletAccountItem[] = [
      { id: 'acc-name-bca', name: 'BCA' },
      { id: 'acc-bank-1234', name: 'Savings', bankAccountNumber: '99881234' },
    ];
    const result = validate('BCA 1234', collisionAccounts);

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-name-bca',
      'acc-bank-1234',
    ]);
  });

  it('fails closed when a numeric hint collides with an account named by that number', () => {
    const numericNameCollisionAccounts: WalletAccountItem[] = [
      { id: 'acc-index-one', name: 'Primary' },
      { id: 'acc-named-one', name: '1' },
    ];
    const result = validate('1', numericNameCollisionAccounts);

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-index-one',
      'acc-named-one',
    ]);
  });

  it('resolves an exact account id', () => {
    const result = validate('acc-bca-personal');

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].accountId).toBe('acc-bca-personal');
    expect(result.accountResolutionIssues).toHaveLength(0);
  });

  it('resolves an exact account name case-insensitively', () => {
    const result = validate('bca personal');

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].accountId).toBe('acc-bca-personal');
  });

  it('resolves a 1-based account index', () => {
    const result = validate('3');

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].accountId).toBe('acc-cash');
  });

  it('resolves a unique partial account name', () => {
    const result = validate('Personal');

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].accountId).toBe('acc-bca-personal');
  });

  it('resolves a unique bank-account-number suffix', () => {
    const result = validate('4567890');

    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].accountId).toBe('acc-bca-personal');
  });

  it('fails closed when a bank-account-number suffix matches multiple accounts', () => {
    const result = validate('67890');

    expect(result.isValid).toBe(false);
    expect(result.sanitizedRecords).toHaveLength(0);
    expect(result.accountResolutionIssues[0].reason).toBe('AMBIGUOUS');
    expect(result.accountResolutionIssues[0].candidates.map(candidate => candidate.id)).toEqual([
      'acc-bca-personal',
      'acc-bca-business',
    ]);
  });

  it('formats Indonesian account-resolution errors including empty candidates', () => {
    const unresolved = indonesianDictionary.errors.accountResolutionUnresolved(1, 'Tidak Ada');
    expect(unresolved).toContain('Transaksi #1');
    expect(unresolved).toContain('Tidak Ada');

    const ambiguous = indonesianDictionary.errors.accountResolutionAmbiguous(2, 'BCA', ['BCA Personal', 'BCA Business']);
    expect(ambiguous).toContain('Kandidat: BCA Personal, BCA Business');

    const ambiguousWithoutCandidates = indonesianDictionary.errors.accountResolutionAmbiguous(3, '', []);
    expect(ambiguousWithoutCandidates).toContain('(kosong)');
    expect(ambiguousWithoutCandidates).toContain('tidak dapat dipilih secara aman');
    expect(indonesianDictionary.errors.accountResolutionFallback).toContain('tidak dapat ditentukan secara aman');
  });

  it('formats English account-resolution errors including empty candidates', () => {
    const unresolved = englishDictionary.errors.accountResolutionUnresolved(1, 'Missing');
    expect(unresolved).toContain('Transaction #1');
    expect(unresolved).toContain('Missing');

    const ambiguous = englishDictionary.errors.accountResolutionAmbiguous(2, 'BCA', ['BCA Personal', 'BCA Business']);
    expect(ambiguous).toContain('Candidates: BCA Personal, BCA Business');

    const ambiguousWithoutCandidates = englishDictionary.errors.accountResolutionAmbiguous(3, '', []);
    expect(ambiguousWithoutCandidates).toContain('(empty)');
    expect(ambiguousWithoutCandidates).toContain('cannot be selected safely');
    expect(englishDictionary.errors.accountResolutionFallback).toContain('could not be determined safely');
  });
});
