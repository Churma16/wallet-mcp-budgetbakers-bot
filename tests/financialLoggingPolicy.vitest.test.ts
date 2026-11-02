import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applicationLogger } from '../src/lib/logger.js';
import { createTestUserMessageHandler } from './fixtures/testContext.js';
import { PendingActionHandler } from '../src/core/handlers/pendingHandler.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { WalletMcpRequestError } from '../src/wallet/index.js';
import {
  installFinancialLoggingPolicy,
  isCredentialPropertyKey,
  isFinancialPayloadDebugEnabled,
  sanitizeFinancialDebugPayload,
  summarizeFinancialLogPayload,
} from '../src/lib/financialLoggingPolicy.js';

function getTodayLogFilePath(): string {
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, '0');
  const day = String(currentDate.getDate()).padStart(2, '0');
  return path.resolve(process.cwd(), 'logs', `app-${year}-${month}-${day}.log`);
}

function readLogBlock(startMarker: string, endMarker: string): string {
  const logContent = fs.readFileSync(getTodayLogFilePath(), 'utf-8');
  const startIndex = logContent.lastIndexOf(startMarker);
  const endIndex = logContent.indexOf(endMarker, startIndex + startMarker.length);
  return startIndex >= 0 && endIndex > startIndex
    ? logContent.slice(startIndex, endIndex)
    : '';
}

describe('financial logging policy', () => {
  let originalDebugFlag: string | undefined;

  beforeEach(() => {
    originalDebugFlag = process.env.DEBUG_FINANCIAL_PAYLOADS;
  });

  afterEach(() => {
    if (originalDebugFlag === undefined) {
      delete process.env.DEBUG_FINANCIAL_PAYLOADS;
    } else {
      process.env.DEBUG_FINANCIAL_PAYLOADS = originalDebugFlag;
    }
  });

  describe('credential key recognition', () => {
    it('identifies credential property keys across various casings and formats', () => {
      process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';
      expect(isFinancialPayloadDebugEnabled()).toBe(false);

      expect(isCredentialPropertyKey('accessToken')).toBe(true);
      expect(isCredentialPropertyKey('walletMcpAccessToken')).toBe(true);
      expect(isCredentialPropertyKey('api_key')).toBe(true);
      expect(isCredentialPropertyKey('clientSecret')).toBe(true);
      expect(isCredentialPropertyKey('tokenUsage')).toBe(false);
    });
  });

  describe('debug payload sanitization', () => {
    it('redacts top-level, nested, and embedded credential pairs', () => {
      const sanitized = sanitizeFinancialDebugPayload({
        accessToken: 'top-level-secret',
        auth: {
          apiKey: 'nested-api-secret',
          refresh_token: 'nested-refresh-secret',
        },
        responseText: 'accessToken="embedded-secret" amount=125000',
      }) as Record<string, any>;

      expect(sanitized.accessToken).toBe('[REDACTED]');
      expect(sanitized.auth.apiKey).toBe('[REDACTED]');
      expect(sanitized.auth.refresh_token).toBe('[REDACTED]');
      expect(sanitized.responseText).not.toContain('embedded-secret');
      expect(sanitized.responseText).toContain('amount=125000');
    });

    it('safely handles circular references and error objects', () => {
      const circularPayload: Record<string, unknown> = { note: 'circular test' };
      circularPayload.self = circularPayload;
      const sanitizedCircular = sanitizeFinancialDebugPayload(circularPayload) as Record<string, unknown>;
      expect(sanitizedCircular.self).toBe('[CIRCULAR]');

      const errorWithCredential = new Error('request failed with accessToken=error-secret');
      (errorWithCredential as unknown as Record<string, unknown>).apiKey = 'error-property-secret';
      const sanitizedError = sanitizeFinancialDebugPayload(errorWithCredential) as Error & { apiKey?: string };
      expect(sanitizedError.message).not.toContain('error-secret');
      expect(sanitizedError.apiKey).toBe('[REDACTED]');
    });
  });

  describe('payload summarization', () => {
    it('summarizes primitives, null, undefined, and errors safely', () => {
      expect(summarizeFinancialLogPayload(null).payloadType).toBe('null');
      expect(summarizeFinancialLogPayload(undefined).payloadType).toBe('undefined');
      expect(summarizeFinancialLogPayload(new TypeError('secret')).errorName).toBe('TypeError');
      expect(summarizeFinancialLogPayload([1, 2, 3]).itemCount).toBe(3);
      expect(summarizeFinancialLogPayload('financial text').characterCount).toBe(14);
      expect(summarizeFinancialLogPayload(125000).payloadType).toBe('number');
    });

    it('preserves high-level metadata while excluding amounts, notes, and credentials', () => {
      const objectSummary = summarizeFinancialLogPayload({
        method: 'create_records',
        records: [{ amount: 125000, note: 'Dinner with Alice', counterParty: 'Kopi Senja' }],
        accessToken: 'super-secret-token',
      });
      const serializedSummary = JSON.stringify(objectSummary);

      expect(objectSummary.recordCount).toBe(1);
      expect(serializedSummary).not.toContain('125000');
      expect(serializedSummary).not.toContain('Dinner with Alice');
      expect(serializedSummary).not.toContain('Kopi Senja');
      expect(serializedSummary).not.toContain('super-secret-token');

      const objectWithoutCollection = summarizeFinancialLogPayload({ provider: 'gemini', latencyMs: 30 });
      expect(objectWithoutCollection.recordCount).toBeUndefined();
    });
  });

  describe('real logger integration', () => {
    it('minimizes real fileDetail log output by default', () => {
      installFinancialLoggingPolicy();
      process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';

      const defaultStartMarker = `FIN_LOG_DEFAULT_START_${Math.random().toString(36).slice(2, 8)}`;
      const defaultEndMarker = `FIN_LOG_DEFAULT_END_${Math.random().toString(36).slice(2, 8)}`;
      applicationLogger.info(defaultStartMarker);
      applicationLogger.fileDetail('mcp', 'Create Records Debug Detail', {
        records: [{ amount: 45123, note: 'Private lunch note', counterParty: 'Kopi Senja' }],
        accessToken: 'default-mode-secret',
      });
      applicationLogger.info(defaultEndMarker);

      const defaultLogBlock = readLogBlock(defaultStartMarker, defaultEndMarker);
      expect(defaultLogBlock).toContain('recordCount');
      expect(defaultLogBlock).not.toContain('45123');
      expect(defaultLogBlock).not.toContain('Private lunch note');
      expect(defaultLogBlock).not.toContain('Kopi Senja');
      expect(defaultLogBlock).not.toContain('default-mode-secret');
    });

    it('includes payload details when debug mode is enabled while still redacting secrets and masking accounts', () => {
      installFinancialLoggingPolicy();
      process.env.DEBUG_FINANCIAL_PAYLOADS = 'true';
      expect(isFinancialPayloadDebugEnabled()).toBe(true);

      const debugStartMarker = `FIN_LOG_DEBUG_START_${Math.random().toString(36).slice(2, 8)}`;
      const debugEndMarker = `FIN_LOG_DEBUG_END_${Math.random().toString(36).slice(2, 8)}`;
      applicationLogger.info(debugStartMarker);
      applicationLogger.fileDetail('mcp', 'Create Records Debug Detail', {
        records: [{ amount: 45123, note: 'Debug lunch note', counterParty: 'Kopi Senja' }],
        accessToken: 'debug-access-secret',
        nestedAuth: {
          apiKey: 'debug-api-secret',
        },
        bankAccountNumber: '507431877335',
      });
      applicationLogger.info(debugEndMarker);

      const debugLogBlock = readLogBlock(debugStartMarker, debugEndMarker);
      expect(debugLogBlock).toContain('45123');
      expect(debugLogBlock).toContain('Debug lunch note');
      expect(debugLogBlock).toContain('Kopi Senja');
      expect(debugLogBlock).not.toContain('debug-access-secret');
      expect(debugLogBlock).not.toContain('debug-api-secret');
      expect(debugLogBlock).toContain('5074****7335');
    });

    it('omits raw transaction text and amounts from user message handler logs', async () => {
      process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';

      const handlerStartMarker = `FIN_HANDLER_START_${Math.random().toString(36).slice(2, 8)}`;
      const handlerEndMarker = `FIN_HANDLER_END_${Math.random().toString(36).slice(2, 8)}`;
      const rawUserText = 'catat makan siang 98765 di Merchant Rahasia';
      const rawAiExplanation = 'Merchant Rahasia dicatat sebesar 98765 sebagai makan siang';

      const messagingGatewayMock = {
        sendTypingPresence: async () => undefined,
        clearTypingPresence: async () => undefined,
        sendMessage: async () => undefined,
      };
      const pendingTransactionManagerMock = {
        hasPendingTransactions: () => false,
      };
      const financialAiProviderMock = {
        providerName: 'test-provider',
        processTextMessage: async () => ({
          action: 'GENERAL_REPLY',
          explanation: rawAiExplanation,
        }),
      };
      const walletCacheServiceMock = {
        getAccounts: () => [],
        getCategories: () => [],
      };

      const handler = createTestUserMessageHandler({
        messagingGateway: messagingGatewayMock as any,
        pendingTransactionManager: pendingTransactionManagerMock as any,
        financialAiProvider: financialAiProviderMock as any,
        walletCacheService: walletCacheServiceMock as any,
      });

      applicationLogger.info(handlerStartMarker);
      await handler.handleIncomingUserMessage({
        channel: 'telegram',
        senderIdentifier: 'user-123',
        chatIdentifier: 'chat-123',
        messageType: 'text',
        textPayload: rawUserText,
      });
      applicationLogger.info(handlerEndMarker);

      const handlerLogBlock = readLogBlock(handlerStartMarker, handlerEndMarker);
      expect(handlerLogBlock).not.toContain(rawUserText);
      expect(handlerLogBlock).not.toContain('98765');
      expect(handlerLogBlock).not.toContain('Merchant Rahasia');
      expect(handlerLogBlock).not.toContain(rawAiExplanation);
      expect(handlerLogBlock).toContain('Decision: GENERAL_REPLY');
    });

    it('omits downstream echoed amounts and merchants on failure while retaining error metadata', async () => {
      process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';

      const downstreamStartMarker = `FIN_DOWNSTREAM_START_${Math.random().toString(36).slice(2, 8)}`;
      const downstreamEndMarker = `FIN_DOWNSTREAM_END_${Math.random().toString(36).slice(2, 8)}`;
      const leakedAmount = '776655';
      const leakedMerchant = 'Merchant Failure Rahasia';
      const pendingService = new PendingTransactionService();
      pendingService.addPendingTransaction({
        sourceType: 'WHATSAPP',
        bankDisplayName: 'Test Bank',
        accountNameHint: 'Cash',
        counterParty: leakedMerchant,
        amount: Number(leakedAmount),
        currency: 'IDR',
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-test',
        matchedCategoryId: 'cat-test',
        note: `Lunch at ${leakedMerchant}`,
        recordDate: '2026-09-10',
      });

      const failingWalletClient = {
        createRecords: async () => {
          throw new WalletMcpRequestError(
            `validation failed for amount ${leakedAmount} at ${leakedMerchant}`,
            'DEFINITIVE_FAILURE'
          );
        },
      };
      const pendingMessagingGateway = {
        sendMessage: async () => undefined,
      };
      const pendingHandler = new PendingActionHandler(
        pendingService,
        failingWalletClient as any,
        pendingMessagingGateway as any,
        () => null
      );

      applicationLogger.info(downstreamStartMarker);
      await pendingHandler.handlePendingAction(
        {
          channel: 'whatsapp',
          senderIdentifier: 'sender-test',
          chatIdentifier: 'chat-test',
          messageType: 'text',
          textPayload: 'ya',
        },
        { actionType: 'CONFIRM', targetScope: 1 },
        Date.now()
      );
      applicationLogger.info(downstreamEndMarker);

      const downstreamLogBlock = readLogBlock(downstreamStartMarker, downstreamEndMarker);
      expect(downstreamLogBlock).not.toContain(leakedAmount);
      expect(downstreamLogBlock).not.toContain(leakedMerchant);
      expect(downstreamLogBlock).toContain('WalletMcpRequestError');
      expect(downstreamLogBlock).toContain('outcome=DEFINITIVE_FAILURE');
    });
  });
});
