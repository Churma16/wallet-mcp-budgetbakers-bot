import { describe, it, expect } from 'vitest';
import {
  isGenericParentCategory,
  buildCompactSystemInstruction,
  buildEmailSystemInstruction,
  buildReceiptSystemInstruction,
  resolveEmailExtractedEntities,
} from '../src/brain/index.js';
import { resolveSemanticCategoryHint } from '../src/brain/semantic/semanticEntityResolver.js';
import { TransactionCorrelationService } from '../src/email/index.js';
import { WalletCategoryItem, WalletAccountItem } from '../src/wallet/index.js';

describe('Universal Specific Subcategory Prioritization Across All Categories', () => {
  const mockCategories: WalletCategoryItem[] = [
    // 1. Shopping group
    {
      id: 'cat-shop-gen',
      name: 'Shopping',
      group: { id: 'shopping', name: 'Shopping' },
      systemId: 'shopping__general',
    },
    {
      id: 'cat-shop-clothes',
      name: 'Clothes & shoes',
      group: { id: 'shopping', name: 'Shopping' },
      systemId: 'shopping__clothes_shoes',
    },
    {
      id: 'cat-shop-elec',
      name: 'Electronics & accessories',
      group: { id: 'shopping', name: 'Shopping' },
      systemId: 'shopping__electronics_accessories',
    },
    // 2. Food & Drinks group
    {
      id: 'cat-food-gen',
      name: 'Food & Drinks',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
      systemId: 'food_and_drinks__general',
    },
    {
      id: 'cat-food-groc',
      name: 'Groceries',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
      systemId: 'food_and_drinks__groceries',
    },
    // 3. PC, Communication group
    {
      id: 'cat-pc-gen',
      name: 'PC, Communication',
      group: { id: 'communication_pc', name: 'PC, Communication' },
      systemId: 'communication_pc__general',
    },
    {
      id: 'cat-pc-digital',
      name: 'Pengeluaran Digital',
      group: { id: 'communication_pc', name: 'PC, Communication' },
      systemId: 'communication_pc__postal_services',
    },
    {
      id: 'cat-pc-soft',
      name: 'Software, apps, games',
      group: { id: 'communication_pc', name: 'PC, Communication' },
      systemId: 'communication_pc__software_apps_games',
    },
    // 4. Transportation group
    {
      id: 'cat-trans-gen',
      name: 'Transportation',
      group: { id: 'transportation', name: 'Transportation' },
      systemId: 'transportation__general',
    },
    {
      id: 'cat-trans-pub',
      name: 'Public transport',
      group: { id: 'transportation', name: 'Transportation' },
      systemId: 'transportation__public_transport',
    },
    // 5. Universal general categories
    {
      id: 'cat-others',
      name: 'Others',
      group: { id: 'others', name: 'Others' },
      systemId: 'others__general',
    },
  ];

  const mockAccounts: WalletAccountItem[] = [
    { id: 'acc-1', name: 'Jago Expense', currency: 'IDR' },
  ];

  describe('isGenericParentCategory classification helper', () => {
    it('accurately identifies generic parent categories across all groups', () => {
      expect(isGenericParentCategory(mockCategories[0])).toBe(true); // Shopping general
      expect(isGenericParentCategory(mockCategories[3])).toBe(true); // Food & Drinks general
      expect(isGenericParentCategory(mockCategories[5])).toBe(true); // PC, Communication general
      expect(isGenericParentCategory(mockCategories[8])).toBe(true); // Transportation general
      expect(isGenericParentCategory(mockCategories[10])).toBe(true); // Others general
    });

    it('accurately classifies specific subcategories as non-generic', () => {
      expect(isGenericParentCategory(mockCategories[1])).toBe(false); // Clothes & shoes
      expect(isGenericParentCategory(mockCategories[2])).toBe(false); // Electronics & accessories
      expect(isGenericParentCategory(mockCategories[4])).toBe(false); // Groceries
      expect(isGenericParentCategory(mockCategories[6])).toBe(false); // Pengeluaran Digital
      expect(isGenericParentCategory(mockCategories[7])).toBe(false); // Software, apps, games
      expect(isGenericParentCategory(mockCategories[9])).toBe(false); // Public transport
    });

    it('handles categories with string-typed groups or dictionary-based umum/others', () => {
      const customUmum: WalletCategoryItem = { id: 'c-umum', name: 'Umum' };
      const customGeneral: WalletCategoryItem = { id: 'c-gen', name: 'General' };
      const customLain: WalletCategoryItem = { id: 'c-lain', name: 'Lain-lain' };
      const customSpecific: WalletCategoryItem = { id: 'c-spec', name: 'Kopi Kenangan', group: { id: 'food', name: 'Food' } };

      expect(isGenericParentCategory(customUmum)).toBe(true);
      expect(isGenericParentCategory(customGeneral)).toBe(true);
      expect(isGenericParentCategory(customLain)).toBe(true);
      expect(isGenericParentCategory(customSpecific)).toBe(false);
    });
  });

  describe('Prompt Builders Category Formatting & Priority Rules', () => {
    it('buildCompactSystemInstruction marks generic fallbacks and includes subcategory rule', () => {
      const prompt = buildCompactSystemInstruction(mockAccounts, mockCategories, '2026-10-21');
      expect(prompt).toContain('cat-shop-gen: Shopping [General Fallback only] (Group: Shopping)');
      expect(prompt).toContain('cat-shop-clothes: Clothes & shoes (Group: Shopping)');
      expect(prompt).toContain('SPECIFIC SUBCATEGORY PREFERENCE:');
      expect(prompt).toContain('NEVER select a generic parent category or any category marked \'[General Fallback only]\'');
    });

    it('buildEmailSystemInstruction marks generic fallbacks and includes Rule 6 subcategory rule', () => {
      const emailPrompt = buildEmailSystemInstruction(mockAccounts, mockCategories);
      expect(emailPrompt).toContain('ID "cat-shop-gen": "Shopping" [General Fallback only] (Group: Shopping)');
      expect(emailPrompt).toContain('ID "cat-pc-digital": "Pengeluaran Digital" (Group: PC, Communication)');
      expect(emailPrompt).toContain('SPECIFIC SUBCATEGORY RULE:');
      expect(emailPrompt).toContain('NEVER choose a generic parent category marked \'[General Fallback only]\'');
    });

    it('buildReceiptSystemInstruction formats subcategories with group indicators and rule', () => {
      const receiptPrompt = buildReceiptSystemInstruction(mockAccounts, mockCategories, '2026-10-21', 'Asia/Jakarta');
      expect(receiptPrompt).toContain('Shopping [General Fallback only] (Group: Shopping)');
      expect(receiptPrompt).toContain('Pengeluaran Digital (Group: PC, Communication)');
      expect(receiptPrompt).toContain('SPECIFIC SUBCATEGORY RULE:');
      expect(receiptPrompt).toContain('Always choose the most specific matching child/sub-category');
    });
  });

  describe('resolveEmailExtractedEntities robustness', () => {
    it('resolves category cleanly even if AI echoed the [General Fallback only] annotation', () => {
      const resolved = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 50000,
          counterParty: 'Tokopedia',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-1',
          matchedCategoryId: 'cat-shop-gen [General Fallback only]',
        },
        { passed: true, candidateAmount: 50000, isTransferCandidate: false },
        'Subject',
        new Date('2026-10-21T10:00:00.000Z'),
        mockAccounts,
        mockCategories
      );

      expect(resolved.matchedCategoryId).toBe('cat-shop-gen');
      expect(resolved.matchedCategoryName).toBe('Shopping');
    });

    it('resolves category by name even if annotated', () => {
      const resolved = resolveEmailExtractedEntities(
        {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 50000,
          counterParty: 'Steam',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-1',
          matchedCategoryId: 'Pengeluaran Digital',
        },
        { passed: true, candidateAmount: 50000, isTransferCandidate: false },
        'Subject',
        new Date('2026-10-21T10:00:00.000Z'),
        mockAccounts,
        mockCategories
      );

      expect(resolved.matchedCategoryId).toBe('cat-pc-digital');
      expect(resolved.matchedCategoryName).toBe('Pengeluaran Digital');
    });
  });

  describe('resolveSemanticCategoryHint disambiguation', () => {
    it('favors specific subcategory over generic parent category when multiple match', () => {
      // "Shopping clothes" matches both "Shopping" and "Clothes & shoes"
      const result = resolveSemanticCategoryHint('Shopping clothes', mockCategories);
      expect(result.status).toBe('RESOLVED');
      if (result.status === 'RESOLVED') {
        expect(result.id).toBe('cat-shop-clothes');
        expect(result.name).toBe('Clothes & shoes');
      }
    });

    it('favors specific food subcategory over generic Food & Drinks', () => {
      const result = resolveSemanticCategoryHint('Food Groceries', mockCategories);
      expect(result.status).toBe('RESOLVED');
      if (result.status === 'RESOLVED') {
        expect(result.id).toBe('cat-food-groc');
        expect(result.name).toBe('Groceries');
      }
    });
  });

  describe('TransactionCorrelationService generic category override', () => {
    it('allows specific merchant category to supersede any generic parent category', () => {
      const service = new TransactionCorrelationService();

      const genericCandidate = {
        candidateId: 'test-cand-1',
        amount: 85470,
        currency: 'IDR',
        occurredAt: '2026-10-20T16:26:18.000Z',
        accountHint: 'Jago Expense',
        accountId: 'acc-1',
        matchedCategoryName: 'Shopping',
        matchedCategoryId: 'cat-shop-gen',
        referenceNumbers: ['REF1'],
        evidenceSources: ['EMAIL_BANK' as const],
      };

      const specificIncoming = {
        sourceType: 'EMAIL_PAYMENT' as const,
        sourceId: 'shopee-receipt',
        amount: 85470,
        currency: 'IDR',
        occurredAt: '2026-10-20T16:26:18.000Z',
        merchant: 'Shopee',
        categoryId: 'cat-pc-digital',
        categoryName: 'Pengeluaran Digital',
        referenceNumbers: ['REF1'],
      };

      const result = service.correlateEvidence(specificIncoming, [genericCandidate], []);
      expect(result.suggestedAction).toBe('MERGE_PENDING');
      expect(result.fusedPendingItem?.matchedCategoryId).toBe('cat-pc-digital');
      expect(result.fusedPendingItem?.matchedCategoryName).toBe('Pengeluaran Digital');
    });
  });
});
