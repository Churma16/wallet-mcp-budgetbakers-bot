import assert from 'node:assert/strict';
import {
  FallbackAiProvider,
  isRecoverableProviderError,
} from '../src/services/ai/fallbackAiProvider.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  ExtractedEmailTransactionData,
} from '../src/services/ai/financialAiProvider.js';
import {
  createFinancialAiProvider,
  createSingleFinancialAiProvider,
} from '../src/services/ai/aiProviderFactory.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';
import { extractAndParseJsonObject } from '../src/services/ai/jsonExtractionHelper.js';
import { ApplicationEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';

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
    availableCategoryList: WalletCategoryItem[]
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
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
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

async function runFallbackAiProviderTestSuite(): Promise<void> {
  console.log('Running FallbackAiProvider Unit Tests...');

  const mockAccounts: WalletAccountItem[] = [{ id: 'acc-1', name: 'Cash', currency: 'IDR' }];
  const mockCategories: WalletCategoryItem[] = [{ id: 'cat-1', name: 'Food' }];

  // Test 1: Recoverable Error Detection
  console.log('Test 1: isRecoverableProviderError detection');
  assert.equal(isRecoverableProviderError(null), false);
  assert.equal(isRecoverableProviderError(new Error('Syntax error')), false);
  assert.equal(isRecoverableProviderError({ response: { status: 429 } }), true);
  assert.equal(isRecoverableProviderError({ response: { status: 503 } }), true);
  assert.equal(isRecoverableProviderError(new Error('Rate limit exceeded')), true);
  assert.equal(isRecoverableProviderError(new Error('RESOURCE_EXHAUSTED: quota exceeded')), true);
  assert.equal(isRecoverableProviderError(new Error('Request timed out')), true);
  console.log('[SUCCESS] Test 1 Passed: Error recovery classifications verified.');

  // Test 2: Primary succeeds, secondary is never invoked
  console.log('Test 2: Primary provider success');
  const primaryProvider = new MockFinancialAiProvider('gemini');
  const secondaryProvider = new MockFinancialAiProvider('openrouter');
  const fallbackProvider = new FallbackAiProvider([primaryProvider, secondaryProvider]);

  const result1 = await fallbackProvider.processTextMessage('Beli kopi 25rb', mockAccounts, mockCategories);
  assert.equal(primaryProvider.callCount, 1);
  assert.equal(secondaryProvider.callCount, 0);
  assert.ok(result1.records?.[0].note.includes('Processed by gemini'));
  console.log('[SUCCESS] Test 2 Passed: Primary executed exclusively on healthy state.');

  // Test 3: Primary fails with 429, falls back to secondary
  console.log('Test 3: Primary 429 failover to secondary');
  const rateLimitedPrimary = new MockFinancialAiProvider('gemini', 429, 'Too Many Requests');
  const activeSecondary = new MockFinancialAiProvider('openrouter');
  const fallbackProvider2 = new FallbackAiProvider([rateLimitedPrimary, activeSecondary]);

  const result2 = await fallbackProvider2.processTextMessage('Makan siang 30rb', mockAccounts, mockCategories);
  assert.equal(rateLimitedPrimary.callCount, 1);
  assert.equal(activeSecondary.callCount, 1);
  assert.ok(result2.records?.[0].note.includes('Processed by openrouter'));
  console.log('[SUCCESS] Test 3 Passed: 429 failover to secondary completed seamlessly.');

  // Test 4: Cascade across 3 providers (1st fails -> 2nd fails -> 3rd succeeds)
  console.log('Test 4: 3-tier cascade fallback');
  const tier1 = new MockFinancialAiProvider('gemini', 503, 'Overloaded');
  const tier2 = new MockFinancialAiProvider('openrouter', 429, 'Quota exceeded');
  const tier3 = new MockFinancialAiProvider('groq');
  const fallbackProvider3 = new FallbackAiProvider([tier1, tier2, tier3]);

  const result3 = await fallbackProvider3.processTextMessage('Isi bensin 100rb', mockAccounts, mockCategories);
  assert.equal(tier1.callCount, 1);
  assert.equal(tier2.callCount, 1);
  assert.equal(tier3.callCount, 1);
  assert.ok(result3.records?.[0].note.includes('Processed by groq'));
  console.log('[SUCCESS] Test 4 Passed: 3-tier cascade executed in strict priority order.');

  // Test 5: Image message fallback
  console.log('Test 5: Image message failover');
  const imageTier1 = new MockFinancialAiProvider('gemini', 429, 'Rate limit');
  const imageTier2 = new MockFinancialAiProvider('openrouter');
  const fallbackProviderImage = new FallbackAiProvider([imageTier1, imageTier2]);

  const imageResult = await fallbackProviderImage.processImageMessage(
    Buffer.from('fake-image'),
    'image/jpeg',
    'receipt',
    mockAccounts,
    mockCategories
  );
  assert.equal(imageTier1.callCount, 1);
  assert.equal(imageTier2.callCount, 1);
  assert.ok(imageResult.records?.[0].note.includes('Image processed by openrouter'));
  console.log('[SUCCESS] Test 5 Passed: Image message failover verified.');

  // Test 6: All providers fail throws last error
  console.log('Test 6: All providers fail');
  const failed1 = new MockFinancialAiProvider('gemini', 429, 'Rate limit 1');
  const failed2 = new MockFinancialAiProvider('openrouter', 503, 'Outage 2');
  const fallbackProviderAllFail = new FallbackAiProvider([failed1, failed2]);

  await assert.rejects(
    async () => {
      await fallbackProviderAllFail.processTextMessage('test', mockAccounts, mockCategories);
    },
    (err: any) => {
      assert.ok(err.message.includes('Outage 2'));
      return true;
    }
  );
  console.log('[SUCCESS] Test 6 Passed: Exhaustion error propagated cleanly.');

  // Test 7: Factory multi-provider resolution
  console.log('Test 7: Factory creation with multiple providers');
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
  assert.ok(createdProvider instanceof FallbackAiProvider);
  assert.equal((createdProvider as FallbackAiProvider).getProviders().length, 2);
  console.log('[SUCCESS] Test 7 Passed: Factory instantiated FallbackAiProvider correctly.');

  // Test 8: Factory single provider backward compatibility
  console.log('Test 8: Factory single provider backward compatibility');
  const singleConfig = {
    aiProvider: 'gemini' as const,
    aiProviders: ['gemini'] as ('gemini')[],
    geminiApiKey: 'test-gemini-key',
    geminiModel: 'gemini-3.5-flash',
    geminiFallbackModels: [],
    geminiRequestTimeoutMilliseconds: 5000,
  } as unknown as ApplicationEnvironmentConfiguration;

  const singleProvider = createFinancialAiProvider(singleConfig);
  assert.ok(!(singleProvider instanceof FallbackAiProvider));
  assert.equal(singleProvider.providerName, 'gemini');
  console.log('[SUCCESS] Test 8 Passed: Single provider maintains 100% backward compatibility.');

  // Test 9: JSON response extraction from markdown code fences
  console.log('Test 9: extractAndParseJsonObject markdown code fence handling');
  const fencedJsonWithLabel = '```json\n{"nominal": 50000, "merchant": "Kopi"}\n```';
  const parsedFencedJson = extractAndParseJsonObject<{ nominal: number; merchant: string }>(fencedJsonWithLabel);
  assert.equal(parsedFencedJson.nominal, 50000);
  assert.equal(parsedFencedJson.merchant, 'Kopi');

  const fencedJsonWithoutLabel = '```\n{"nominal": 25000}\n```';
  const parsedPlainFencedJson = extractAndParseJsonObject<{ nominal: number }>(fencedJsonWithoutLabel);
  assert.equal(parsedPlainFencedJson.nominal, 25000);

  const rawJsonResponse = '{"nominal": 10000}';
  const parsedRawJson = extractAndParseJsonObject<{ nominal: number }>(rawJsonResponse);
  assert.equal(parsedRawJson.nominal, 10000);

  const unclosedFenceResponse = '```json\n{"nominal": 75000}';
  const parsedUnclosedFenceJson = extractAndParseJsonObject<{ nominal: number }>(unclosedFenceResponse);
  assert.equal(parsedUnclosedFenceJson.nominal, 75000);
  console.log('[SUCCESS] Test 9 Passed: Markdown fenced and raw JSON responses parsed deterministically.');

  // Test 10: OpenAI-compatible provider base URL trailing slash normalization
  console.log('Test 10: OpenAiCompatibleAiProvider base URL trailing slash trimming');
  const openAiCompatibleProvider = new OpenAiCompatibleAiProvider({
    baseUrl: 'http://localhost:11434/v1///',
    apiKey: 'test-key',
    primaryModelName: 'test-model',
  });
  const normalizedBaseUrl = (openAiCompatibleProvider as unknown as {
    httpClient: { defaults: { baseURL: string } };
  }).httpClient.defaults.baseURL;
  assert.equal(normalizedBaseUrl, 'http://localhost:11434/v1');
  console.log('[SUCCESS] Test 10 Passed: Trailing slashes normalized without regex backtracking.');

  console.log('\nAll FallbackAiProvider unit tests passed successfully!');
}

runFallbackAiProviderTestSuite().catch((err) => {
  console.error('[ERROR] Unit test suite failed:', err);
  process.exit(1);
});
