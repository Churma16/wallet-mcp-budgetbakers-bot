import { describe, expect, it } from 'vitest';
import {
  loadEnvironmentConfiguration,
  validateApplicationConfiguration,
} from '../src/config/environmentConfig.js';
import {
  collectSetupConfiguration,
  SetupChoice,
  SetupPrompter,
} from '../src/setup/setupWizard.js';
import {
  mergeEnvFileContent,
  parseEnvFileContent,
} from '../src/setup/envFileEditor.js';

interface FakePrompterOptions {
  readonly secrets?: Record<string, string>;
  readonly questionAnswers?: Record<string, string[]>;
  readonly aiProviders?: string[];
  readonly channels?: string[];
  readonly language?: string;
  readonly emailEnabled?: boolean;
}

class FakeSetupPrompter implements SetupPrompter {
  public readonly infoMessages: string[] = [];
  private readonly questionAnswers: Record<string, string[]>;

  constructor(private readonly options: FakePrompterOptions = {}) {
    this.questionAnswers = Object.fromEntries(
      Object.entries(options.questionAnswers || {}).map(([key, values]) => [key, [...values]])
    );
  }

  public info(message: string): void {
    this.infoMessages.push(message);
  }

  public async question(message: string, defaultValue?: string): Promise<string> {
    for (const [messageFragment, answers] of Object.entries(this.questionAnswers)) {
      if (message.includes(messageFragment) && answers.length > 0) {
        return answers.shift() || '';
      }
    }

    if (message.includes('Authorized WhatsApp phone number')) {
      return defaultValue || '6281234567890';
    }
    if (message.includes('Authorized Telegram user ID')) {
      return defaultValue || '123456789';
    }
    if (message.includes('IMAP email address')) {
      return defaultValue || 'user@example.com';
    }
    return defaultValue || 'value';
  }

  public async secret(message: string): Promise<string> {
    for (const [messageFragment, value] of Object.entries(this.options.secrets || {})) {
      if (message.includes(messageFragment)) {
        return value;
      }
    }
    return '';
  }

  public async confirm(message: string): Promise<boolean> {
    if (message.includes('email monitoring')) {
      return this.options.emailEnabled ?? false;
    }
    return true;
  }

  public async choose(
    _message: string,
    _choices: readonly SetupChoice[],
    defaultValue: string
  ): Promise<string> {
    return this.options.language || defaultValue;
  }

  public async chooseMany(message: string): Promise<string[]> {
    if (message.includes('AI provider')) {
      return this.options.aiProviders || ['gemini'];
    }
    return this.options.channels || ['whatsapp'];
  }
}

function withEnvironment<T>(values: Record<string, string>, callback: () => T): T {
  const managedKeys = [
    'AI_PROVIDER',
    'AI_API_KEY',
    'AI_BASE_URL',
    'AI_MODEL',
    'OPENROUTER_API_KEY',
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'WALLET_MCP_BASE_URL',
    'WALLET_MCP_ACCESS_TOKEN',
    'ALLOWED_PHONE_NUMBER',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_ALLOWED_USER_ID',
    'EMAIL_SYNC_ENABLED',
    'ENABLED_MESSENGER_CHANNELS',
    'APP_LANGUAGE',
    'DEFAULT_CURRENCY',
    'APP_TIMEZONE',
  ];
  const previousValues = new Map<string, string | undefined>();

  for (const key of managedKeys) {
    previousValues.set(key, process.env[key]);
    delete process.env[key];
  }
  Object.assign(process.env, values);

  try {
    return callback();
  } finally {
    for (const key of managedKeys) {
      const previousValue = previousValues.get(key);
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
  }
}

describe('setup wizard', () => {
  it('preserves comments, inline comments, quoted hashes, and unknown values', () => {
    const existing = [
      '# existing comment',
      'UNKNOWN_SETTING=keep-me',
      'APP_LANGUAGE=en # preferred locally',
      'CUSTOM_TEXT="value # not comment" # preserve this note',
      'WALLET_MCP_ACCESS_TOKEN=old-secret',
      '',
    ].join('\n');

    const merged = mergeEnvFileContent(existing, {
      APP_LANGUAGE: 'id',
      CUSTOM_TEXT: 'changed # value',
      DEFAULT_CURRENCY: 'IDR',
    });
    const parsed = parseEnvFileContent(merged);

    expect(merged).toContain('# existing comment');
    expect(merged).toContain('APP_LANGUAGE=id # preferred locally');
    expect(merged).toContain('CUSTOM_TEXT="changed # value" # preserve this note');
    expect(parsed.UNKNOWN_SETTING).toBe('keep-me');
    expect(parsed.WALLET_MCP_ACCESS_TOKEN).toBe('old-secret');
    expect(parsed.APP_LANGUAGE).toBe('id');
    expect(parsed.CUSTOM_TEXT).toBe('changed # value');
    expect(parsed.DEFAULT_CURRENCY).toBe('IDR');
  });

  it('keeps configured secrets when the user presses Enter and never includes them in the summary', async () => {
    const existingValues = {
      WALLET_MCP_BASE_URL: 'https://mcp.wallet.budgetbakers.com',
      WALLET_MCP_ACCESS_TOKEN: 'wallet-existing-secret',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-existing-secret',
      GEMINI_MODEL: 'gemini-3.5-flash-lite',
      ENABLED_MESSENGER_CHANNELS: 'whatsapp',
      ALLOWED_PHONE_NUMBER: '6281234567890',
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
      APP_TIMEZONE: 'Asia/Jakarta',
      EMAIL_SYNC_ENABLED: 'false',
    };

    const prompter = new FakeSetupPrompter();
    const result = await collectSetupConfiguration(prompter, existingValues);
    const renderedSummary = result.summaryLines.join('\n');

    expect(result.updates.WALLET_MCP_ACCESS_TOKEN).toBeUndefined();
    expect(result.updates.GEMINI_API_KEY).toBeUndefined();
    expect(renderedSummary).not.toContain('wallet-existing-secret');
    expect(renderedSummary).not.toContain('gemini-existing-secret');
    expect(renderedSummary).not.toContain('6281234567890');
    expect(renderedSummary).toContain('Wallet MCP: configured');
  });

  it('collects fresh required credentials while keeping them out of help and summary output', async () => {
    const prompter = new FakeSetupPrompter({
      secrets: {
        WALLET_MCP_ACCESS_TOKEN: 'wallet-new-secret',
        GEMINI_API_KEY: 'gemini-new-secret',
      },
    });

    const result = await collectSetupConfiguration(prompter, {});
    const visibleOutput = [...prompter.infoMessages, ...result.summaryLines].join('\n');

    expect(result.updates.WALLET_MCP_ACCESS_TOKEN).toBe('wallet-new-secret');
    expect(result.updates.GEMINI_API_KEY).toBe('gemini-new-secret');
    expect(visibleOutput).not.toContain('wallet-new-secret');
    expect(visibleOutput).not.toContain('gemini-new-secret');
    expect(visibleOutput).toContain('docs/setup-credentials.md#wallet-mcp');
    expect(visibleOutput).toContain('docs/setup-credentials.md#gemini');
  });

  it('rebinds AI_API_KEY to a retained credential when the primary provider is reordered', async () => {
    const existingValues = {
      WALLET_MCP_BASE_URL: 'https://mcp.wallet.budgetbakers.com',
      WALLET_MCP_ACCESS_TOKEN: 'wallet-existing-secret',
      AI_PROVIDER: 'openrouter,groq',
      AI_API_KEY: 'openrouter-primary-secret',
      OPENROUTER_API_KEY: 'openrouter-provider-secret',
      GROQ_API_KEY: 'groq-provider-secret',
      AI_BASE_URL: 'https://openrouter.ai/api/v1',
      AI_MODEL: 'openrouter-model',
      ENABLED_MESSENGER_CHANNELS: 'console',
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
      APP_TIMEZONE: 'Asia/Jakarta',
      EMAIL_SYNC_ENABLED: 'false',
    };
    const prompter = new FakeSetupPrompter({
      aiProviders: ['groq', 'openrouter'],
      channels: ['console'],
    });

    const result = await collectSetupConfiguration(prompter, existingValues);
    const existingContent = Object.entries(existingValues)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const mergedValues = parseEnvFileContent(
      mergeEnvFileContent(existingContent, result.updates)
    );

    expect(result.updates.AI_API_KEY).toBe('groq-provider-secret');
    expect(mergedValues.AI_PROVIDER).toBe('groq,openrouter');

    const loadedConfig = withEnvironment(mergedValues, () => loadEnvironmentConfiguration());
    expect(loadedConfig.aiProvider).toBe('groq');
    expect(loadedConfig.aiApiKey).toBe('groq-provider-secret');
  });

  it('requires fresh custom credentials and endpoint when switching from a named provider', async () => {
    const existingValues = {
      WALLET_MCP_ACCESS_TOKEN: 'wallet-existing-secret',
      AI_PROVIDER: 'openrouter',
      AI_API_KEY: 'stale-openrouter-generic-secret',
      AI_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_API_KEY: 'openrouter-provider-secret',
      ENABLED_MESSENGER_CHANNELS: 'console',
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
      APP_TIMEZONE: 'Asia/Jakarta',
      EMAIL_SYNC_ENABLED: 'false',
    };
    const prompter = new FakeSetupPrompter({
      aiProviders: ['custom'],
      channels: ['console'],
      secrets: {
        AI_API_KEY: 'custom-new-secret',
      },
      questionAnswers: {
        'custom base URL': ['', 'https://custom.example/v1'],
        'custom model': ['custom-model'],
      },
    });

    const result = await collectSetupConfiguration(prompter, existingValues);

    expect(result.updates.AI_API_KEY).toBe('custom-new-secret');
    expect(result.updates.AI_BASE_URL).toBe('https://custom.example/v1');
    expect(result.updates.AI_BASE_URL).not.toBe('https://openrouter.ai/api/v1');
    expect(result.updates.AI_MODEL).toBe('custom-model');
    expect(prompter.infoMessages).toContain('[WARN] A value is required.');
  });

  it('reprompts invalid WhatsApp numbers and stores only the runtime-normalized value', async () => {
    const existingValues = {
      WALLET_MCP_ACCESS_TOKEN: 'wallet-existing-secret',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-existing-secret',
      ENABLED_MESSENGER_CHANNELS: 'whatsapp',
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
      APP_TIMEZONE: 'Asia/Jakarta',
      EMAIL_SYNC_ENABLED: 'false',
    };
    const prompter = new FakeSetupPrompter({
      questionAnswers: {
        'Authorized WhatsApp phone number': ['123', '081234567890'],
      },
    });

    const result = await collectSetupConfiguration(prompter, existingValues);

    expect(result.updates.ALLOWED_PHONE_NUMBER).toBe('6281234567890');
    expect(
      prompter.infoMessages.some(message => message.includes('valid WhatsApp phone number'))
    ).toBe(true);
  });

  it('reprompts invalid Telegram IDs and timezones until runtime-valid values are entered', async () => {
    const existingValues = {
      WALLET_MCP_BASE_URL: 'https://mcp.wallet.budgetbakers.com',
      WALLET_MCP_ACCESS_TOKEN: 'wallet-existing-secret',
      AI_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'gemini-existing-secret',
      ENABLED_MESSENGER_CHANNELS: 'console',
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
      APP_TIMEZONE: 'Asia/Jakarta',
      EMAIL_SYNC_ENABLED: 'false',
    };
    const prompter = new FakeSetupPrompter({
      aiProviders: ['gemini'],
      channels: ['telegram', 'console'],
      secrets: {
        TELEGRAM_BOT_TOKEN: 'telegram-new-secret',
      },
      questionAnswers: {
        'Authorized Telegram user ID': ['@fathan', '@123456789'],
        'Application timezone': ['Jakarta', 'Asia/Jakarta'],
      },
    });

    const result = await collectSetupConfiguration(prompter, existingValues);
    const mergedValues = parseEnvFileContent(
      mergeEnvFileContent(
        Object.entries(existingValues)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
        result.updates
      )
    );
    const loadedConfig = withEnvironment(mergedValues, () => loadEnvironmentConfiguration());
    const validationResult = validateApplicationConfiguration(loadedConfig);

    expect(result.updates.TELEGRAM_ALLOWED_USER_ID).toBe('123456789');
    expect(result.updates.APP_TIMEZONE).toBe('Asia/Jakarta');
    expect(validationResult.isValid).toBe(true);
    expect(
      prompter.infoMessages.some(message => message.includes('numeric Telegram user ID'))
    ).toBe(true);
    expect(
      prompter.infoMessages.some(message => message.includes('valid IANA timezone identifier'))
    ).toBe(true);
  });

  it('configures Telegram, console, OpenAI, and optional email sync in one run', async () => {
    const prompter = new FakeSetupPrompter({
      aiProviders: ['openai'],
      channels: ['telegram', 'console'],
      emailEnabled: true,
      secrets: {
        WALLET_MCP_ACCESS_TOKEN: 'wallet-new-secret',
        OPENAI_API_KEY: 'openai-new-secret',
        TELEGRAM_BOT_TOKEN: 'telegram-new-secret',
        EMAIL_IMAP_PASSWORD: 'email-app-password',
      },
      questionAnswers: {
        'Authorized Telegram user ID': ['123456789'],
        'IMAP email address': ['user@example.com'],
      },
    });

    const result = await collectSetupConfiguration(prompter, {});

    expect(result.updates.AI_PROVIDER).toBe('openai');
    expect(result.updates.AI_API_KEY).toBe('openai-new-secret');
    expect(result.updates.OPENAI_API_KEY).toBe('openai-new-secret');
    expect(result.updates.ENABLED_MESSENGER_CHANNELS).toBe('telegram,console');
    expect(result.updates.TELEGRAM_ALLOWED_USER_ID).toBe('123456789');
    expect(result.updates.EMAIL_SYNC_ENABLED).toBe('true');
    expect(result.updates.EMAIL_IMAP_USER).toBe('user@example.com');
    expect(result.updates.EMAIL_IMAP_PASSWORD).toBe('email-app-password');
  });
});
