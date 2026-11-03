import { describe, it, expect, vi } from 'vitest';
import { inferCategoryFromText, selectBestCategory } from '../src/brain/category/categoryScorer.js';
import { buildCategoryClassificationPrompt } from '../src/brain/prompts/prompts.js';
import { parseCategoryClassificationResponse } from '../src/brain/providers/jsonExtraction.js';
import { GeminiAiProvider } from '../src/brain/providers/geminiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/brain/providers/openAiProvider.js';
import { FallbackAiProvider } from '../src/brain/providers/fallbackProvider.js';
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

  describe('buildCategoryClassificationPrompt', () => {
    it('formats categories list and wraps untrusted user text safely', () => {
      const { systemInstruction, promptText } = buildCategoryClassificationPrompt(
        'Beli bensin pertamax di SPBU',
        sampleCategories
      );

      expect(systemInstruction).toContain('ALLOWED CATEGORIES:');
      expect(systemInstruction).toContain('[ID: cat-food] Makanan & Minuman (Group: Food & Beverage)');
      expect(systemInstruction).toContain('[ID: cat-transport] Transportasi (Group: Transportation)');
      expect(promptText).toContain('<untrusted_user_text');
      expect(promptText).toContain('Beli bensin pertamax di SPBU');
      expect(promptText).toContain('</untrusted_user_text>');
    });

    it('handles category group as a string or empty', () => {
      const customCategories: WalletCategoryItem[] = [
        { id: 'cat-custom', name: 'Custom Cat', group: 'Custom Group' as any, isAssignable: true },
        { id: 'cat-nogroup', name: 'No Group Cat', isAssignable: true },
      ];
      const { systemInstruction } = buildCategoryClassificationPrompt('Testing', customCategories);
      expect(systemInstruction).toContain('[ID: cat-custom] Custom Cat (Group: Custom Group)');
      expect(systemInstruction).toContain('[ID: cat-nogroup] No Group Cat');
    });
  });

  describe('parseCategoryClassificationResponse', () => {
    it('parses valid raw JSON response', () => {
      const raw = JSON.stringify({
        categoryId: 'cat-transport',
        categoryName: 'Transportasi',
        confidence: 'high',
      });
      const parsed = parseCategoryClassificationResponse(raw, { totalTokens: 15 });
      expect(parsed.categoryId).toBe('cat-transport');
      expect(parsed.categoryName).toBe('Transportasi');
      expect(parsed.confidence).toBe('high');
      expect(parsed.tokenUsage?.totalTokens).toBe(15);
    });

    it('parses JSON wrapped in markdown code fences', () => {
      const raw = '```json\n{"categoryId": "cat-food", "categoryName": "Makanan & Minuman", "confidence": "low"}\n```';
      const parsed = parseCategoryClassificationResponse(raw);
      expect(parsed.categoryId).toBe('cat-food');
      expect(parsed.categoryName).toBe('Makanan & Minuman');
      expect(parsed.confidence).toBe('low');
    });

    it('normalizes null or whitespace categoryId and handles parsing errors gracefully', () => {
      const nullParsed = parseCategoryClassificationResponse('{"categoryId": null, "categoryName": null}');
      expect(nullParsed.categoryId).toBeNull();
      expect(nullParsed.categoryName).toBeNull();

      const whitespaceParsed = parseCategoryClassificationResponse('{"categoryId": "   ", "categoryName": "  "}');
      expect(whitespaceParsed.categoryId).toBeNull();
      expect(whitespaceParsed.categoryName).toBeNull();

      const errorParsed = parseCategoryClassificationResponse('Not valid JSON at all');
      expect(errorParsed.categoryId).toBeNull();
      expect(errorParsed.categoryName).toBeNull();
    });
  });

  describe('Provider classifyCategory implementations', () => {
    it('GeminiAiProvider executes classifyCategory with generation fallback', async () => {
      const geminiProvider = new GeminiAiProvider('mock-key', 'gemini-3.5-flash', []);
      (geminiProvider as any).googleGenAiClient = {
        models: {
          generateContent: async () => ({
            text: JSON.stringify({
              categoryId: 'cat-food',
              categoryName: 'Makanan & Minuman',
              confidence: 'high',
            }),
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 5,
              totalTokenCount: 15,
            },
          }),
        },
      };

      const result = await geminiProvider.classifyCategory('Beli nasi goreng', sampleCategories);
      expect(result.categoryId).toBe('cat-food');
      expect(result.categoryName).toBe('Makanan & Minuman');
      expect(result.confidence).toBe('high');
      expect(result.tokenUsage?.totalTokens).toBe(15);
    });

    it('OpenAiCompatibleAiProvider executes classifyCategory via chat completions', async () => {
      const openAiProvider = new OpenAiCompatibleAiProvider({
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'test-key',
        primaryModelName: 'test-model',
      });
      (openAiProvider as any).httpClient = {
        post: async () => ({
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    categoryId: 'cat-transport',
                    categoryName: 'Transportasi',
                    confidence: 'high',
                  }),
                },
              },
            ],
            usage: {
              prompt_tokens: 12,
              completion_tokens: 6,
              total_tokens: 18,
            },
          },
        }),
      };

      const result = await openAiProvider.classifyCategory('Beli bensin shell', sampleCategories);
      expect(result.categoryId).toBe('cat-transport');
      expect(result.categoryName).toBe('Transportasi');
      expect(result.confidence).toBe('high');
      expect(result.tokenUsage?.totalTokens).toBe(18);
    });

    it('FallbackAiProvider executes classifyCategory and fails over to secondary on recoverable error', async () => {
      const failingPrimary: FinancialAiProvider = {
        providerName: 'primary-mock',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async () => {
          const err: any = new Error('Rate limit exceeded (429)');
          err.response = { status: 429 };
          throw err;
        }),
      };

      const workingSecondary: FinancialAiProvider = {
        providerName: 'secondary-mock',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        classifyCategory: vi.fn(async () => ({
          categoryId: 'cat-health',
          categoryName: 'Kesehatan',
          confidence: 'high',
        })),
      };

      const fallbackProvider = new FallbackAiProvider([failingPrimary, workingSecondary]);
      const result = await fallbackProvider.classifyCategory('Beli obat flu', sampleCategories);
      expect(result.categoryId).toBe('cat-health');
      expect(failingPrimary.classifyCategory).toHaveBeenCalled();
      expect(workingSecondary.classifyCategory).toHaveBeenCalled();
    });

    it('FallbackAiProvider throws when provider does not implement classifyCategory', async () => {
      const nonImplementingProvider: FinancialAiProvider = {
        providerName: 'no-classify-mock',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
      };

      const fallbackProvider = new FallbackAiProvider([nonImplementingProvider]);
      await expect(
        fallbackProvider.classifyCategory('Test text', sampleCategories)
      ).rejects.toThrow("Provider 'no-classify-mock' does not implement classifyCategory.");
    });
  });
});
