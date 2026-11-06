import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupChoice, SetupPrompter } from '../src/cli/setupWizard.js';
import { runSetup } from '../src/cli/setup.js';

class MockSetupPrompter implements SetupPrompter {
  public loggedMessages: string[] = [];

  constructor(
    private readonly answers: {
      confirmDefault?: boolean;
      secrets?: Record<string, string>;
      questions?: Record<string, string>;
      language?: string;
      channels?: string[];
      aiProviders?: string[];
    } = {}
  ) {}

  public info(message: string): void {
    this.loggedMessages.push(message);
  }

  public async question(message: string, defaultValue?: string): Promise<string> {
    for (const [key, val] of Object.entries(this.answers.questions || {})) {
      if (message.includes(key)) {
        return val;
      }
    }
    if (defaultValue) {
      return defaultValue;
    }
    if (message.includes('timezone')) {
      return 'Asia/Jakarta';
    }
    if (message.includes('currency')) {
      return 'IDR';
    }
    if (message.includes('Authorized WhatsApp phone number')) {
      return '6281234567890';
    }
    if (message.includes('Authorized Telegram user ID')) {
      return '123456789';
    }
    if (message.includes('IMAP email address')) {
      return 'user@example.com';
    }
    return 'test-value';
  }

  public async secret(message: string): Promise<string> {
    for (const [key, val] of Object.entries(this.answers.secrets || {})) {
      if (message.includes(key)) {
        return val;
      }
    }
    return 'mock-secret';
  }

  public async confirm(_message: string, defaultValue: boolean): Promise<boolean> {
    return this.answers.confirmDefault !== undefined ? this.answers.confirmDefault : defaultValue;
  }

  public async choose(_message: string, _choices: readonly SetupChoice[], defaultValue: string): Promise<string> {
    return this.answers.language || defaultValue;
  }

  public async chooseMany(message: string): Promise<string[]> {
    if (message.includes('AI provider')) {
      return this.answers.aiProviders || ['gemini'];
    }
    return this.answers.channels || ['whatsapp'];
  }
}

describe('runSetup CLI execution (dev and dry-run)', () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-mcp-setup-test-'));
    fs.writeFileSync(
      path.join(tempDirectory, '.env.example'),
      'AI_PROVIDER=gemini\nWALLET_MCP_ACCESS_TOKEN=\nALLOWED_PHONE_NUMBER=\n',
      'utf8'
    );
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('performs a dry-run without writing to disk', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompter = new MockSetupPrompter({
      secrets: { 'Wallet MCP access token': 'test-token', 'Gemini API key': 'test-gemini-key' },
      questions: { 'Authorized WhatsApp phone number': '6281234567890' },
    });

    await runSetup(
      {
        isDryRun: true,
        envFile: '.env',
        targetPath: path.join(tempDirectory, '.env'),
      },
      prompter,
      tempDirectory
    );

    expect(fs.existsSync(path.join(tempDirectory, '.env'))).toBe(false);
    const loggedCalls = consoleLogSpy.mock.calls.map(call => call.join(' '));
    expect(loggedCalls.some(line => line.includes('[DRY-RUN] Simulation mode active'))).toBe(true);
    expect(loggedCalls.some(line => line.includes('[SUCCESS] Dry-run completed successfully'))).toBe(true);

    consoleLogSpy.mockRestore();
  });

  it('prints merged configuration preview when debug and dry-run are both active', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompter = new MockSetupPrompter({
      secrets: { 'Wallet MCP access token': 'debug-token' },
    });

    await runSetup(
      {
        isDryRun: true,
        isDebug: true,
        envFile: '.env',
        targetPath: path.join(tempDirectory, '.env'),
      },
      prompter,
      tempDirectory
    );

    const loggedCalls = consoleLogSpy.mock.calls.map(call => call.join(' '));
    expect(loggedCalls.some(line => line.includes('[DEBUG] Merged configuration preview:'))).toBe(true);
    expect(fs.existsSync(path.join(tempDirectory, '.env'))).toBe(false);

    consoleLogSpy.mockRestore();
  });

  it('writes to .env.dev and preserves existing .env when in dev mode', async () => {
    const originalProdEnv = 'PROD_SECRET=keep-safe\n';
    fs.writeFileSync(path.join(tempDirectory, '.env'), originalProdEnv, 'utf8');

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompter = new MockSetupPrompter({
      confirmDefault: true,
      secrets: { WALLET_MCP_ACCESS_TOKEN: 'dev-token-123' },
      questions: { 'Authorized WhatsApp phone number': '6289999999999' },
    });

    const devEnvPath = path.join(tempDirectory, '.env.dev');
    await runSetup(
      {
        isDev: true,
        envFile: '.env.dev',
        targetPath: devEnvPath,
      },
      prompter,
      tempDirectory
    );

    // .env should NOT be touched
    expect(fs.readFileSync(path.join(tempDirectory, '.env'), 'utf8')).toBe(originalProdEnv);

    // .env.dev should be written with new values
    expect(fs.existsSync(devEnvPath)).toBe(true);
    const writtenDevContent = fs.readFileSync(devEnvPath, 'utf8');
    expect(writtenDevContent).toContain('dev-token-123');
    expect(writtenDevContent).toContain('6289999999999');

    const loggedCalls = consoleLogSpy.mock.calls.map(call => call.join(' '));
    expect(loggedCalls.some(line => line.includes('[SUCCESS] Configuration saved to .env.dev'))).toBe(true);
    expect(loggedCalls.some(line => line.includes('npm run doctor -- --dev'))).toBe(true);

    consoleLogSpy.mockRestore();
  });

  it('exits early without prompting when showHelp is true', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prompter = new MockSetupPrompter();

    await runSetup(
      {
        showHelp: true,
      },
      prompter,
      tempDirectory
    );

    expect(prompter.loggedMessages.length).toBe(0);
    const loggedCalls = consoleLogSpy.mock.calls.map(call => call.join(' '));
    expect(loggedCalls.some(line => line.includes('Usage: npm run setup'))).toBe(true);

    consoleLogSpy.mockRestore();
  });
});
