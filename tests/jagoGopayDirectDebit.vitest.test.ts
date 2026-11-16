import { describe, it, expect } from 'vitest';
import { resolveEmailExtractedEntities } from '../src/brain/prompts/prompts.js';
import { buildEmailSystemInstruction } from '../src/brain/prompts/promptEmailTemplate.js';
import type { WalletAccountItem, WalletCategoryItem } from '../src/wallet/types.js';
import type { GateEvaluationResult } from '../src/email/types.js';

describe('Bank Jago x GoPay Direct Debit Disambiguation', () => {
  const mockAccounts: WalletAccountItem[] = [
    { id: 'acc-jago-exp', name: 'Jago Expense', currency: 'IDR' },
    { id: 'acc-gopay', name: 'Gopay', currency: 'IDR' },
    { id: 'acc-mandiri', name: 'Mandiri Livin', currency: 'IDR' },
  ];

  const mockCategories: WalletCategoryItem[] = [
    { id: 'cat-transport', name: 'Transportasi', isAssignable: true },
    { id: 'cat-food', name: 'Food & Drinks', isAssignable: true },
    { id: 'cat-savings', name: 'Savings', isAssignable: true },
    { id: 'cat-general', name: 'General', isAssignable: true },
  ];

  describe('resolveEmailExtractedEntities', () => {
    it('corrects a mistaken TRANSFER to EXPENSE when notification is via GoPay direct debit', () => {
      const gateResult: GateEvaluationResult = {
        passed: true,
        candidateAmount: 54000,
        isDirectDebitGateway: true,
        isTransferCandidate: false,
        matchedBankRule: {
          bankKey: 'jago',
          displayName: 'Bank Jago',
          accountNameHint: 'Jago',
          senderDomains: ['jago.com'],
          subjectKeywords: [],
          blacklistKeywords: [],
          bodyRequiredPatterns: [],
          amountPriorityPatterns: [],
          referencePatterns: [],
          transferOrTopupKeywords: [],
        },
      };

      const aiExtracted = {
        isTransaction: true,
        transactionType: 'TRANSFER' as const,
        amount: 54000,
        counterParty: 'GoPay',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'acc-jago-exp',
        destinationAccountNameHint: 'Gopay',
        matchedDestinationAccountId: 'acc-gopay',
        matchedCategoryId: 'cat-savings',
        matchedCategoryName: 'Savings',
        note: 'Top up GoPay sebesar Rp54.000',
        explanation: 'Transaksi sebesar Rp54.000 via GoPay diproses sebagai transfer ke Gopay',
      };

      const resolved = resolveEmailExtractedEntities(
        aiExtracted,
        gateResult,
        'Jago',
        new Date('2026-11-16T03:12:28.808Z'),
        mockAccounts,
        mockCategories
      );

      expect(resolved.transactionType).toBe('EXPENSE');
      expect(resolved.matchedAccountId).toBe('acc-jago-exp');
      expect(resolved.accountNameHint).toBe('Jago Expense');
      expect(resolved.matchedDestinationAccountId).toBeUndefined();
      expect(resolved.destinationAccountNameHint).toBeUndefined();
      expect(resolved.counterParty).toBe('Gojek via Jago');
      expect(resolved.matchedCategoryId).toBe('cat-transport');
      expect(resolved.matchedCategoryName).toBe('Transportasi');
      expect(resolved.note).toBe('Transaksi via GoPay');
    });

    it('preserves legitimate TRANSFER when notification is an explicit top-up or transfer', () => {
      const gateResult: GateEvaluationResult = {
        passed: true,
        candidateAmount: 50000,
        isDirectDebitGateway: false,
        isTransferCandidate: true,
        matchedBankRule: {
          bankKey: 'jago',
          displayName: 'Bank Jago',
          accountNameHint: 'Jago',
          senderDomains: ['jago.com'],
          subjectKeywords: [],
          blacklistKeywords: [],
          bodyRequiredPatterns: [],
          amountPriorityPatterns: [],
          referencePatterns: [],
          transferOrTopupKeywords: ['top up', 'transfer'],
        },
      };

      const aiExtracted = {
        isTransaction: true,
        transactionType: 'TRANSFER' as const,
        amount: 50000,
        counterParty: 'GoPay',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'acc-jago-exp',
        destinationAccountNameHint: 'Gopay',
        matchedDestinationAccountId: 'acc-gopay',
        matchedCategoryId: 'cat-savings',
        matchedCategoryName: 'Savings',
        note: 'Top up GoPay sebesar Rp 50.000',
        explanation: 'Top up ke saldo GoPay dari Jago',
      };

      const resolved = resolveEmailExtractedEntities(
        aiExtracted,
        gateResult,
        'Top up GoPay Berhasil',
        new Date('2026-11-16T03:12:28.808Z'),
        mockAccounts,
        mockCategories
      );

      expect(resolved.transactionType).toBe('TRANSFER');
      expect(resolved.matchedAccountId).toBe('acc-jago-exp');
      expect(resolved.matchedDestinationAccountId).toBe('acc-gopay');
      expect(resolved.destinationAccountNameHint).toBe('Gopay');
    });
  });

  describe('buildEmailSystemInstruction', () => {
    it('contains explicit guidelines instructing AI to treat via GoPay direct debit as EXPENSE', () => {
      const prompt = buildEmailSystemInstruction(mockAccounts, mockCategories);
      expect(prompt).toContain('CRITICAL DIRECT DEBIT VS TRANSFER RULE');
      expect(prompt).toContain('via GoPay');
      expect(prompt).toContain('DIRECT DEBIT PAYMENTS / PURCHASES ("EXPENSE")');
      expect(prompt).toContain('NEVER classify "via <E-Wallet>" as "TRANSFER"');
      expect(prompt).toContain('Gojek via Jago');
    });
  });
});
