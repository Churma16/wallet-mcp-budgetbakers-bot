import { describe, expect, it } from 'vitest';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
  isGenericCategory,
  fuseCandidateWithEvidence,
} from '../src/email/index.js';
import type { PendingTransactionItem } from '../src/core/pending.js';
import type { TransactionEvidence } from '../src/email/index.js';

describe('transactionFusion unit tests', () => {
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

  describe('isGenericCategory', () => {
    it('detects generic and placeholder categories', () => {
      expect(isGenericCategory(undefined)).toBe(true);
      expect(isGenericCategory(null)).toBe(true);
      expect(isGenericCategory('')).toBe(true);
      expect(isGenericCategory('Unknown')).toBe(true);
      expect(isGenericCategory('Belanja')).toBe(true);
      expect(isGenericCategory('General')).toBe(true);
      expect(isGenericCategory('Lain-lain')).toBe(true);
    });

    it('identifies concrete leaf categories', () => {
      expect(isGenericCategory('Makanan & Minuman')).toBe(false);
      expect(isGenericCategory('Transportasi')).toBe(false);
      expect(isGenericCategory('Pendidikan')).toBe(false);
    });
  });

  describe('fuseCandidateWithEvidence', () => {
    it('fuses candidate state with arrival order invariance and preserves bank sync flag', () => {
      const fused = fuseCandidateWithEvidence(mockPending, mockEvidence);
      expect(fused.matchedAccountId).toBe('acc-mandiri-123');
      expect(fused.counterParty).toBe('Blibli Offline Store');
      expect(fused.note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR');
      expect(fused.matchedCategoryId).toBe('cat-food');
      expect(fused.referenceNumbers).toEqual(['REF-BANK-001', 'ORDER-BLIBLI-999']);
      expect(fused.evidenceSources).toEqual(['EMAIL_BANK', 'EMAIL_PAYMENT']);
      expect(fused.isBankSyncedAccount).toBe(true);
    });
  });
});
