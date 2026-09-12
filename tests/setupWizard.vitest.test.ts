import { describe, expect, it } from 'vitest';
import {
  collectSetupConfiguration,
  SetupChoice,
  SetupPrompter,
} from '../src/setup/setupWizard.js';
import {
  mergeEnvFileContent,
  parseEnvFileContent,
} from '../src/setup/envFileEditor.js';

class FakeSetupPrompter implements SetupPrompter {
  public readonly infoMessages: string[] = [];

  constructor(private readonly secretValues: Record<string, string> = {}) {}

  public info(message: string): void {
    this.infoMessages.push(message);
  }

  public async question(message: string, defaultValue?: string): Promise<string> {
    if (message.includes('Authorized WhatsApp phone number')) {
      return defaultValue || '6281234567890';
    }
    return defaultValue || 'value';
  }

  public async secret(message: string): Promise<string> {
    if (message.includes('WALLET_MCP_ACCESS_TOKEN')) {
      return this.secretValues.wallet || '';
    }
    if (message.includes('GEMINI_API_KEY')) {
      return this.secretValues.gemini || '';
    }
    return '';
  }

  public async confirm(message: string): Promise<boolean> {
    if (message.includes('email monitoring')) {
      return false;
    }
    return true;
  }

  public async choose(
    _message: string,
    _choices: readonly SetupChoice[],
    defaultValue: string
  ): Promise<string> {
    return defaultValue;
  }

  public async chooseMany(message: string): Promise<string[]> {
    if (message.includes('AI provider')) {
      return ['gemini'];
    }
    return ['whatsapp'];
  }
}

describe('setup wizard', () => {
  it('preserves comments and unknown values when updating env content', () => {
    const existing = [
      '# existing comment',
      'UNKNOWN_SETTING=keep-me',
      'APP_LANGUAGE=en',
      'WALLET_MCP_ACCESS_TOKEN=old-secret',
      '',
    ].join('\n');

    const merged = mergeEnvFileContent(existing, {
      APP_LANGUAGE: 'id',
      DEFAULT_CURRENCY: 'IDR',
    });
    const parsed = parseEnvFileContent(merged);

    expect(merged).toContain('# existing comment');
    expect(parsed.UNKNOWN_SETTING).toBe('keep-me');
    expect(parsed.WALLET_MCP_ACCESS_TOKEN).toBe('old-secret');
    expect(parsed.APP_LANGUAGE).toBe('id');
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
      wallet: 'wallet-new-secret',
      gemini: 'gemini-new-secret',
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
});
