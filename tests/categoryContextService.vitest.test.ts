import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CategoryContextService } from '../src/services/categoryContextService.js';
import {
  buildCompactSystemInstruction,
  buildReceiptSystemInstruction,
  buildEmailSystemInstruction,
} from '../src/services/ai/aiPromptBuilder.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { Application } from '../src/app.js';
import { GateEvaluationResult } from '../src/utils/emailGateEvaluator.js';

const mockAccounts: WalletAccountItem[] = [
  { id: 'acc-1', name: 'Cash', currency: 'IDR', accountType: 'Cash' },
  { id: 'acc-2', name: 'Bank Mandiri', currency: 'IDR', accountType: 'CurrentAccount' },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-fnb', name: 'Food & Beverage' },
  { id: 'cat-nafsu', name: 'Makan Nafsu' },
  { id: 'cat-hangout', name: 'Makan Hangout' },
  { id: 'cat-home', name: 'Home & garden' },
];

const validJsonPayload = {
  version: '1.0',
  userContext: 'Software engineer living in Jakarta, regularly orders GoFood.',
  categories: [
    {
      category: 'Makan Nafsu',
      scope: 'Impulsive snacking, boba, and gourmet desserts non-staple meals.',
      examples: ['boba chatime', 'kopi kenangan', 'croissant'],
      exclusions: ['makan siang kantor', 'nasi warteg'],
    },
    {
      category: 'Home & garden',
      scope: 'Home furniture, cleaning supplies, and domestic maintenance.',
      examples: ['sapu dan pel', 'sprei kasur'],
      exclusions: ['alat kerja kantor', 'gadget'],
    },
  ],
};

let temporaryDirectory = '';

function writeFixture(name: string, payload: unknown): string {
  const filePath = path.join(temporaryDirectory, name);
  fs.writeFileSync(filePath, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

function createValidContextService(): { service: CategoryContextService; filePath: string } {
  const filePath = writeFixture('valid-category-context.json', validJsonPayload);
  return { service: new CategoryContextService(filePath), filePath };
}

describe('category context and disambiguation', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T06:00:00.000Z'));
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'category-context-vitest-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('loads array-format configuration and the tracked example configuration', () => {
    const { service } = createValidContextService();
    const configuration = service.getConfiguration();

    expect(configuration.version).toBe('1.0');
    expect(configuration.userContextSummary).toContain('Software engineer living in Jakarta');
    expect(configuration.categoryRules).toHaveLength(2);
    const nafsuRule = configuration.categoryRules.find(rule => rule.category === 'Makan Nafsu');
    expect(nafsuRule).toBeDefined();
    expect(nafsuRule?.examples).toContain('boba chatime');
    expect(nafsuRule?.exclusions).toContain('nasi warteg');
    expect(service.getContextFingerprint().length).toBeGreaterThan(0);

    const repoExampleFilePath = path.resolve(process.cwd(), 'config/category-context.example.json');
    expect(fs.existsSync(repoExampleFilePath)).toBe(true);
    const exampleService = new CategoryContextService(repoExampleFilePath);
    expect(exampleService.getConfiguration().categoryRules.length).toBeGreaterThanOrEqual(3);
  });

  it('loads dictionary/map category configuration', () => {
    const filePath = writeFixture('dictionary-category-context.json', {
      userContext: 'Remote developer in Bandung.',
      categories: {
        'Makan Nafsu': {
          scope: 'Boba and coffee.',
          examples: ['kopi tuku'],
          exclusions: ['nasi padang'],
        },
        Entertainment: {
          scope: 'Movies and streaming services.',
          examples: ['netflix', 'cinema xxi'],
        },
      },
    });
    const configuration = new CategoryContextService(filePath).getConfiguration();

    expect(configuration.categoryRules).toHaveLength(2);
    expect(configuration.categoryRules.some(rule => rule.category === 'Entertainment')).toBe(true);
  });

  it('falls back safely when the configuration file is missing', () => {
    const service = new CategoryContextService(path.join(temporaryDirectory, 'does-not-exist.json'));

    expect(service.getConfiguration().categoryRules).toHaveLength(0);
    expect(service.getConfiguration().userContextSummary).toBe('');
    expect(service.getContextFingerprint()).toBe('');
    expect(service.formatCompactContext(mockCategories)).toBe('');
  });

  it('falls back safely when configuration JSON is malformed', () => {
    const filePath = writeFixture(
      'corrupted-category-context.json',
      '{ "version": "1.0", "categories": [ INVALID JSON HERE ] }'
    );
    const service = new CategoryContextService(filePath);

    expect(service.getConfiguration().categoryRules).toHaveLength(0);
    expect(service.getContextFingerprint()).toBe('');
    expect(service.formatCompactContext()).toBe('');
  });

  it('keeps valid rules while sanitizing partially invalid configuration', () => {
    const filePath = writeFixture('partial-invalid-category-context.json', {
      userContext: 12345,
      categories: [
        { category: 'Makan Nafsu', scope: 'Snacks and coffee', examples: ['boba', 123], exclusions: 'not an array' },
        { scope: 'Missing category name should be skipped' },
        { category: '', scope: 'Empty name' },
        { category: 'Valid Category', scope: 'Clean scope' },
        'not even an object',
      ],
    });
    const configuration = new CategoryContextService(filePath).getConfiguration();

    expect(configuration.categoryRules).toHaveLength(2);
    expect(configuration.categoryRules[0].category).toBe('Makan Nafsu');
    expect(configuration.categoryRules[0].examples).toEqual(['boba']);
    expect(configuration.categoryRules[0].exclusions).toBeUndefined();
    expect(configuration.categoryRules[1].category).toBe('Valid Category');
  });

  it('formats compact context in deterministic alphabetical order', () => {
    const filePath = writeFixture('unsorted-category-context.json', {
      userContext: 'Tech worker in BSD.',
      categories: [
        { category: 'Zebra Supplies', scope: 'Rare items' },
        { category: 'Alpha Groceries', scope: 'Basic food' },
        { category: 'Beta Travel', scope: 'Flights and trains' },
      ],
    });
    const output = new CategoryContextService(filePath).formatCompactContext();

    expect(output).toContain('CATEGORY SEMANTICS & RULES:');
    expect(output).toContain('USER CONTEXT:\nTech worker in BSD.');
    const alphaIndex = output.indexOf('"Alpha Groceries"');
    const betaIndex = output.indexOf('"Beta Travel"');
    const zebraIndex = output.indexOf('"Zebra Supplies"');
    expect(alphaIndex).toBeGreaterThanOrEqual(0);
    expect(betaIndex).toBeGreaterThan(alphaIndex);
    expect(zebraIndex).toBeGreaterThan(betaIndex);
  });

  it('filters semantic rules to active Wallet categories', () => {
    const { service } = createValidContextService();
    const output = service.formatCompactContext([
      { id: 'cat-nafsu', name: 'Makan Nafsu' },
      { id: 'cat-fnb', name: 'Food & Beverage' },
    ]);

    expect(output).toContain('Makan Nafsu');
    expect(output).not.toContain('Home & garden');
  });

  it('formats object-style lifestyle user context', () => {
    const filePath = writeFixture('object-context.json', {
      userContext: {
        profile: 'Data Scientist working hybrid in South Jakarta',
        notes: ['Commutes via MRT daily', 'Prefers cashless QRIS payments'],
      },
      categories: [{ category: 'Commute', scope: 'Daily MRT and train fares' }],
    });
    const output = new CategoryContextService(filePath).formatCompactContext();

    expect(output).toContain('Data Scientist working hybrid in South Jakarta');
    expect(output).toContain('- Commutes via MRT daily');
  });

  it('invalidates Gemini system-instruction cache when context changes', () => {
    const filePath = writeFixture('dynamic-category-context.json', {
      categories: [{ category: 'Makan Nafsu', scope: 'Initial Scope V1' }],
    });
    const service = new CategoryContextService(filePath);
    const provider = new GeminiAiProvider('mock-key', 'gemini-3.6-flash', [], 20000, service);

    const initialInstruction = provider.getSystemInstruction(mockAccounts, mockCategories);
    const initialCacheKey = provider.getSystemInstructionCacheKey();
    expect(initialInstruction).toContain('Initial Scope V1');

    fs.writeFileSync(
      filePath,
      JSON.stringify({ categories: [{ category: 'Makan Nafsu', scope: 'Updated Scope V2' }] }),
      'utf8'
    );
    service.reload();

    const updatedInstruction = provider.getSystemInstruction(mockAccounts, mockCategories);
    const updatedCacheKey = provider.getSystemInstructionCacheKey();
    expect(updatedCacheKey).not.toBe(initialCacheKey);
    expect(updatedInstruction).toContain('Updated Scope V2');
    expect(updatedInstruction).not.toContain('Initial Scope V1');
  });

  it('measures prompt character/token overhead and active category counts', () => {
    const { service } = createValidContextService();
    const report = service.measureOverhead(mockCategories);

    expect(report.formattedCharacterCount).toBeGreaterThan(0);
    expect(report.estimatedTokenCount).toBeGreaterThan(0);
    expect(report.activeCategoryCount).toBe(2);
    expect(report.configuredCategoryCount).toBe(2);
  });

  it('injects custom category semantics consistently across prompt builders and provider construction', () => {
    const { service } = createValidContextService();
    const compactContext = service.formatCompactContext(mockCategories);
    const now = new Date('2026-09-13T06:00:00.000Z');

    const textInstruction = buildCompactSystemInstruction(
      mockAccounts,
      mockCategories,
      '2026-09-11',
      'Asia/Jakarta',
      now,
      compactContext
    );
    expect(textInstruction).toContain('prioritizing user-defined meanings over generic dictionary names');
    expect(textInstruction).toContain('Ex: boba chatime, kopi kenangan');
    expect(textInstruction).toContain('Exclude: makan siang kantor, nasi warteg');

    const receiptInstruction = buildReceiptSystemInstruction(
      mockAccounts,
      mockCategories,
      '2026-09-11',
      'Asia/Jakarta',
      now,
      compactContext
    );
    expect(receiptInstruction).toContain('CATEGORY SEMANTICS & RULES:');
    expect(receiptInstruction).toContain('Home & garden');

    const emailInstruction = buildEmailSystemInstruction(mockAccounts, mockCategories, compactContext);
    expect(emailInstruction).toContain('CATEGORY SEMANTICS & RULES:');
    expect(emailInstruction).toContain('adhere to any custom category semantics and exclusions defined in CATEGORY SEMANTICS & RULES');

    const openAiProvider = new OpenAiCompatibleAiProvider({
      providerName: 'test-openai',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      primaryModelName: 'gpt-4o-mini',
      categoryContextService: service,
    });
    expect(openAiProvider).toBeTruthy();
  });

  it('preserves user context but renders no semantic rules for an explicitly empty active-category list', () => {
    const { service } = createValidContextService();
    const output = service.formatCompactContext([]);
    const report = service.measureOverhead([]);

    expect(output).not.toContain('CATEGORY SEMANTICS & RULES:');
    expect(output).toContain('USER CONTEXT:\nSoftware engineer living in Jakarta');
    expect(report.activeCategoryCount).toBe(0);
    expect(report.configuredCategoryCount).toBe(2);
  });

  it('auto-reloads modified/deleted files and integrates with Application reload', () => {
    const autoReloadFilePath = writeFixture('autoreload-category-context.json', {
      userContext: 'V1 User Context',
      categories: [{ category: 'Category V1', scope: 'Scope 1' }],
    });
    const service = new CategoryContextService(autoReloadFilePath);
    const v1Fingerprint = service.getContextFingerprint();
    expect(service.getConfiguration().userContextSummary).toBe('V1 User Context');

    const futureTimestamp = new Date(Date.now() + 5000);
    fs.writeFileSync(
      autoReloadFilePath,
      JSON.stringify({ userContext: 'V2 User Context', categories: [{ category: 'Category V2', scope: 'Scope 2' }] }),
      'utf8'
    );
    fs.utimesSync(autoReloadFilePath, futureTimestamp, futureTimestamp);

    const v2Fingerprint = service.getContextFingerprint();
    expect(v2Fingerprint).not.toBe(v1Fingerprint);
    expect(service.getConfiguration().userContextSummary).toBe('V2 User Context');

    fs.unlinkSync(autoReloadFilePath);
    expect(service.refreshIfModifiedOnDisk()).toBe(true);
    expect(service.getContextFingerprint()).toBe('');

    const { filePath } = createValidContextService();
    const app = new Application({
      walletMcpBaseUrl: 'http://localhost:8000',
      walletMcpAccessToken: 'test-token',
      categoryContextFilePath: filePath,
      geminiApiKey: 'test-key',
      enabledMessengerChannels: [],
    } as any);
    expect(app.getCategoryContextService()).toBeTruthy();
    expect(app.reloadCategoryContext().isValid).toBe(true);
  });

  it('handles dictionary-format edge cases and computes an empty fingerprint for empty config', () => {
    const filePath = writeFixture('edge-case-dictionary.json', {
      userContext: 'Developer with custom categories',
      categories: {
        'Groceries & Supermarket': {
          category: 'WrongNestedName',
          scope: 'Weekly groceries',
          examples: ['fruits', 'vegetables'],
          exclusions: ['restaurants'],
        },
        InvalidArrayRule: ['this', 'should', 'be', 'skipped'],
      },
    });
    const service = new CategoryContextService(filePath);
    const configuration = service.getConfiguration();

    expect(configuration.categoryRules).toHaveLength(1);
    expect(configuration.categoryRules[0].category).toBe('Groceries & Supermarket');
    expect(configuration.categoryRules.some(rule => rule.category === 'WrongNestedName')).toBe(false);
    expect(configuration.categoryRules.some(rule => rule.category === 'InvalidArrayRule')).toBe(false);

    const { service: validService } = createValidContextService();
    const emptyFingerprint = (validService as any).computeContextFingerprint({
      version: '1.0',
      userContextSummary: '',
      categoryRules: [],
    });
    expect(emptyFingerprint).toBe('');
  });

  it('injects category context during Gemini and OpenAI-compatible text, image, and email execution', async () => {
    const { service } = createValidContextService();
    const geminiProvider = new GeminiAiProvider('mock-key', 'gemini-3.6-flash', [], 20000, service);
    const mockGeminiClient = (geminiProvider as any).googleGenAiClient;
    const originalGenerateContent = mockGeminiClient.models.generateContent;
    let geminiCapturedInstruction: string | undefined;

    try {
      mockGeminiClient.models.generateContent = async (requestConfig: any) => {
        geminiCapturedInstruction = requestConfig.config?.systemInstruction;
        return {
          text: JSON.stringify({
            action: 'CREATE_RECORD',
            records: [{
              amount: -45000,
              accountId: 'acc-1',
              categoryId: 'cat-nafsu',
              recordDate: '2026-09-08T04:54:00.000Z',
              currency: 'IDR',
              note: 'Boba and cake',
            }],
          }),
          usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 },
        };
      };

      const dummyImageBuffer = Buffer.from('mock-image-data');
      const geminiImageResult = await geminiProvider.processImageMessage(
        dummyImageBuffer,
        'image/jpeg',
        'Struk boba',
        mockAccounts,
        mockCategories
      );
      expect(geminiImageResult.action).toBe('CREATE_RECORD');
      expect(geminiCapturedInstruction).toContain('CATEGORY SEMANTICS & RULES:');

      mockGeminiClient.models.generateContent = async (requestConfig: any) => {
        geminiCapturedInstruction = requestConfig.config?.systemInstruction;
        return {
          text: JSON.stringify({
            isTransaction: true,
            transactionType: 'EXPENSE',
            amount: 150000,
            counterParty: 'Supermarket',
            accountNameHint: 'Cash',
            matchedCategoryId: 'cat-nafsu',
            note: 'Weekly groceries',
            recordDate: '2026-09-11T12:00:00.000Z',
            explanation: 'Payment to Supermarket detected',
          }),
          usageMetadata: { promptTokenCount: 140, candidatesTokenCount: 45, totalTokenCount: 185 },
        };
      };

      const mockGateResult: GateEvaluationResult = {
        isFinancial: true,
        confidence: 'HIGH',
        channel: 'EMAIL',
        detectedBank: 'BCA',
        detectedCurrency: 'IDR',
        detectedAmount: 150000,
        detectedTimestamp: new Date('2026-09-13T06:00:00.000Z'),
      };
      const geminiEmailResult = await geminiProvider.processEmailTransactionMessage(
        mockGateResult,
        'Payment to Supermarket',
        'alerts@bca.co.id',
        'Transaksi berhasil sebesar IDR 150.000 di Supermarket',
        new Date('2026-09-13T06:00:00.000Z'),
        mockAccounts,
        mockCategories
      );
      expect(geminiEmailResult.isTransaction).toBe(true);
      expect(geminiEmailResult.amount).toBe(150000);
      expect(geminiCapturedInstruction).toContain('CATEGORY SEMANTICS & RULES:');

      const openAiProvider = new OpenAiCompatibleAiProvider({
        providerName: 'test-openai',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: 'test-key',
        primaryModelName: 'gpt-4o-mini',
        categoryContextService: service,
      });
      const mockHttpClient = (openAiProvider as any).httpClient;
      let openAiCapturedMessages: Array<{ role: string; content: string }> = [];

      mockHttpClient.post = async (_url: string, payload: any) => {
        openAiCapturedMessages = payload.messages;
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({
              action: 'RECORD_EXPENSE',
              records: [{ amount: -35000, accountId: 'acc-1', categoryId: 'cat-nafsu', note: 'Boba Chatime' }],
            }) } }],
            usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
          },
        };
      };
      const openAiTextResult = await openAiProvider.processTextMessage(
        'Beli boba chatime 35rb bayar tunai',
        mockAccounts,
        mockCategories
      );
      expect(openAiTextResult.action).toBe('RECORD_EXPENSE');
      expect(openAiCapturedMessages.find(message => message.role === 'system')?.content).toContain('CATEGORY SEMANTICS & RULES:');

      mockHttpClient.post = async (_url: string, payload: any) => {
        openAiCapturedMessages = payload.messages;
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({
              action: 'CREATE_RECORD',
              records: [{
                amount: -35000,
                accountId: 'acc-1',
                categoryId: 'cat-nafsu',
                recordDate: '2026-09-08T04:54:00.000Z',
                currency: 'IDR',
                note: 'Boba Chatime',
              }],
            }) } }],
            usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
          },
        };
      };
      const openAiImageResult = await openAiProvider.processImageMessage(
        dummyImageBuffer,
        'image/jpeg',
        'Kwitansi toko',
        mockAccounts,
        mockCategories
      );
      expect(openAiImageResult.action).toBe('CREATE_RECORD');
      expect(openAiCapturedMessages.find(message => message.role === 'system')?.content).toContain('CATEGORY SEMANTICS & RULES:');

      mockHttpClient.post = async (_url: string, payload: any) => {
        openAiCapturedMessages = payload.messages;
        return {
          data: {
            choices: [{ message: { content: JSON.stringify({
              isTransaction: true,
              transactionType: 'EXPENSE',
              amount: 35000,
              counterParty: 'Kopi Kenangan',
              accountNameHint: 'Cash',
              matchedCategoryId: 'cat-nafsu',
              note: 'Coffee',
              recordDate: '2026-09-11T12:00:00.000Z',
              explanation: 'QRIS payment detected',
            }) } }],
            usage: { prompt_tokens: 160, completion_tokens: 50, total_tokens: 210 },
          },
        };
      };
      const openAiEmailResult = await openAiProvider.processEmailTransactionMessage(
        mockGateResult,
        'Notifikasi Debit BCA',
        'alerts@bca.co.id',
        'Pembayaran QRIS 35.000 ke Kopi Kenangan berhasil',
        new Date('2026-09-13T06:00:00.000Z'),
        mockAccounts,
        mockCategories
      );
      expect(openAiEmailResult.isTransaction).toBe(true);
      expect(openAiEmailResult.amount).toBe(35000);
      expect(openAiCapturedMessages.find(message => message.role === 'system')?.content).toContain('CATEGORY SEMANTICS & RULES:');
    } finally {
      mockGeminiClient.models.generateContent = originalGenerateContent;
    }
  });
});
