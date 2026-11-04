import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  RuntimeSettingsManager,
  SYSTEM_DEFAULT_RUNTIME_SETTINGS,
  resolveTimezoneFromAliasOrIana,
  ALLOWED_RUNTIME_SETTINGS_KEYS,
} from '../src/config/runtimeSettingsManager.js';
import { getActiveLanguage, setActiveLanguage } from '../src/i18n/index.js';
import { ApplicationEnvironmentConfiguration } from '../src/config/environmentConfig.js';

describe('RuntimeSettingsManager', () => {
  let tempDirectory: string;
  let testSettingsFilePath: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-mcp-settings-test-'));
    testSettingsFilePath = path.join(tempDirectory, 'app-settings.json');
    RuntimeSettingsManager.resetInstance();
  });

  afterEach(() => {
    RuntimeSettingsManager.resetInstance();
    try {
      if (fs.existsSync(tempDirectory)) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup error
    }
  });

  describe('Initialization and Cascading Fallbacks', () => {
    it('returns system defaults when no disk file and no process.env overrides exist', () => {
      const originalEnv = { ...process.env };
      delete process.env.CATEGORY_RESOLUTION_MODE;
      delete process.env.AI_MODEL;
      delete process.env.GEMINI_MODEL;
      delete process.env.AI_FALLBACK_MODELS;
      delete process.env.GEMINI_FALLBACK_MODELS;
      delete process.env.APP_LANGUAGE;
      delete process.env.DEFAULT_CURRENCY;
      delete process.env.APP_TIMEZONE;
      delete process.env.AI_TIMEOUT_SECONDS;
      delete process.env.GEMINI_TIMEOUT_SECONDS;
      delete process.env.EMAIL_LOOKBACK_MINUTES;
      delete process.env.WHATSAPP_MESSAGE_QUEUE_INTERVAL_MS;
      delete process.env.LOG_RETENTION_DAYS;
      delete process.env.DEBUG_FINANCIAL_PAYLOADS;

      try {
        const manager = new RuntimeSettingsManager(testSettingsFilePath);
        const settings = manager.getSettings();

        expect(settings.categoryResolutionMode).toBe('ask');
        expect(settings.aiModel).toBe('gemini-3.5-flash-lite');
        expect(settings.aiFallbackModels).toEqual(['gemini-3.6-flash', 'gemini-3.8-flash']);
        expect(settings.appLanguage).toBe('id');
        expect(settings.defaultCurrency).toBe('IDR');
        expect(settings.appTimezone).toBe('Asia/Jakarta');
        expect(settings.aiRequestTimeoutSeconds).toBe(20);
        expect(settings.emailLookbackMinutes).toBe(10);
        expect(settings.whatsappMessageQueueIntervalMs).toBe(1000);
        expect(settings.logRetentionDays).toBe(7);
        expect(settings.debugLoggingEnabled).toBe(false);
      } finally {
        process.env = originalEnv;
      }
    });

    it('cascades to environment variables if disk file does not specify an override', () => {
      const originalEnv = { ...process.env };
      process.env.CATEGORY_RESOLUTION_MODE = 'auto';
      process.env.DEFAULT_CURRENCY = 'USD';
      process.env.APP_LANGUAGE = 'en';

      try {
        const manager = new RuntimeSettingsManager(testSettingsFilePath);
        const settings = manager.getSettings();

        expect(settings.categoryResolutionMode).toBe('auto');
        expect(settings.defaultCurrency).toBe('USD');
        expect(settings.appLanguage).toBe('en');
      } finally {
        process.env = originalEnv;
      }
    });

    it('prioritizes disk settings (app-settings.json) over process.env', () => {
      const originalEnv = { ...process.env };
      process.env.CATEGORY_RESOLUTION_MODE = 'auto';
      process.env.DEFAULT_CURRENCY = 'USD';

      fs.writeFileSync(
        testSettingsFilePath,
        JSON.stringify({ categoryResolutionMode: 'ask', defaultCurrency: 'SGD' }),
        'utf-8'
      );

      try {
        const manager = new RuntimeSettingsManager(testSettingsFilePath);
        const settings = manager.getSettings();

        expect(settings.categoryResolutionMode).toBe('ask');
        expect(settings.defaultCurrency).toBe('SGD');
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('Updating Settings and Disk Persistence', () => {
    it('persists updated settings to disk and preserves existing keys', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);

      await manager.updateSettings({
        categoryResolutionMode: 'auto',
        defaultCurrency: 'EUR',
      });

      expect(fs.existsSync(testSettingsFilePath)).toBe(true);
      const fileData = JSON.parse(fs.readFileSync(testSettingsFilePath, 'utf-8'));
      expect(fileData.categoryResolutionMode).toBe('auto');
      expect(fileData.defaultCurrency).toBe('EUR');

      // Update another field
      await manager.updateSetting('aiModel', 'gemini-3.8-flash');

      const updatedFileData = JSON.parse(fs.readFileSync(testSettingsFilePath, 'utf-8'));
      expect(updatedFileData.categoryResolutionMode).toBe('auto');
      expect(updatedFileData.defaultCurrency).toBe('EUR');
      expect(updatedFileData.aiModel).toBe('gemini-3.8-flash');
    });

    it('reloads from disk accurately in a new manager instance', async () => {
      const manager1 = new RuntimeSettingsManager(testSettingsFilePath);
      await manager1.updateSettings({
        appLanguage: 'en',
        aiRequestTimeoutSeconds: 45,
        logRetentionDays: 30,
      });

      const manager2 = new RuntimeSettingsManager(testSettingsFilePath);
      expect(manager2.getSetting('appLanguage')).toBe('en');
      expect(manager2.getSetting('aiRequestTimeoutSeconds')).toBe(45);
      expect(manager2.getSetting('logRetentionDays')).toBe(30);
    });

    it('resets to defaults by deleting the storage file and reverting in-memory overrides', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);
      await manager.updateSettings({
        categoryResolutionMode: 'auto',
        defaultCurrency: 'USD',
      });

      expect(fs.existsSync(testSettingsFilePath)).toBe(true);

      await manager.resetToDefaults();

      expect(fs.existsSync(testSettingsFilePath)).toBe(false);
      expect(manager.getStoredOverrides()).toEqual({});
      expect(manager.getSetting('categoryResolutionMode')).toBe('ask');
    });
  });

  describe('Hot Reload Side Effects and Config Sync', () => {
    it('updates active language when appLanguage is changed', async () => {
      setActiveLanguage('id');
      expect(getActiveLanguage()).toBe('id');

      const manager = new RuntimeSettingsManager(testSettingsFilePath);
      await manager.updateSetting('appLanguage', 'en');

      expect(getActiveLanguage()).toBe('en');
    });

    it('syncs process.env.DEBUG_FINANCIAL_PAYLOADS when debugLoggingEnabled is toggled', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);

      await manager.updateSetting('debugLoggingEnabled', true);
      expect(process.env.DEBUG_FINANCIAL_PAYLOADS).toBe('true');

      await manager.updateSetting('debugLoggingEnabled', false);
      expect(process.env.DEBUG_FINANCIAL_PAYLOADS).toBe('false');
    });

    it('applies runtime settings to ApplicationEnvironmentConfiguration object', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);
      await manager.updateSettings({
        categoryResolutionMode: 'auto',
        aiModel: 'gemini-3.8-flash',
        aiFallbackModels: ['gemini-3.5-flash-lite'],
        appLanguage: 'en',
        defaultCurrency: 'EUR',
        appTimezone: 'Asia/Makassar',
        aiRequestTimeoutSeconds: 30,
        emailLookbackMinutes: 15,
        whatsappMessageQueueIntervalMs: 2000,
        logRetentionDays: 14,
      });

      const dummyConfig = {
        categoryResolutionMode: 'ask',
        aiModel: 'gemini-3.5-flash-lite',
        geminiModel: 'gemini-3.5-flash-lite',
        aiFallbackModels: [],
        geminiFallbackModels: [],
        appLanguage: 'id',
        defaultCurrency: 'IDR',
        appTimezone: 'Asia/Jakarta',
        aiRequestTimeoutMilliseconds: 20000,
        geminiRequestTimeoutMilliseconds: 20000,
        emailLookbackMinutes: 10,
        whatsappMessageQueueIntervalMs: 1000,
        logRetentionDays: 7,
      } as unknown as ApplicationEnvironmentConfiguration;

      manager.applyToConfiguration(dummyConfig);

      expect(dummyConfig.categoryResolutionMode).toBe('auto');
      expect(dummyConfig.aiModel).toBe('gemini-3.8-flash');
      expect(dummyConfig.geminiModel).toBe('gemini-3.8-flash');
      expect(dummyConfig.appLanguage).toBe('en');
      expect(dummyConfig.defaultCurrency).toBe('EUR');
      expect(dummyConfig.appTimezone).toBe('Asia/Makassar');
      expect(dummyConfig.aiRequestTimeoutMilliseconds).toBe(30000);
      expect(dummyConfig.geminiRequestTimeoutMilliseconds).toBe(30000);
      expect(dummyConfig.emailLookbackMinutes).toBe(15);
      expect(dummyConfig.whatsappMessageQueueIntervalMs).toBe(2000);
      expect(dummyConfig.logRetentionDays).toBe(14);
    });
  });

  describe('Timezone Resolution and Aliases', () => {
    it('maps regional aliases to canonical IANA timezone names', () => {
      expect(resolveTimezoneFromAliasOrIana('WIB')).toBe('Asia/Jakarta');
      expect(resolveTimezoneFromAliasOrIana('wib')).toBe('Asia/Jakarta');
      expect(resolveTimezoneFromAliasOrIana('WITA')).toBe('Asia/Makassar');
      expect(resolveTimezoneFromAliasOrIana('WIT')).toBe('Asia/Jayapura');
      expect(resolveTimezoneFromAliasOrIana('UTC')).toBe('UTC');
    });

    it('accepts direct valid IANA timezone string and falls back on invalid', () => {
      expect(resolveTimezoneFromAliasOrIana('America/New_York')).toBe('America/New_York');
      expect(resolveTimezoneFromAliasOrIana('invalid/tz_nowhere')).toBe('Asia/Jakarta');
    });
  });

  describe('Security and Isolation', () => {
    it('strictly isolates credentials and rejects non-whitelisted keys from disk persistence', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);

      // Attempt to sneak in credential overrides
      const maliciousPayload = {
        categoryResolutionMode: 'auto',
        telegramBotToken: 'stolen_bot_token',
        geminiApiKey: 'stolen_gemini_key',
        walletMcpAccessToken: 'stolen_access_token',
        allowedPhoneNumber: '6289999999999',
        telegramAllowedUserId: '999999999',
      } as any;

      await manager.updateSettings(maliciousPayload);

      const fileData = JSON.parse(fs.readFileSync(testSettingsFilePath, 'utf-8'));
      expect(fileData.categoryResolutionMode).toBe('auto');
      expect(fileData.telegramBotToken).toBeUndefined();
      expect(fileData.geminiApiKey).toBeUndefined();
      expect(fileData.walletMcpAccessToken).toBeUndefined();
      expect(fileData.allowedPhoneNumber).toBeUndefined();
      expect(fileData.telegramAllowedUserId).toBeUndefined();
    });

    it('contains only approved keys in ALLOWED_RUNTIME_SETTINGS_KEYS', () => {
      expect(ALLOWED_RUNTIME_SETTINGS_KEYS).toEqual([
        'categoryResolutionMode',
        'aiModel',
        'aiFallbackModels',
        'appLanguage',
        'defaultCurrency',
        'appTimezone',
        'aiRequestTimeoutSeconds',
        'emailLookbackMinutes',
        'whatsappMessageQueueIntervalMs',
        'logRetentionDays',
        'debugLoggingEnabled',
      ]);
    });
  });

  describe('Input Validation', () => {
    it('ignores invalid categoryResolutionMode', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);
      await manager.updateSettings({
        categoryResolutionMode: 'invalid_mode' as any,
      });

      expect(manager.getStoredOverrides().categoryResolutionMode).toBeUndefined();
    });

    it('ignores negative or invalid numbers for timeout and retention', async () => {
      const manager = new RuntimeSettingsManager(testSettingsFilePath);
      await manager.updateSettings({
        aiRequestTimeoutSeconds: -5 as any,
        logRetentionDays: 'invalid_num' as any,
      });

      expect(manager.getStoredOverrides().aiRequestTimeoutSeconds).toBeUndefined();
      expect(manager.getStoredOverrides().logRetentionDays).toBeUndefined();
    });
  });
});
