import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPLICATION_CONFIG_ENV_KEYS,
  loadEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';
import { runDoctor } from '../src/cli/doctor.js';

describe('doctor CLI and env isolation', () => {
  let tempDirectory: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-mcp-doctor-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    // Restore original env
    for (const key of APPLICATION_CONFIG_ENV_KEYS) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('prints doctor help text when showHelp is true', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDoctor({ showHelp: true }, tempDirectory);

    const loggedCalls = consoleLogSpy.mock.calls.map(call => call.join(' '));
    expect(loggedCalls.some(line => line.includes('Usage: npm run doctor'))).toBe(true);

    consoleLogSpy.mockRestore();
  });

  it('logs an error when targeted dev environment file does not exist', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runDoctor(
      {
        isDev: true,
        envFile: '.env.dev',
        targetPath: path.join(tempDirectory, '.env.dev'),
      },
      tempDirectory
    );

    const loggedErrors = consoleErrorSpy.mock.calls.map(call => call.join(' '));
    expect(loggedErrors.some(line => line.includes("Environment file '.env.dev' not found"))).toBe(true);
    expect(loggedErrors.some(line => line.includes("Run 'npm run setup:dev'"))).toBe(true);

    consoleErrorSpy.mockRestore();
  });

  it('isolates configuration keys when loading custom envPath', () => {
    // Pollute process.env with lingering prod keys
    process.env.WALLET_MCP_ACCESS_TOKEN = 'lingering-prod-token';
    process.env.TELEGRAM_BOT_TOKEN = 'lingering-telegram-bot-token';
    process.env.ALLOWED_PHONE_NUMBER = '6281111111111';

    const devEnvFile = path.join(tempDirectory, '.env.dev');
    fs.writeFileSync(
      devEnvFile,
      'WALLET_MCP_ACCESS_TOKEN=isolated-dev-token\nALLOWED_PHONE_NUMBER=6282222222222\n',
      'utf8'
    );

    const config = loadEnvironmentConfiguration({ envPath: devEnvFile, isolateEnv: true });

    expect(config.walletMcpAccessToken).toBe('isolated-dev-token');
    expect(config.allowedPhoneNumber).toBe('6282222222222');
    // TELEGRAM_BOT_TOKEN was not in .env.dev, so it should be cleared from process.env
    expect(config.telegramBotToken).toBe('');
  });
});
