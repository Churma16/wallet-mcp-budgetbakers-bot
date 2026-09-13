import { describe, expect, it } from 'vitest';
import {
  evaluateEmailThroughGateOne,
  extractSenderDomain,
} from '../src/utils/emailGateEvaluator.js';

const NOW = new Date('2026-09-13T06:00:00.000Z');
const STARTUP_CUTOFF = new Date(NOW.getTime() - 10 * 60 * 1000);
const TRANSACTION_SUBJECT = 'Notifikasi Transaksi Livin by Mandiri: Debit Rekening';
const TRANSACTION_BODY = 'Total Debet: Rp 50.000';

const malformedSenderCases = [
  ['double opening angle bracket', '<<noreply@bankmandiri.co.id>'],
  ['multiple angle-bracket address groups', 'x<evil@attacker.com><noreply@bankmandiri.co.id>'],
  ['unbalanced opening angle bracket', '<noreply@bankmandiri.co.id'],
  ['unbalanced closing angle bracket', 'noreply@bankmandiri.co.id>'],
] as const;

describe('email sender domain validation', () => {
  it.each(malformedSenderCases)('%s does not produce a sender domain', (_caseName, senderValue) => {
    expect(extractSenderDomain(senderValue)).toBeUndefined();
  });

  it.each(malformedSenderCases)('%s fails Gate 1 sender validation', (_caseName, senderValue) => {
    const gateResult = evaluateEmailThroughGateOne(
      TRANSACTION_SUBJECT,
      senderValue,
      TRANSACTION_BODY,
      NOW,
      STARTUP_CUTOFF,
      new Set<string>()
    );

    expect(gateResult.passed).toBe(false);
    expect(gateResult.reason).toBe('UNMATCHED_SENDER_DOMAIN');
  });

  it('parses a legitimate display-name wrapped sender', () => {
    expect(extractSenderDomain('Livin by Mandiri <noreply@bankmandiri.co.id>')).toBe(
      'bankmandiri.co.id'
    );
  });
});
