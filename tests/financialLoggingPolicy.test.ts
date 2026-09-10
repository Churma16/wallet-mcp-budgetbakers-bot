import fs from 'fs';
import path from 'path';
import { applicationLogger } from '../src/utils/logger.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import {
  installFinancialLoggingPolicy,
  isCredentialPropertyKey,
  isFinancialPayloadDebugEnabled,
  sanitizeFinancialDebugPayload,
  summarizeFinancialLogPayload,
} from '../src/utils/financialLoggingPolicy.js';

let allTestsPassed = true;

function assertCondition(description: string, condition: boolean): void {
  if (!condition) {
    console.error(`[FAIL] ${description}`);
    allTestsPassed = false;
    return;
  }
  console.log(`[PASS] ${description}`);
}

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

async function runFinancialLoggingPolicyTests(): Promise<void> {
  const originalDebugFlag = process.env.DEBUG_FINANCIAL_PAYLOADS;

  try {
    process.env.DEBUG_FINANCIAL_PAYLOADS = 'false';
    assertCondition('debug flag defaults to disabled semantics', isFinancialPayloadDebugEnabled() === false);

    assertCondition('accessToken is recognized as a credential key', isCredentialPropertyKey('accessToken'));
    assertCondition('nested wallet access token key is recognized', isCredentialPropertyKey('walletMcpAccessToken'));
    assertCondition('snake_case api key is recognized', isCredentialPropertyKey('api_key'));
    assertCondition('client secret key is recognized', isCredentialPropertyKey('clientSecret'));
    assertCondition('token usage metadata is not treated as a credential', !isCredentialPropertyKey('tokenUsage'));

    const sanitizedDebugPayload = sanitizeFinancialDebugPayload({
      accessToken: 'top-level-secret',
      auth: {
        apiKey: 'nested-api-secret',
        refresh_token: 'nested-refresh-secret',
      },
      responseText: 'accessToken="embedded-secret" amount=125000',
    }) as Record<string, any>;

    assertCondition('top-level camelCase credential is redacted', sanitizedDebugPayload.accessToken === '[REDACTED]');
    assertCondition('nested credential is redacted', sanitizedDebugPayload.auth.apiKey === '[REDACTED]');
    assertCondition('nested snake_case credential is redacted', sanitizedDebugPayload.auth.refresh_token === '[REDACTED]');
    assertCondition('embedded camelCase credential pair is redacted', !sanitizedDebugPayload.responseText.includes('embedded-secret'));
    assertCondition('non-credential debug text remains available', sanitizedDebugPayload.responseText.includes('amount=125000'));

    const circularPayload: Record<string, unknown> = { note: 'circular test' };
    circularPayload.self = circularPayload;
    const sanitizedCircularPayload = sanitizeFinancialDebugPayload(circularPayload) as Record<string, unknown>;
    assertCondition('debug sanitizer handles circular references', sanitizedCircularPayload.self === '[CIRCULAR]');

    const errorWithCredential = new Error('request failed with accessToken=error-secret');
    (errorWithCredential as unknown as Record<string, unknown>).apiKey = 'error-property-secret';
    const sanitizedError = sanitizeFinancialDebugPayload(errorWithCredential) as Error & { apiKey?: string };
    assertCondition('Error message credential pair is redacted', !sanitizedError.message.includes('error-secret'));
    assertCondition('Error custom credential property is redacted', sanitizedError.apiKey === '[REDACTED]');

    assertCondition('null payload summary is safe', summarizeFinancialLogPayload(null).payloadType === 'null');
    assertCondition('undefined payload summary is safe', summarizeFinancialLogPayload(undefined).payloadType === 'undefined');
    assertCondition('Error payload summary keeps only error type', summarizeFinancialLogPayload(new TypeError('secret')).errorName === 'TypeError');
    assertCondition('array payload summary keeps item count', summarizeFinancialLogPayload([1, 2, 3]).itemCount === 3);
    assertCondition('string payload summary keeps only length', summarizeFinancialLogPayload('financial text').characterCount === 14);
    assertCondition('primitive payload summary keeps type', summarizeFinancialLogPayload(125000).payloadType === 'number');

    const objectSummary = summarizeFinancialLogPayload({
      method: 'create_records',
      records: [{ amount: 125000, note: 'Dinner with Alice', counterParty: 'Kopi Senja' }],
      accessToken: 'super-secret-token',
    });
    const serializedSummary = JSON.stringify(objectSummary);
    assertCondition('object summary preserves record count metadata', objectSummary.recordCount === 1);
    assertCondition('object summary excludes transaction amount', !serializedSummary.includes('125000'));
    assertCondition('object summary excludes transaction note', !serializedSummary.includes('Dinner with Alice'));
    assertCondition('object summary excludes merchant/counterparty', !serializedSummary.includes('Kopi Senja'));
    assertCondition('object summary excludes credential value', !serializedSummary.includes('super-secret-token'));

    const objectWithoutCollection = summarizeFinancialLogPayload({ provider: 'gemini', latencyMs: 30 });
    assertCondition('object summary without collection omits record count', objectWithoutCollection.recordCount === undefined);

    // installFinancialLoggingPolicy auto-installs at module load; a second call must be harmless.
    installFinancialLoggingPolicy();

    const defaultStartMarker = `FIN_LOG_DEFAULT_START_${Math.random().toString(36).slice(2, 8)}`;
    const defaultEndMarker = `FIN_LOG_DEFAULT_END_${Math.random().toString(36).slice(2, 8)}`;
    applicationLogger.info(defaultStartMarker);
    applicationLogger.fileDetail('mcp', 'Create Records Debug Detail', {
      records: [{ amount: 45123, note: 'Private lunch note', counterParty: 'Kopi Senja' }],
      accessToken: 'default-mode-secret',
    });
    applicationLogger.info(defaultEndMarker);

    const defaultLogBlock = readLogBlock(defaultStartMarker, defaultEndMarker);
    assertCondition('default real log path contains operational metadata', defaultLogBlock.includes('recordCount'));
    assertCondition('default real log path omits exact amount', !defaultLogBlock.includes('45123'));
    assertCondition('default real log path omits note', !defaultLogBlock.includes('Private lunch note'));
    assertCondition('default real log path omits merchant/counterparty', !defaultLogBlock.includes('Kopi Senja'));
    assertCondition('default real log path omits credential value', !defaultLogBlock.includes('default-mode-secret'));

    process.env.DEBUG_FINANCIAL_PAYLOADS = 'true';
    assertCondition('debug flag requires explicit true opt-in', isFinancialPayloadDebugEnabled() === true);

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
    assertCondition('debug real log path includes transaction amount', debugLogBlock.includes('45123'));
    assertCondition('debug real log path includes transaction note', debugLogBlock.includes('Debug lunch note'));
    assertCondition('debug real log path includes merchant/counterparty', debugLogBlock.includes('Kopi Senja'));
    assertCondition('debug real log path redacts camelCase accessToken', !debugLogBlock.includes('debug-access-secret'));
    assertCondition('debug real log path redacts nested apiKey', !debugLogBlock.includes('debug-api-secret'));
    assertCondition('debug real log path still masks account numbers', debugLogBlock.includes('5074****7335'));

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

    const handler = new UserMessageHandler(
      messagingGatewayMock as any,
      pendingTransactionManagerMock as any,
      {} as any,
      {} as any,
      financialAiProviderMock as any,
      walletCacheServiceMock as any,
      {} as any
    );

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
    assertCondition('handler default log omits raw user transaction text', !handlerLogBlock.includes(rawUserText));
    assertCondition('handler default log omits arbitrary transaction amount', !handlerLogBlock.includes('98765'));
    assertCondition('handler default log omits arbitrary merchant text', !handlerLogBlock.includes('Merchant Rahasia'));
    assertCondition('handler default log omits raw AI explanation', !handlerLogBlock.includes(rawAiExplanation));
    assertCondition('handler default log retains AI decision metadata', handlerLogBlock.includes('Decision: GENERAL_REPLY'));
  } finally {
    if (originalDebugFlag === undefined) {
      delete process.env.DEBUG_FINANCIAL_PAYLOADS;
    } else {
      process.env.DEBUG_FINANCIAL_PAYLOADS = originalDebugFlag;
    }
  }

  if (!allTestsPassed) {
    throw new Error('Financial logging policy tests failed');
  }

  console.log('[SUCCESS] Financial logging policy tests passed.');
}

runFinancialLoggingPolicyTests().catch(error => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
