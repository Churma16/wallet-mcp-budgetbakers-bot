import { describe, expect, it } from 'vitest';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
  isGenericCategory,
} from '../src/email/index.js';

describe('correlationPredicates unit tests', () => {
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
});
