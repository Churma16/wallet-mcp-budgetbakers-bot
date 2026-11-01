import { describe, expect, it } from 'vitest';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  detectConflictingMerchants,
  isGenericNote,
  isBankSource,
  isPaymentOrReceiptSource,
  resolveAccount,
  resolveCounterParty,
  resolveNote,
  resolveCategory,
  resolveReferenceNumbers,
  resolveEvidenceSources,
  fuseCandidateWithEvidence,
  evaluateComplementarySources,
} from '../src/email/index.js';
import { CommercePlatformRegistry } from '../src/config/commercePlatforms.js';
import type { PendingTransactionItem } from '../src/core/pending.js';
import type { TransactionEvidence } from '../src/email/index.js';

describe('transactionFusion unit tests', () => {
  const platformRegistry = CommercePlatformRegistry.getInstance();

  const mockPending: PendingTransactionItem = {
    ticketId: 10,
    sourceType: 'EMAIL',
    bankDisplayName: 'Bank Mandiri (Livin)',
    accountNameHint: 'Mandiri',
    counterParty: 'BLIBLI.COM KUDUS - ID',
    amount: -16700,
    currency: 'IDR',
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-mandiri-123',
    matchedCategoryId: 'cat-general',
    matchedCategoryName: 'Belanja',
    note: 'Pembayaran QRIS',
    recordDate: '2026-10-14T10:18:00.000Z',
    referenceNumber: 'REF-BANK-001',
    referenceNumbers: ['REF-BANK-001'],
    evidenceSources: ['EMAIL_BANK'],
    createdAt: new Date('2026-10-14T10:18:00.000Z'),
    expiresAt: new Date('2026-10-15T10:18:00.000Z'),
    isBankSyncedAccount: true,
  };

  const mockEvidence: TransactionEvidence = {
    sourceType: 'EMAIL_PAYMENT',
    amount: -16700,
    currency: 'IDR',
    occurredAt: '2026-10-14T10:18:15.000Z',
    merchant: 'Blibli Offline Store',
    accountHint: 'Cash',
    accountId: 'acc-cash',
    referenceNumbers: ['ORDER-BLIBLI-999'],
    note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
    categoryId: 'cat-food',
    categoryName: 'Makanan & Minuman',
    transactionType: 'EXPENSE',
  };

  describe('isGenericMerchant', () => {
    it('correctly identifies generic merchant strings', () => {
      expect(isGenericMerchant(undefined)).toBe(true);
      expect(isGenericMerchant(null)).toBe(true);
      expect(isGenericMerchant('')).toBe(true);
      expect(isGenericMerchant('Unknown')).toBe(true);
      expect(isGenericMerchant('Pembayaran QRIS')).toBe(true);
      expect(isGenericMerchant('Kartu Debit')).toBe(true);
    });

    it('identifies non-generic merchants', () => {
      expect(isGenericMerchant('PT Pos Indonesia')).toBe(false);
      expect(isGenericMerchant('Starbucks Coffee')).toBe(false);
      expect(isGenericMerchant('Blibli Offline Store')).toBe(false);
    });
  });

  describe('isGenericCardAccountOrMethod', () => {
    it('detects card networks and methods', () => {
      expect(isGenericCardAccountOrMethod('Visa')).toBe(true);
      expect(isGenericCardAccountOrMethod('Mastercard Debit')).toBe(true);
      expect(isGenericCardAccountOrMethod('Kartu Kredit')).toBe(true);
      expect(isGenericCardAccountOrMethod('Mandiri Savings')).toBe(false);
      expect(isGenericCardAccountOrMethod(undefined)).toBe(false);
    });
  });

  describe('detectConflictingMerchants', () => {
    it('flags conflicting merchants without token overlap', () => {
      expect(
        detectConflictingMerchants(
          { counterParty: 'Starbucks Coffee' },
          { merchant: 'Alfamart Express' },
          platformRegistry
        )
      ).toBe(true);
    });

    it('allows matching brands or token overlaps', () => {
      expect(
        detectConflictingMerchants(
          { counterParty: 'BLIBLI.COM KUDUS - ID' },
          { merchant: 'Blibli Offline Store' },
          platformRegistry
        )
      ).toBe(false);
    });
  });

  describe('isGenericNote', () => {
    it('recognizes generic transaction notes', () => {
      expect(isGenericNote('Transaksi menggunakan kartu debit')).toBe(true);
      expect(isGenericNote('Pembayaran QRIS')).toBe(true);
      expect(isGenericNote('Grab E-Receipt')).toBe(true);
    });

    it('preserves rich notes with itemization or order IDs', () => {
      expect(isGenericNote('Order #12345')).toBe(false);
      expect(isGenericNote('Item 1 • Item 2')).toBe(false);
      expect(isGenericNote('Line 1\nLine 2')).toBe(false);
    });
  });

  describe('isBankSource and isPaymentOrReceiptSource', () => {
    it('detects bank sources accurately', () => {
      expect(isBankSource({ evidenceSources: ['EMAIL_BANK'] })).toBe(true);
      expect(isBankSource({ bankDisplayName: 'Bank Central Asia' })).toBe(true);
      expect(isBankSource({ bankDisplayName: 'Tokopedia' })).toBe(false);
    });

    it('detects payment/receipt sources accurately', () => {
      expect(isPaymentOrReceiptSource({ evidenceSources: ['RECEIPT'] }, platformRegistry)).toBe(true);
      expect(isPaymentOrReceiptSource({ bankDisplayName: 'Grab E-Receipt' }, platformRegistry)).toBe(true);
    });
  });

  describe('resolveAccount & resolveCounterParty & resolveNote & resolveCategory', () => {
    it('resolves bank account precedence over platform wallet or cash', () => {
      const account = resolveAccount(mockPending, mockEvidence, platformRegistry);
      expect(account.matchedAccountId).toBe('acc-mandiri-123');
      expect(account.bankDisplayName).toBe('Bank Mandiri (Livin)');
    });

    it('resolves clean merchant name over bank description', () => {
      const counterParty = resolveCounterParty(mockPending, mockEvidence);
      expect(counterParty).toBe('Blibli Offline Store');
    });

    it('resolves itemized note over generic bank note', () => {
      const note = resolveNote(mockPending, mockEvidence);
      expect(note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR');
    });

    it('resolves specific category over generic category', () => {
      const category = resolveCategory(mockPending, mockEvidence);
      expect(category.matchedCategoryId).toBe('cat-food');
      expect(category.matchedCategoryName).toBe('Makanan & Minuman');
    });
  });

  describe('fuseCandidateWithEvidence', () => {
    it('fuses candidate state with arrival order invariance and preserves bank sync flag', () => {
      const fused = fuseCandidateWithEvidence(mockPending, mockEvidence, platformRegistry);
      expect(fused.matchedAccountId).toBe('acc-mandiri-123');
      expect(fused.counterParty).toBe('Blibli Offline Store');
      expect(fused.note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR');
      expect(fused.matchedCategoryId).toBe('cat-food');
      expect(fused.referenceNumbers).toEqual(['REF-BANK-001', 'ORDER-BLIBLI-999']);
      expect(fused.evidenceSources).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT']);
      expect(fused.isBankSyncedAccount).toBe(true);
    });
  });

  describe('evaluateComplementarySources', () => {
    it('evaluates complementary bank debit and merchant receipt with high confidence', () => {
      const evaluation = evaluateComplementarySources(mockPending, mockEvidence, 15000, {
        platformRegistry,
        tightWindowMilliseconds: 900000,
      });
      expect(evaluation.isHighConfidence).toBe(true);
      expect(evaluation.reasons.length).toBeGreaterThan(0);
    });
  });
});
