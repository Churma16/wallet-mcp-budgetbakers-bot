import { describe, expect, it } from 'vitest';
import {
  FallbackAiProvider,
  isRecoverableProviderError,
} from '../src/brain/index.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
} from '../src/brain/index.js';
import {
  createFinancialAiProvider,
} from '../src/brain/index.js';
import { OpenAiCompatibleAiProvider } from '../src/brain/index.js';
import { extractAndParseJsonObject } from '../src/brain/index.js';
import { ApplicationEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/wallet/index.js';

class MockFinancialAiProvider implements FinancialAiProvider {
  public callCount = 0;

  constructor(
    public readonly providerName: string,
    private readonly shouldFailWithStatus?: number,
    private readonly failureMessage?: string
  ) {}

  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    _availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    this.callCount++;

    if (this.shouldFailWithStatus || this.failureMessage) {
      const error: any = new Error(this.failureMessage || 'Mock failure');
      if (this.shouldFailWithStatus) {
        error.response = { status: this.shouldFailWithStatus };
      }
      throw error;
    }

    return {
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: availableAccountList[0]?.id || 'acc-1',
          amount: 50000,
          recordDate: '2026-09-08',
          note: 'Processed by ' + this.providerName + ': ' + userMessageText,
        },
      ],
      explanation: 'Successfully processed via ' + this.providerName,
    };
  }

  public async processImageMessage(
    _imageBuffer: Buffer,
    _mimeType: string,
    _optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    _availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    this.callCount++;

    if (this.shouldFailWithStatus || this.failureMessage) {
      const error: any = new Error(this.failureMessage || 'Mock image failure');
      if (this.shouldFailWithStatus) {
        error.response = { status: this.shouldFailWithStatus };
      }
      throw error;
    }

    return {
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: availableAccountList[0]?.id || 'acc-1',
          amount: 75000,
          recordDate: '2026-09-08',
          note: 'Image processed by ' + this.providerName,
        },
      ],
    };
  }

  public async processEmailTransactionMessage(): Promise<ExtractedEmailTransactionData> {
    this.callCount++;

    if (this.shouldFailWithStatus || this.failureMessage) {
      const error: any = new Error(this.failureMessage || 'Mock email failure');
      if (this.shouldFailWithStatus) {
        error.response = { status: this.shouldFailWithStatus };
      }
      throw error;
    }

    return {
      isTransaction: true,
      transactionType: 'EXPENSE',
      amount: 100000,
      counterParty: 'Merchant',
      accountNameHint: 'Cash',
      note: 'Email processed by ' + this.providerName,
      recordDate: '2026-09-08',
      explanation: 'Done',
    };
  }
}

describe('FallbackAiProvider and AI resilience', () => {
  const mockAccounts: WalletAccountItem[] = [{ id: 'acc-1', name: 'Cash', currency: 'IDR' }];
  const mockCategories: WalletCategoryItem[] = [{ id: 'cat-1', name: 'Food' }];

  describe('isRecoverableProviderError', () => {
    it.each([
      ['null', null, false],
      ['Syntax error', new Error('Syntax error'), false],
      ['response status 429', { response: { status: 429 } }, true],
      ['response status 503', { response: { status: 503 } }, true],
      ['Rate limit message', new Error('Rate limit exceeded'), true],
      ['RESOURCE_EXHAUSTED quota message', new Error('RESOURCE_EXHAUSTED: quota exceeded'), true],
      ['Timeout message', new Error('Request timed out'), true],
    ])('evaluates %s as recoverable=%s', (_description, error, expectedRecoverable) => {
      expect(isRecoverableProviderError(error)).toBe(expectedRecoverable);
    });
  });

  describe('failover behavior', () => {
    it('executes primary provider exclusively when primary is healthy', async () => {
      const primaryProvider = new MockFinancialAiProvider('gemini');
      const secondaryProvider = new MockFinancialAiProvider('openrouter');
      const fallbackProvider = new FallbackAiProvider([primaryProvider, secondaryProvider]);

      const result = await fallbackProvider.processTextMessage('Beli kopi 25rb', mockAccounts, mockCategories);

      expect(primaryProvider.callCount).toBe(1);
      expect(secondaryProvider.callCount).toBe(0);
      expect(result.records?.[0].note).toContain('Processed by gemini');
    });

    it('falls back to secondary provider seamlessly when primary encounters a 429', async () => {
      const rateLimitedPrimary = new MockFinancialAiProvider('gemini', 429, 'Too Many Requests');
      const activeSecondary = new MockFinancialAiProvider('openrouter');
      const fallbackProvider = new FallbackAiProvider([rateLimitedPrimary, activeSecondary]);

      const result = await fallbackProvider.processTextMessage('Makan siang 30rb', mockAccounts, mockCategories);

      expect(rateLimitedPrimary.callCount).toBe(1);
      expect(activeSecondary.callCount).toBe(1);
      expect(result.records?.[0].note).toContain('Processed by openrouter');
    });

    it('executes 3-tier cascade fallback in strict priority order', async () => {
      const tier1 = new MockFinancialAiProvider('gemini', 503, 'Overloaded');
      const tier2 = new MockFinancialAiProvider('openrouter', 429, 'Quota exceeded');
      const tier3 = new MockFinancialAiProvider('groq');
      const fallbackProvider = new FallbackAiProvider([tier1, tier2, tier3]);

      const result = await fallbackProvider.processTextMessage('Isi bensin 100rb', mockAccounts, mockCategories);

      expect(tier1.callCount).toBe(1);
      expect(tier2.callCount).toBe(1);
      expect(tier3.callCount).toBe(1);
      expect(result.records?.[0].note).toContain('Processed by groq');
    });

    it('falls back to secondary provider for image messages when primary fails with 429', async () => {
      const imageTier1 = new MockFinancialAiProvider('gemini', 429, 'Rate limit');
      const imageTier2 = new MockFinancialAiProvider('openrouter');
      const fallbackProvider = new FallbackAiProvider([imageTier1, imageTier2]);

      const imageResult = await fallbackProvider.processImageMessage(
        Buffer.from('fake-image'),
        'image/jpeg',
        'receipt',
        mockAccounts,
        mockCategories
      );

      expect(imageTier1.callCount).toBe(1);
      expect(imageTier2.callCount).toBe(1);
      expect(imageResult.records?.[0].note).toContain('Image processed by openrouter');
    });

    it('invokes options.onFallback callback during provider failover', async () => {
      const primary = new MockFinancialAiProvider('gemini', 429, 'Rate limit');
      const secondary = new MockFinancialAiProvider('openrouter');
      const fallbackProvider = new FallbackAiProvider([primary, secondary]);

      const fallbackEvents: any[] = [];
      const result = await fallbackProvider.processTextMessage(
        'Beli pulsa 50rb',
        mockAccounts,
        mockCategories,
        new Date(),
        {
          onFallback: async (event) => {
            fallbackEvents.push(event);
          },
        }
      );

      expect(result.records?.[0].note).toContain('Processed by openrouter');
      expect(fallbackEvents).toHaveLength(1);
      expect(fallbackEvents[0]).toEqual({
        currentModel: 'gemini',
        nextModel: 'openrouter',
        attemptIndex: 1,
        totalCandidates: 2,
        reason: expect.any(String),
      });
    });

    it('propagates the last failure when all providers fail', async () => {
      const failed1 = new MockFinancialAiProvider('gemini', 429, 'Rate limit 1');
      const failed2 = new MockFinancialAiProvider('openrouter', 503, 'Outage 2');
      const fallbackProvider = new FallbackAiProvider([failed1, failed2]);

      await expect(
        fallbackProvider.processTextMessage('test', mockAccounts, mockCategories)
      ).rejects.toThrow(/Outage 2/);
    });
  });

  describe('factory resolution', () => {
    it('instantiates FallbackAiProvider when multiple providers are configured', () => {
      const mockConfig = {
        aiProvider: 'gemini' as const,
        aiProviders: ['gemini', 'openrouter'] as ('gemini' | 'openrouter')[],
        geminiApiKey: 'test-gemini-key',
        geminiModel: 'gemini-3.5-flash',
        geminiFallbackModels: [],
        geminiRequestTimeoutMilliseconds: 5000,
        aiApiKey: 'test-openrouter-key',
        aiBaseUrl: 'https://openrouter.ai/api/v1',
        aiModel: 'meta-llama/llama-3.3-70b-instruct:free',
        aiFallbackModels: [],
        aiRequestTimeoutMilliseconds: 5000,
      } as unknown as ApplicationEnvironmentConfiguration;

      const createdProvider = createFinancialAiProvider(mockConfig);
      expect(createdProvider).toBeInstanceOf(FallbackAiProvider);
      expect((createdProvider as FallbackAiProvider).getProviders()).toHaveLength(2);
    });

    it('instantiates a single provider directly when only one provider is configured', () => {
      const singleConfig = {
        aiProvider: 'gemini' as const,
        aiProviders: ['gemini'] as ('gemini')[],
        geminiApiKey: 'test-gemini-key',
        geminiModel: 'gemini-3.5-flash',
        geminiFallbackModels: [],
        geminiRequestTimeoutMilliseconds: 5000,
      } as unknown as ApplicationEnvironmentConfiguration;

      const singleProvider = createFinancialAiProvider(singleConfig);
      expect(singleProvider).not.toBeInstanceOf(FallbackAiProvider);
      expect(singleProvider.providerName).toBe('gemini');
    });
  });

  describe('extractAndParseJsonObject', () => {
    it('parses JSON from labeled markdown code fences', () => {
      const fencedJsonWithLabel = '```json\n{"nominal": 50000, "merchant": "Kopi"}\n```';
      const parsed = extractAndParseJsonObject<{ nominal: number; merchant: string }>(fencedJsonWithLabel);
      expect(parsed).toEqual({ nominal: 50000, merchant: 'Kopi' });
    });

    it('parses JSON from unlabeled markdown code fences', () => {
      const fencedJsonWithoutLabel = '```\n{"nominal": 25000}\n```';
      const parsed = extractAndParseJsonObject<{ nominal: number }>(fencedJsonWithoutLabel);
      expect(parsed).toEqual({ nominal: 25000 });
    });

    it('parses raw JSON strings without code fences', () => {
      const rawJsonResponse = '{"nominal": 10000}';
      const parsed = extractAndParseJsonObject<{ nominal: number }>(rawJsonResponse);
      expect(parsed).toEqual({ nominal: 10000 });
    });

    it('parses unclosed markdown code fences', () => {
      const unclosedFenceResponse = '```json\n{"nominal": 75000}';
      const parsed = extractAndParseJsonObject<{ nominal: number }>(unclosedFenceResponse);
      expect(parsed).toEqual({ nominal: 75000 });
    });
  });

  describe('OpenAiCompatibleAiProvider base URL normalization', () => {
    it('normalizes trailing slashes on base URLs without regex backtracking', () => {
      const openAiCompatibleProvider = new OpenAiCompatibleAiProvider({
        baseUrl: 'http://localhost:11434/v1///',
        apiKey: 'test-key',
        primaryModelName: 'test-model',
      });
      const normalizedBaseUrl = (openAiCompatibleProvider as unknown as {
        httpClient: { defaults: { baseURL: string } };
      }).httpClient.defaults.baseURL;

      expect(normalizedBaseUrl).toBe('http://localhost:11434/v1');
    });
  });
});
