import {
  isValidIanaTimezone,
  normalizePhoneNumber,
  SupportedAiProviderType,
} from '../config/environmentConfig.js';
import { EnvironmentValueMap } from './envFileEditor.js';

export interface SetupChoice {
  readonly label: string;
  readonly value: string;
}

export interface SetupPrompter {
  info(message: string): void;
  question(message: string, defaultValue?: string): Promise<string>;
  secret(message: string, existingConfigured: boolean): Promise<string>;
  confirm(message: string, defaultValue: boolean): Promise<boolean>;
  choose(message: string, choices: readonly SetupChoice[], defaultValue: string): Promise<string>;
  chooseMany(
    message: string,
    choices: readonly SetupChoice[],
    defaultValues: readonly string[]
  ): Promise<string[]>;
}

export interface SetupWizardResult {
  readonly updates: EnvironmentValueMap;
  readonly summaryLines: string[];
}

export interface CollectSetupOptions {
  readonly isAdvanced?: boolean;
  readonly isDev?: boolean;
}

const REPOSITORY_DOC_BASE =
  'https://github.com/Churma16/wallet-mcp-budgetbakers-bot/blob/main/docs/setup-credentials.md';

export const GLOBAL_TIMEZONE_ALIASES: Record<string, string> = {
  // Indonesia
  WIB: 'Asia/Jakarta',
  WITA: 'Asia/Makassar',
  WIT: 'Asia/Jayapura',
  JAKARTA: 'Asia/Jakarta',
  BALI: 'Asia/Makassar',
  MAKASSAR: 'Asia/Makassar',
  JAYAPURA: 'Asia/Jayapura',
  // Global Offsets & Zones
  UTC: 'UTC',
  GMT: 'Etc/GMT',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  CET: 'Europe/Berlin',
  CEST: 'Europe/Berlin',
  JST: 'Asia/Tokyo',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
  // Popular International Cities
  LONDON: 'Europe/London',
  PARIS: 'Europe/Paris',
  BERLIN: 'Europe/Berlin',
  AMSTERDAM: 'Europe/Amsterdam',
  TOKYO: 'Asia/Tokyo',
  SINGAPORE: 'Asia/Singapore',
  SYDNEY: 'Australia/Sydney',
  MELBOURNE: 'Australia/Melbourne',
  TORONTO: 'America/Toronto',
  VANCOUVER: 'America/Vancouver',
  'NEW YORK': 'America/New_York',
  NYC: 'America/New_York',
  'LOS ANGELES': 'America/Los_Angeles',
  LA: 'America/Los_Angeles',
  CHICAGO: 'America/Chicago',
  DUBAI: 'Asia/Dubai',
  BANGKOK: 'Asia/Bangkok',
};

export function getSystemTimezone(): string {
  try {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && isValidIanaTimezone(detected)) {
      return detected;
    }
  } catch {
    // Intl timezone detection unavailable
  }
  return 'UTC';
}

export function resolveTimezoneAlias(input: string): string | null {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return null;
  }
  const upper = trimmed.toUpperCase();
  if (GLOBAL_TIMEZONE_ALIASES[upper]) {
    return GLOBAL_TIMEZONE_ALIASES[upper];
  }
  if (isValidIanaTimezone(trimmed)) {
    return trimmed;
  }
  return null;
}

export function validatePortNumber(portCandidate: string): number | null {
  const trimmed = portCandidate.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const portNumber = Number.parseInt(trimmed, 10);
  if (portNumber >= 1 && portNumber <= 65535) {
    return portNumber;
  }
  return null;
}

export function validateEmailAddress(emailCandidate: string): boolean {
  const trimmed = emailCandidate.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

export function validateHostname(hostCandidate: string): boolean {
  const trimmed = hostCandidate.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  return (
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(trimmed) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(trimmed) ||
    trimmed === 'localhost'
  );
}

export function sanitizeModelInput(
  enteredValue: string,
  defaultModel: string
): { model: string; wasAutoCorrected: boolean } {
  const trimmed = enteredValue.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === 'y' || lower === 'yes') {
    return { model: defaultModel, wasAutoCorrected: lower === 'y' || lower === 'yes' };
  }
  return { model: trimmed, wasAutoCorrected: false };
}

const AI_PROVIDER_CHOICES: readonly SetupChoice[] = [
  { label: 'Gemini', value: 'gemini' },
  { label: 'OpenRouter', value: 'openrouter' },
  { label: 'Groq', value: 'groq' },
  { label: 'OpenAI', value: 'openai' },
  { label: 'Ollama', value: 'ollama' },
  { label: 'Custom OpenAI-compatible endpoint', value: 'custom' },
];

const MESSENGER_CHOICES: readonly SetupChoice[] = [
  { label: 'WhatsApp', value: 'whatsapp' },
  { label: 'Telegram', value: 'telegram' },
  { label: 'Console', value: 'console' },
];

const PROVIDER_API_KEY_VARIABLE: Partial<Record<SupportedAiProviderType, string>> = {
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  openai: 'OPENAI_API_KEY',
  custom: 'AI_API_KEY',
};

const PROVIDER_DEFAULT_BASE_URL: Partial<Record<SupportedAiProviderType, string>> = {
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

const PROVIDER_DEFAULT_MODEL: Record<SupportedAiProviderType, string> = {
  gemini: 'gemini-3.5-flash-lite',
  openrouter: 'openrouter/free',
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini',
  ollama: 'llama3.2',
  custom: '',
};

const PROVIDER_HELP: Partial<
  Record<SupportedAiProviderType, { acquisitionUrl: string; guideAnchor: string; hint: string }>
> = {
  gemini: {
    acquisitionUrl: 'https://aistudio.google.com/app/apikey',
    guideAnchor: 'gemini',
    hint: 'Create an API key in Google AI Studio.',
  },
  openrouter: {
    acquisitionUrl: 'https://openrouter.ai/settings/keys',
    guideAnchor: 'openrouter',
    hint: 'Create an API key in your OpenRouter settings.',
  },
  groq: {
    acquisitionUrl: 'https://console.groq.com/keys',
    guideAnchor: 'groq',
    hint: 'Create an API key in the Groq console.',
  },
  openai: {
    acquisitionUrl: 'https://platform.openai.com/api-keys',
    guideAnchor: 'openai',
    hint: 'Create an API key in the OpenAI platform.',
  },
};

function splitConfiguredValues(rawValue?: string): string[] {
  return (rawValue || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function isKnownProvider(value: string): value is SupportedAiProviderType {
  return AI_PROVIDER_CHOICES.some(choice => choice.value === value);
}

function isKnownMessenger(value: string): value is 'whatsapp' | 'telegram' | 'console' {
  return MESSENGER_CHOICES.some(choice => choice.value === value);
}

function hasConfiguredCredential(value?: string): boolean {
  const trimmedValue = (value || '').trim();
  if (!trimmedValue) {
    return false;
  }

  const normalizedValue = trimmedValue.toLowerCase();
  return !(
    normalizedValue.startsWith('your_') ||
    normalizedValue.startsWith('your-') ||
    normalizedValue.includes('your_wallet_mcp') ||
    normalizedValue.includes('your_gemini') ||
    normalizedValue.includes('your_custom') ||
    normalizedValue.includes('your_16_char') ||
    normalizedValue.includes('abcde')
  );
}

function maskIdentifier(value: string): string {
  const trimmedValue = value.trim();
  if (trimmedValue.length <= 6) {
    return '*'.repeat(trimmedValue.length);
  }

  return `${trimmedValue.slice(0, 3)}${'*'.repeat(Math.max(3, trimmedValue.length - 6))}${trimmedValue.slice(-3)}`;
}

function showCredentialHelp(
  prompter: SetupPrompter,
  title: string,
  hint: string,
  acquisitionUrl: string,
  guideAnchor: string
): void {
  prompter.info('');
  prompter.info(`=== ${title} ===`);
  prompter.info(hint);
  prompter.info(`Get it here: ${acquisitionUrl}`);
  prompter.info(`Full guide: ${REPOSITORY_DOC_BASE}#${guideAnchor}`);
  prompter.info('');
}

async function promptRequiredText(
  prompter: SetupPrompter,
  message: string,
  defaultValue?: string
): Promise<string> {
  while (true) {
    const value = (await prompter.question(message, defaultValue)).trim();
    if (value) {
      return value;
    }
    prompter.info('[WARN] A value is required.');
  }
}

async function promptCredential(
  prompter: SetupPrompter,
  message: string,
  existingValue: string | undefined,
  required: boolean
): Promise<string | undefined> {
  const existingConfigured = hasConfiguredCredential(existingValue);

  while (true) {
    const enteredValue = (await prompter.secret(message, existingConfigured)).trim();
    if (enteredValue) {
      return enteredValue;
    }

    if (existingConfigured) {
      return undefined;
    }

    if (!required) {
      return undefined;
    }

    prompter.info('[WARN] A credential is required for this selection.');
  }
}

async function normalizeWhatsAppPhoneNumber(
  prompter: SetupPrompter,
  initialValue: string,
  defaultCurrency: string,
  appTimezone: string,
  appLanguage: string
): Promise<string> {
  let candidateValue = initialValue;

  while (true) {
    try {
      const normalizedValue = normalizePhoneNumber(
        candidateValue,
        defaultCurrency,
        appTimezone,
        appLanguage
      );
      if (normalizedValue) {
        return normalizedValue;
      }
    } catch {
      // Re-prompt below with a concise message rather than echoing runtime error details.
    }

    prompter.info(
      '[WARN] Enter a valid WhatsApp phone number in international E.164 format (7-15 digits), or an Indonesian 08 number when using Indonesian regional settings.'
    );
    candidateValue = await promptRequiredText(prompter, 'Authorized WhatsApp phone number');
  }
}

async function promptTelegramAllowedUserId(
  prompter: SetupPrompter,
  existingValue?: string
): Promise<string> {
  let defaultValue = existingValue?.trim().replace(/^@/, '');

  while (true) {
    const enteredValue = await promptRequiredText(
      prompter,
      'Authorized Telegram user ID (numbers only)',
      defaultValue
    );
    const canonicalValue = enteredValue.trim().replace(/^@/, '');
    if (/^\d+$/.test(canonicalValue)) {
      return canonicalValue;
    }

    prompter.info(
      '[WARN] Enter the numeric Telegram user ID only (for example 123456789); usernames are not supported.'
    );
    defaultValue = undefined;
  }
}

async function promptValidIanaTimezone(
  prompter: SetupPrompter,
  existingValue?: string
): Promise<string> {
  const defaultTz = existingValue || getSystemTimezone();
  prompter.info('');
  prompter.info(
    '[TIP] Press Enter to keep your auto-detected timezone, or find yours at https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
  );
  let defaultValue: string | undefined = defaultTz;

  while (true) {
    const enteredValue = await promptRequiredText(
      prompter,
      'Application timezone (IANA identifier)',
      defaultValue
    );
    const resolved = resolveTimezoneAlias(enteredValue);
    if (resolved) {
      return resolved;
    }

    prompter.info(
      '[WARN] Enter a valid IANA timezone identifier or supported city (for example London, New York, Asia/Jakarta, or UTC).'
    );
    defaultValue = undefined;
  }
}

function resolveExistingProviderKey(
  provider: SupportedAiProviderType,
  existingValues: EnvironmentValueMap,
  existingPrimaryProvider: SupportedAiProviderType | undefined
): string | undefined {
  const providerVariable = PROVIDER_API_KEY_VARIABLE[provider];
  if (!providerVariable) {
    return undefined;
  }

  if (provider === 'custom') {
    return existingPrimaryProvider === 'custom' ? existingValues.AI_API_KEY : undefined;
  }

  if (provider === existingPrimaryProvider && provider !== 'gemini') {
    return existingValues.AI_API_KEY || existingValues[providerVariable];
  }

  return existingValues[providerVariable];
}

async function configureAiProviders(
  prompter: SetupPrompter,
  existingValues: EnvironmentValueMap,
  updates: EnvironmentValueMap
): Promise<SupportedAiProviderType[]> {
  const existingProviderList = splitConfiguredValues(existingValues.AI_PROVIDER).filter(isKnownProvider);
  const defaultProviderList = existingProviderList.length > 0 ? existingProviderList : ['gemini'];

  let selectedProviders: SupportedAiProviderType[] = [];
  while (selectedProviders.length === 0) {
    const selectedProviderValues = await prompter.chooseMany(
      'Select AI provider(s) in priority order',
      AI_PROVIDER_CHOICES,
      defaultProviderList
    );
    const candidateProviders = selectedProviderValues.filter(isKnownProvider);

    if (candidateProviders.length === 0) {
      prompter.info('[WARN] Select at least one AI provider.');
      continue;
    }

    if (candidateProviders.includes('custom') && candidateProviders[0] !== 'custom') {
      prompter.info('[WARN] The custom provider can only be the primary provider because its generic AI_* settings are not provider-specific.');
      continue;
    }

    selectedProviders = candidateProviders;
  }

  const primaryProvider = selectedProviders[0];
  const existingPrimaryProvider = existingProviderList[0];
  updates.AI_PROVIDER = selectedProviders.join(',');

  for (const provider of selectedProviders) {
    const help = PROVIDER_HELP[provider];
    if (help) {
      showCredentialHelp(
        prompter,
        `${AI_PROVIDER_CHOICES.find(choice => choice.value === provider)?.label || provider} API credential`,
        help.hint,
        help.acquisitionUrl,
        help.guideAnchor
      );
    }

    if (provider !== 'ollama') {
      const existingCredential = resolveExistingProviderKey(
        provider,
        existingValues,
        existingPrimaryProvider
      );
      const enteredCredential = await promptCredential(
        prompter,
        `Enter ${PROVIDER_API_KEY_VARIABLE[provider]}${hasConfiguredCredential(existingCredential) ? ' (press Enter to keep current)' : ''}`,
        existingCredential,
        true
      );
      const effectiveCredential = enteredCredential || existingCredential;

      if (enteredCredential) {
        const providerVariable = PROVIDER_API_KEY_VARIABLE[provider];
        if (providerVariable) {
          updates[providerVariable] = enteredCredential;
        }
      }

      if (provider === primaryProvider && provider !== 'gemini' && effectiveCredential) {
        updates.AI_API_KEY = effectiveCredential;
      }
    }

    if (provider === primaryProvider) {
      if (provider === 'gemini') {
        const defaultModel =
          existingPrimaryProvider === provider
            ? existingValues.GEMINI_MODEL || PROVIDER_DEFAULT_MODEL.gemini
            : PROVIDER_DEFAULT_MODEL.gemini;
        const rawModelInput = await promptRequiredText(
          prompter,
          'Gemini model',
          defaultModel
        );
        const { model, wasAutoCorrected } = sanitizeModelInput(rawModelInput, defaultModel);
        if (wasAutoCorrected) {
          prompter.info(`Selected default Gemini model: ${defaultModel}`);
        }
        updates.GEMINI_MODEL = model;
      } else {
        const defaultBaseUrl =
          provider === 'custom'
            ? existingPrimaryProvider === 'custom'
              ? existingValues.AI_BASE_URL || ''
              : ''
            : PROVIDER_DEFAULT_BASE_URL[provider] || '';
        updates.AI_BASE_URL = await promptRequiredText(
          prompter,
          `${provider} base URL`,
          existingPrimaryProvider === provider
            ? existingValues.AI_BASE_URL || defaultBaseUrl
            : defaultBaseUrl
        );

        updates.AI_MODEL = await promptRequiredText(
          prompter,
          `${provider} model`,
          existingPrimaryProvider === provider
            ? existingValues.AI_MODEL || PROVIDER_DEFAULT_MODEL[provider]
            : PROVIDER_DEFAULT_MODEL[provider]
        );

        if (provider === 'ollama') {
          updates.AI_API_KEY = 'ollama';
        }
      }
    }
  }

  return selectedProviders;
}

export async function collectSetupConfiguration(
  prompter: SetupPrompter,
  existingValues: EnvironmentValueMap,
  options: CollectSetupOptions = {}
): Promise<SetupWizardResult> {
  const updates: EnvironmentValueMap = {};

  showCredentialHelp(
    prompter,
    'Wallet MCP Access Token',
    'Create a Personal Access Token in BudgetBakers Wallet web settings. Required scopes are documented in the guide.',
    'https://web.budgetbakers.com/settings/mcp-server',
    'wallet-mcp'
  );

  const isCustomBaseUrl = Boolean(
    existingValues.WALLET_MCP_BASE_URL &&
    existingValues.WALLET_MCP_BASE_URL !== 'https://mcp.wallet.budgetbakers.com'
  );

  if (options.isAdvanced || options.isDev || isCustomBaseUrl) {
    updates.WALLET_MCP_BASE_URL = await promptRequiredText(
      prompter,
      'Wallet MCP base URL',
      existingValues.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com'
    );
  } else {
    updates.WALLET_MCP_BASE_URL = existingValues.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
  }

  const walletToken = await promptCredential(
    prompter,
    `Enter WALLET_MCP_ACCESS_TOKEN${hasConfiguredCredential(existingValues.WALLET_MCP_ACCESS_TOKEN) ? ' (press Enter to keep current)' : ''}`,
    existingValues.WALLET_MCP_ACCESS_TOKEN,
    true
  );
  if (walletToken) {
    updates.WALLET_MCP_ACCESS_TOKEN = walletToken;
  }

  const selectedProviders = await configureAiProviders(prompter, existingValues, updates);

  const existingChannels = splitConfiguredValues(existingValues.ENABLED_MESSENGER_CHANNELS).filter(
    isKnownMessenger
  );
  const defaultChannels = existingChannels.length > 0 ? existingChannels : ['whatsapp'];

  let selectedChannelValues: string[] = [];
  while (selectedChannelValues.length === 0) {
    selectedChannelValues = await prompter.chooseMany(
      'Select messaging channel(s)',
      MESSENGER_CHOICES,
      defaultChannels
    );
    if (selectedChannelValues.length === 0) {
      prompter.info('[WARN] Select at least one messaging channel.');
    }
  }

  const selectedChannels = selectedChannelValues.filter(isKnownMessenger);
  updates.ENABLED_MESSENGER_CHANNELS = selectedChannels.join(',');
  let whatsappPhoneNumberCandidate: string | undefined;

  if (selectedChannels.includes('whatsapp')) {
    prompter.info('');
    prompter.info('=== WhatsApp Setup ===');
    prompter.info('Use the authorized phone number in international E.164 format.');
    prompter.info(`Full guide: ${REPOSITORY_DOC_BASE}#whatsapp`);
    whatsappPhoneNumberCandidate = await promptRequiredText(
      prompter,
      'Authorized WhatsApp phone number',
      existingValues.ALLOWED_PHONE_NUMBER
    );
    updates.WHATSAPP_SESSION_PATH =
      existingValues.WHATSAPP_SESSION_PATH || './auth_session';
  }

  if (selectedChannels.includes('telegram')) {
    showCredentialHelp(
      prompter,
      'Telegram Bot Token',
      'Create a Telegram bot with @BotFather, then copy the generated bot token.',
      'https://t.me/BotFather',
      'telegram'
    );

    const telegramToken = await promptCredential(
      prompter,
      `Enter TELEGRAM_BOT_TOKEN${hasConfiguredCredential(existingValues.TELEGRAM_BOT_TOKEN) ? ' (press Enter to keep current)' : ''}`,
      existingValues.TELEGRAM_BOT_TOKEN,
      true
    );
    if (telegramToken) {
      updates.TELEGRAM_BOT_TOKEN = telegramToken;
    }

    prompter.info('');
    prompter.info('=== Security: Telegram Account Authorization ===');
    prompter.info('To ensure your financial data stays private, only your account will be permitted.');
    prompter.info('Find your numeric ID by sending /start to @userinfobot or @raw_data_bot on Telegram.');
    updates.TELEGRAM_ALLOWED_USER_ID = await promptTelegramAllowedUserId(
      prompter,
      existingValues.TELEGRAM_ALLOWED_USER_ID
    );
  }

  updates.APP_LANGUAGE = await prompter.choose(
    'Response language',
    [
      { label: 'English', value: 'en' },
      { label: 'Bahasa Indonesia', value: 'id' },
    ],
    existingValues.APP_LANGUAGE === 'id' ? 'id' : 'en'
  );

  updates.DEFAULT_CURRENCY = (
    await promptRequiredText(
      prompter,
      'Default currency',
      existingValues.DEFAULT_CURRENCY || 'USD'
    )
  ).toUpperCase();

  updates.APP_TIMEZONE = await promptValidIanaTimezone(
    prompter,
    existingValues.APP_TIMEZONE
  );

  if (whatsappPhoneNumberCandidate !== undefined) {
    updates.ALLOWED_PHONE_NUMBER = await normalizeWhatsAppPhoneNumber(
      prompter,
      whatsappPhoneNumberCandidate,
      updates.DEFAULT_CURRENCY,
      updates.APP_TIMEZONE,
      updates.APP_LANGUAGE
    );
  }

  const existingEmailEnabled = existingValues.EMAIL_SYNC_ENABLED === 'true';
  const enableEmailSync = await prompter.confirm(
    'Enable bank/e-wallet email monitoring?',
    existingEmailEnabled
  );
  updates.EMAIL_SYNC_ENABLED = enableEmailSync ? 'true' : 'false';

  if (enableEmailSync) {
    showCredentialHelp(
      prompter,
      'Gmail IMAP App Password',
      'Use a Google App Password, not your normal Google account password. 2-Step Verification must be enabled first.',
      'https://myaccount.google.com/apppasswords',
      'gmail-imap'
    );

    let candidateEmail = existingValues.EMAIL_IMAP_USER || '';
    while (true) {
      candidateEmail = await promptRequiredText(
        prompter,
        'IMAP email address',
        existingValues.EMAIL_IMAP_USER
      );
      if (validateEmailAddress(candidateEmail)) {
        break;
      }
      prompter.info('[WARN] Enter a valid email address (for example user@gmail.com).');
    }
    updates.EMAIL_IMAP_USER = candidateEmail;

    const lowerEmail = candidateEmail.toLowerCase();
    const isGmail = lowerEmail.endsWith('@gmail.com') || lowerEmail.endsWith('@googlemail.com');
    const hasCustomHost = Boolean(
      existingValues.EMAIL_IMAP_HOST &&
      existingValues.EMAIL_IMAP_HOST !== 'imap.gmail.com'
    );
    const hasCustomPort = Boolean(
      existingValues.EMAIL_IMAP_PORT &&
      existingValues.EMAIL_IMAP_PORT !== '993'
    );
    const hasCustomLookback = Boolean(
      existingValues.EMAIL_LOOKBACK_MINUTES &&
      existingValues.EMAIL_LOOKBACK_MINUTES !== '10'
    );

    const shouldPromptAdvancedImap = Boolean(
      options.isAdvanced ||
      options.isDev ||
      !isGmail ||
      hasCustomHost ||
      hasCustomPort
    );

    if (shouldPromptAdvancedImap) {
      const defaultHost = existingValues.EMAIL_IMAP_HOST || 'imap.gmail.com';
      let candidateHost = defaultHost;
      while (true) {
        candidateHost = await promptRequiredText(prompter, 'IMAP host', defaultHost);
        if (validateHostname(candidateHost)) {
          break;
        }
        prompter.info('[WARN] Enter a valid hostname or IP address (for example imap.gmail.com).');
      }
      updates.EMAIL_IMAP_HOST = candidateHost;

      const defaultPort = existingValues.EMAIL_IMAP_PORT || '993';
      let candidatePort = defaultPort;
      while (true) {
        candidatePort = await promptRequiredText(prompter, 'IMAP port', defaultPort);
        if (validatePortNumber(candidatePort) !== null) {
          break;
        }
        prompter.info('[WARN] Port must be a valid number between 1 and 65535.');
      }
      updates.EMAIL_IMAP_PORT = candidatePort;
    } else {
      updates.EMAIL_IMAP_HOST = existingValues.EMAIL_IMAP_HOST || 'imap.gmail.com';
      updates.EMAIL_IMAP_PORT = existingValues.EMAIL_IMAP_PORT || '993';
    }

    const emailPassword = await promptCredential(
      prompter,
      `Enter EMAIL_IMAP_PASSWORD${hasConfiguredCredential(existingValues.EMAIL_IMAP_PASSWORD) ? ' (press Enter to keep current)' : ''}`,
      existingValues.EMAIL_IMAP_PASSWORD,
      true
    );
    if (emailPassword) {
      updates.EMAIL_IMAP_PASSWORD = emailPassword;
    }

    const shouldPromptLookback = Boolean(
      options.isAdvanced ||
      options.isDev ||
      hasCustomLookback
    );

    if (shouldPromptLookback) {
      const defaultLookback = existingValues.EMAIL_LOOKBACK_MINUTES || '10';
      let candidateLookback = defaultLookback;
      while (true) {
        candidateLookback = await promptRequiredText(
          prompter,
          'Initial email lookback in minutes',
          defaultLookback
        );
        const parsedMinutes = Number.parseInt(candidateLookback.trim(), 10);
        if (!Number.isNaN(parsedMinutes) && parsedMinutes >= 1 && parsedMinutes <= 10080) {
          break;
        }
        prompter.info('[WARN] Lookback must be a positive number of minutes (1 to 10080).');
      }
      updates.EMAIL_LOOKBACK_MINUTES = candidateLookback;
    } else {
      updates.EMAIL_LOOKBACK_MINUTES = existingValues.EMAIL_LOOKBACK_MINUTES || '10';
    }
  }

  const effectivePhoneNumber = updates.ALLOWED_PHONE_NUMBER || existingValues.ALLOWED_PHONE_NUMBER || '';
  const primaryAiModel =
    updates.GEMINI_MODEL ||
    updates.AI_MODEL ||
    PROVIDER_DEFAULT_MODEL[selectedProviders[0]] ||
    'default';
  const summaryLines = [
    `Wallet MCP: ${walletToken || hasConfiguredCredential(existingValues.WALLET_MCP_ACCESS_TOKEN) ? 'configured' : 'missing'}`,
    `AI providers: ${selectedProviders.join(' -> ')} (model: ${primaryAiModel})`,
    `Messaging channels: ${selectedChannels.join(', ')}`,
    ...(selectedChannels.includes('whatsapp') && effectivePhoneNumber
      ? [`WhatsApp authorized number: ${maskIdentifier(effectivePhoneNumber)}`]
      : []),
    ...(selectedChannels.includes('telegram') && (updates.TELEGRAM_ALLOWED_USER_ID || existingValues.TELEGRAM_ALLOWED_USER_ID)
      ? [`Telegram authorized user ID: ${updates.TELEGRAM_ALLOWED_USER_ID || existingValues.TELEGRAM_ALLOWED_USER_ID}`]
      : []),
    `Language: ${updates.APP_LANGUAGE}`,
    `Currency: ${updates.DEFAULT_CURRENCY}`,
    `Timezone: ${updates.APP_TIMEZONE}`,
    `Email sync: ${enableEmailSync ? `enabled (${updates.EMAIL_IMAP_USER || existingValues.EMAIL_IMAP_USER || 'configured'} via ${updates.EMAIL_IMAP_HOST || existingValues.EMAIL_IMAP_HOST || 'imap.gmail.com'}:${updates.EMAIL_IMAP_PORT || existingValues.EMAIL_IMAP_PORT || '993'})` : 'disabled'}`,
  ];

  return {
    updates,
    summaryLines,
  };
}
