import { describe, expect, it } from 'vitest';
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
  type AiExecutionResult,
} from '../src/services/ai/aiProviderWorkflow.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';
import { WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { GateEvaluationResult } from '../src/utils/emailGateEvaluator.js';
import { GeminiAiProvider } from '../src/services/ai/geminiAiProvider.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';

describe('AI Provider Workflow (Issue #108)', () => {
  const mockAccountList: WalletAccountItem[] = [
    { id: 'account-cash-id', name: 'Cash Wallet', currency: 'IDR' },
    { id: 'account-bca-id', name: 'BCA Account', currency: 'IDR' },
  ];

  const mockCategoryList: WalletCategoryItem[] = [
    { id: 'category-food-id', name: 'Food & Dining' },
    { id: 'category-transport-id', name: 'Transportation' },
  ];

  const fixedReferenceInstant = new Date('2026-09-13T10:00:00.000Z');

  describe('SystemInstructionCache', () => {
    it('returns compiled system instruction and reuses cache on identical parameters', () => {
      const instructionCache = new SystemInstructionCache();
      const firstInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const firstCacheKey = instructionCache.getCacheKey();

      expect(firstInstruction.length).toBeGreaterThan(0);
      expect(firstCacheKey.length).toBeGreaterThan(0);

      const secondInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const secondCacheKey = instructionCache.getCacheKey();

      expect(secondInstruction).toBe(firstInstruction);
      expect(secondCacheKey).toBe(firstCacheKey);
    });

    it('invalidates cache key when reference date crosses date boundaries', () => {
      const instructionCache = new SystemInstructionCache();
      instructionCache.getSystemInstruction(mockAccountList, mockCategoryList, fixedReferenceInstant);
      const initialCacheKey = instructionCache.getCacheKey();

      const nextDayReferenceInstant = new Date('2026-09-14T10:00:00.000Z');
      const nextDayInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        nextDayReferenceInstant
      );
      const nextDayCacheKey = instructionCache.getCacheKey();

      expect(nextDayCacheKey).not.toBe(initialCacheKey);
      expect(nextDayInstruction.length).toBeGreaterThan(0);
    });

    it('invalidates cache key and updates instruction when account metadata changes with stable ID', () => {
      const instructionCache = new SystemInstructionCache();
      const initialInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const initialCacheKey = instructionCache.getCacheKey();

      expect(initialInstruction).toContain('Cash Wallet');

      // 1. Account name rename with identical ID
      const renamedAccountList: WalletAccountItem[] = [
        { id: 'account-cash-id', name: 'Petty Cash Daily', currency: 'IDR' },
        mockAccountList[1],
      ];
      const renamedInstruction = instructionCache.getSystemInstruction(
        renamedAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const renamedCacheKey = instructionCache.getCacheKey();

      expect(renamedCacheKey).not.toBe(initialCacheKey);
      expect(renamedInstruction).toContain('Petty Cash Daily');
      expect(renamedInstruction).not.toContain('Cash Wallet');

      // 2. Account currency change with identical ID
      const currencyChangedAccountList: WalletAccountItem[] = [
        { id: 'account-cash-id', name: 'Petty Cash Daily', currency: 'USD' },
        mockAccountList[1],
      ];
      const currencyInstruction = instructionCache.getSystemInstruction(
        currencyChangedAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const currencyCacheKey = instructionCache.getCacheKey();

      expect(currencyCacheKey).not.toBe(renamedCacheKey);
      expect(currencyInstruction).toContain('[USD]');

      // 3. Bank account number change with identical ID
      const bankAccountChangedList: WalletAccountItem[] = [
        mockAccountList[0],
        { id: 'account-bca-id', name: 'BCA Account', currency: 'IDR', bankAccountNumber: '987654321' },
      ];
      const bankAccountInstruction = instructionCache.getSystemInstruction(
        bankAccountChangedList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const bankAccountCacheKey = instructionCache.getCacheKey();

      expect(bankAccountCacheKey).not.toBe(initialCacheKey);
      expect(bankAccountInstruction).toContain('987654321');
    });

    it('invalidates cache key and updates instruction when category metadata changes with stable ID', () => {
      const instructionCache = new SystemInstructionCache();
      const initialInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const initialCacheKey = instructionCache.getCacheKey();

      expect(initialInstruction).toContain('Food & Dining');

      const renamedCategoryList: WalletCategoryItem[] = [
        { id: 'category-food-id', name: 'Gourmet Dining & Snacks' },
        mockCategoryList[1],
      ];
      const renamedInstruction = instructionCache.getSystemInstruction(
        mockAccountList,
        renamedCategoryList,
        fixedReferenceInstant
      );
      const renamedCacheKey = instructionCache.getCacheKey();

      expect(renamedCacheKey).not.toBe(initialCacheKey);
      expect(renamedInstruction).toContain('Gourmet Dining & Snacks');
      expect(renamedInstruction).not.toContain('Food & Dining');
    });
  });

  describe('Prompt Preparation Helpers', () => {
    it('prepares text message prompt with trimmed message and request context', () => {
      const instructionCache = new SystemInstructionCache();
      const prepared = prepareTextMessagePrompt(
        '  Beli makan siang 25000 pakai BCA  ',
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant,
        instructionCache
      );

      expect(prepared.promptText).toContain('Beli makan siang 25000 pakai BCA');
      expect(prepared.requestContextDescription).toBe('Text message: "Beli makan siang 25000 pakai BCA"');
      expect(prepared.systemInstruction.length).toBeGreaterThan(0);
    });

    it('prepares receipt vision extraction prompt', () => {
      const prepared = prepareReceiptPrompt(
        'image/jpeg',
        1024,
        'Lunch receipt',
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );

      expect(prepared.promptText).toContain('Lunch receipt');
      expect(prepared.requestContextDescription).toBe(
        'Receipt photo message (mime: image/jpeg, size: 1024 bytes, caption: "Lunch receipt")'
      );
      expect(prepared.systemInstruction.length).toBeGreaterThan(0);
    });

    it('prepares email evaluation prompt with Gate 1 metadata', () => {
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

      const prepared = prepareEmailEvaluationPrompt(
        mockGateResult,
        'Notifikasi Transaksi QRIS',
        'no-reply@bankmandiri.co.id',
        'Transaksi berhasil di Merchant Kopi Kenangan sebesar Rp 75.000',
        fixedReferenceInstant,
        mockAccountList,
        mockCategoryList
      );

      expect(prepared.promptText).toContain('REF12345');
      expect(prepared.requestContextDescription).toBe(
        'Email transaction parsing: "Notifikasi Transaksi QRIS" from no-reply@bankmandiri.co.id'
      );
      expect(prepared.systemInstruction.length).toBeGreaterThan(0);
    });
  });

  describe('Response Post-Processing', () => {
    it('parses valid financial intent JSON and attaches token usage', () => {
      const validResult: AiExecutionResult = {
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

      const parsed = postProcessFinancialIntentResponse(validResult, 'TestProvider');
      expect(parsed.action).toBe('CREATE_RECORD');
      expect(parsed.records).toHaveLength(1);
      expect(parsed.records?.[0].amount).toBe(25000);
      expect(parsed.tokenUsage).toEqual(validResult.tokenUsage);
    });

    it('strips markdown code fences from JSON intent response', () => {
      const fencedResult: AiExecutionResult = {
        responseText: '```json\n{"action": "CHECK_BALANCE", "explanation": "Checking balances"}\n```',
        tokenUsage: { promptTokens: 50, candidatesTokens: 20, totalTokens: 70 },
      };

      const parsed = postProcessFinancialIntentResponse(fencedResult, 'TestProvider');
      expect(parsed.action).toBe('CHECK_BALANCE');
      expect(parsed.explanation).toBe('Checking balances');
      expect(parsed.tokenUsage?.totalTokens).toBe(70);
    });

    it('falls back to GENERAL_REPLY when text response contains non-JSON text', () => {
      const malformedResult: AiExecutionResult = {
        responseText: 'Halo! Saya asisten keuangan Anda. Ada yang bisa dibantu?',
        tokenUsage: { promptTokens: 80, candidatesTokens: 30, totalTokens: 110 },
      };

      const parsed = postProcessFinancialIntentResponse(malformedResult, 'TestProvider');
      expect(parsed.action).toBe('GENERAL_REPLY');
      expect(parsed.explanation).toBe(malformedResult.responseText);
      expect(parsed.tokenUsage).toEqual(malformedResult.tokenUsage);
    });

    it('validates receipt vision intent envelope and attaches token usage', () => {
      const validReceiptResult: AiExecutionResult = {
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

      const parsed = postProcessReceiptVisionResponse(validReceiptResult, 'TestVision');
      expect(parsed.action).toBe('CREATE_RECORD');
      expect(parsed.records?.[0].amount).toBe(55000);
      expect(parsed.records?.[0].currency).toBe('IDR');
      expect(parsed.tokenUsage).toEqual(validReceiptResult.tokenUsage);
    });

    it('throws AiResponseParseError when receipt output has invalid envelope', () => {
      const invalidReceiptResult: AiExecutionResult = {
        responseText: '{"action": "INVALID_ACTION"}',
      };

      expect(() => postProcessReceiptVisionResponse(invalidReceiptResult, 'TestVision')).toThrow(
        AiResponseParseError
      );
    });

    it('resolves extracted entities and attaches token usage for email transactions', () => {
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

      const validEmailResult: AiExecutionResult = {
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

      const parsed = postProcessEmailTransactionResponse(
        validEmailResult,
        mockGateResult,
        'Notifikasi Transaksi QRIS',
        fixedReferenceInstant,
        mockAccountList,
        mockCategoryList,
        'TestEmailProvider'
      );

      expect(parsed.isTransaction).toBe(true);
      expect(parsed.amount).toBe(75000);
      expect(parsed.counterParty).toBe('Kopi Kenangan');
      expect(parsed.referenceNumber).toBe('REF12345');
      expect(parsed.tokenUsage).toEqual(validEmailResult.tokenUsage);
    });

    it('builds failed email fallback with provider attribution on unparseable response', () => {
      const mockGateResult: GateEvaluationResult = {
        passed: true,
        candidateAmount: 75000,
      };

      const unparseableResult: AiExecutionResult = {
        responseText: 'Sorry, I could not parse this email.',
        tokenUsage: { promptTokens: 100, candidatesTokens: 15, totalTokens: 115 },
      };

      const fallback = postProcessEmailTransactionResponse(
        unparseableResult,
        mockGateResult,
        'Notifikasi Transaksi QRIS',
        fixedReferenceInstant,
        mockAccountList,
        mockCategoryList,
        'OpenAI'
      );

      expect(fallback.isTransaction).toBe(false);
      expect(fallback.amount).toBe(75000);
      expect(fallback.explanation).toContain('OpenAI');
      expect(fallback.tokenUsage).toEqual(unparseableResult.tokenUsage);
    });
  });

  describe('Recoverable Model Execution Error Classification', () => {
    it('classifies transient HTTP status codes as recoverable', () => {
      expect(
        isRecoverableModelExecutionError({
          response: { status: 408, data: { error: { message: 'Request Timeout' } } },
        })
      ).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 408 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 404 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 429 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 500 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 502 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 503 } })).toBe(true);
      expect(isRecoverableModelExecutionError({ response: { status: 504 } })).toBe(true);
    });

    it('classifies Gemini gRPC transient errors as recoverable', () => {
      expect(isRecoverableModelExecutionError(new Error('DEADLINE_EXCEEDED: timed out'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('UNAVAILABLE: server overloaded'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('RESOURCE_EXHAUSTED: quota exceeded'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('The model is overloaded. Please try again later.'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('Request aborted due to timeout'))).toBe(true);
    });

    it('classifies OpenAI and network transient errors as recoverable', () => {
      expect(isRecoverableModelExecutionError(new Error('rate limit reached: please slow down'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('timeout of 25000ms exceeded'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('ECONNABORTED: connection closed'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('too many requests'))).toBe(true);
      expect(isRecoverableModelExecutionError(new Error('request timed out'))).toBe(true);
    });

    it('rejects HTTP 400 with datetime or format error without generic time misclassification', () => {
      // 400 Bad Request error containing "datetime"
      expect(
        isRecoverableModelExecutionError({
          response: { status: 400, data: { error: { message: 'invalid datetime format' } } },
        })
      ).toBe(false);

      // Error message containing "invalid datetime format"
      expect(isRecoverableModelExecutionError(new Error('400 Bad Request: invalid datetime format'))).toBe(false);
      expect(isRecoverableModelExecutionError(new Error('Validation failed: time zone is invalid'))).toBe(false);
      expect(isRecoverableModelExecutionError(new Error('Real-time parsing rejected payload'))).toBe(false);
    });

    it('rejects non-recoverable client errors and random exceptions', () => {
      expect(isRecoverableModelExecutionError(null)).toBe(false);
      expect(isRecoverableModelExecutionError(undefined)).toBe(false);
      expect(isRecoverableModelExecutionError({ response: { status: 400 } })).toBe(false);
      expect(isRecoverableModelExecutionError({ response: { status: 401 } })).toBe(false);
      expect(isRecoverableModelExecutionError({ response: { status: 403 } })).toBe(false);
      expect(isRecoverableModelExecutionError({ response: { status: 422 } })).toBe(false);
      expect(isRecoverableModelExecutionError(new Error('Invalid argument: missing required field'))).toBe(false);
      expect(isRecoverableModelExecutionError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });
  });

  describe('Workflow Execution Orchestrators', () => {
    it('orchestrates text workflow end-to-end with transport callback', async () => {
      const instructionCache = new SystemInstructionCache();
      let capturedDescription = '';

      const result = await executeTextWorkflow(
        {
          userMessageText: 'Makan bakso 30rb',
          availableAccountList: mockAccountList,
          availableCategoryList: mockCategoryList,
          referenceInstant: fixedReferenceInstant,
          systemInstructionCache: instructionCache,
          providerLabel: 'MockProvider',
        },
        async (prepared) => {
          capturedDescription = prepared.requestContextDescription;
          return {
            responseText: JSON.stringify({
              action: 'CREATE_RECORD',
              records: [
                { accountId: 'account-bca-id', amount: 30000, recordDate: '2026-09-13', note: 'Bakso' },
              ],
            }),
          };
        }
      );

      expect(capturedDescription).toBe('Text message: "Makan bakso 30rb"');
      expect(result.action).toBe('CREATE_RECORD');
      expect(result.records?.[0].amount).toBe(30000);
    });

    it('orchestrates receipt workflow end-to-end with transport callback', async () => {
      let capturedDescription = '';

      const result = await executeReceiptWorkflow(
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
          capturedDescription = prepared.requestContextDescription;
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

      expect(capturedDescription).toContain('Dinner bill');
      expect(result.action).toBe('CREATE_RECORD');
      expect(result.records?.[0].amount).toBe(85000);
    });

    it('orchestrates email workflow end-to-end with transport callback', async () => {
      const mockGateResult: GateEvaluationResult = {
        passed: true,
        candidateAmount: 50000,
      };
      let capturedDescription = '';

      const result = await executeEmailTransactionWorkflow(
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
          capturedDescription = prepared.requestContextDescription;
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

      expect(capturedDescription).toContain('Notifikasi QRIS');
      expect(result.isTransaction).toBe(true);
      expect(result.amount).toBe(50000);
    });
  });

  describe('Provider Public Delegation & Parity', () => {
    it('preserves Gemini provider public instruction cache delegation', () => {
      const geminiProvider = new GeminiAiProvider('test-gemini-key');
      const instruction = geminiProvider.getSystemInstruction(
        mockAccountList,
        mockCategoryList,
        fixedReferenceInstant
      );
      const cacheKey = geminiProvider.getSystemInstructionCacheKey();

      expect(instruction.length).toBeGreaterThan(0);
      expect(cacheKey.length).toBeGreaterThan(0);
      expect(geminiProvider.getSystemInstructionCacheKey()).toBe(cacheKey);
      expect(geminiProvider.providerName).toBe('gemini');
    });

    it('supports OpenAI-compatible provider parity with configured provider name', () => {
      const openAiProvider = new OpenAiCompatibleAiProvider({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'test-openai-key',
        primaryModelName: 'gpt-4o-mini',
      });

      expect(openAiProvider.providerName).toBe('openai-compatible');
    });
  });
});
