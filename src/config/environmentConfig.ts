import dotenv from 'dotenv';
import { applicationLogger } from '../utils/logger.js';

dotenv.config();

export type SupportedAiProviderType = 'gemini' | 'openrouter' | 'groq' | 'ollama' | 'openai' | 'custom';

export interface ApplicationEnvironmentConfiguration {
  aiProvider: SupportedAiProviderType;
  aiProviders: SupportedAiProviderType[];
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  aiFallbackModels: string[];
  aiRequestTimeoutMilliseconds: number;

  geminiApiKey: string;
  geminiModel: string;
  geminiFallbackModels: string[];
  geminiRequestTimeoutMilliseconds: number;

  walletMcpBaseUrl: string;
  walletMcpAccessToken: string;
  allowedPhoneNumber: string;
  whatsappSessionPath: string;
  telegramBotToken: string;
  telegramAllowedUserId: string;
  enabledMessengerChannels: ('whatsapp' | 'telegram')[];
  logRetentionDays: number;
  emailSyncEnabled: boolean;
  emailImapHost: string;
  emailImapPort: number;
  emailImapUser: string;
  emailImapPassword: string;
  emailLookbackMinutes: number;
  appLanguage: 'id' | 'en';
  defaultCurrency: string;
  appTimezone: string;
  whatsappMaxReconnectAttempts: number;
  whatsappReconnectMaxBackoffSeconds: number;
  whatsappMessageQueueIntervalMs: number;
  whatsappTypingPresenceCooldownMs: number;
  telegramMaxStartupAttempts: number;
  telegramStartupRetryDelayMs: number;
  maxMediaDownloadMb: number;
}


export interface ProviderConfigStrategy {
  getDefaultBaseUrl(): string;
  getDefaultModel(fallbackModel: string): string;
  getDefaultApiKey(fallbackApiKey: string): string;
}

export const PROVIDER_CONFIG_STRATEGIES: Record<SupportedAiProviderType, ProviderConfigStrategy> = {
  openrouter: {
    getDefaultBaseUrl: () => 'https://openrouter.ai/api/v1',
    getDefaultModel: () => 'google/gemini-2.0-flash-exp:free',
    getDefaultApiKey: () => process.env.OPENROUTER_API_KEY || '',
  },
  groq: {
    getDefaultBaseUrl: () => 'https://api.groq.com/openai/v1',
    getDefaultModel: () => 'llama-3.3-70b-versatile',
    getDefaultApiKey: () => process.env.GROQ_API_KEY || '',
  },
  ollama: {
    getDefaultBaseUrl: () => 'http://localhost:11434/v1',
    getDefaultModel: () => 'llama3.2',
    getDefaultApiKey: () => 'ollama',
  },
  openai: {
    getDefaultBaseUrl: () => 'https://api.openai.com/v1',
    getDefaultModel: () => 'gpt-4o-mini',
    getDefaultApiKey: () => process.env.OPENAI_API_KEY || '',
  },
  gemini: {
    getDefaultBaseUrl: () => '',
    getDefaultModel: (fallbackModel: string) => fallbackModel,
    getDefaultApiKey: (fallbackApiKey: string) => fallbackApiKey,
  },
  custom: {
    getDefaultBaseUrl: () => process.env.AI_BASE_URL || '',
    getDefaultModel: (fallbackModel: string) => fallbackModel,
    getDefaultApiKey: () => process.env.AI_API_KEY || '',
  },
};

export function normalizePhoneNumber(
  rawNumber: string,
  defaultCurrency?: string,
  appTimezone?: string
): string {
  const trimmedRawNumber = (rawNumber || '').replace(/@s\.whatsapp\.net/gi, '').trim();
  if (!trimmedRawNumber) {
    return '';
  }

  const sanitizedDigits = trimmedRawNumber.replace(/[^0-9]/g, '');

  if (sanitizedDigits.startsWith('0')) {
    const isIndonesianRegionalContext =
      (defaultCurrency || '').toUpperCase() === 'IDR' || appTimezone === 'Asia/Jakarta';

    if (sanitizedDigits.startsWith('08') && isIndonesianRegionalContext) {
      const internationalIndonesianDigits = `62${sanitizedDigits.slice(1)}`;
      applicationLogger.info(
        `Auto-converted domestic Indonesian prefix '08...' to international E.164 '${internationalIndonesianDigits}'`
      );
      return enforceE164LengthLimit(internationalIndonesianDigits, trimmedRawNumber);
    }

    throw new Error(
      `Invalid ALLOWED_PHONE_NUMBER: '${trimmedRawNumber}'. Phone numbers cannot start with '0' as WhatsApp requires full international E.164 format with country code (e.g. 14155552671 for US, 447911123456 for UK, 6281234567890 for ID).`
    );
  }

  return enforceE164LengthLimit(sanitizedDigits, trimmedRawNumber);
}

function enforceE164LengthLimit(digitsOnlyNumber: string, originalRawNumber: string): string {
  if (digitsOnlyNumber.length < 7 || digitsOnlyNumber.length > 15) {
    throw new Error(
      `Invalid ALLOWED_PHONE_NUMBER: '${originalRawNumber}'. The sanitized number '${digitsOnlyNumber}' must be between 7 and 15 digits to comply with the ITU-T E.164 standard.`
    );
  }
  return digitsOnlyNumber;
}

export function loadEnvironmentConfiguration(): ApplicationEnvironmentConfiguration {
  const allowedProviderTypes: SupportedAiProviderType[] = ['gemini', 'openrouter', 'groq', 'ollama', 'openai', 'custom'];
  const rawAiProviderEnv = (process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();

  const parsedProviders = rawAiProviderEnv
    .split(',')
    .map(providerItem => providerItem.trim().toLowerCase() as SupportedAiProviderType)
    .filter((providerItem): providerItem is SupportedAiProviderType => allowedProviderTypes.includes(providerItem));

  const aiProviders: SupportedAiProviderType[] = parsedProviders.length > 0
    ? Array.from(new Set(parsedProviders))
    : ['gemini'];

  const aiProvider: SupportedAiProviderType = aiProviders[0];

  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const geminiFallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite')
    .split(',')
    .map(modelItem => modelItem.trim())
    .filter(Boolean);
  const geminiRequestTimeoutSeconds = parseInt(process.env.GEMINI_TIMEOUT_SECONDS || '20', 10) || 20;
  const geminiRequestTimeoutMilliseconds = geminiRequestTimeoutSeconds * 1000;

  // Resolve generic AI settings using Strategy Pattern
  const activeStrategy = PROVIDER_CONFIG_STRATEGIES[aiProvider] || PROVIDER_CONFIG_STRATEGIES.gemini;
  const defaultBaseUrl = activeStrategy.getDefaultBaseUrl();
  const defaultModel = activeStrategy.getDefaultModel(geminiModel);
  const defaultApiKey = activeStrategy.getDefaultApiKey(geminiApiKey);

  const aiBaseUrl = process.env.AI_BASE_URL || defaultBaseUrl;
  const aiApiKey = process.env.AI_API_KEY || defaultApiKey;
  const aiModel = process.env.AI_MODEL || defaultModel;
  const aiFallbackModels = (process.env.AI_FALLBACK_MODELS || '')
    .split(',')
    .map(modelItem => modelItem.trim())
    .filter(Boolean);
  const aiRequestTimeoutSeconds = parseInt(
    process.env.AI_TIMEOUT_SECONDS || process.env.GEMINI_TIMEOUT_SECONDS || '25',
    10
  ) || 25;
  const aiRequestTimeoutMilliseconds = aiRequestTimeoutSeconds * 1000;

  const walletMcpBaseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
  const walletMcpAccessToken = process.env.WALLET_MCP_ACCESS_TOKEN || '';
  const whatsappSessionPath = process.env.WHATSAPP_SESSION_PATH || './auth_session';
  const logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10) || 7;
  const emailSyncEnabled = process.env.EMAIL_SYNC_ENABLED === 'true';
  const emailImapHost = process.env.EMAIL_IMAP_HOST || 'imap.gmail.com';
  const emailImapPort = parseInt(process.env.EMAIL_IMAP_PORT || '993', 10) || 993;
  const emailImapUser = process.env.EMAIL_IMAP_USER || '';
  const emailImapPassword = process.env.EMAIL_IMAP_PASSWORD || '';
  const emailLookbackMinutes = parseInt(process.env.EMAIL_LOOKBACK_MINUTES || '10', 10) || 10;

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const telegramAllowedUserId = (process.env.TELEGRAM_ALLOWED_USER_ID || '').trim();

  const rawLanguage = (process.env.APP_LANGUAGE || process.env.BOT_LANGUAGE || 'id').toLowerCase().trim();
  const appLanguage: 'id' | 'en' = rawLanguage === 'en' ? 'en' : 'id';
  const defaultCurrency = (process.env.DEFAULT_CURRENCY || 'IDR').toUpperCase().trim();
  const appTimezone = process.env.APP_TIMEZONE || 'Asia/Jakarta';

  const rawAllowedPhoneNumber = (process.env.ALLOWED_PHONE_NUMBER || process.env.OWNER_PHONE_NUMBER || '')
    .trim();
  const allowedPhoneNumber = normalizePhoneNumber(rawAllowedPhoneNumber, defaultCurrency, appTimezone);

  // Resolve enabled messenger channels
  let enabledMessengerChannels: ('whatsapp' | 'telegram')[] = [];
  if (process.env.ENABLED_MESSENGER_CHANNELS) {
    const rawChannels = process.env.ENABLED_MESSENGER_CHANNELS.split(',')
      .map(channel => channel.trim().toLowerCase())
      .filter((channel): channel is 'whatsapp' | 'telegram' => channel === 'whatsapp' || channel === 'telegram');
    enabledMessengerChannels = Array.from(new Set(rawChannels));
  } else {
    // Auto-detect based on provided credentials
    if (allowedPhoneNumber) {
      enabledMessengerChannels.push('whatsapp');
    }
    if (telegramBotToken) {
      enabledMessengerChannels.push('telegram');
    }
    if (enabledMessengerChannels.length === 0) {
      enabledMessengerChannels.push('whatsapp');
    }
  }

  const whatsappMaxReconnectAttempts = parseInt(process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS || '6', 10) || 6;
  const whatsappReconnectMaxBackoffSeconds = parseInt(process.env.WHATSAPP_RECONNECT_MAX_BACKOFF_SECONDS || '300', 10) || 300;
  const whatsappMessageQueueIntervalMs = parseInt(process.env.WHATSAPP_MESSAGE_QUEUE_INTERVAL_MS || '1000', 10) || 1000;
  const parsedTypingCooldown = process.env.WHATSAPP_TYPING_PRESENCE_COOLDOWN_MS !== undefined
    ? parseInt(process.env.WHATSAPP_TYPING_PRESENCE_COOLDOWN_MS, 10)
    : 2500;
  const whatsappTypingPresenceCooldownMs = Number.isNaN(parsedTypingCooldown) ? 2500 : parsedTypingCooldown;

  const telegramMaxStartupAttempts = parseInt(process.env.TELEGRAM_MAX_STARTUP_ATTEMPTS || '5', 10) || 5;
  const telegramStartupRetryDelayMs = parseInt(process.env.TELEGRAM_STARTUP_RETRY_DELAY_MS || '2000', 10) || 2000;

  const parsedMaxMediaDownloadMb = parseInt(process.env.MAX_MEDIA_DOWNLOAD_MB || '10', 10);
  const maxMediaDownloadMb = Number.isNaN(parsedMaxMediaDownloadMb) || parsedMaxMediaDownloadMb <= 0
    ? 10
    : parsedMaxMediaDownloadMb;

  return {
    aiProvider,
    aiProviders,
    aiApiKey,
    aiBaseUrl,
    aiModel,
    aiFallbackModels,
    aiRequestTimeoutMilliseconds,
    geminiApiKey,
    geminiModel,
    geminiFallbackModels,
    geminiRequestTimeoutMilliseconds,
    walletMcpBaseUrl,
    walletMcpAccessToken,
    allowedPhoneNumber,
    whatsappSessionPath,
    telegramBotToken,
    telegramAllowedUserId,
    enabledMessengerChannels,
    logRetentionDays,
    emailSyncEnabled,
    emailImapHost,
    emailImapPort,
    emailImapUser,
    emailImapPassword,
    emailLookbackMinutes,
    appLanguage,
    defaultCurrency,
    appTimezone,
    whatsappMaxReconnectAttempts,
    whatsappReconnectMaxBackoffSeconds,
    whatsappMessageQueueIntervalMs,
    whatsappTypingPresenceCooldownMs,
    telegramMaxStartupAttempts,
    telegramStartupRetryDelayMs,
    maxMediaDownloadMb,
  };
}

