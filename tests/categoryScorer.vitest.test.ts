import { describe, it, expect, vi } from 'vitest';
import { inferCategoryFromText, selectBestCategory } from '../src/brain/category/categoryScorer.js';
import type { WalletCategoryItem } from '../src/wallet/types.js';
import type { FinancialAiProvider } from '../src/brain/types.js';

describe('categoryScorer & inferCategoryFromText (AI-driven)', () => {
  const sampleCategories: WalletCategoryItem[] = [
    {
      id: 'cat-food',
      name: 'Makanan & Minuman',
      group: { id: 'food', name: 'Food & Beverage' },
      isAssignable: true,
    },
    {
      id: 'cat-transport',
      name: 'Transportasi',
      group: { id: 'transport', name: 'Transportation' },
      isAssignable: true,
    },
    {
      id: 'cat-groceries',
      name: 'Belanja',
      group: { id: 'shopping', name: 'Shopping' },
      isAssignable: true,
    },
    {
      id: 'cat-health',
      name: 'Kesehatan',
      group: { id: 'health', name: 'Healthcare' },
      isAssignable: true,
    },
    {
      id: 'cat-bills',
      name: 'Tagihan & Utilitas',
      group: { id: 'bills', name: 'Bills' },
      isAssignable: true,
    },
    {
      id: 'cat-entertainment',
      name: 'Hiburan',
      group: { id: 'entertainment', name: 'Life & Entertainment' },
      isAssignable: true,
    },
    {
      id: 'cat-income',
      name: 'Pendapatan',
      group: { id: 'income', name: 'Income' },
      isAssignable: true,
    },
    {
      id: 'cat-system',
      name: 'System Category',
      group: { id: 'system_categories', name: 'System' },
      isAssignable: false,
    },
  ];

  describe('inferCategoryFromText with AI Provider', () => {
    it('uses AI Provider to classify categories contextually without static restrictions', async () => {
      const mockAiProvider: FinancialAiProvider = {
        providerName: 'gemini',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async (text: string) => {
          if (text.includes('Kopi') || text.includes('Mixue') || text.includes('Seblak')) {
            return { categoryId: 'cat-food', categoryName: 'Makanan & Minuman', confidence: 'high' };
          }
          if (text.includes('Pertamax') || text.includes('Tambal Ban') || text.includes('Ganti Oli')) {
            return { categoryId: 'cat-transport', categoryName: 'Transportasi', confidence: 'high' };
          }
          if (text.includes('Steam') || text.includes('Netflix')) {
            return { categoryId: 'cat-entertainment', categoryName: 'Hiburan', confidence: 'high' };
          }
          return { categoryId: null, categoryName: null };
        }),
      };

      const match1 = await inferCategoryFromText('Beli Seblak Ceker Pedas', sampleCategories, mockAiProvider);
      expect(match1?.id).toBe('cat-food');

      const match2 = await inferCategoryFromText('Ganti Oli Motor Beat di Bengkel', sampleCategories, mockAiProvider);
      expect(match2?.id).toBe('cat-transport');

      const match3 = await inferCategoryFromText('Beli Game di Steam Sale', sampleCategories, mockAiProvider);
      expect(match3?.id).toBe('cat-entertainment');

      expect(mockAiProvider.classifyCategory).toHaveBeenCalledTimes(3);
    });

    it('falls back gracefully to deterministic token match if AI classification throws an error', async () => {
      const failingAiProvider: FinancialAiProvider = {
        providerName: 'gemini',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async () => {
          throw new Error('AI Provider Rate Limit (429)');
        }),
      };

      const match = await inferCategoryFromText('Makanan siang', sampleCategories, failingAiProvider);
      expect(match?.id).toBe('cat-food');
    });

    it('falls back to deterministic token match if AI classification returns null categoryId', async () => {
      const emptyAiProvider: FinancialAiProvider = {
        providerName: 'gemini',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async () => ({ categoryId: null, categoryName: null })),
      };

      const match = await inferCategoryFromText('Transportasi umum', sampleCategories, emptyAiProvider);
      expect(match?.id).toBe('cat-transport');
    });

    it('returns undefined when text is unclassifiable by both AI and fallback', async () => {
      const emptyAiProvider: FinancialAiProvider = {
        providerName: 'gemini',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async () => ({ categoryId: null, categoryName: null })),
      };

      const match = await inferCategoryFromText('xyz123abc 9999', sampleCategories, emptyAiProvider);
      expect(match).toBeUndefined();
    });

    it('handles empty or whitespace text without calling AI provider', async () => {
      const mockAiProvider: FinancialAiProvider = {
        providerName: 'gemini',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(),
      };

      expect(await inferCategoryFromText('', sampleCategories, mockAiProvider)).toBeUndefined();
      expect(await inferCategoryFromText('   ', sampleCategories, mockAiProvider)).toBeUndefined();
      expect(await inferCategoryFromText(undefined, sampleCategories, mockAiProvider)).toBeUndefined();
      expect(mockAiProvider.classifyCategory).not.toHaveBeenCalled();
    });
  });

  describe('selectBestCategory fallback', () => {
    it('matches exact and substring category names without AI', () => {
      expect(selectBestCategory('', [], sampleCategories, 'Makanan')?.id).toBe('cat-food');
      expect(selectBestCategory('', [], sampleCategories, 'Transportasi')?.id).toBe('cat-transport');
      expect(selectBestCategory('', [], sampleCategories, 'Tagihan')?.id).toBe('cat-bills');
    });

    it('ignores categoryHint when given "auto" to prevent searching for "auto"', () => {
      const match = selectBestCategory('auto', [], sampleCategories, 'Transportasi');
      expect(match?.id).toBe('cat-transport');
    });
  });
});
