import { describe, it, expect } from 'vitest';
import type { WalletRecordItem } from '../src/wallet/types.js';
import type { BankMutationItem } from '../src/core/reconciliation/types.js';
import {
  compareMutationsWithWalletRecords,
  getCalendarDayDifference,
} from '../src/core/reconciliation/comparisonEngine.js';
import {
  applyReconciliationRules,
  jagoGopayRule,
} from '../src/core/reconciliation/rules/jagoGopayRules.js';
import { parseStatementExtractionResponse } from '../src/brain/parsers/statementParser.js';
import { formatReconciliationCard } from '../src/core/reconciliation/reconciliationCardFormatter.js';
import { extractReconciliationAccountHint, isReconciliationCommand } from '../src/core/handlers/reconciliationHandler.js';

describe('Reconciliation Engine - Distance Priority & Exact Matching', () => {
  it('calculates calendar day difference accurately', () => {
    expect(getCalendarDayDifference('2026-11-06T12:00:00Z', '2026-11-06')).toBe(0);
    expect(getCalendarDayDifference('2026-11-05T23:30:00Z', '2026-11-06')).toBe(1);
    expect(getCalendarDayDifference('2026-11-04', '2026-11-06')).toBe(2);
  });

  it('correctly matches exact amount on the exact same day (delta 0)', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 54500,
        direction: 'DEBIT',
        counterParty: 'Grab',
      },
    ];

    const records: WalletRecordItem[] = [
      {
        id: 'rec-1',
        accountId: 'acc-jago',
        amount: -54500,
        currency: 'IDR',
        recordDate: '2026-11-06T10:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(1);
    expect(result.matched[0].walletRecord.id).toBe('rec-1');
    expect(result.missing.length).toBe(0);
    expect(result.wrongAccount.length).toBe(0);
  });

  it('prioritizes exact same day (delta 0) over adjacent day (delta 1) in greedy pairing', () => {
    // Two mutations with the same amount: one on Nov 5, one on Nov 6
    const mutations: BankMutationItem[] = [
      {
        id: 'm-nov5',
        date: '2026-11-05',
        amount: 65800,
        direction: 'DEBIT',
        counterParty: 'Grab Nov 5',
      },
      {
        id: 'm-nov6',
        date: '2026-11-06',
        amount: 65800,
        direction: 'DEBIT',
        counterParty: 'Grab Nov 6',
      },
    ];

    // Two Wallet records: one on Nov 5, one on Nov 6
    const records: WalletRecordItem[] = [
      {
        id: 'rec-nov6',
        accountId: 'acc-jago',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-06T15:00:00Z',
        recordType: 'expense',
      },
      {
        id: 'rec-nov5',
        accountId: 'acc-jago',
        amount: -65800,
        currency: 'IDR',
        recordDate: '2026-11-05T09:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(2);
    // Nov 5 mutation must pair with Nov 5 record
    const matchNov5 = result.matched.find(m => m.mutation.id === 'm-nov5');
    expect(matchNov5?.walletRecord.id).toBe('rec-nov5');

    // Nov 6 mutation must pair with Nov 6 record
    const matchNov6 = result.matched.find(m => m.mutation.id === 'm-nov6');
    expect(matchNov6?.walletRecord.id).toBe('rec-nov6');
  });

  it('detects cross-wallet mismatch when record exists under another account', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm-gojez',
        date: '2026-11-06',
        amount: 27000,
        direction: 'DEBIT',
        counterParty: 'Gojez Store',
      },
    ];

    // Recorded under BCA instead of Jago
    const records: WalletRecordItem[] = [
      {
        id: 'rec-bca',
        accountId: 'acc-bca',
        accountName: 'BCA Utama',
        amount: -27000,
        currency: 'IDR',
        recordDate: '2026-11-06T14:00:00Z',
        recordType: 'expense',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      records
    );

    expect(result.matched.length).toBe(0);
    expect(result.wrongAccount.length).toBe(1);
    expect(result.wrongAccount[0].actualAccountName).toBe('BCA Utama');
    expect(result.wrongAccount[0].walletRecord.id).toBe('rec-bca');
    expect(result.missing.length).toBe(0);
  });

  it('flags unrecorded transactions as missing', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm-william',
        date: '2026-11-04',
        amount: 15000,
        direction: 'DEBIT',
        counterParty: 'William Gunawan',
      },
    ];

    const result = compareMutationsWithWalletRecords(
      mutations,
      'acc-jago',
      'Bank Jago',
      [] // empty wallet
    );

    expect(result.matched.length).toBe(0);
    expect(result.wrongAccount.length).toBe(0);
    expect(result.missing.length).toBe(1);
    expect(result.missing[0].mutation.counterParty).toBe('William Gunawan');
  });
});

describe('Reconciliation Custom Rules - Bank Jago x GoPay', () => {
  it('transforms GoPay mutation into Gojek via Jago for Bank Jago target wallet', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 58500,
        direction: 'DEBIT',
        counterParty: 'GoPay',
        note: 'Outgoing',
      },
      {
        id: 'm2',
        date: '2026-11-06',
        amount: 14000,
        direction: 'DEBIT',
        counterParty: 'Grab',
      },
    ];

    const enriched = applyReconciliationRules('Kantong Jago Utama', mutations);

    expect(enriched[0].counterParty).toBe('Gojek via Jago');
    expect(enriched[0].note).toBe('Gojek via Jago');
    expect(enriched[1].counterParty).toBe('Grab'); // untouched
  });

  it('leaves GoPay mutation untouched if target wallet is not Jago', () => {
    const mutations: BankMutationItem[] = [
      {
        id: 'm1',
        date: '2026-11-06',
        amount: 58500,
        direction: 'DEBIT',
        counterParty: 'GoPay',
      },
    ];

    const enriched = applyReconciliationRules('BCA Digital', mutations);
    expect(enriched[0].counterParty).toBe('GoPay');
  });
});

describe('Statement Vision Parser - Extraction & Deduplication', () => {
  it('parses structured JSON and dedupes overlapping screenshots', () => {
    const rawLlmOutput = `
\`\`\`json
{
  "mutations": [
    {
      "date": "2026-11-06",
      "amount": "-Rp58.500",
      "direction": "DEBIT",
      "counterParty": "GoPay",
      "note": "Outgoing"
    },
    {
      "date": "2026-11-06",
      "amount": 58500,
      "direction": "DEBIT",
      "counterParty": "GoPay",
      "note": "Outgoing"
    },
    {
      "date": "2026-11-04",
      "amount": "- Rp 38.000,00",
      "direction": "DEBIT",
      "counterParty": "QR Bayar ke BLIBLI.COM"
    }
  ]
}
\`\`\`
    `;

    const parsed = parseStatementExtractionResponse(rawLlmOutput);
    expect(parsed.length).toBe(2); // The duplicate 58500 row is filtered out!
    expect(parsed[0].amount).toBe(58500);
    expect(parsed[0].direction).toBe('DEBIT');
    expect(parsed[1].amount).toBe(38000);
    expect(parsed[1].counterParty).toBe('QR Bayar ke BLIBLI.COM');
  });
});

describe('Reconciliation Card Formatter & Command Parser', () => {
  it('detects reconciliation commands and extracts account hints', () => {
    expect(isReconciliationCommand('/reconciliation jago')).toBe(true);
    expect(isReconciliationCommand('/reconciliation')).toBe(true);
    expect(isReconciliationCommand('reconciliation jago')).toBe(false);

    expect(extractReconciliationAccountHint('/reconciliation jago')).toBe('jago');
    expect(extractReconciliationAccountHint('/reconciliation Blu BCA Digital')).toBe('Blu BCA Digital');
    expect(extractReconciliationAccountHint('/reconciliation')).toBe('');
  });

  it('formats clean, mobile-optimized card response with tickets', () => {
    const comparisonResult = {
      targetAccountId: 'acc-jago',
      targetAccountName: 'Bank Jago',
      dateRange: { startDate: '2026-11-04', endDate: '2026-11-06' },
      totalMutations: 3,
      matched: [
        {
          mutation: { id: 'm1', date: '2026-11-06', amount: 54500, direction: 'DEBIT' as const, counterParty: 'Grab' },
          walletRecord: { id: 'r1', accountId: 'acc-jago', amount: -54500, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
        },
      ],
      wrongAccount: [
        {
          mutation: { id: 'm2', date: '2026-11-06', amount: 27000, direction: 'DEBIT' as const, counterParty: 'Gojez Store' },
          walletRecord: { id: 'r2', accountId: 'acc-bca', amount: -27000, currency: 'IDR', recordDate: '2026-11-06', recordType: 'expense' as const },
          actualAccountName: 'BCA',
        },
      ],
      missing: [
        {
          mutation: { id: 'm3', date: '2026-11-04', amount: 15000, direction: 'DEBIT' as const, counterParty: 'William Gunawan' },
          note: 'William Gunawan',
        },
      ],
      extraInWallet: [],
    };

    const card = formatReconciliationCard(comparisonResult, {
      ticketReferences: [{ mutationId: 'm3', ticketId: 101 }],
    });

    expect(card).toContain('Hasil Rekonsiliasi: Bank Jago');
    expect(card).toContain('Sudah Sesuai (1)');
    expect(card).toContain('Salah Wallet / Akun (1)');
    expect(card).toContain('Terlewat / Belum Tercatat (1)');
    expect(card).toContain('[Tiket #101]');
    expect(card).toContain('Balas <b>Ya 101</b>');
  });
});
