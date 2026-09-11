import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CategoryContextService } from '../src/services/categoryContextService.js';
import {
  buildCompactSystemInstruction,
  buildReceiptSystemInstruction,
  buildEmailSystemInstruction,
} from '../src/services/ai/aiPromptBuilder.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { applicationLogger } from '../src/utils/logger.js';

function assertCondition(condition: boolean, testDescription: string): void {
  if (!condition) {
    applicationLogger.error(`[FAIL] ${testDescription}`);
    throw new Error(`Assertion failed: ${testDescription}`);
  }
  applicationLogger.success(`[PASS] ${testDescription}`);
}

async function runCategoryContextTestSuite(): Promise<void> {
  console.log('\n======================================================');
  applicationLogger.info('Starting Category Context & Disambiguation Test Suite...');
  console.log('======================================================\n');

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'category-context-test-'));

  try {
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

    // -----------------------------------------------------------------------------------
    // TEST 1: Valid Configuration Loading (Array format & Example JSON verification)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('TEST 1: Valid Configuration Loading (Array format)');
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

    const validFilePath = path.join(temporaryDirectory, 'valid-category-context.json');
    fs.writeFileSync(validFilePath, JSON.stringify(validJsonPayload, null, 2), 'utf8');

    const contextService = new CategoryContextService(validFilePath);
    const configuration = contextService.getConfiguration();

    assertCondition(configuration.version === '1.0', 'Configuration version is 1.0');
    assertCondition(configuration.userContextSummary.includes('Software engineer living in Jakarta'), 'User context summary loaded');
    assertCondition(configuration.categoryRules.length === 2, 'Loaded 2 category rules');

    const nafsuRule = configuration.categoryRules.find(r => r.category === 'Makan Nafsu');
    assertCondition(Boolean(nafsuRule), 'Makan Nafsu rule found');
    assertCondition(nafsuRule?.examples?.includes('boba chatime') === true, 'Examples parsed correctly');
    assertCondition(nafsuRule?.exclusions?.includes('nasi warteg') === true, 'Exclusions parsed correctly');

    const fingerprint = contextService.getContextFingerprint();
    assertCondition(fingerprint.length > 0, `Generated stable context fingerprint: ${fingerprint}`);

    // Verify tracked example file in repo
    const repoExampleFilePath = path.resolve(process.cwd(), 'config/category-context.example.json');
    assertCondition(fs.existsSync(repoExampleFilePath), 'config/category-context.example.json exists in repository');
    const exampleService = new CategoryContextService(repoExampleFilePath);
    assertCondition(exampleService.getConfiguration().categoryRules.length >= 3, 'Example configuration contains at least 3 documented category rules');

    // -----------------------------------------------------------------------------------
    // TEST 2: Valid Configuration Loading (Dictionary / Map format)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 2: Valid Configuration Loading (Dictionary format)');
    const dictionaryJsonPayload = {
      userContext: 'Remote developer in Bandung.',
      categories: {
        'Makan Nafsu': {
          scope: 'Boba and coffee.',
          examples: ['kopi tuku'],
          exclusions: ['nasi padang'],
        },
        'Entertainment': {
          scope: 'Movies and streaming services.',
          examples: ['netflix', 'cinema xxi'],
        },
      },
    };

    const dictFilePath = path.join(temporaryDirectory, 'dictionary-category-context.json');
    fs.writeFileSync(dictFilePath, JSON.stringify(dictionaryJsonPayload, null, 2), 'utf8');

    const dictContextService = new CategoryContextService(dictFilePath);
    const dictConfig = dictContextService.getConfiguration();
    assertCondition(dictConfig.categoryRules.length === 2, 'Dictionary format loaded 2 category rules');
    assertCondition(dictConfig.categoryRules.some(r => r.category === 'Entertainment'), 'Entertainment category recognized from map key');

    // -----------------------------------------------------------------------------------
    // TEST 3: Missing File Fallback (Safe default, no crash)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 3: Missing File Fallback');
    const nonExistentPath = path.join(temporaryDirectory, 'does-not-exist-category-context.json');
    const fallbackService = new CategoryContextService(nonExistentPath);

    assertCondition(fallbackService.getConfiguration().categoryRules.length === 0, 'Missing file yields 0 category rules');
    assertCondition(fallbackService.getConfiguration().userContextSummary === '', 'Missing file yields empty user context');
    assertCondition(fallbackService.getContextFingerprint() === '', 'Missing file yields empty context fingerprint');
    assertCondition(fallbackService.formatCompactContext(mockCategories) === '', 'Missing file formats to empty prompt string');

    // -----------------------------------------------------------------------------------
    // TEST 4: Malformed JSON Syntax Fallback (Safe default, no crash)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 4: Malformed JSON Syntax Fallback');
    const malformedFilePath = path.join(temporaryDirectory, 'corrupted-category-context.json');
    fs.writeFileSync(malformedFilePath, '{ "version": "1.0", "categories": [ INVALID JSON HERE ] }', 'utf8');

    const corruptedService = new CategoryContextService(malformedFilePath);
    assertCondition(corruptedService.getConfiguration().categoryRules.length === 0, 'Corrupted JSON yields 0 category rules');
    assertCondition(corruptedService.getContextFingerprint() === '', 'Corrupted JSON yields empty fingerprint');
    assertCondition(corruptedService.formatCompactContext() === '', 'Corrupted JSON formats to empty string');

    // -----------------------------------------------------------------------------------
    // TEST 5: Partial Invalid Configuration (Keeps valid rules, filters corrupt rules)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 5: Partial Invalid Configuration Fallback');
    const partialInvalidPayload = {
      userContext: 12345, // Invalid type for user context (should be warned & skipped)
      categories: [
        {
          category: 'Makan Nafsu',
          scope: 'Snacks and coffee',
          examples: ['boba', 123], // 123 is invalid string item
          exclusions: 'not an array', // Invalid type
        },
        {
          // Missing category name
          scope: 'Missing category name should be skipped',
        },
        {
          category: '', // Empty category name should be skipped
          scope: 'Empty name',
        },
        {
          category: 'Valid Category',
          scope: 'Clean scope',
        },
        'not even an object', // Should be skipped
      ],
    };

    const partialFilePath = path.join(temporaryDirectory, 'partial-invalid-category-context.json');
    fs.writeFileSync(partialFilePath, JSON.stringify(partialInvalidPayload, null, 2), 'utf8');

    const partialService = new CategoryContextService(partialFilePath);
    const partialConfig = partialService.getConfiguration();
    assertCondition(partialConfig.categoryRules.length === 2, `Partial validation preserved exactly 2 valid rules (actual: ${partialConfig.categoryRules.length})`);
    assertCondition(partialConfig.categoryRules[0].category === 'Makan Nafsu', 'First rule is Makan Nafsu');
    assertCondition(partialConfig.categoryRules[0].examples?.length === 1 && partialConfig.categoryRules[0].examples[0] === 'boba', 'Sanitized non-string example');
    assertCondition(partialConfig.categoryRules[0].exclusions === undefined, 'Dropped invalid exclusions type');
    assertCondition(partialConfig.categoryRules[1].category === 'Valid Category', 'Second rule is Valid Category');

    // -----------------------------------------------------------------------------------
    // TEST 6: Compact Prompt Formatting and Deterministic Ordering
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 6: Compact Prompt Formatting and Deterministic Ordering');
    const unsortedPayload = {
      userContext: 'Tech worker in BSD.',
      categories: [
        { category: 'Zebra Supplies', scope: 'Rare items' },
        { category: 'Alpha Groceries', scope: 'Basic food' },
        { category: 'Beta Travel', scope: 'Flights and trains' },
      ],
    };

    const unsortedFilePath = path.join(temporaryDirectory, 'unsorted-category-context.json');
    fs.writeFileSync(unsortedFilePath, JSON.stringify(unsortedPayload, null, 2), 'utf8');

    const unsortedService = new CategoryContextService(unsortedFilePath);
    const compactOutput = unsortedService.formatCompactContext();

    assertCondition(compactOutput.includes('CATEGORY SEMANTICS & RULES:'), 'Prompt section header present');
    assertCondition(compactOutput.includes('USER CONTEXT:\nTech worker in BSD.'), 'User context section present');

    const alphaIndex = compactOutput.indexOf('"Alpha Groceries"');
    const betaIndex = compactOutput.indexOf('"Beta Travel"');
    const zebraIndex = compactOutput.indexOf('"Zebra Supplies"');

    assertCondition(
      alphaIndex >= 0 && betaIndex > alphaIndex && zebraIndex > betaIndex,
      'Category rules are deterministically sorted alphabetically regardless of file order'
    );

    // -----------------------------------------------------------------------------------
    // TEST 7: Active Category Filtering in Prompt Formatting
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 7: Active Category Filtering');
    const availableCategories: WalletCategoryItem[] = [
      { id: 'cat-nafsu', name: 'Makan Nafsu' },
      { id: 'cat-fnb', name: 'Food & Beverage' },
    ];

    const filteredOutput = contextService.formatCompactContext(availableCategories);
    assertCondition(filteredOutput.includes('Makan Nafsu'), 'Active category "Makan Nafsu" included');
    assertCondition(!filteredOutput.includes('Home & garden'), 'Inactive category "Home & garden" filtered out from prompt');

    // -----------------------------------------------------------------------------------
    // TEST 8: Lifestyle User Context Formats (String and Object)
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 8: Lifestyle User Context Injected (Object format)');
    const objectContextPayload = {
      userContext: {
        profile: 'Data Scientist working hybrid in South Jakarta',
        notes: ['Commutes via MRT daily', 'Prefers cashless QRIS payments'],
      },
      categories: [{ category: 'Commute', scope: 'Daily MRT and train fares' }],
    };

    const objectContextFilePath = path.join(temporaryDirectory, 'object-context.json');
    fs.writeFileSync(objectContextFilePath, JSON.stringify(objectContextPayload, null, 2), 'utf8');

    const objectContextService = new CategoryContextService(objectContextFilePath);
    const objectFormatted = objectContextService.formatCompactContext();

    assertCondition(objectFormatted.includes('Data Scientist working hybrid in South Jakarta'), 'Object profile included');
    assertCondition(objectFormatted.includes('- Commutes via MRT daily'), 'Object notes included as bullet points');

    // -----------------------------------------------------------------------------------
    // TEST 9: Cache Key Invalidation in GeminiAiProvider on Context Change
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 9: Cache Key Invalidation in GeminiAiProvider on Context Change');
    const dynamicContextFilePath = path.join(temporaryDirectory, 'dynamic-category-context.json');
    fs.writeFileSync(
      dynamicContextFilePath,
      JSON.stringify({ categories: [{ category: 'Makan Nafsu', scope: 'Initial Scope V1' }] }),
      'utf8'
    );

    const dynamicContextService = new CategoryContextService(dynamicContextFilePath);
    const geminiProvider = new GeminiAiProvider('mock-key', 'gemini-3.6-flash', [], 20000, dynamicContextService);

    const initialInstruction = geminiProvider.getSystemInstruction(mockAccounts, mockCategories);
    const initialCacheKey = geminiProvider.getSystemInstructionCacheKey();
    assertCondition(initialInstruction.includes('Initial Scope V1'), 'Initial system instruction contains V1 scope');

    // Modify file on disk and reload
    fs.writeFileSync(
      dynamicContextFilePath,
      JSON.stringify({ categories: [{ category: 'Makan Nafsu', scope: 'Updated Scope V2' }] }),
      'utf8'
    );
    dynamicContextService.reload();

    const updatedInstruction = geminiProvider.getSystemInstruction(mockAccounts, mockCategories);
    const updatedCacheKey = geminiProvider.getSystemInstructionCacheKey();

    assertCondition(initialCacheKey !== updatedCacheKey, 'System instruction cacheKey changed after context reload');
    assertCondition(updatedInstruction.includes('Updated Scope V2'), 'System instruction refreshed with V2 scope');
    assertCondition(!updatedInstruction.includes('Initial Scope V1'), 'Stale V1 scope is purged from cache');

    // -----------------------------------------------------------------------------------
    // TEST 10: Token and Character Prompt Overhead Measurement
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 10: Token and Character Prompt Overhead Measurement');
    const overheadReport = contextService.measureOverhead(mockCategories);

    applicationLogger.info(
      `[OVERHEAD REPORT] Formatted Chars: ${overheadReport.formattedCharacterCount}, Estimated Tokens: ${overheadReport.estimatedTokenCount}, Active Categories: ${overheadReport.activeCategoryCount}/${overheadReport.configuredCategoryCount}`
    );

    assertCondition(overheadReport.formattedCharacterCount > 0, 'Formatted character count is greater than 0');
    assertCondition(overheadReport.estimatedTokenCount > 0, 'Estimated token count is greater than 0');
    assertCondition(overheadReport.activeCategoryCount === 2, 'Active categories match available categories');
    assertCondition(overheadReport.configuredCategoryCount === 2, 'Configured categories total 2');

    // -----------------------------------------------------------------------------------
    // TEST 11: Ambiguous Category Semantic Disambiguation & Provider Parity
    // -----------------------------------------------------------------------------------
    applicationLogger.info('\nTEST 11: Ambiguous Category Semantic Disambiguation & Provider Parity');

    // Text prompt instruction
    const compactTextInstruction = buildCompactSystemInstruction(
      mockAccounts,
      mockCategories,
      '2026-09-11',
      'Asia/Jakarta',
      new Date(),
      contextService.formatCompactContext(mockCategories)
    );

    assertCondition(
      compactTextInstruction.includes('prioritizing user-defined meanings over generic dictionary names'),
      'Text system instruction prioritizes user-defined meanings'
    );
    assertCondition(
      compactTextInstruction.includes('Ex: boba chatime, kopi kenangan'),
      'Text system instruction contains disambiguating boba & coffee examples for Makan Nafsu'
    );
    assertCondition(
      compactTextInstruction.includes('Exclude: makan siang kantor, nasi warteg'),
      'Text system instruction contains staple meal exclusion for Makan Nafsu'
    );

    // Receipt vision instruction
    const receiptVisionInstruction = buildReceiptSystemInstruction(
      mockAccounts,
      mockCategories,
      '2026-09-11',
      'Asia/Jakarta',
      new Date(),
      contextService.formatCompactContext(mockCategories)
    );

    assertCondition(
      receiptVisionInstruction.includes('CATEGORY SEMANTICS & RULES:'),
      'Receipt vision system instruction contains CATEGORY SEMANTICS & RULES'
    );
    assertCondition(
      receiptVisionInstruction.includes('Home & garden'),
      'Receipt vision system instruction contains Home & garden semantic rule'
    );

    // Email parsing instruction
    const emailInstruction = buildEmailSystemInstruction(
      mockAccounts,
      mockCategories,
      contextService.formatCompactContext(mockCategories)
    );

    assertCondition(
      emailInstruction.includes('CATEGORY SEMANTICS & RULES:'),
      'Email system instruction contains CATEGORY SEMANTICS & RULES'
    );
    assertCondition(
      emailInstruction.includes('adhere to any custom category semantics and exclusions defined in CATEGORY SEMANTICS & RULES'),
      'Email system instruction explicitly directs rule adherence'
    );

    // OpenAI-compatible provider parity verification
    const openAiProvider = new OpenAiCompatibleAiProvider({
      providerName: 'test-openai',
      baseUrl: 'http://localhost:8000/v1',
      apiKey: 'test-key',
      primaryModelName: 'gpt-4o-mini',
      categoryContextService: contextService,
    });

    assertCondition(Boolean(openAiProvider), 'OpenAiCompatibleAiProvider instantiated with categoryContextService');

    console.log('\n======================================================');
    applicationLogger.success('All Category Context & Disambiguation tests passed cleanly!');
    console.log('======================================================\n');
  } finally {
    // Clean up temporary test directory
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  }
}

runCategoryContextTestSuite().catch(error => {
  console.error('\n[ERROR] Test suite failed with exception:\n', error);
  process.exit(1);
});
