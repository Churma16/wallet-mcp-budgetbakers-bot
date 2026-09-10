import assert from 'node:assert';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { CreateRecordInputPayload, WalletAccountItem } from '../src/types/walletTypes.js';

console.log('[TEST] Starting Record Validator Account Resolution Tests...');

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

{
  const result = validate('missing-account');
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.deepEqual(result.accountResolutionIssues, [
    {
      recordIndex: 0,
      accountHint: 'missing-account',
      reason: 'UNRESOLVED',
      candidates: [],
    },
  ]);
}

{
  const result = validate('BCA');
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues.length, 1);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-bca-personal', 'acc-bca-business']
  );
}

{
  const duplicateNameAccounts: WalletAccountItem[] = [
    { id: 'acc-cash-primary', name: 'Cash' },
    { id: 'acc-cash-secondary', name: 'Cash' },
  ];
  const result = validate('cash', duplicateNameAccounts);
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-cash-primary', 'acc-cash-secondary']
  );
}

{
  const numericCollisionAccounts: WalletAccountItem[] = [
    { id: 'acc-one', name: 'One' },
    { id: 'acc-index-two', name: 'Index Two' },
    { id: 'acc-bank-match', name: 'Bank Match', bankAccountNumber: '99880002' },
  ];
  const result = validate('0002', numericCollisionAccounts);
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-index-two', 'acc-bank-match']
  );
}

{
  const partialNameBankCollisionAccounts: WalletAccountItem[] = [
    { id: 'acc-name-bca', name: 'BCA' },
    { id: 'acc-bank-1234', name: 'Savings', bankAccountNumber: '99881234' },
  ];
  const result = validate('BCA 1234', partialNameBankCollisionAccounts);
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-name-bca', 'acc-bank-1234']
  );
}

{
  const numericNameCollisionAccounts: WalletAccountItem[] = [
    { id: 'acc-index-one', name: 'Primary' },
    { id: 'acc-named-one', name: '1' },
  ];
  const result = validate('1', numericNameCollisionAccounts);
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-index-one', 'acc-named-one']
  );
}

{
  const result = validate('acc-bca-personal');
  assert.equal(result.isValid, true);
  assert.equal(result.sanitizedRecords[0].accountId, 'acc-bca-personal');
  assert.equal(result.accountResolutionIssues.length, 0);
}

{
  const result = validate('bca personal');
  assert.equal(result.isValid, true);
  assert.equal(result.sanitizedRecords[0].accountId, 'acc-bca-personal');
}

{
  const result = validate('3');
  assert.equal(result.isValid, true);
  assert.equal(result.sanitizedRecords[0].accountId, 'acc-cash');
}

{
  const result = validate('Personal');
  assert.equal(result.isValid, true);
  assert.equal(result.sanitizedRecords[0].accountId, 'acc-bca-personal');
}

{
  const result = validate('4567890');
  assert.equal(result.isValid, true);
  assert.equal(result.sanitizedRecords[0].accountId, 'acc-bca-personal');
}

{
  const result = validate('67890');
  assert.equal(result.isValid, false);
  assert.equal(result.sanitizedRecords.length, 0);
  assert.equal(result.accountResolutionIssues[0].reason, 'AMBIGUOUS');
  assert.deepEqual(
    result.accountResolutionIssues[0].candidates.map(candidate => candidate.id),
    ['acc-bca-personal', 'acc-bca-business']
  );
}

console.log('[PASS] Record validator account resolution tests passed.');
