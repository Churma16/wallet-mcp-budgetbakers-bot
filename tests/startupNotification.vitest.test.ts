import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDictionary } from '../src/i18n/index.js';
import { Application } from '../src/app.js';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { createTestAppContext } from './fixtures/testContext.js';
import { applicationLogger } from '../src/lib/index.js';

describe('System Startup Notification (UX Option 2)', () => {
  describe('Dictionary Formatting', () => {
    it('formats startup notification card cleanly in Indonesian (id)', () => {
      const dictionary = getDictionary('id');
      const rendered = dictionary.system.startupNotification({
        telegramStatus: 'Aktif',
        gmailStatus: 'Terhubung',
        timeDisplay: '21:20 WIB',
      });

      expect(rendered).toContain('🤖 *Wallet Bot siap digunakan*');
      expect(rendered).toContain('• Telegram & Webhook: Aktif');
      expect(rendered).toContain('• Gmail Sync: Terhubung');
      expect(rendered).toContain('⏱️ 21:20 WIB');
    });

    it('formats startup notification card cleanly in English (en)', () => {
      const dictionary = getDictionary('en');
      const rendered = dictionary.system.startupNotification({
        telegramStatus: 'Active',
        gmailStatus: 'Connected',
        timeDisplay: '21:20 WIB',
      });

      expect(rendered).toContain('🤖 *Wallet Bot is ready to use*');
      expect(rendered).toContain('• Telegram & Webhook: Active');
      expect(rendered).toContain('• Gmail Sync: Connected');
      expect(rendered).toContain('⏱️ 21:20 WIB');
    });
  });

  describe('Application.dispatchStartupNotification', () => {
    it('dispatches startup notification via gateway broadcast with correct statuses', async () => {
      const mockGateway = {
        isChannelConnected: vi.fn().mockImplementation((channel: string) => channel === 'telegram'),
        broadcastNotification: vi.fn().mockResolvedValue({ telegram: 'msg-boot-1' }),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'id',
          notificationWebhookEnabled: true,
          emailSyncEnabled: true,
          notifyOnStartup: true,
        } as any,
        gateway: mockGateway as any,
        webhook: { port: 3000 } as any,
        email: { listener: { isConnected: true } as any },
      });

      const app = new Application(context);

      await app.dispatchStartupNotification();

      expect(mockGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      const message = mockGateway.broadcastNotification.mock.calls[0][0];
      expect(message).toContain('🤖 *Wallet Bot siap digunakan*');
      expect(message).toContain('• Telegram & Webhook: Aktif');
      expect(message).toContain('• Gmail Sync: Terhubung');
      expect(message).toContain('⏱️');
    });

    it('reflects inactive or disabled services accurately in the broadcast text', async () => {
      const mockGateway = {
        isChannelConnected: vi.fn().mockReturnValue(false),
        broadcastNotification: vi.fn().mockResolvedValue({}),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'id',
          notificationWebhookEnabled: false,
          emailSyncEnabled: false,
          notifyOnStartup: true,
        } as any,
        gateway: mockGateway as any,
        webhook: null,
        email: { listener: null },
      });

      const app = new Application(context);

      await app.dispatchStartupNotification();

      expect(mockGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      const message = mockGateway.broadcastNotification.mock.calls[0][0];
      expect(message).toContain('• Telegram & Webhook: Nonaktif');
      expect(message).toContain('• Gmail Sync: Nonaktif');
    });

    it('formats English broadcast with individual connected and disabled states', async () => {
      const mockGateway = {
        isChannelConnected: vi.fn().mockReturnValue(true),
        broadcastNotification: vi.fn().mockResolvedValue({}),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'en',
          notificationWebhookEnabled: false,
          emailSyncEnabled: false,
          notifyOnStartup: true,
        } as any,
        gateway: mockGateway as any,
        webhook: null,
        email: { listener: null },
      });

      const app = new Application(context);

      await app.dispatchStartupNotification();

      expect(mockGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      const message = mockGateway.broadcastNotification.mock.calls[0][0];
      expect(message).toContain('🤖 *Wallet Bot is ready to use*');
      expect(message).toContain('• Telegram & Webhook: Connected');
      expect(message).toContain('• Gmail Sync: Disabled');
    });

    it('formats English broadcast with active webhook and connected gmail', async () => {
      const mockGateway = {
        isChannelConnected: vi.fn().mockReturnValue(true),
        broadcastNotification: vi.fn().mockResolvedValue({}),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'en',
          notificationWebhookEnabled: true,
          emailSyncEnabled: true,
          notifyOnStartup: true,
        } as any,
        gateway: mockGateway as any,
        webhook: { port: 3000 },
        email: { listener: { isConnected: true } },
      });

      const app = new Application(context);

      await app.dispatchStartupNotification();

      expect(mockGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      const message = mockGateway.broadcastNotification.mock.calls[0][0];
      expect(message).toContain('• Telegram & Webhook: Active');
      expect(message).toContain('• Gmail Sync: Connected');
    });

    it('formats English broadcast with inactive telegram and disabled gmail', async () => {
      const mockGateway = {
        isChannelConnected: vi.fn().mockReturnValue(false),
        broadcastNotification: vi.fn().mockResolvedValue({}),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'en',
          notificationWebhookEnabled: false,
          emailSyncEnabled: false,
          notifyOnStartup: true,
        } as any,
        gateway: mockGateway as any,
        webhook: null,
        email: { listener: null },
      });

      const app = new Application(context);

      await app.dispatchStartupNotification();

      expect(mockGateway.broadcastNotification).toHaveBeenCalledTimes(1);
      const message = mockGateway.broadcastNotification.mock.calls[0][0];
      expect(message).toContain('• Telegram & Webhook: Inactive');
      expect(message).toContain('• Gmail Sync: Disabled');
    });
  });

  describe('Application.start notification lifecycle', () => {
    it('dispatches startup notification during start() lifecycle and logs warning on failure', async () => {
      const warnSpy = vi.spyOn(applicationLogger, 'warn').mockImplementation(() => {});
      const mockGateway = {
        isChannelConnected: vi.fn().mockReturnValue(true),
        broadcastNotification: vi.fn().mockRejectedValue(new Error('Network offline')),
        registerAdapter: vi.fn(),
        startAll: vi.fn().mockResolvedValue(undefined),
      };

      const context = createTestAppContext({
        config: {
          appLanguage: 'id',
          enabledMessengerChannels: [],
          emailSyncEnabled: false,
          notificationWebhookEnabled: false,
          notifyOnStartup: true,
          logRetentionDays: 30,
        } as any,
        gateway: mockGateway as any,
        wallet: {
          client: { listTools: vi.fn().mockResolvedValue([]) },
          cache: {
            initialize: vi.fn().mockResolvedValue(undefined),
            getAccounts: () => [],
            getCategories: () => [],
          },
        },
      });

      const app = new Application(context);
      (app as any).validateConfiguration = vi.fn();

      await app.start();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to dispatch startup notification: Network offline')
      );
      warnSpy.mockRestore();
    });

    it('initializes context when constructor receives configuration object', () => {
      const app = new Application({
        walletMcpBaseUrl: 'https://example.com',
      } as any);
      expect(app.context).toBeDefined();
    });
  });

  describe('Configuration Parsing', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env = { ...originalEnv };
    });

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('evaluates notifyOnStartup correctly according to env variables', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.NOTIFY_ON_STARTUP;
      const defaultProdConfig = loadEnvironmentConfiguration();
      expect(defaultProdConfig.notifyOnStartup).toBe(true);

      process.env.NOTIFY_ON_STARTUP = 'false';
      const disabledConfig = loadEnvironmentConfiguration();
      expect(disabledConfig.notifyOnStartup).toBe(false);

      process.env.NODE_ENV = 'test';
      delete process.env.NOTIFY_ON_STARTUP;
      const testConfig = loadEnvironmentConfiguration();
      expect(testConfig.notifyOnStartup).toBe(false);

      process.env.NOTIFY_ON_STARTUP = 'true';
      const testExplicitConfig = loadEnvironmentConfiguration();
      expect(testExplicitConfig.notifyOnStartup).toBe(true);
    });
  });
});
