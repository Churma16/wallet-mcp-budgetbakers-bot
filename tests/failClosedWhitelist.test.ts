import { TelegramMessagingAdapter } from '../src/services/messaging/telegramAdapter.js';
import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';
import {
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';
import type { proto } from '@whiskeysockets/baileys';
import type { Context } from 'grammy';

interface AssertionStatistics {
  totalCount: number;
  passedCount: number;
  failedCount: number;
}

const testStatistics: AssertionStatistics = {
  totalCount: 0,
  passedCount: 0,
  failedCount: 0,
};

function assertCondition(testCaseIdentifier: string, conditionMet: boolean, failureDetail?: string): void {
  testStatistics.totalCount++;
  if (conditionMet) {
    testStatistics.passedCount++;
    console.log(`  [PASS] ${testCaseIdentifier}`);
  } else {
    testStatistics.failedCount++;
    console.error(`  [FAIL] ${testCaseIdentifier}${failureDetail ? ` -> ${failureDetail}` : ''}`);
  }
}

function createBaseConfiguration(
  overrides?: Partial<ApplicationEnvironmentConfiguration>
): ApplicationEnvironmentConfiguration {
  return {
    aiProvider: 'gemini',
    aiProviders: ['gemini'],
    aiApiKey: '',
    aiBaseUrl: '',
    aiModel: 'gemini-3.6-flash',
    aiFallbackModels: [],
    aiRequestTimeoutMilliseconds: 20000,
    geminiApiKey: 'test-gemini-key',
    geminiModel: 'gemini-3.6-flash',
    geminiFallbackModels: [],
    geminiRequestTimeoutMilliseconds: 20000,
    walletMcpBaseUrl: 'https://mcp.wallet.budgetbakers.com',
    walletMcpAccessToken: 'test-wallet-token',
    allowedPhoneNumber: '6281234567890',
    whatsappSessionPath: './test_session',
    telegramBotToken: '123456:TEST_TELEGRAM_TOKEN',
    telegramAllowedUserId: '987654321',
    enabledMessengerChannels: ['whatsapp'],
    logRetentionDays: 7,
    emailSyncEnabled: false,
    emailImapHost: 'imap.gmail.com',
    emailImapPort: 993,
    emailImapUser: '',
    emailImapPassword: '',
    emailLookbackMinutes: 10,
    appLanguage: 'id',
    defaultCurrency: 'IDR',
    appTimezone: 'Asia/Jakarta',
    whatsappMaxReconnectAttempts: 6,
    whatsappReconnectMaxBackoffSeconds: 300,
    whatsappMessageQueueIntervalMs: 50,
    whatsappTypingPresenceCooldownMs: 2500,
    telegramMaxStartupAttempts: 5,
    telegramStartupRetryDelayMs: 2000,
    maxMediaDownloadMb: 10,
    ...overrides,
  };
}

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running Fail-Closed Whitelist Authorization Test Suite (Issue #74)');
  console.log('====================================================\n');

  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyCallback = async (_event: IncomingUserMessageEvent) => {};

  // ----------------------------------------------------
  // TEST GROUP 1: Application Startup Configuration Validation
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Application Startup Configuration Validation');
  {
    // Case 1.1: Valid WhatsApp-only configuration
    const validWhatsAppConfig = createBaseConfiguration({
      enabledMessengerChannels: ['whatsapp'],
      allowedPhoneNumber: '6281234567890',
    });
    const result1 = validateApplicationConfiguration(validWhatsAppConfig);
    assertCondition('SEC-1.1: Valid WhatsApp-only configuration passes validation', result1.isValid);
    assertCondition('SEC-1.2: No errors returned for valid WhatsApp config', result1.errors.length === 0);

    // Case 1.2: Valid Telegram-only configuration
    const validTelegramConfig = createBaseConfiguration({
      enabledMessengerChannels: ['telegram'],
      allowedPhoneNumber: '',
      telegramBotToken: dummyToken,
      telegramAllowedUserId: '987654321',
    });
    const result2 = validateApplicationConfiguration(validTelegramConfig);
    assertCondition('SEC-1.3: Valid Telegram-only configuration passes validation', result2.isValid);
    assertCondition('SEC-1.4: No errors returned for valid Telegram config', result2.errors.length === 0);

    // Case 1.3: Enabled Telegram with missing TELEGRAM_ALLOWED_USER_ID fails closed
    const telegramMissingUserIdConfig = createBaseConfiguration({
      enabledMessengerChannels: ['telegram'],
      allowedPhoneNumber: '',
      telegramBotToken: dummyToken,
      telegramAllowedUserId: '',
    });
    const result3 = validateApplicationConfiguration(telegramMissingUserIdConfig);
    assertCondition('SEC-1.5: Enabled Telegram without TELEGRAM_ALLOWED_USER_ID fails validation', result3.isValid === false);
    assertCondition(
      'SEC-1.6: Error flags missing TELEGRAM_ALLOWED_USER_ID',
      result3.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID')
    );

    // Case 1.4: Enabled WhatsApp with missing ALLOWED_PHONE_NUMBER fails closed
    const whatsAppMissingPhoneConfig = createBaseConfiguration({
      enabledMessengerChannels: ['whatsapp'],
      allowedPhoneNumber: '',
      telegramBotToken: '',
      telegramAllowedUserId: '',
    });
    const result4 = validateApplicationConfiguration(whatsAppMissingPhoneConfig);
    assertCondition('SEC-1.7: Enabled WhatsApp without ALLOWED_PHONE_NUMBER fails validation', result4.isValid === false);
    assertCondition(
      'SEC-1.8: Error flags missing ALLOWED_PHONE_NUMBER',
      result4.errors.some(errorItem => errorItem.variableName === 'ALLOWED_PHONE_NUMBER')
    );

    // Case 1.5: Both channels enabled, but Telegram lacks allowlist -> validation must fail
    const mixedConfigWithMissingTelegramAllowlist = createBaseConfiguration({
      enabledMessengerChannels: ['whatsapp', 'telegram'],
      allowedPhoneNumber: '6281234567890',
      telegramBotToken: dummyToken,
      telegramAllowedUserId: '',
    });
    const result5 = validateApplicationConfiguration(mixedConfigWithMissingTelegramAllowlist);
    assertCondition(
      'SEC-1.9: Multi-channel configuration fails if any enabled channel lacks allowlist',
      result5.isValid === false
    );
    assertCondition(
      'SEC-1.10: Error specifically identifies unconfigured TELEGRAM_ALLOWED_USER_ID',
      result5.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID')
    );

    // Case 1.6: Enabled Telegram without TELEGRAM_BOT_TOKEN fails validation
    const telegramMissingTokenConfig = createBaseConfiguration({
      enabledMessengerChannels: ['telegram'],
      allowedPhoneNumber: '',
      telegramBotToken: '',
      telegramAllowedUserId: '987654321',
    });
    const result6 = validateApplicationConfiguration(telegramMissingTokenConfig);
    assertCondition('SEC-1.11: Enabled Telegram without TELEGRAM_BOT_TOKEN fails validation', result6.isValid === false);
    assertCondition(
      'SEC-1.12: Error flags missing TELEGRAM_BOT_TOKEN',
      result6.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_BOT_TOKEN')
    );

    // Case 1.7: No enabled messenger channels fails validation
    const noChannelsConfig = createBaseConfiguration({
      enabledMessengerChannels: [],
    });
    const result7 = validateApplicationConfiguration(noChannelsConfig);
    assertCondition('SEC-1.13: Empty enabledMessengerChannels fails validation', result7.isValid === false);
  }

  // ----------------------------------------------------
  // TEST GROUP 2: Telegram Adapter Fail-Closed Middleware & Whitelist Gates
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Telegram Adapter Fail-Closed Middleware & Whitelist Gates');
  {
    // Case 2.1: Empty allowlist rejects all senders (fail-closed)
    const emptyAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '', dummyCallback);
    assertCondition(
      'SEC-2.1: Empty allowlist rejects arbitrary numeric ID',
      emptyAllowlistAdapter.isAuthorizedSender('123456789') === false
    );
    assertCondition(
      'SEC-2.2: Empty allowlist rejects arbitrary username',
      emptyAllowlistAdapter.isAuthorizedSender('', 'someuser') === false
    );
    assertCondition(
      'SEC-2.3: Empty allowlist rejects combined ID and username',
      emptyAllowlistAdapter.isAuthorizedSender('123456789', 'someuser') === false
    );

    // Test middleware execution with empty allowlist
    let nextHandlerCalled1 = false;
    const mockContext1: Partial<Context> = {
      from: { id: 123456789, is_bot: false, first_name: 'Attacker', username: 'attacker' },
    };
    await emptyAllowlistAdapter.handleInboundMiddleware(mockContext1 as Context, async () => {
      nextHandlerCalled1 = true;
    });
    assertCondition(
      'SEC-2.4: Inbound middleware blocks message propagation when allowlist is empty (fail-closed)',
      nextHandlerCalled1 === false
    );

    // Case 2.2: Undefined / whitespace allowlist also fails closed
    const whitespaceAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '   ', dummyCallback);
    assertCondition(
      'SEC-2.5: Whitespace allowlist rejects arbitrary sender',
      whitespaceAllowlistAdapter.isAuthorizedSender('123456789') === false
    );
    let nextHandlerCalled2 = false;
    await whitespaceAllowlistAdapter.handleInboundMiddleware(mockContext1 as Context, async () => {
      nextHandlerCalled2 = true;
    });
    assertCondition(
      'SEC-2.6: Inbound middleware blocks message when allowlist is whitespace',
      nextHandlerCalled2 === false
    );

    // Case 2.3: Configured numeric allowlist allows whitelisted sender and rejects others
    const authorizedNumericId = '55667788';
    const numericAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, authorizedNumericId, dummyCallback);

    assertCondition(
      'SEC-2.7: Whitelisted numeric ID is authorized',
      numericAllowlistAdapter.isAuthorizedSender(authorizedNumericId) === true
    );
    assertCondition(
      'SEC-2.8: Non-whitelisted numeric ID is rejected',
      numericAllowlistAdapter.isAuthorizedSender('99999999') === false
    );

    let authorizedNextCalled = false;
    const authorizedContext: Partial<Context> = {
      from: { id: 55667788, is_bot: false, first_name: 'Owner', username: 'owner_handle' },
    };
    await numericAllowlistAdapter.handleInboundMiddleware(authorizedContext as Context, async () => {
      authorizedNextCalled = true;
    });
    assertCondition(
      'SEC-2.9: Middleware invokes next() for whitelisted numeric sender',
      authorizedNextCalled === true
    );

    let unauthorizedNextCalled = false;
    const unauthorizedContext: Partial<Context> = {
      from: { id: 11223344, is_bot: false, first_name: 'Stranger', username: 'stranger' },
    };
    await numericAllowlistAdapter.handleInboundMiddleware(unauthorizedContext as Context, async () => {
      unauthorizedNextCalled = true;
    });
    assertCondition(
      'SEC-2.10: Middleware blocks next() for unauthorized numeric sender',
      unauthorizedNextCalled === false
    );

    // Case 2.4: Configured username allowlist allows case-insensitive username match
    const usernameAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '@Churma16', dummyCallback);
    assertCondition(
      'SEC-2.11: Whitelisted username matches exact case',
      usernameAllowlistAdapter.isAuthorizedSender('12345', 'Churma16') === true
    );
    assertCondition(
      'SEC-2.12: Whitelisted username matches lowercase',
      usernameAllowlistAdapter.isAuthorizedSender('12345', 'churma16') === true
    );
    assertCondition(
      'SEC-2.13: Whitelisted username matches uppercase',
      usernameAllowlistAdapter.isAuthorizedSender('12345', 'CHURMA16') === true
    );
    assertCondition(
      'SEC-2.14: Whitelisted username matches with leading @ in sender',
      usernameAllowlistAdapter.isAuthorizedSender('12345', '@churma16') === true
    );
    assertCondition(
      'SEC-2.15: Unmatched username is rejected',
      usernameAllowlistAdapter.isAuthorizedSender('12345', 'otheruser') === false
    );

    let usernameNextCalled = false;
    const usernameContext: Partial<Context> = {
      from: { id: 99999, is_bot: false, first_name: 'Churma', username: 'churma16' },
    };
    await usernameAllowlistAdapter.handleInboundMiddleware(usernameContext as Context, async () => {
      usernameNextCalled = true;
    });
    assertCondition(
      'SEC-2.16: Middleware invokes next() for whitelisted username sender',
      usernameNextCalled === true
    );
  }

  // ----------------------------------------------------
  // TEST GROUP 3: WhatsApp Adapter Fail-Closed Inbound Authorization
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] WhatsApp Adapter Fail-Closed Inbound Authorization');
  {
    const dummySessionDir = './test_auth_session';

    // Case 3.1: Empty ALLOWED_PHONE_NUMBER rejects non-self messages
    let messageCallbackInvokedCount = 0;
    const callbackSpy = async (_event: IncomingUserMessageEvent) => {
      messageCallbackInvokedCount++;
    };

    const emptyPhoneAdapter = new WhatsappMessagingAdapter(dummySessionDir, '', callbackSpy);

    assertCondition(
      'SEC-3.1: Empty allowlist rejects non-self sender in isAuthorizedSender',
      emptyPhoneAdapter.isAuthorizedSender('6281234567890@s.whatsapp.net', false) === false
    );

    // Non-self message from external number
    const externalMessage: proto.IWebMessageInfo = {
      key: {
        remoteJid: '62899998888@s.whatsapp.net',
        fromMe: false,
        id: 'EXT_MSG_001',
      },
      message: {
        conversation: 'Beli bensin 50000',
      },
    };

    await emptyPhoneAdapter.processIncomingMessages([externalMessage]);
    assertCondition(
      'SEC-3.2: Non-self message rejected when ALLOWED_PHONE_NUMBER is empty (fail-closed)',
      messageCallbackInvokedCount === 0
    );

    // Case 3.2: Configured allowlist authorizes whitelisted sender
    const whitelistedPhoneNumber = '6281234567890';
    let whitelistedCallbackReceived = false;
    let receivedPayloadText = '';
    const whitelistedCallbackSpy = async (event: IncomingUserMessageEvent) => {
      whitelistedCallbackReceived = true;
      receivedPayloadText = event.textPayload;
    };

    const whitelistedAdapter = new WhatsappMessagingAdapter(
      dummySessionDir,
      whitelistedPhoneNumber,
      whitelistedCallbackSpy
    );

    assertCondition(
      'SEC-3.3: Configured allowlist authorizes matching phone number',
      whitelistedAdapter.isAuthorizedSender('6281234567890@s.whatsapp.net', false) === true
    );
    assertCondition(
      'SEC-3.4: Configured allowlist rejects non-matching phone number',
      whitelistedAdapter.isAuthorizedSender('62899998888@s.whatsapp.net', false) === false
    );

    // Unauthorized sender message
    const unauthorizedMessage: proto.IWebMessageInfo = {
      key: {
        remoteJid: '62899998888@s.whatsapp.net',
        fromMe: false,
        id: 'UNAUTH_MSG_001',
      },
      message: {
        conversation: 'Transfer uang 1000000',
      },
    };

    await whitelistedAdapter.processIncomingMessages([unauthorizedMessage]);
    assertCondition(
      'SEC-3.5: Message from unauthorized sender is discarded',
      whitelistedCallbackReceived === false
    );

    // Authorized sender message
    const authorizedMessage: proto.IWebMessageInfo = {
      key: {
        remoteJid: '6281234567890@s.whatsapp.net',
        fromMe: false,
        id: 'AUTH_MSG_001',
      },
      message: {
        conversation: 'Kopi 25000',
      },
    };

    await whitelistedAdapter.processIncomingMessages([authorizedMessage]);
    assertCondition(
      'SEC-3.6: Message from whitelisted sender is successfully processed',
      whitelistedCallbackReceived === true && receivedPayloadText === 'Kopi 25000'
    );

    // Case 3.3: Self-targeted messages (notes-to-self, fromMe) are authorized
    assertCondition(
      'SEC-3.7: Self-targeted message is recognized when sender matches allowed number',
      whitelistedAdapter.isTargetingSelf('6281234567890@s.whatsapp.net') === true
    );
    assertCondition(
      'SEC-3.8: Self-targeted message is recognized when sender matches botUserPhoneNumber',
      emptyPhoneAdapter.isTargetingSelf('6285555555555@s.whatsapp.net', '6285555555555') === true
    );
    assertCondition(
      'SEC-3.9: isAuthorizedSender returns true for self-targeted message',
      emptyPhoneAdapter.isAuthorizedSender('6285555555555@s.whatsapp.net', true) === true
    );
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Defense in Depth (Bypassed Application Validation)
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Defense in Depth (Bypassed Application Validation)');
  {
    // If an adapter is created directly or via bypassed startup validation with an undefined allowlist:
    const undefTelegramAdapter = new TelegramMessagingAdapter(dummyToken, undefined as any, dummyCallback);
    assertCondition(
      'SEC-4.1: Telegram adapter with undefined allowlist fails closed',
      undefTelegramAdapter.isAuthorizedSender('123456') === false
    );

    let undefNextCalled = false;
    await undefTelegramAdapter.handleInboundMiddleware(
      { from: { id: 123456, is_bot: false, first_name: 'Test' } } as Context,
      async () => {
        undefNextCalled = true;
      }
    );
    assertCondition(
      'SEC-4.2: Telegram middleware blocks incoming messages when allowlist is undefined',
      undefNextCalled === false
    );

    const undefWhatsAppAdapter = new WhatsappMessagingAdapter('./test_dir', undefined as any, dummyCallback);
    assertCondition(
      'SEC-4.3: WhatsApp adapter with undefined allowlist fails closed for non-self sender',
      undefWhatsAppAdapter.isAuthorizedSender('628123456789@s.whatsapp.net', false) === false
    );
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(
    `[TEST SUMMARY] Total: ${testStatistics.totalCount} | Passed: ${testStatistics.passedCount} | Failed: ${testStatistics.failedCount}`
  );
  console.log('====================================================');

  if (testStatistics.failedCount > 0) {
    process.exit(1);
  } else {
    console.log('[SUCCESS] All fail-closed whitelist authorization test cases passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
