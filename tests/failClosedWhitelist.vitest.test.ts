import { describe, expect, it } from 'vitest';
import type { proto } from '@whiskeysockets/baileys';
import type { Context } from 'grammy';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { WhatsappMessagingAdapter } from '../src/gateway/whatsapp.js';
import {
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';
import { Application } from '../src/app.js';
import { IncomingUserMessageEvent } from '../src/gateway/types.js';

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

describe('fail-closed whitelist authorization and configuration validation', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyCallback = async (_event: IncomingUserMessageEvent) => {};

  describe('application configuration validation', () => {
    it('accepts valid WhatsApp-only and Telegram-only configurations', () => {
      const validWhatsAppConfig = createBaseConfiguration({
        enabledMessengerChannels: ['whatsapp'],
        allowedPhoneNumber: '6281234567890',
      });
      const resultWhatsApp = validateApplicationConfiguration(validWhatsAppConfig);
      expect(resultWhatsApp.isValid).toBe(true);
      expect(resultWhatsApp.errors).toHaveLength(0);

      const validTelegramConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        allowedPhoneNumber: '',
        telegramBotToken: dummyToken,
        telegramAllowedUserId: '987654321',
      });
      const resultTelegram = validateApplicationConfiguration(validTelegramConfig);
      expect(resultTelegram.isValid).toBe(true);
      expect(resultTelegram.errors).toHaveLength(0);
    });

    it('rejects enabled Telegram when TELEGRAM_ALLOWED_USER_ID is missing or whitespace', () => {
      const missingConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        allowedPhoneNumber: '',
        telegramBotToken: dummyToken,
        telegramAllowedUserId: '',
      });
      const missingResult = validateApplicationConfiguration(missingConfig);
      expect(missingResult.isValid).toBe(false);
      expect(missingResult.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID')).toBe(true);

      const whitespaceConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        allowedPhoneNumber: '',
        telegramBotToken: dummyToken,
        telegramAllowedUserId: '   ',
      });
      const whitespaceResult = validateApplicationConfiguration(whitespaceConfig);
      expect(whitespaceResult.isValid).toBe(false);
      expect(
        whitespaceResult.errors.some(
          errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID' && errorItem.message.includes('not set')
        )
      ).toBe(true);
    });

    it('rejects invalid canonical Telegram user IDs including isolated @, usernames, and alphanumeric strings', () => {
      const isolatedAtResult = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['telegram'],
          allowedPhoneNumber: '',
          telegramBotToken: dummyToken,
          telegramAllowedUserId: '@',
        })
      );
      expect(isolatedAtResult.isValid).toBe(false);
      expect(
        isolatedAtResult.errors.some(
          errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID' && errorItem.message.includes('empty or invalid')
        )
      ).toBe(true);

      const usernameResult = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['telegram'],
          allowedPhoneNumber: '',
          telegramBotToken: dummyToken,
          telegramAllowedUserId: 'churma16',
        })
      );
      expect(usernameResult.isValid).toBe(false);
      expect(
        usernameResult.errors.some(
          errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID' && errorItem.message.includes('usernames are not supported')
        )
      ).toBe(true);

      const atUsernameResult = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['telegram'],
          allowedPhoneNumber: '',
          telegramBotToken: dummyToken,
          telegramAllowedUserId: '@churma16',
        })
      );
      expect(atUsernameResult.isValid).toBe(false);

      const alphanumericResult = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['telegram'],
          allowedPhoneNumber: '',
          telegramBotToken: dummyToken,
          telegramAllowedUserId: '12345abc',
        })
      );
      expect(alphanumericResult.isValid).toBe(false);
    });

    it('does not reproduce sentinel secret values in validation error messages', () => {
      const sentinelSecretValue = 'super-secret-telegram-token-xyz-12345-never-log';
      const sentinelConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        allowedPhoneNumber: '',
        telegramBotToken: dummyToken,
        telegramAllowedUserId: sentinelSecretValue,
      });
      const resultSentinel = validateApplicationConfiguration(sentinelConfig);

      expect(resultSentinel.isValid).toBe(false);
      const leaksSentinel = resultSentinel.errors.some(
        errorItem => errorItem.message.includes(sentinelSecretValue) || Boolean(errorItem.hint?.includes(sentinelSecretValue))
      );
      expect(leaksSentinel).toBe(false);
    });

    it('accepts numeric Telegram user IDs with optional leading @ and produces a usable adapter', () => {
      const validNumericWithAt = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        allowedPhoneNumber: '',
        telegramBotToken: dummyToken,
        telegramAllowedUserId: '@987654321',
      });
      const result = validateApplicationConfiguration(validNumericWithAt);
      expect(result.isValid).toBe(true);

      const canonicalAdapter = new TelegramMessagingAdapter(dummyToken, validNumericWithAt.telegramAllowedUserId, dummyCallback);
      expect(canonicalAdapter.isAuthorizedSender('987654321')).toBe(true);
    });

    it('validates required messenger credentials and channel allowlists', () => {
      const whatsAppMissingPhone = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['whatsapp'],
          allowedPhoneNumber: '',
          telegramBotToken: '',
          telegramAllowedUserId: '',
        })
      );
      expect(whatsAppMissingPhone.isValid).toBe(false);
      expect(whatsAppMissingPhone.errors.some(errorItem => errorItem.variableName === 'ALLOWED_PHONE_NUMBER')).toBe(true);

      const mixedConfigMissingTelegram = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['whatsapp', 'telegram'],
          allowedPhoneNumber: '6281234567890',
          telegramBotToken: dummyToken,
          telegramAllowedUserId: '',
        })
      );
      expect(mixedConfigMissingTelegram.isValid).toBe(false);
      expect(mixedConfigMissingTelegram.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_ALLOWED_USER_ID')).toBe(true);

      const telegramMissingToken = validateApplicationConfiguration(
        createBaseConfiguration({
          enabledMessengerChannels: ['telegram'],
          allowedPhoneNumber: '',
          telegramBotToken: '',
          telegramAllowedUserId: '987654321',
        })
      );
      expect(telegramMissingToken.isValid).toBe(false);
      expect(telegramMissingToken.errors.some(errorItem => errorItem.variableName === 'TELEGRAM_BOT_TOKEN')).toBe(true);

      const noChannels = validateApplicationConfiguration(
        createBaseConfiguration({ enabledMessengerChannels: [] })
      );
      expect(noChannels.isValid).toBe(false);
    });

    it('validates provider-specific AI and Wallet MCP credentials', () => {
      const missingGeminiKey = validateApplicationConfiguration(
        createBaseConfiguration({
          aiProvider: 'gemini',
          geminiApiKey: '',
        })
      );
      expect(missingGeminiKey.isValid).toBe(false);
      expect(
        missingGeminiKey.errors.some(errorItem => errorItem.variableName === 'GEMINI_API_KEY' && Boolean(errorItem.hint))
      ).toBe(true);

      const missingOtherAiKey = validateApplicationConfiguration(
        createBaseConfiguration({
          aiProvider: 'openrouter',
          aiApiKey: '',
          geminiApiKey: '',
        })
      );
      expect(missingOtherAiKey.isValid).toBe(false);
      expect(missingOtherAiKey.errors.some(errorItem => errorItem.variableName === 'AI_API_KEY')).toBe(true);

      const ollamaConfig = validateApplicationConfiguration(
        createBaseConfiguration({
          aiProvider: 'ollama',
          aiApiKey: '',
          geminiApiKey: '',
        })
      );
      expect(ollamaConfig.isValid).toBe(true);

      const missingWalletToken = validateApplicationConfiguration(
        createBaseConfiguration({ walletMcpAccessToken: '' })
      );
      expect(missingWalletToken.isValid).toBe(false);
      expect(
        missingWalletToken.errors.some(
          errorItem => errorItem.variableName === 'WALLET_MCP_ACCESS_TOKEN' && Boolean(errorItem.hint)
        )
      ).toBe(true);
    });

    it('fails closed when notification webhook is enabled without secret on non-loopback host or in production', () => {
      // 1. Non-loopback host (0.0.0.0) without secret -> error (isValid: false)
      const nonLoopbackMissingSecret = validateApplicationConfiguration(
        createBaseConfiguration({
          notificationWebhookEnabled: true,
          notificationWebhookHost: '0.0.0.0',
          notificationWebhookSecret: '',
        })
      );
      expect(nonLoopbackMissingSecret.isValid).toBe(false);
      expect(
        nonLoopbackMissingSecret.errors.some(
          errorItem => errorItem.variableName === 'NOTIFICATION_WEBHOOK_SECRET'
        )
      ).toBe(true);

      // 2. Loopback host (127.0.0.1) in production without secret -> error (isValid: false)
      const originalNodeEnv = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        const productionMissingSecret = validateApplicationConfiguration(
          createBaseConfiguration({
            notificationWebhookEnabled: true,
            notificationWebhookHost: '127.0.0.1',
            notificationWebhookSecret: '',
          })
        );
        expect(productionMissingSecret.isValid).toBe(false);
        expect(
          productionMissingSecret.errors.some(
            errorItem => errorItem.variableName === 'NOTIFICATION_WEBHOOK_SECRET'
          )
        ).toBe(true);
      } finally {
        process.env.NODE_ENV = originalNodeEnv;
      }

      // 3. Loopback host (127.0.0.1) in dev/test without secret -> warning (isValid: true)
      const loopbackDevMissingSecret = validateApplicationConfiguration(
        createBaseConfiguration({
          notificationWebhookEnabled: true,
          notificationWebhookHost: '127.0.0.1',
          notificationWebhookSecret: '',
        })
      );
      expect(loopbackDevMissingSecret.isValid).toBe(true);
      expect(
        loopbackDevMissingSecret.warnings.some(
          warnItem => warnItem.variableName === 'NOTIFICATION_WEBHOOK_SECRET'
        )
      ).toBe(true);

      // 4. Valid secret configured on 0.0.0.0 -> valid (no error or warning)
      const validWebhookConfig = validateApplicationConfiguration(
        createBaseConfiguration({
          notificationWebhookEnabled: true,
          notificationWebhookHost: '0.0.0.0',
          notificationWebhookSecret: 'secure-token-12345',
        })
      );
      expect(validWebhookConfig.isValid).toBe(true);
      expect(
        validWebhookConfig.errors.some(
          errorItem => errorItem.variableName === 'NOTIFICATION_WEBHOOK_SECRET'
        )
      ).toBe(false);
      expect(
        validWebhookConfig.warnings.some(
          warnItem => warnItem.variableName === 'NOTIFICATION_WEBHOOK_SECRET'
        )
      ).toBe(false);
    });
  });

  describe('TelegramMessagingAdapter fail-closed authorization gates', () => {
    it('rejects all senders and blocks middleware when allowlist is empty or whitespace', async () => {
      const emptyAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '', dummyCallback);
      expect(emptyAllowlistAdapter.isAuthorizedSender('123456789')).toBe(false);
      expect(emptyAllowlistAdapter.isAuthorizedSender('', 'someuser')).toBe(false);
      expect(emptyAllowlistAdapter.isAuthorizedSender('123456789', 'someuser')).toBe(false);

      let nextCalledEmpty = false;
      const mockContext1: Partial<Context> = {
        from: { id: 123456789, is_bot: false, first_name: 'Attacker', username: 'attacker' },
      };
      await emptyAllowlistAdapter.handleInboundMiddleware(mockContext1 as Context, async () => {
        nextCalledEmpty = true;
      });
      expect(nextCalledEmpty).toBe(false);

      const whitespaceAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '   ', dummyCallback);
      expect(whitespaceAllowlistAdapter.isAuthorizedSender('123456789')).toBe(false);

      let nextCalledWhitespace = false;
      await whitespaceAllowlistAdapter.handleInboundMiddleware(mockContext1 as Context, async () => {
        nextCalledWhitespace = true;
      });
      expect(nextCalledWhitespace).toBe(false);
    });

    it('authorizes whitelisted numeric IDs and blocks unauthorized senders in middleware', async () => {
      const authorizedNumericId = '55667788';
      const numericAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, authorizedNumericId, dummyCallback);

      expect(numericAllowlistAdapter.isAuthorizedSender(authorizedNumericId)).toBe(true);
      expect(numericAllowlistAdapter.isAuthorizedSender('99999999')).toBe(false);

      let authorizedNextCalled = false;
      const authorizedContext: Partial<Context> = {
        from: { id: 55667788, is_bot: false, first_name: 'Owner', username: 'owner_handle' },
      };
      await numericAllowlistAdapter.handleInboundMiddleware(authorizedContext as Context, async () => {
        authorizedNextCalled = true;
      });
      expect(authorizedNextCalled).toBe(true);

      let unauthorizedNextCalled = false;
      const unauthorizedContext: Partial<Context> = {
        from: { id: 11223344, is_bot: false, first_name: 'Stranger', username: 'stranger' },
      };
      await numericAllowlistAdapter.handleInboundMiddleware(unauthorizedContext as Context, async () => {
        unauthorizedNextCalled = true;
      });
      expect(unauthorizedNextCalled).toBe(false);
    });

    it('fails closed when configured with non-numeric usernames', async () => {
      const nonNumericAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '@Churma16', dummyCallback);
      expect(nonNumericAllowlistAdapter.isAuthorizedSender('12345', 'Churma16')).toBe(false);
      expect(nonNumericAllowlistAdapter.isAuthorizedSender('12345')).toBe(false);

      let nonNumericNextCalled = false;
      const nonNumericContext: Partial<Context> = {
        from: { id: 12345, is_bot: false, first_name: 'Churma', username: 'Churma16' },
      };
      await nonNumericAllowlistAdapter.handleInboundMiddleware(nonNumericContext as Context, async () => {
        nonNumericNextCalled = true;
      });
      expect(nonNumericNextCalled).toBe(false);
    });

    it('strictly checks numeric user IDs and ignores username spoofing or changes', async () => {
      const targetUserId = '77889900';
      const strictIdAdapter = new TelegramMessagingAdapter(dummyToken, targetUserId, dummyCallback);

      expect(strictIdAdapter.isAuthorizedSender('99999999', targetUserId)).toBe(false);
      expect(strictIdAdapter.isAuthorizedSender('99999999', 'owner_handle')).toBe(false);
      expect(strictIdAdapter.isAuthorizedSender(targetUserId, 'any_random_username')).toBe(true);
      expect(strictIdAdapter.isAuthorizedSender(targetUserId, undefined)).toBe(true);

      let impersonatorNextCalled = false;
      const impersonatorContext: Partial<Context> = {
        from: { id: 99999999, is_bot: false, first_name: 'Impersonator', username: 'owner_handle' },
      };
      await strictIdAdapter.handleInboundMiddleware(impersonatorContext as Context, async () => {
        impersonatorNextCalled = true;
      });
      expect(impersonatorNextCalled).toBe(false);

      let legitimateOwnerNextCalled = false;
      const legitimateOwnerContext: Partial<Context> = {
        from: { id: Number(targetUserId), is_bot: false, first_name: 'Real Owner', username: 'different_handle' },
      };
      await strictIdAdapter.handleInboundMiddleware(legitimateOwnerContext as Context, async () => {
        legitimateOwnerNextCalled = true;
      });
      expect(legitimateOwnerNextCalled).toBe(true);
    });
  });

  describe('WhatsappMessagingAdapter fail-closed inbound authorization', () => {
    const dummySessionDir = './test_auth_session';

    it('rejects non-self messages when ALLOWED_PHONE_NUMBER is empty', async () => {
      let callbackCount = 0;
      const emptyPhoneAdapter = new WhatsappMessagingAdapter(dummySessionDir, '', async () => {
        callbackCount++;
      });

      expect(emptyPhoneAdapter.isAuthorizedSender('6281234567890@s.whatsapp.net', false)).toBe(false);

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
      expect(callbackCount).toBe(0);
    });

    it('authorizes whitelisted phone numbers and drops unauthorized messages', async () => {
      const whitelistedPhoneNumber = '6281234567890';
      let whitelistedCallbackReceived = false;
      let receivedPayloadText = '';
      const whitelistedCallback = async (event: IncomingUserMessageEvent) => {
        whitelistedCallbackReceived = true;
        receivedPayloadText = event.textPayload;
      };

      const whitelistedAdapter = new WhatsappMessagingAdapter(
        dummySessionDir,
        whitelistedPhoneNumber,
        whitelistedCallback
      );

      expect(whitelistedAdapter.isAuthorizedSender('6281234567890@s.whatsapp.net', false)).toBe(true);
      expect(whitelistedAdapter.isAuthorizedSender('62899998888@s.whatsapp.net', false)).toBe(false);

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
      expect(whitelistedCallbackReceived).toBe(false);

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
      expect(whitelistedCallbackReceived).toBe(true);
      expect(receivedPayloadText).toBe('Kopi 25000');
    });

    it('authorizes self-targeted messages (notes-to-self)', () => {
      const whitelistedAdapter = new WhatsappMessagingAdapter(dummySessionDir, '6281234567890', dummyCallback);
      const emptyPhoneAdapter = new WhatsappMessagingAdapter(dummySessionDir, '', dummyCallback);

      expect(whitelistedAdapter.isTargetingSelf('6281234567890@s.whatsapp.net')).toBe(true);
      expect(emptyPhoneAdapter.isTargetingSelf('6285555555555@s.whatsapp.net', '6285555555555')).toBe(true);
      expect(emptyPhoneAdapter.isAuthorizedSender('6285555555555@s.whatsapp.net', true)).toBe(true);
    });
  });

  describe('defense in depth with bypassed application validation', () => {
    it('fails closed when adapters are created directly with undefined allowlists', async () => {
      const undefTelegramAdapter = new TelegramMessagingAdapter(dummyToken, undefined as unknown as string, dummyCallback);
      expect(undefTelegramAdapter.isAuthorizedSender('123456')).toBe(false);

      let undefNextCalled = false;
      await undefTelegramAdapter.handleInboundMiddleware(
        { from: { id: 123456, is_bot: false, first_name: 'Test' } } as Context,
        async () => {
          undefNextCalled = true;
        }
      );
      expect(undefNextCalled).toBe(false);

      const undefWhatsAppAdapter = new WhatsappMessagingAdapter('./test_dir', undefined as unknown as string, dummyCallback);
      expect(undefWhatsAppAdapter.isAuthorizedSender('628123456789@s.whatsapp.net', false)).toBe(false);
    });
  });

  describe('Application class configuration validation integration', () => {
    it('instantiates and validates cleanly on valid configuration', () => {
      const validAppConfig = createBaseConfiguration({
        enabledMessengerChannels: ['whatsapp'],
        allowedPhoneNumber: '6281234567890',
      });
      const validApp = new Application(validAppConfig);
      expect(validApp).toBeDefined();

      expect(() => {
        (validApp as unknown as { validateConfiguration: () => void }).validateConfiguration();
      }).not.toThrow();
    });

    it('exits with code 1 when configuration validation fails on Application.validateConfiguration', () => {
      const invalidAppConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        telegramBotToken: dummyToken,
        telegramAllowedUserId: '',
      });
      const invalidApp = new Application(invalidAppConfig);
      let processExitCode: number | null = null;
      const originalProcessExit = process.exit;

      try {
        process.exit = ((exitCode?: number) => {
          processExitCode = exitCode ?? 0;
          throw new Error('INTERCEPTED_PROCESS_EXIT');
        }) as unknown as typeof process.exit;

        try {
          (invalidApp as unknown as { validateConfiguration: () => void }).validateConfiguration();
        } catch (exitError) {
          if ((exitError as Error).message !== 'INTERCEPTED_PROCESS_EXIT') {
            throw exitError;
          }
        }
      } finally {
        process.exit = originalProcessExit;
      }

      expect(processExitCode).toBe(1);
    });

    it('does not log raw sentinel secret values to console or logs during validation failure', () => {
      const sentinelSecretLeakValue = 'sentinel-super-secret-token-do-not-leak-999';
      const sentinelLeakTestConfig = createBaseConfiguration({
        enabledMessengerChannels: ['telegram'],
        telegramBotToken: dummyToken,
        telegramAllowedUserId: sentinelSecretLeakValue,
      });
      const leakTestApp = new Application(sentinelLeakTestConfig);
      const capturedLogOutputs: string[] = [];

      const originalConsoleLog = console.log;
      const originalConsoleError = console.error;
      const originalConsoleWarn = console.warn;
      const originalConsoleInfo = console.info;
      const originalProcessExit = process.exit;

      try {
        const logCatcher = (...args: unknown[]) => {
          capturedLogOutputs.push(
            args.map(argumentItem => (typeof argumentItem === 'string' ? argumentItem : JSON.stringify(argumentItem))).join(' ')
          );
        };
        console.log = logCatcher;
        console.error = logCatcher;
        console.warn = logCatcher;
        console.info = logCatcher;

        process.exit = (() => {
          throw new Error('INTERCEPTED_PROCESS_EXIT');
        }) as unknown as typeof process.exit;

        try {
          (leakTestApp as unknown as { validateConfiguration: () => void }).validateConfiguration();
        } catch (exitError) {
          if ((exitError as Error).message !== 'INTERCEPTED_PROCESS_EXIT') {
            throw exitError;
          }
        }
      } finally {
        process.exit = originalProcessExit;
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
        console.info = originalConsoleInfo;
      }

      const combinedOutput = capturedLogOutputs.join('\n');
      expect(combinedOutput).not.toContain(sentinelSecretLeakValue);
    });
  });
});
