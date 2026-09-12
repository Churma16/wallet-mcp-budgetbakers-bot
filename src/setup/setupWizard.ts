import { SupportedAiProviderType } from '../config/environmentConfig.js';
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

const REPOSITORY_DOC_BASE =
  'https://github.com/Churma16/wallet-mcp-budgetbakers-bot/blob/main/docs/setup-credentials.md';

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
  openrouter: 'google/gemini-2.0-flash-exp:free',
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
  prompter.info(`[INFO] ${title}`);
  prompter.info(hint);
  prompter.info(`Get it here: ${acquisitionUrl}`);
  prompter.info(`Full guide: ${REPOSITORY_DOC_BASE}#${guideAnchor}`);
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

function resolveExistingProviderKey(
  provider: SupportedAiProviderType,
  existingValues: EnvironmentValueMap,
  existingPrimaryProvider: SupportedAiProviderType | undefined
): string | undefined {
  const providerVariable = PROVIDER_API_KEY_VARIABLE[provider];
  if (!providerVariable) {
    return undefined;
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

      if (enteredCredential) {
        const providerVariable = PROVIDER_API_KEY_VARIABLE[provider];
        if (providerVariable) {
          updates[providerVariable] = enteredCredential;
        }
        if (provider === primaryProvider && provider !== 'gemini') {
          updates.AI_API_KEY = enteredCredential;
        }
      }
    }

    if (provider === primaryProvider) {
      if (provider === 'gemini') {
        updates.GEMINI_MODEL = await promptRequiredText(
          prompter,
          'Gemini model',
          existingPrimaryProvider === provider
            ? existingValues.GEMINI_MODEL || PROVIDER_DEFAULT_MODEL.gemini
            : PROVIDER_DEFAULT_MODEL.gemini
        );
      } else {
        const defaultBaseUrl = PROVIDER_DEFAULT_BASE_URL[provider] || existingValues.AI_BASE_URL || '';
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
  existingValues: EnvironmentValueMap
): Promise<SetupWizardResult> {
  const updates: EnvironmentValueMap = {};

  showCredentialHelp(
    prompter,
    'Wallet MCP access token',
    'Create a Personal Access Token in BudgetBakers Wallet. Required scopes are documented in the guide.',
    'https://web.budgetbakers.com/settings/mcp-server',
    'wallet-mcp'
  );

  updates.WALLET_MCP_BASE_URL = await promptRequiredText(
    prompter,
    'Wallet MCP base URL',
    existingValues.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com'
  );

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

  if (selectedChannels.includes('whatsapp')) {
    prompter.info('');
    prompter.info('[INFO] WhatsApp setup');
    prompter.info('Use the authorized phone number in international E.164 format.');
    prompter.info(`Full guide: ${REPOSITORY_DOC_BASE}#whatsapp`);
    updates.ALLOWED_PHONE_NUMBER = await promptRequiredText(
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
      'Telegram bot token',
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

    prompter.info('Find your immutable numeric Telegram user ID with @userinfobot or @raw_data_bot.');
    updates.TELEGRAM_ALLOWED_USER_ID = await promptRequiredText(
      prompter,
      'Authorized Telegram user ID',
      existingValues.TELEGRAM_ALLOWED_USER_ID
    );
  }

  updates.APP_LANGUAGE = await prompter.choose(
    'Response language',
    [
      { label: 'Bahasa Indonesia', value: 'id' },
      { label: 'English', value: 'en' },
    ],
    existingValues.APP_LANGUAGE === 'en' ? 'en' : 'id'
  );

  updates.DEFAULT_CURRENCY = (
    await promptRequiredText(
      prompter,
      'Default currency',
      existingValues.DEFAULT_CURRENCY || 'IDR'
    )
  ).toUpperCase();

  updates.APP_TIMEZONE = await promptRequiredText(
    prompter,
    'Application timezone (IANA identifier)',
    existingValues.APP_TIMEZONE || 'Asia/Jakarta'
  );

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

    updates.EMAIL_IMAP_HOST = await promptRequiredText(
      prompter,
      'IMAP host',
      existingValues.EMAIL_IMAP_HOST || 'imap.gmail.com'
    );
    updates.EMAIL_IMAP_PORT = await promptRequiredText(
      prompter,
      'IMAP port',
      existingValues.EMAIL_IMAP_PORT || '993'
    );
    updates.EMAIL_IMAP_USER = await promptRequiredText(
      prompter,
      'IMAP email address',
      existingValues.EMAIL_IMAP_USER
    );

    const emailPassword = await promptCredential(
      prompter,
      `Enter EMAIL_IMAP_PASSWORD${hasConfiguredCredential(existingValues.EMAIL_IMAP_PASSWORD) ? ' (press Enter to keep current)' : ''}`,
      existingValues.EMAIL_IMAP_PASSWORD,
      true
    );
    if (emailPassword) {
      updates.EMAIL_IMAP_PASSWORD = emailPassword;
    }

    updates.EMAIL_LOOKBACK_MINUTES = await promptRequiredText(
      prompter,
      'Initial email lookback in minutes',
      existingValues.EMAIL_LOOKBACK_MINUTES || '10'
    );
  }

  const effectivePhoneNumber = updates.ALLOWED_PHONE_NUMBER || existingValues.ALLOWED_PHONE_NUMBER || '';
  const summaryLines = [
    `Wallet MCP: ${walletToken || hasConfiguredCredential(existingValues.WALLET_MCP_ACCESS_TOKEN) ? 'configured' : 'missing'}`,
    `AI providers: ${selectedProviders.join(' -> ')}`,
    `Messaging channels: ${selectedChannels.join(', ')}`,
    ...(selectedChannels.includes('whatsapp') && effectivePhoneNumber
      ? [`WhatsApp authorized number: ${maskIdentifier(effectivePhoneNumber)}`]
      : []),
    `Language: ${updates.APP_LANGUAGE}`,
    `Currency: ${updates.DEFAULT_CURRENCY}`,
    `Timezone: ${updates.APP_TIMEZONE}`,
    `Email sync: ${enableEmailSync ? 'enabled' : 'disabled'}`,
  ];

  return {
    updates,
    summaryLines,
  };
}
