import fs from 'node:fs';
import path from 'node:path';
import { applicationLogger } from '../lib/logger.js';
import { setActiveLanguage, SupportedLanguage } from '../i18n/index.js';
import {
  ApplicationEnvironmentConfiguration,
  DEFAULT_APP_CURRENCY,
  DEFAULT_APP_LANGUAGE,
  DEFAULT_APP_TIMEZONE,
  isValidIanaTimezone,
  loadEnvironmentConfiguration,
  resolveSafeTimezone,
} from './environmentConfig.js';
import { isFinancialPayloadDebugEnabled } from '../lib/financialLoggingPolicy.js';
import { setRuntimeApplicationConfig, getRuntimeApplicationConfig } from './applicationConfig.js';

export interface RuntimeSettings {
  categoryResolutionMode: 'ask' | 'auto';
  aiModel: string;
  aiFallbackModels: string[];
  appLanguage: 'id' | 'en';
  defaultCurrency: string;
  appTimezone: string;
  aiRequestTimeoutSeconds: number;
  emailLookbackMinutes: number;
  whatsappMessageQueueIntervalMs: number;
  logRetentionDays: number;
  debugLoggingEnabled: boolean;
}

export const SYSTEM_DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  categoryResolutionMode: 'ask',
  aiModel: 'gemini-3.5-flash-lite',
  aiFallbackModels: ['gemini-3.6-flash', 'gemini-3.8-flash'],
  appLanguage: 'id',
  defaultCurrency: 'IDR',
  appTimezone: 'Asia/Jakarta',
  aiRequestTimeoutSeconds: 20,
  emailLookbackMinutes: 10,
  whatsappMessageQueueIntervalMs: 1000,
  logRetentionDays: 7,
  debugLoggingEnabled: false,
};

export const TIMEZONE_ALIAS_MAP: Record<string, string> = {
  WIB: 'Asia/Jakarta',
  WITA: 'Asia/Makassar',
  WIT: 'Asia/Jayapura',
  UTC: 'UTC',
};

export const REVERSE_TIMEZONE_ALIAS_MAP: Record<string, string> = {
  'Asia/Jakarta': 'WIB',
  'Asia/Makassar': 'WITA',
  'Asia/Jayapura': 'WIT',
  UTC: 'UTC',
};

export function resolveTimezoneFromAliasOrIana(input: string): string {
  const trimmed = (input || '').trim();
  const aliasMatch = TIMEZONE_ALIAS_MAP[trimmed.toUpperCase()];
  if (aliasMatch) {
    return aliasMatch;
  }
  return resolveSafeTimezone(trimmed);
}

export const ALLOWED_RUNTIME_SETTINGS_KEYS: ReadonlyArray<keyof RuntimeSettings> = [
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
];

export class RuntimeSettingsManager {
  private static instance: RuntimeSettingsManager | null = null;
  private readonly storageFilePath: string;
  private inMemoryOverrides: Partial<RuntimeSettings> = {};

  constructor(customStorageFilePath?: string) {
    this.storageFilePath =
      customStorageFilePath ||
      process.env.APP_SETTINGS_PATH ||
      path.resolve(process.cwd(), 'auth_session/app-settings.json');
    this.reloadFromDisk();
  }

  public static getInstance(customStorageFilePath?: string): RuntimeSettingsManager {
    if (!RuntimeSettingsManager.instance) {
      RuntimeSettingsManager.instance = new RuntimeSettingsManager(customStorageFilePath);
    }
    return RuntimeSettingsManager.instance;
  }

  public static resetInstance(): void {
    RuntimeSettingsManager.instance = null;
  }

  public getStorageFilePath(): string {
    return this.storageFilePath;
  }

  /**
   * Reloads persisted settings overrides from the storage file on disk.
   */
  public reloadFromDisk(): void {
    try {
      if (fs.existsSync(this.storageFilePath)) {
        const fileContent = fs.readFileSync(this.storageFilePath, 'utf-8');
        const parsedData = JSON.parse(fileContent);
        if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
          this.inMemoryOverrides = this.sanitizeAndValidateOverrides(parsedData);
          return;
        }
      }
    } catch (readError: unknown) {
      applicationLogger.warn(
        `[WARN] Failed to read app-settings.json at ${this.storageFilePath}: ${readError instanceof Error ? readError.message : String(readError)}`
      );
    }
    this.inMemoryOverrides = {};
  }

  /**
   * Returns current overrides directly loaded from app-settings.json without environment fallbacks.
   */
  public getStoredOverrides(): Partial<RuntimeSettings> {
    return { ...this.inMemoryOverrides };
  }

  /**
   * Resolves cascading environment configuration defaults (.env -> SYSTEM_DEFAULT_RUNTIME_SETTINGS).
   * Dynamically reflects currently active environment values from loaded configuration.
   */
  public getEnvironmentDefaults(): RuntimeSettings {
    const config = loadEnvironmentConfiguration();
    const isGeminiPrimary = config.aiProvider === 'gemini';

    const aiModel = isGeminiPrimary
      ? (config.geminiModel || SYSTEM_DEFAULT_RUNTIME_SETTINGS.aiModel)
      : (config.aiModel || config.geminiModel || SYSTEM_DEFAULT_RUNTIME_SETTINGS.aiModel);

    const aiFallbackModels = isGeminiPrimary && config.geminiFallbackModels && config.geminiFallbackModels.length > 0
      ? config.geminiFallbackModels
      : (config.aiFallbackModels && config.aiFallbackModels.length > 0
          ? config.aiFallbackModels
          : (config.geminiFallbackModels || SYSTEM_DEFAULT_RUNTIME_SETTINGS.aiFallbackModels));

    const aiRequestTimeoutSeconds = isGeminiPrimary
      ? Math.round(config.geminiRequestTimeoutMilliseconds / 1000)
      : Math.round(config.aiRequestTimeoutMilliseconds / 1000);

    const debugLoggingEnabled = isFinancialPayloadDebugEnabled();

    return {
      categoryResolutionMode: config.categoryResolutionMode,
      aiModel,
      aiFallbackModels,
      appLanguage: config.appLanguage,
      defaultCurrency: config.defaultCurrency,
      appTimezone: config.appTimezone,
      aiRequestTimeoutSeconds: aiRequestTimeoutSeconds > 0 ? aiRequestTimeoutSeconds : 20,
      emailLookbackMinutes: config.emailLookbackMinutes,
      whatsappMessageQueueIntervalMs: config.whatsappMessageQueueIntervalMs,
      logRetentionDays: config.logRetentionDays,
      debugLoggingEnabled,
    };
  }

  /**
   * Resolves the effective runtime settings using cascading priority:
   * app-settings.json -> .env -> system defaults.
   */
  public getSettings(): RuntimeSettings {
    const envDefaults = this.getEnvironmentDefaults();
    return {
      categoryResolutionMode: this.inMemoryOverrides.categoryResolutionMode ?? envDefaults.categoryResolutionMode,
      aiModel: this.inMemoryOverrides.aiModel ?? envDefaults.aiModel,
      aiFallbackModels: this.inMemoryOverrides.aiFallbackModels ?? envDefaults.aiFallbackModels,
      appLanguage: this.inMemoryOverrides.appLanguage ?? envDefaults.appLanguage,
      defaultCurrency: this.inMemoryOverrides.defaultCurrency ?? envDefaults.defaultCurrency,
      appTimezone: this.inMemoryOverrides.appTimezone ?? envDefaults.appTimezone,
      aiRequestTimeoutSeconds: this.inMemoryOverrides.aiRequestTimeoutSeconds ?? envDefaults.aiRequestTimeoutSeconds,
      emailLookbackMinutes: this.inMemoryOverrides.emailLookbackMinutes ?? envDefaults.emailLookbackMinutes,
      whatsappMessageQueueIntervalMs: this.inMemoryOverrides.whatsappMessageQueueIntervalMs ?? envDefaults.whatsappMessageQueueIntervalMs,
      logRetentionDays: this.inMemoryOverrides.logRetentionDays ?? envDefaults.logRetentionDays,
      debugLoggingEnabled: this.inMemoryOverrides.debugLoggingEnabled ?? envDefaults.debugLoggingEnabled,
    };
  }

  /**
   * Gets a single effective runtime setting.
   */
  public getSetting<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] {
    return this.getSettings()[key];
  }

  /**
   * Updates partial runtime configuration, persists to disk, and applies runtime hot-reload.
   */
  public async updateSettings(partialUpdates: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const sanitized = this.sanitizeAndValidateOverrides(partialUpdates);

    this.inMemoryOverrides = {
      ...this.inMemoryOverrides,
      ...sanitized,
    };

    await this.persistToDisk();
    this.applyHotReloadSideEffects(sanitized);

    return this.getSettings();
  }

  /**
   * Updates a single setting and persists to disk.
   */
  public async updateSetting<K extends keyof RuntimeSettings>(
    key: K,
    value: RuntimeSettings[K]
  ): Promise<RuntimeSettings> {
    return this.updateSettings({ [key]: value });
  }

  /**
   * Resets all runtime settings back to .env / system defaults and removes app-settings.json.
   */
  public async resetToDefaults(): Promise<void> {
    this.inMemoryOverrides = {};
    try {
      if (fs.existsSync(this.storageFilePath)) {
        fs.unlinkSync(this.storageFilePath);
      }
    } catch (unlinkError: unknown) {
      applicationLogger.warn(
        `[WARN] Could not remove settings file at ${this.storageFilePath}: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`
      );
    }

    const envDefaults = this.getEnvironmentDefaults();
    setActiveLanguage(envDefaults.appLanguage as SupportedLanguage);
    process.env.DEBUG_FINANCIAL_PAYLOADS = envDefaults.debugLoggingEnabled ? 'true' : 'false';

    try {
      const activeConfig = getRuntimeApplicationConfig();
      if (activeConfig) {
        this.applyToConfiguration(activeConfig);
      }
    } catch {
      // Ignore if config not yet initialized
    }
  }

  /**
   * Applies active runtime settings onto an ApplicationEnvironmentConfiguration instance.
   */
  public applyToConfiguration(targetConfig: ApplicationEnvironmentConfiguration): ApplicationEnvironmentConfiguration {
    const active = this.getSettings();

    targetConfig.categoryResolutionMode = active.categoryResolutionMode;
    targetConfig.aiModel = active.aiModel;
    targetConfig.geminiModel = active.aiModel;
    targetConfig.aiFallbackModels = active.aiFallbackModels;
    targetConfig.geminiFallbackModels = active.aiFallbackModels;
    targetConfig.appLanguage = active.appLanguage;
    targetConfig.defaultCurrency = active.defaultCurrency;
    targetConfig.appTimezone = active.appTimezone;
    targetConfig.aiRequestTimeoutMilliseconds = active.aiRequestTimeoutSeconds * 1000;
    targetConfig.geminiRequestTimeoutMilliseconds = active.aiRequestTimeoutSeconds * 1000;
    targetConfig.emailLookbackMinutes = active.emailLookbackMinutes;
    targetConfig.whatsappMessageQueueIntervalMs = active.whatsappMessageQueueIntervalMs;
    targetConfig.logRetentionDays = active.logRetentionDays;

    return targetConfig;
  }

  private async persistToDisk(): Promise<void> {
    try {
      const targetDirectory = path.dirname(this.storageFilePath);
      if (!fs.existsSync(targetDirectory)) {
        fs.mkdirSync(targetDirectory, { recursive: true });
      }

      const serializedContent = JSON.stringify(this.inMemoryOverrides, null, 2);
      fs.writeFileSync(this.storageFilePath, serializedContent, 'utf-8');
    } catch (writeError: unknown) {
      applicationLogger.error(
        `[ERROR] Failed to save app-settings.json to ${this.storageFilePath}: ${writeError instanceof Error ? writeError.message : String(writeError)}`
      );
      throw writeError;
    }
  }

  private applyHotReloadSideEffects(appliedUpdates: Partial<RuntimeSettings>): void {
    if (appliedUpdates.appLanguage) {
      setActiveLanguage(appliedUpdates.appLanguage as SupportedLanguage);
    }

    if (appliedUpdates.debugLoggingEnabled !== undefined) {
      process.env.DEBUG_FINANCIAL_PAYLOADS = appliedUpdates.debugLoggingEnabled ? 'true' : 'false';
    }

    try {
      const activeConfig = getRuntimeApplicationConfig();
      if (activeConfig) {
        this.applyToConfiguration(activeConfig);
        setRuntimeApplicationConfig(activeConfig);
      }
    } catch {
      // Best-effort hot reload sync
    }
  }

  private sanitizeAndValidateOverrides(rawInput: Record<string, unknown>): Partial<RuntimeSettings> {
    const sanitized: Partial<RuntimeSettings> = {};

    for (const key of ALLOWED_RUNTIME_SETTINGS_KEYS) {
      if (rawInput[key] === undefined || rawInput[key] === null) {
        continue;
      }

      const val = rawInput[key];

      switch (key) {
        case 'categoryResolutionMode': {
          const str = String(val).trim().toLowerCase();
          if (str === 'auto' || str === 'ask') {
            sanitized.categoryResolutionMode = str;
          }
          break;
        }

        case 'aiModel': {
          const str = String(val).trim();
          if (str.length > 0) {
            sanitized.aiModel = str;
          }
          break;
        }

        case 'aiFallbackModels': {
          if (Array.isArray(val)) {
            const models = val.map(item => String(item).trim()).filter(Boolean);
            sanitized.aiFallbackModels = models;
          } else if (typeof val === 'string') {
            const models = val.split(',').map(item => item.trim()).filter(Boolean);
            sanitized.aiFallbackModels = models;
          }
          break;
        }

        case 'appLanguage': {
          const str = String(val).trim().toLowerCase();
          if (str === 'id' || str === 'en') {
            sanitized.appLanguage = str;
          }
          break;
        }

        case 'defaultCurrency': {
          const str = String(val).trim().toUpperCase();
          if (str.length > 0) {
            sanitized.defaultCurrency = str;
          }
          break;
        }

        case 'appTimezone': {
          const str = String(val).trim();
          if (str.length > 0) {
            sanitized.appTimezone = resolveTimezoneFromAliasOrIana(str);
          }
          break;
        }

        case 'aiRequestTimeoutSeconds': {
          const num = typeof val === 'number' ? val : Number.parseInt(String(val), 10);
          if (!Number.isNaN(num) && num > 0) {
            sanitized.aiRequestTimeoutSeconds = num;
          }
          break;
        }

        case 'emailLookbackMinutes': {
          const num = typeof val === 'number' ? val : Number.parseInt(String(val), 10);
          if (!Number.isNaN(num) && num > 0) {
            sanitized.emailLookbackMinutes = num;
          }
          break;
        }

        case 'whatsappMessageQueueIntervalMs': {
          const num = typeof val === 'number' ? val : Number.parseInt(String(val), 10);
          if (!Number.isNaN(num) && num > 0) {
            sanitized.whatsappMessageQueueIntervalMs = num;
          }
          break;
        }

        case 'logRetentionDays': {
          const num = typeof val === 'number' ? val : Number.parseInt(String(val), 10);
          if (!Number.isNaN(num) && num > 0) {
            sanitized.logRetentionDays = num;
          }
          break;
        }

        case 'debugLoggingEnabled': {
          if (typeof val === 'boolean') {
            sanitized.debugLoggingEnabled = val;
          } else if (typeof val === 'string') {
            sanitized.debugLoggingEnabled = val.trim().toLowerCase() === 'true';
          }
          break;
        }
      }
    }

    return sanitized;
  }
}
