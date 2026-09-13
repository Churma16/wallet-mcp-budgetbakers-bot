import { describe, expect, it } from 'vitest';
import {
  englishDictionary,
  indonesianDictionary,
} from '../src/i18n/index.js';

function baseEmailParams(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: 41,
    typeIcon: '📩',
    typeLabel: 'Payment',
    formattedAmount: 'Rp 25.000',
    formattedTime: '13 Sep 2026',
    bankDisplayName: 'BCA',
    totalPendingCount: 1,
    ...overrides,
  } as any;
}

describe('PR #155 response dictionary coverage', () => {
  it.each([
    ['id', indonesianDictionary],
    ['en', englishDictionary],
  ] as const)('covers all new status, uncertainty, and reconciliation functions in %s', (_language, dictionary) => {
    expect(dictionary.status.needsCheckHeader(2)).toContain('2');
    expect(dictionary.status.waitingConfirmationHeader(3)).toContain('3');
    expect(dictionary.status.waitingAccountHeader(4)).toContain('4');
    expect(dictionary.status.header.length).toBeGreaterThan(0);
    expect(dictionary.status.emptyAttention.length).toBeGreaterThan(0);
    expect(dictionary.status.noOtherTransactionsWaiting.length).toBeGreaterThan(0);

    expect(dictionary.uncertain.title.length).toBeGreaterThan(0);
    expect(dictionary.uncertain.riskWarning.length).toBeGreaterThan(0);
    expect(dictionary.uncertain.actionPromptSingle.length).toBeGreaterThan(0);
    const multiplePrompt = dictionary.uncertain.actionPromptMultiple([41, 42]);
    expect(multiplePrompt).toContain('#41');
    expect(multiplePrompt).toContain('#42');

    expect(dictionary.reconciliation.recordedWithTicket(41)).toContain('#41');
    expect(dictionary.reconciliation.recordedSingle.length).toBeGreaterThan(0);
    expect(dictionary.reconciliation.absentWithTicket(42)).toContain('#42');
    expect(dictionary.reconciliation.absentSingle.length).toBeGreaterThan(0);
    expect(dictionary.reconciliation.notFoundWithTicket(43)).toContain('#43');
    expect(dictionary.reconciliation.notFoundNone.length).toBeGreaterThan(0);
    const ambiguous = dictionary.reconciliation.ambiguous([44, 45]);
    expect(ambiguous).toContain('#44');
    expect(ambiguous).toContain('#45');
  });

  it.each([
    ['id', indonesianDictionary],
    ['en', englishDictionary],
  ] as const)('covers payment notification branches in %s', (_language, dictionary) => {
    const detailedSingle = dictionary.emailPending.formatNotification(baseEmailParams({
      typeLabel: 'Payment',
      counterParty: 'Kopi Kenangan',
      accountNameHint: 'BCA Utama',
      matchedCategoryName: 'Food',
    }));
    expect(detailedSingle).toContain('Kopi Kenangan');
    expect(detailedSingle).toContain('BCA Utama');
    expect(detailedSingle).toContain('Food');
    expect(detailedSingle).not.toContain('(#41)');

    const categoryFallback = dictionary.emailPending.formatNotification(baseEmailParams({
      typeLabel: 'Payment',
      counterParty: undefined,
      matchedCategoryName: 'Shopping',
      accountNameHint: undefined,
    }));
    expect(categoryFallback).toContain('Shopping');

    const bankFallback = dictionary.emailPending.formatNotification(baseEmailParams({
      typeLabel: 'Payment',
      counterParty: undefined,
      matchedCategoryName: undefined,
      accountNameHint: undefined,
      bankDisplayName: 'Mandiri',
    }));
    expect(bankFallback).toContain('Mandiri');

    const multiple = dictionary.emailPending.formatNotification(baseEmailParams({
      ticketId: 77,
      typeLabel: 'Payment',
      counterParty: 'Merchant',
      totalPendingCount: 3,
    }));
    expect(multiple).toContain('#77');
    expect(multiple).toContain('2');
  });

  it.each([
    ['id', indonesianDictionary],
    ['en', englishDictionary],
  ] as const)('covers transfer notification branches and fallbacks in %s', (_language, dictionary) => {
    const explicitTransfer = dictionary.emailPending.formatNotification(baseEmailParams({
      typeIcon: '🔄',
      typeLabel: 'Transfer',
      accountNameHint: 'Checking',
      destinationAccountNameHint: 'Savings',
      matchedCategoryName: 'Ignored Category',
    }));
    expect(explicitTransfer).toContain('Checking');
    expect(explicitTransfer).toContain('Savings');
    expect(explicitTransfer).not.toContain('Ignored Category');

    const fallbackTransfer = dictionary.emailPending.formatNotification(baseEmailParams({
      typeIcon: '🔄',
      typeLabel: 'Transfer',
      accountNameHint: undefined,
      destinationAccountNameHint: undefined,
      totalPendingCount: 2,
    }));
    expect(fallbackTransfer).toContain('#41');
    expect(fallbackTransfer.length).toBeGreaterThan(0);
  });
});
