import { describe, expect, it } from 'vitest';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
  isGenericCategory,
  isOnlinePlatformOrGateway,
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

    it('identifies financial expenses as generic catch-all', () => {
      expect(isGenericCategory('Financial expenses')).toBe(true);
      expect(isGenericCategory('biaya keuangan')).toBe(true);
    });
  });

  describe('isOnlinePlatformOrGateway', () => {
    it('detects online platforms with web TLDs', () => {
      expect(isOnlinePlatformOrGateway('SHOPEE.CO.ID')).toBe(true);
      expect(isOnlinePlatformOrGateway('BLIBLI.COM')).toBe(true);
      expect(isOnlinePlatformOrGateway('TOKOPEDIA.COM')).toBe(true);
      expect(isOnlinePlatformOrGateway('ALFAGIFT.ID')).toBe(true);
      expect(isOnlinePlatformOrGateway('GRAB.COM')).toBe(true);
    });

    it('detects gateway aggregator prefixes and star delimiters', () => {
      expect(isOnlinePlatformOrGateway('MIDTRANS*STORE')).toBe(true);
      expect(isOnlinePlatformOrGateway('QRIS_NOBU')).toBe(true);
      expect(isOnlinePlatformOrGateway('PG_DOKU')).toBe(true);
      expect(isOnlinePlatformOrGateway('SHOPEEPAY_MERCHANT')).toBe(true);
    });

    it('does not classify specific store or seller names as platforms', () => {
      expect(isOnlinePlatformOrGateway('dettolvanishharpic')).toBe(false);
      expect(isOnlinePlatformOrGateway('Starbucks')).toBe(false);
      expect(isOnlinePlatformOrGateway('Indomaret')).toBe(false);
      expect(isOnlinePlatformOrGateway(undefined)).toBe(false);
    });
  });

  describe('isGenericNote with Bank Jago single-line bullet format', () => {
    it('recognizes Bank Jago debit bullet boilerplate as generic', () => {
      expect(
        isGenericNote('Debit card payment • Debit card transaction of Rp51.612 using Jago debit card')
      ).toBe(true);
    });
  });
});
