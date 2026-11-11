import { describe, it, expect, beforeEach } from 'vitest';
import {
  CommercePlatformRegistry,
  DEFAULT_COMMERCE_PLATFORMS,
  CommercePlatformDefinition,
} from '../src/config/commercePlatforms.js';
import { TransactionCorrelationEngine } from '../src/email/index.js';
import type { PendingTransactionItem } from '../src/core/pending.js';
import type { TransactionEvidence } from '../src/email/index.js';

describe('CommercePlatformRegistry', () => {
  let registry: CommercePlatformRegistry;

  beforeEach(() => {
    CommercePlatformRegistry.resetInstance();
    registry = CommercePlatformRegistry.getInstance();
  });

  describe('Registration & Retrieval', () => {
    it('initializes with default commerce platforms (Grab, Blibli, Shopee, Alfagift)', () => {
      const allPlatforms = registry.getAll();
      const ids = allPlatforms.map(p => p.id);

      expect(ids).toContain('grab');
      expect(ids).toContain('blibli');
      expect(ids).toContain('shopee');
      expect(ids).toContain('alfagift');
      expect(allPlatforms.length).toBe(DEFAULT_COMMERCE_PLATFORMS.length);
    });

    it('retrieves platform definition by id case-insensitively', () => {
      const grab = registry.getById('GRAB');
      expect(grab).toBeDefined();
      expect(grab?.displayName).toBe('Grab');
      expect(grab?.defaultCategory).toBe('Ojol');

      const shopee = registry.getById('shopee');
      expect(shopee).toBeDefined();
      expect(shopee?.defaultCategory).toBe('Shopping');
    });

    it('returns undefined for non-registered platform id', () => {
      expect(registry.getById('unknown-superapp')).toBeUndefined();
    });
  });

  describe('isPlatformWallet identification', () => {
    it('identifies registered platform wallets and digital currencies', () => {
      expect(registry.isPlatformWallet('ShopeePay')).toBe(true);
      expect(registry.isPlatformWallet('spaylater')).toBe(true);
      expect(registry.isPlatformWallet('Grab')).toBe(true);
      expect(registry.isPlatformWallet('GrabPay')).toBe(true);
      expect(registry.isPlatformWallet('Blibli Tiket Points')).toBe(true);
    });

    it('identifies universal platform placeholders (cash, tunai, general e-wallets)', () => {
      expect(registry.isPlatformWallet('Cash')).toBe(true);
      expect(registry.isPlatformWallet('Dompet Tunai')).toBe(true);
      expect(registry.isPlatformWallet('GoPay')).toBe(true);
      expect(registry.isPlatformWallet('OVO')).toBe(true);
      expect(registry.isPlatformWallet('DANA')).toBe(true);
      expect(registry.isPlatformWallet('LinkAja')).toBe(true);
    });

    it('returns false for authoritative bank accounts and credit cards', () => {
      expect(registry.isPlatformWallet('Jago Expense')).toBe(false);
      expect(registry.isPlatformWallet('Bank Mandiri')).toBe(false);
      expect(registry.isPlatformWallet('BCA Prioritas')).toBe(false);
      expect(registry.isPlatformWallet('CIMB Niaga')).toBe(false);
      expect(registry.isPlatformWallet(undefined)).toBe(false);
      expect(registry.isPlatformWallet(null)).toBe(false);
      expect(registry.isPlatformWallet('')).toBe(false);
    });
  });

  describe('isCommerceMerchant identification', () => {
    it('identifies registered commerce platform names and service variations', () => {
      expect(registry.isCommerceMerchant('Grab')).toBe(true);
      expect(registry.isCommerceMerchant('GrabFood')).toBe(true);
      expect(registry.isCommerceMerchant('GrabBike')).toBe(true);
      expect(registry.isCommerceMerchant('GrabCar')).toBe(true);
      expect(registry.isCommerceMerchant('Shopee')).toBe(true);
      expect(registry.isCommerceMerchant('ShopeePay')).toBe(true);
      expect(registry.isCommerceMerchant('Blibli')).toBe(true);
      expect(registry.isCommerceMerchant('BLIBLI.COM KUDUS - ID')).toBe(true);
    });

    it('identifies retail merchant keywords', () => {
      expect(registry.isCommerceMerchant('Alfamart')).toBe(true);
      expect(registry.isCommerceMerchant('Alfagift')).toBe(true);
      expect(registry.isCommerceMerchant('Indomaret')).toBe(true);
      expect(registry.isCommerceMerchant('Flip')).toBe(true);
    });

    it('returns false for generic placeholders and pure banks', () => {
      expect(registry.isCommerceMerchant('Unknown')).toBe(false);
      expect(registry.isCommerceMerchant('Kartu Debit')).toBe(false);
      expect(registry.isCommerceMerchant('Bank Mandiri')).toBe(false);
      expect(registry.isCommerceMerchant(undefined)).toBe(false);
      expect(registry.isCommerceMerchant(null)).toBe(false);
      expect(registry.isCommerceMerchant('')).toBe(false);
    });
  });

  describe('isMarketplacePlatform and findMarketplacePlatform identification', () => {
    it('identifies registered marketplace platforms where bank debits display platform name while receipts display 3rd-party sellers', () => {
      expect(registry.isMarketplacePlatform('Shopee')).toBe(true);
      expect(registry.isMarketplacePlatform('Shopee Indonesia')).toBe(true);
      expect(registry.isMarketplacePlatform('Grab')).toBe(true);
      expect(registry.isMarketplacePlatform('GrabFood')).toBe(true);
      expect(registry.isMarketplacePlatform('Blibli')).toBe(true);
      expect(registry.isMarketplacePlatform('Blibli Offline Store')).toBe(true);

      const shopeeDef = registry.findMarketplacePlatform('Shopee');
      expect(shopeeDef).toBeDefined();
      expect(shopeeDef?.id).toBe('shopee');

      const grabDef = registry.findMarketplacePlatform('GrabFood');
      expect(grabDef).toBeDefined();
      expect(grabDef?.id).toBe('grab');
    });

    it('returns false for retail stores and platforms marked isMarketplace: false', () => {
      expect(registry.isMarketplacePlatform('Alfagift')).toBe(false);
      expect(registry.isMarketplacePlatform('Alfamart')).toBe(false);
      expect(registry.isMarketplacePlatform('Indomaret')).toBe(false);
      expect(registry.isMarketplacePlatform('Starbucks')).toBe(false);
      expect(registry.findMarketplacePlatform('Alfagift')).toBeUndefined();
      expect(registry.findMarketplacePlatform('Alfamart')).toBeUndefined();
      expect(registry.findMarketplacePlatform('Indomaret')).toBeUndefined();
    });

    it('returns false for generic placeholders, pure banks, and null/undefined', () => {
      expect(registry.isMarketplacePlatform('Unknown')).toBe(false);
      expect(registry.isMarketplacePlatform('Kartu Debit')).toBe(false);
      expect(registry.isMarketplacePlatform('Bank Jago')).toBe(false);
      expect(registry.isMarketplacePlatform(undefined)).toBe(false);
      expect(registry.isMarketplacePlatform(null)).toBe(false);
      expect(registry.isMarketplacePlatform('')).toBe(false);
    });
  });

  describe('toBankEmailRules translation', () => {
    it('generates valid BankEmailRuleDefinition entries with MERCHANT_RECEIPT category', () => {
      const generatedRules = registry.toBankEmailRules();
      expect(generatedRules.length).toBe(DEFAULT_COMMERCE_PLATFORMS.length);

      const shopeeRule = generatedRules.find(r => r.bankKey === 'shopee');
      expect(shopeeRule).toBeDefined();
      expect(shopeeRule?.displayName).toBe('Shopee');
      expect(shopeeRule?.ruleCategory).toBe('MERCHANT_RECEIPT');
      expect(shopeeRule?.senderDomains).toContain('shopee.co.id');
      expect(shopeeRule?.referencePatterns.length).toBeGreaterThan(0);
      expect(shopeeRule?.amountPriorityPatterns.length).toBeGreaterThan(0);

      const alfagiftRule = generatedRules.find(r => r.bankKey === 'alfagift');
      expect(alfagiftRule).toBeDefined();
      expect(alfagiftRule?.displayName).toBe('Alfagift');
      expect(alfagiftRule?.ruleCategory).toBe('MERCHANT_RECEIPT');
      expect(alfagiftRule?.senderDomains).toContain('alfagift.id');
      expect(alfagiftRule?.referencePatterns.length).toBeGreaterThan(0);
      expect(alfagiftRule?.amountPriorityPatterns.length).toBeGreaterThan(0);

      const grabRule = generatedRules.find(r => r.bankKey === 'grab');
      expect(grabRule).toBeDefined();
      expect(grabRule?.displayName).toBe('Grab');
      expect(grabRule?.transferOrTopupKeywords).toContain('top up');
    });
  });

  describe('Extensibility & Strategy Pattern (Adding a new platform like Tokopedia)', () => {
    it('dynamically supports a new platform and integrates with TransactionCorrelationEngine without code changes', () => {
      const customRegistry = new CommercePlatformRegistry();

      // Register Tokopedia dynamically
      const tokopediaDef: CommercePlatformDefinition = {
        id: 'tokopedia',
        displayName: 'Tokopedia',
        isMarketplace: true,
        defaultCategory: 'Shopping',
        defaultAccountHint: 'Cash',
        senderDomains: ['tokopedia.com', 'tokomail.com'],
        subjectKeywords: ['pembayaran berhasil', 'invoice', 'tagihan'],
        blacklistKeywords: ['promo', 'diskon', 'otp'],
        bodyRequiredPatterns: [/invoice|total pembayaran|rincian pesanan/i],
        amountPriorityPatterns: [/(?:Total Tagihan|Total)[:\s]*Rp\s*([\d.,]+)/i],
        referencePatterns: [/INV\/[0-9]{8}\/[A-Z0-9\/]+/i],
        platformWallets: ['tokopedia saldo', 'gopay'],
        merchantKeywords: ['tokopedia', 'tokopedia official store'],
      };

      customRegistry.register(tokopediaDef);

      expect(customRegistry.isCommerceMerchant('Tokopedia Official Store')).toBe(true);
      expect(customRegistry.isMarketplacePlatform('Tokopedia')).toBe(true);
      expect(customRegistry.isPlatformWallet('Tokopedia Saldo')).toBe(true);

      // Verify that TransactionCorrelationEngine initialized with customRegistry
      // seamlessly correlates a generic bank debit with Tokopedia invoice
      const correlationService = new TransactionCorrelationEngine({
        platformRegistry: customRegistry,
      });

      const bankJagoCandidate: PendingTransactionItem = {
        ticketId: 1,
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        matchedAccountId: 'acc-jago-expense-1',
        counterParty: 'Unknown',
        amount: -125000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'General',
        note: 'Transaction using Jago debit card',
        recordDate: '2026-10-15T15:00:00.000Z',
        referenceNumbers: [],
        evidenceSources: ['EMAIL_BANK'],
        createdAt: new Date('2026-10-15T15:00:00.000Z'),
      };

      const tokopediaEvidence: TransactionEvidence = {
        sourceType: 'EMAIL_PAYMENT',
        sourceId: 'Invoice Pembayaran Tokopedia',
        merchant: 'Tokopedia',
        amount: -125000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountHint: 'Tokopedia Saldo',
        accountId: 'acc-tokopedia-wallet',
        categoryId: 'cat-shopping',
        categoryName: 'Shopping',
        note: 'Pembayaran pesanan Tokopedia (#INV/20261015/MPL/123456)',
        occurredAt: '2026-10-15T15:00:30.000Z',
        referenceNumbers: ['INV/20261015/MPL/123456'],
      };

      const result = correlationService.correlateEvidence(tokopediaEvidence, [bankJagoCandidate]);

      expect(result.confidence).toBe('HIGH');
      expect(result.suggestedAction).toBe('MERGE_PENDING');

      const fused = result.fusedPendingItem!;
      expect(fused.matchedAccountId).toBe('acc-jago-expense-1');
      expect(fused.accountNameHint).toBe('Jago Expense');
      expect(fused.counterParty).toBe('Tokopedia');
      expect(fused.matchedCategoryName).toBe('Shopping');
      expect(fused.note).toBe('Pembayaran pesanan Tokopedia (#INV/20261015/MPL/123456)');
      expect(fused.referenceNumbers).toContain('INV/20261015/MPL/123456');
    });
  });
});
