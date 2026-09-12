import assert from 'node:assert/strict';
import {
  SystemInstructionCache,
  prepareTextMessagePrompt,
  prepareReceiptPrompt,
  prepareEmailEvaluationPrompt,
  postProcessFinancialIntentResponse,
  postProcessReceiptVisionResponse,
  postProcessEmailTransactionResponse,
  isRecoverableModelExecutionError,
  executeTextWorkflow,
  executeReceiptWorkflow,
  executeEmailTransactionWorkflow,
  AiExecutionResult,
} from '../src/services/ai/aiProviderWorkflow.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { GateEvaluationResult } from '../src/utils/emailGateEvaluator.js';
import { CategoryContextService } from '../src/services/categoryContextService.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';

async function runAiProviderWorkflowTestSuite(): Promise<void> {
  console.log('Running AI Provider Workflow Test Suite...');

  const mockAccountList: WalletAccountItem[] = [
    { id: 'account-cash-id', name: 'Cash Wallet', currency: 'IDR' },
    { id: 'account-bca-id', name: 'BCA Account', currency: 'IDR' },
  ];

  const mockCategoryList: WalletCategoryItem[] = [
    { id: 'category-food-id', name: 'Food & Dining' },
    { id: 'category-transport-id', name: 'Transportation' },
  ];

  const fixedReferenceInstant = new Date('2026-09-13T10:00:00.000Z');

  // =========================================================================
  // Test 1: SystemInstructionCache hit and invalidation
  // =========================================================================
  console.log('Test 1: SystemInstructionCache caching and invalidation');
  const instructionCache = new SystemInstructionCache();

  const firstInstruction = instructionCache.getSystemInstruction(
    mockAccountList,
    mockCategoryList,
    fixedReferenceInstant
  );
  const firstCacheKey = instructionCache.getCacheKey();

  assert.ok(firstInstruction.length > 0, 'Instruction should be compiled');
  assert.ok(firstCacheKey.length > 0, 'Cache key should be non-empty');

  // Second call with same inputs should hit cache
  const secondInstruction = instructionCache.getSystemInstruction(
    mockAccountList,
    mockCategoryList,
    fixedReferenceInstant
  );
  const secondCacheKey = instructionCache.getCacheKey();

  assert.equal(secondInstruction, firstInstruction, 'Instruction should match cached value');
  assert.equal(secondCacheKey, firstCacheKey, 'Cache key should be identical');

  // Invalidation: date change
  const nextDayReferenceInstant = new Date('2026-09-14T10:00:00.000Z');
  const nextDayInstruction = instructionCache.getSystemInstruction(
    mockAccountList,
    mockCategoryList,
    nextDayReferenceInstant
  );
  const nextDayCacheKey = instructionCache.getCacheKey();

  assert.notEqual(nextDayCacheKey, firstCacheKey, 'Cache key should change on date boundary');
  assert.ok(nextDayInstruction.length > 0, 'Next day instruction compiled');

  // Invalidation: account list change
  const expandedAccountList: WalletAccountItem[] = [
    ...mockAccountList,
    { id: 'account-gopay-id', name: 'GoPay', currency: 'IDR' },
  ];
  instructionCache.getSystemInstruction(expandedAccountList, mockCategoryList, fixedReferenceInstant);
  const accountChangeCacheKey = instructionCache.getCacheKey();
  assert.notEqual(accountChangeCacheKey, firstCacheKey, 'Cache key should change when accounts change');

  console.log('[PASS] Test 1: SystemInstructionCache verified.');

  // =========================================================================
  // Test 2: prepareTextMessagePrompt trims message and builds request context
  // =========================================================================
  console.log('Test 2: prepareTextMessagePrompt');
  const preparedText = prepareTextMessagePrompt(
    '  Beli makan siang 25000 pakai BCA  ',
    mockAccountList,
    mockCategoryList,
    fixedReferenceInstant,
    instructionCache
  );

  assert.ok(preparedText.promptText.includes('Beli makan siang 25000 pakai BCA'));
  assert.equal(preparedText.requestContextDescription, 'Text message: "Beli makan siang 25000 pakai BCA"');
  assert.ok(preparedText.systemInstruction.length > 0);
  console.log('[PASS] Test 2: prepareTextMessagePrompt verified.');

  // =========================================================================
  // Test 3: prepareReceiptPrompt formats receipt context
  // =========================================================================
  console.log('Test 3: prepareReceiptPrompt');
  const preparedReceipt = prepareReceiptPrompt(
    'image/jpeg',
    1024,
    'Lunch receipt',
    mockAccountList,
    mockCategoryList,
    fixedReferenceInstant
  );

  assert.ok(preparedReceipt.promptText.includes('Lunch receipt'));
  assert.equal(
    preparedReceipt.requestContextDescription,
    'Receipt photo message (mime: image/jpeg, size: 1024 bytes, caption: "Lunch receipt")'
  );
  assert.ok(preparedReceipt.systemInstruction.length > 0);
  console.log('[PASS] Test 3: prepareReceiptPrompt verified.');

  // =========================================================================
  // Test 4: prepareEmailEvaluationPrompt builds Gate 1 evaluation context
  // =========================================================================
  console.log('Test 4: prepareEmailEvaluationPrompt');
  const mockGateResult: GateEvaluationResult = {
    passed: true,
    matchedBankRule: {
      bankKey: 'mandiri',
      displayName: 'Bank Mandiri',
      accountNameHint: 'Mandiri',
      senderDomains: ['bankmandiri.co.id'],
      subjectKeywords: ['notifikasi'],
      blacklistKeywords: [],
      bodyRequiredPatterns: [],
      amountPriorityPatterns: [],
      referencePatterns: [],
      transferOrTopupKeywords: [],
    },
    candidateAmount: 75000,
    referenceNumber: 'REF12345',
    isTransferCandidate: false,
  };

  const preparedEmail = prepareEmailEvaluationPrompt(
    mockGateResult,
    'Notifikasi Transaksi QRIS',
    'no-reply@bankmandiri.co.id',
    'Transaksi berhasil di Merchant Kopi Kenangan sebesar Rp 75.000',
    fixedReferenceInstant,
    mockAccountList,
    mockCategoryList
  );

  assert.ok(preparedEmail.promptText.includes('REF12345'));
  assert.equal(
    preparedEmail.requestContextDescription,
    'Email transaction parsing: "Notifikasi Transaksi QRIS" from no-reply@bankmandiri.co.id'
  );
  assert.ok(preparedEmail.systemInstruction.length > 0);
  console.log('[PASS] Test 4: prepareEmailEvaluationPrompt verified.');

  // =========================================================================
  // Test 5: postProcessFinancialIntentResponse JSON parse & fallback
  // =========================================================================
  console.log('Test 5: postProcessFinancialIntentResponse');
  const validJsonResponse: AiExecutionResult = {
    responseText: JSON.stringify({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'account-bca-id',
          categoryId: 'category-food-id',
          amount: 25000,
          recordDate: '2026-09-13T12:00:00',
          note: 'Makan siang',
        },
      ],
      explanation: 'Expense recorded',
    }),
    tokenUsage: {
      promptTokens: 120,
      candidatesTokens: 45,
      totalTokens: 165,
    },
  };

  const parsedValidIntent = postProcessFinancialIntentResponse(validJsonResponse, 'TestProvider');
  assert.equal(parsedValidIntent.action, 'CREATE_RECORD');
  assert.equal(parsedValidIntent.records?.length, 1);
  assert.equal(parsedValidIntent.records?.[0].amount, 25000);
  assert.deepEqual(parsedValidIntent.tokenUsage, validJsonResponse.tokenUsage);

  // Markdown code fence wrapped JSON
  const fencedJsonResponse: AiExecutionResult = {
    responseText: '```json\n{"action": "CHECK_BALANCE", "explanation": "Checking balances"}\n```',
    tokenUsage: { promptTokens: 50, candidatesTokens: 20, totalTokens: 70 },
  };
  const parsedFencedIntent = postProcessFinancialIntentResponse(fencedJsonResponse, 'TestProvider');
  assert.equal(parsedFencedIntent.action, 'CHECK_BALANCE');
  assert.equal(parsedFencedIntent.explanation, 'Checking balances');
  assert.equal(parsedFencedIntent.tokenUsage?.totalTokens, 70);

  // Malformed JSON falls back gracefully to GENERAL_REPLY
  const malformedJsonResponse: AiExecutionResult = {
    responseText: 'Halo! Saya asisten keuangan Anda. Ada yang bisa dibantu?',
    tokenUsage: { promptTokens: 80, candidatesTokens: 30, totalTokens: 110 },
  };
  const parsedFallbackIntent = postProcessFinancialIntentResponse(malformedJsonResponse, 'TestProvider');
  assert.equal(parsedFallbackIntent.action, 'GENERAL_REPLY');
  assert.equal(parsedFallbackIntent.explanation, malformedJsonResponse.responseText);
  assert.deepEqual(parsedFallbackIntent.tokenUsage, malformedJsonResponse.tokenUsage);
  console.log('[PASS] Test 5: postProcessFinancialIntentResponse verified.');

  // =========================================================================
  // Test 6: postProcessReceiptVisionResponse envelope validation
  // =========================================================================
  console.log('Test 6: postProcessReceiptVisionResponse');
  const validReceiptResponse: AiExecutionResult = {
    responseText: JSON.stringify({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'account-bca-id',
          amount: 55000,
          currency: 'IDR',
          recordDate: '2026-09-13T14:30:00Z',
          note: 'Supermarket grocery',
        },
      ],
      explanation: 'Scanned receipt',
    }),
    tokenUsage: { promptTokens: 400, candidatesTokens: 80, totalTokens: 480 },
  };

  const parsedReceiptIntent = postProcessReceiptVisionResponse(validReceiptResponse, 'TestVision');
  assert.equal(parsedReceiptIntent.action, 'CREATE_RECORD');
  assert.equal(parsedReceiptIntent.records?.[0].amount, 55000);
  assert.equal(parsedReceiptIntent.records?.[0].currency, 'IDR');
  assert.deepEqual(parsedReceiptIntent.tokenUsage, validReceiptResponse.tokenUsage);

  // Malformed receipt output should throw AiResponseParseError
  const invalidReceiptResponse: AiExecutionResult = {
    responseText: '{"action": "INVALID_ACTION"}',
  };
  assert.throws(
    () => postProcessReceiptVisionResponse(invalidReceiptResponse, 'TestVision'),
    (error: unknown) => error instanceof AiResponseParseError
  );
  console.log('[PASS] Test 6: postProcessReceiptVisionResponse verified.');

  // =========================================================================
  // Test 7: postProcessEmailTransactionResponse parsing and entity resolution
  // =========================================================================
  console.log('Test 7: postProcessEmailTransactionResponse');
  const validEmailResponse: AiExecutionResult = {
    responseText: JSON.stringify({
      isTransaction: true,
      transactionType: 'EXPENSE',
      amount: 75000,
      counterParty: 'Kopi Kenangan',
      accountNameHint: 'Mandiri',
      note: 'Kopi Kenangan QRIS',
      recordDate: '2026-09-13T10:00:00.000Z',
      explanation: 'Parsed payment',
    }),
    tokenUsage: { promptTokens: 300, candidatesTokens: 60, totalTokens: 360 },
  };

  const parsedEmailData = postProcessEmailTransactionResponse(
    validEmailResponse,
    mockGateResult,
    'Notifikasi Transaksi QRIS',
    fixedReferenceInstant,
    mockAccountList,
    mockCategoryList,
    'TestEmailProvider'
  );

  assert.equal(parsedEmailData.isTransaction, true);
  assert.equal(parsedEmailData.amount, 75000);
  assert.equal(parsedEmailData.counterParty, 'Kopi Kenangan');
  assert.equal(parsedEmailData.referenceNumber, 'REF12345');
  assert.deepEqual(parsedEmailData.tokenUsage, validEmailResponse.tokenUsage);

  // Unparseable JSON email response falls back cleanly to failed transaction item
  const unparseableEmailResponse: AiExecutionResult = {
    responseText: 'Sorry, I could not parse this email.',
    tokenUsage: { promptTokens: 100, candidatesTokens: 15, totalTokens: 115 },
  };
  const fallbackEmailData = postProcessEmailTransactionResponse(
    unparseableEmailResponse,
    mockGateResult,
    'Notifikasi Transaksi QRIS',
    fixedReferenceInstant,
    mockAccountList,
    mockCategoryList,
    'TestEmailProvider'
  );

  assert.equal(fallbackEmailData.isTransaction, false);
  assert.equal(fallbackEmailData.amount, 75000);
  assert.ok(fallbackEmailData.explanation.includes('TestEmailProvider'));
  assert.deepEqual(fallbackEmailData.tokenUsage, unparseableEmailResponse.tokenUsage);
  console.log('[PASS] Test 7: postProcessEmailTransactionResponse verified.');

  // =========================================================================
  // Test 8: isRecoverableModelExecutionError classification
  // =========================================================================
  console.log('Test 8: isRecoverableModelExecutionError classification');
  // HTTP status checks
  assert.equal(isRecoverableModelExecutionError({ response: { status: 429 } }), true);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 503 } }), true);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 504 } }), true);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 500 } }), true);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 404 } }), true);

  // Gemini gRPC style errors
  assert.equal(isRecoverableModelExecutionError(new Error('DEADLINE_EXCEEDED: timed out')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('UNAVAILABLE: server overloaded')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('RESOURCE_EXHAUSTED: quota exceeded')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('The model is overloaded. Please try again later.')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('Request aborted due to timeout')), true);

  // OpenAI / Axios HTTP style errors
  assert.equal(isRecoverableModelExecutionError(new Error('rate limit reached: please slow down')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('timeout of 25000ms exceeded')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('ECONNABORTED: connection closed')), true);
  assert.equal(isRecoverableModelExecutionError(new Error('too many requests')), true);

  // Non-recoverable errors
  assert.equal(isRecoverableModelExecutionError(null), false);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 401 } }), false);
  assert.equal(isRecoverableModelExecutionError({ response: { status: 403 } }), false);
  assert.equal(isRecoverableModelExecutionError(new Error('Invalid argument: field missing')), false);
  assert.equal(isRecoverableModelExecutionError(new TypeError('Cannot read properties of undefined')), false);
  console.log('[PASS] Test 8: isRecoverableModelExecutionError classification verified.');

  // =========================================================================
  // Test 9: End-to-end workflow execution orchestrators with mock transport
  // =========================================================================
  console.log('Test 9: executeTextWorkflow, executeReceiptWorkflow, executeEmailTransactionWorkflow');
  let capturedTextTransportDescription = '';
  const textResult = await executeTextWorkflow(
    {
      userMessageText: 'Makan bakso 30rb',
      availableAccountList: mockAccountList,
      availableCategoryList: mockCategoryList,
      referenceInstant: fixedReferenceInstant,
      systemInstructionCache: instructionCache,
      providerLabel: 'MockProvider',
    },
    async (prepared) => {
      capturedTextTransportDescription = prepared.requestContextDescription;
      return {
        responseText: JSON.stringify({
          action: 'CREATE_RECORD',
          records: [{ accountId: 'account-bca-id', amount: 30000, recordDate: '2026-09-13', note: 'Bakso' }],
        }),
      };
    }
  );

  assert.equal(capturedTextTransportDescription, 'Text message: "Makan bakso 30rb"');
  assert.equal(textResult.action, 'CREATE_RECORD');
  assert.equal(textResult.records?.[0].amount, 30000);

  let capturedReceiptTransportDescription = '';
  const receiptResult = await executeReceiptWorkflow(
    {
      imageBuffer: Buffer.from('dummy-image-data'),
      mimeType: 'image/png',
      optionalCaption: 'Dinner bill',
      availableAccountList: mockAccountList,
      availableCategoryList: mockCategoryList,
      referenceInstant: fixedReferenceInstant,
      providerLabel: 'MockProvider',
    },
    async (prepared) => {
      capturedReceiptTransportDescription = prepared.requestContextDescription;
      return {
        responseText: JSON.stringify({
          action: 'CREATE_RECORD',
          records: [
            {
              accountId: 'account-bca-id',
              amount: 85000,
              currency: 'IDR',
              recordDate: '2026-09-13T19:00:00Z',
              note: 'Dinner bill',
            },
          ],
        }),
      };
    }
  );

  assert.ok(capturedReceiptTransportDescription.includes('Dinner bill'));
  assert.equal(receiptResult.action, 'CREATE_RECORD');
  assert.equal(receiptResult.records?.[0].amount, 85000);

  let capturedEmailTransportDescription = '';
  const emailResult = await executeEmailTransactionWorkflow(
    {
      gateResult: mockGateResult,
      emailSubject: 'Notifikasi QRIS',
      emailSender: 'no-reply@bank.com',
      emailBodyText: 'Pembayaran sukses 50000',
      emailDate: fixedReferenceInstant,
      availableAccountList: mockAccountList,
      availableCategoryList: mockCategoryList,
      providerLabel: 'MockProvider',
    },
    async (prepared) => {
      capturedEmailTransportDescription = prepared.requestContextDescription;
      return {
        responseText: JSON.stringify({
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: 50000,
          counterParty: 'Merchant',
          accountNameHint: 'Cash',
          note: 'Payment note',
          recordDate: '2026-09-13',
          explanation: 'Ok',
        }),
      };
    }
  );

  assert.ok(capturedEmailTransportDescription.includes('Notifikasi QRIS'));
  assert.equal(emailResult.isTransaction, true);
  assert.equal(emailResult.amount, 50000);
  console.log('[PASS] Test 9: Workflow orchestrators verified.');

  // =========================================================================
  // Test 10: Provider public method backward compatibility and delegation
  // =========================================================================
  console.log('Test 10: Provider public method delegation');
  const geminiProvider = new GeminiAiProvider('test-gemini-key');
  const openAiProvider = new OpenAiCompatibleAiProvider({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-openai-key',
    primaryModelName: 'gpt-4o-mini',
  });

  // Verify Gemini provider system instruction cache methods remain functional
  const geminiSystemInstruction = geminiProvider.getSystemInstruction(mockAccountList, mockCategoryList, fixedReferenceInstant);
  const geminiCacheKey = geminiProvider.getSystemInstructionCacheKey();
  assert.ok(geminiSystemInstruction.length > 0);
  assert.ok(geminiCacheKey.length > 0);

  // Calling it again returns identical cache key
  const geminiCacheKeySecond = geminiProvider.getSystemInstructionCacheKey();
  assert.equal(geminiCacheKey, geminiCacheKeySecond);

  // Verify provider identifiers
  assert.equal(geminiProvider.providerName, 'gemini');
  assert.equal(openAiProvider.providerName, 'openai-compatible');
  console.log('[PASS] Test 10: Provider public delegation verified.');

  console.log('\nAll AI Provider Workflow tests passed successfully!');
}

runAiProviderWorkflowTestSuite().catch((error) => {
  console.error('[ERROR] AI Provider Workflow test suite failed:', error);
  process.exit(1);
});
