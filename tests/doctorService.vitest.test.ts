import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import {
  createDefaultDoctorDependencies,
  DoctorDependencies,
  renderDoctorResult,
  runDoctorDiagnostics,
} from '../src/diagnostics/doctorService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';

function createConfiguration(): ApplicationEnvironmentConfiguration {
  return {
    aiProvider: 'gemini',
    aiProviders: ['gemini'],
    aiApiKey: 'gemini-secret',
    aiBaseUrl: '',
    aiModel: 'gemini-3.5-flash-lite',
    aiFallbackModels: [],
    aiRequestTimeoutMilliseconds: 25000,
    geminiApiKey: 'gemini-secret',
    geminiModel: 'gemini-3.5-flash-lite',
    geminiFallbackModels: [],
    geminiRequestTimeoutMilliseconds: 20000,
    walletMcpBaseUrl: 'https://mcp.wallet.budgetbakers.com',
    walletMcpAccessToken: 'wallet-secret',
    allowedPhoneNumber: '6281234567890',
    whatsappSessionPath: './auth_session',
    telegramBotToken: '',
    telegramAllowedUserId: '',
    enabledMessengerChannels: ['whatsapp'],
    logRetentionDays: 7,
    emailSyncEnabled: false,
    emailImapHost: 'imap.gmail.com',
    emailImapPort: 993,
    emailImapUser: '',
    emailImapPassword: '',
    emailLookbackMinutes: 10,
    appLanguage: 'id',
    defaultCurrency: 'IDR',
    appTimezone: 'Asia/Jakarta',
    whatsappMaxReconnectAttempts: 6,
    whatsappReconnectMaxBackoffSeconds: 300,
    whatsappMessageQueueIntervalMs: 1000,
    whatsappTypingPresenceCooldownMs: 2500,
    telegramMaxStartupAttempts: 5,
    telegramStartupRetryDelayMs: 2000,
    maxMediaDownloadMb: 10,
    categoryContextFilePath: 'config/category-context.json',
  };
}

function createDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    nodeVersion: '22.16.0',
    probeWalletMcp: vi.fn().mockResolvedValue(undefined),
    probeAiProvider: vi.fn().mockResolvedValue(undefined),
    probeTelegram: vi.fn().mockResolvedValue(undefined),
    probeEmail: vi.fn().mockResolvedValue(undefined),
    hasWhatsAppSession: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('doctor diagnostics', () => {
  it('reports successful read-only checks for a valid configuration', async () => {
    const config = createConfiguration();
    const results = await runDoctorDiagnostics(config, createDependencies());

    expect(results.some(result => result.status === 'ERROR')).toBe(false);
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Wallet MCP',
      message: 'Connection and access token were accepted.',
    });
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'AI/gemini',
      message: 'Provider connection and model request succeeded.',
    });
  });

  it('warns instead of failing when WhatsApp is configured but has not been paired yet', async () => {
    const config = createConfiguration();
    const results = await runDoctorDiagnostics(
      config,
      createDependencies({ hasWhatsAppSession: vi.fn().mockReturnValue(false) })
    );

    expect(results).toContainEqual({
      status: 'WARN',
      check: 'WhatsApp',
      message: 'Configuration is valid, but no paired session was found. Start the bot once and scan the QR code.',
    });
  });

  it('does not expose secrets even when dependency errors contain them', async () => {
    const config = createConfiguration();
    const dependencies = createDependencies({
      probeWalletMcp: vi.fn().mockRejectedValue(
        new Error(`request failed with token ${config.walletMcpAccessToken}`)
      ),
      probeAiProvider: vi.fn().mockRejectedValue(
        new Error(`request failed with key ${config.geminiApiKey}`)
      ),
    });

    const results = await runDoctorDiagnostics(config, dependencies);
    const renderedOutput = results.map(renderDoctorResult).join('\n');

    expect(renderedOutput).not.toContain(config.walletMcpAccessToken);
    expect(renderedOutput).not.toContain(config.geminiApiKey);
    expect(renderedOutput).toContain('[ERROR] Wallet MCP');
    expect(renderedOutput).toContain('[ERROR] AI/gemini');
  });

  it('fails runtime compatibility below Node.js 22', async () => {
    const config = createConfiguration();
    const results = await runDoctorDiagnostics(
      config,
      createDependencies({ nodeVersion: '20.19.0' })
    );

    expect(results).toContainEqual({
      status: 'ERROR',
      check: 'Runtime',
      message: 'Node.js 22 or newer is required; current version is 20.19.0.',
    });
  });

  it('checks Telegram, console, and enabled email sync', async () => {
    const config = {
      ...createConfiguration(),
      allowedPhoneNumber: '',
      enabledMessengerChannels: ['telegram', 'console'] as ('telegram' | 'console')[],
      telegramBotToken: 'telegram-secret',
      telegramAllowedUserId: '123456789',
      emailSyncEnabled: true,
      emailImapUser: 'user@example.com',
      emailImapPassword: 'app-password',
    };
    const dependencies = createDependencies();

    const results = await runDoctorDiagnostics(config, dependencies);

    expect(dependencies.probeTelegram).toHaveBeenCalledWith('telegram-secret');
    expect(dependencies.probeEmail).toHaveBeenCalledWith(config);
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Console',
      message: 'Console messaging channel is enabled.',
    });
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Email IMAP',
      message: 'IMAP authentication and connection succeeded.',
    });
  });

  it('reports missing or rejected messaging and email diagnostics safely', async () => {
    const config = {
      ...createConfiguration(),
      allowedPhoneNumber: '',
      enabledMessengerChannels: ['whatsapp', 'telegram'] as ('whatsapp' | 'telegram')[],
      telegramBotToken: '',
      telegramAllowedUserId: '',
      emailSyncEnabled: true,
      emailImapUser: '',
      emailImapPassword: '',
    };

    const results = await runDoctorDiagnostics(config, createDependencies());

    expect(results).toContainEqual({
      status: 'ERROR',
      check: 'WhatsApp',
      message: 'ALLOWED_PHONE_NUMBER is required when WhatsApp is enabled.',
    });
    expect(results).toContainEqual({
      status: 'ERROR',
      check: 'Telegram',
      message: 'Bot token and numeric allowed user ID are required when Telegram is enabled.',
    });
    expect(results).toContainEqual({
      status: 'ERROR',
      check: 'Email IMAP',
      message: 'IMAP user and App Password are required when email sync is enabled.',
    });
  });

  it('reports Telegram and email probe failures without exposing upstream errors', async () => {
    const config = {
      ...createConfiguration(),
      allowedPhoneNumber: '',
      enabledMessengerChannels: ['telegram'] as ['telegram'],
      telegramBotToken: 'telegram-secret',
      telegramAllowedUserId: '123456789',
      emailSyncEnabled: true,
      emailImapUser: 'user@example.com',
      emailImapPassword: 'app-password',
    };
    const dependencies = createDependencies({
      probeTelegram: vi.fn().mockRejectedValue(new Error('telegram-secret leaked upstream')),
      probeEmail: vi.fn().mockRejectedValue(new Error('app-password leaked upstream')),
    });

    const results = await runDoctorDiagnostics(config, dependencies);
    const output = results.map(renderDoctorResult).join('\n');

    expect(output).toContain('[ERROR] Telegram');
    expect(output).toContain('[ERROR] Email IMAP');
    expect(output).not.toContain('telegram-secret');
    expect(output).not.toContain('app-password');
  });

  it('uses the configured runtime timeout for OpenAI-compatible AI probes', async () => {
    const post = vi.fn().mockResolvedValue({ data: { choices: [] } });
    const createSpy = vi.spyOn(axios, 'create').mockReturnValue({ post } as never);
    const config = {
      ...createConfiguration(),
      aiProvider: 'ollama' as const,
      aiProviders: ['ollama'] as ['ollama'],
      aiApiKey: 'ollama',
      aiBaseUrl: 'http://localhost:11434/v1///',
      aiModel: 'llama3.2',
      aiRequestTimeoutMilliseconds: 60000,
    };

    await createDefaultDoctorDependencies().probeAiProvider('ollama', config);

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'http://localhost:11434/v1',
        timeout: 60000,
      })
    );
    expect(post).toHaveBeenCalledWith(
      '/chat/completions',
      expect.objectContaining({ model: 'llama3.2' })
    );
  });

  it('rejects incomplete OpenAI-compatible probe configuration before network access', async () => {
    const dependencies = createDefaultDoctorDependencies();
    const missingBaseUrl = {
      ...createConfiguration(),
      aiProvider: 'custom' as const,
      aiProviders: ['custom'] as ['custom'],
      aiApiKey: 'custom-secret',
      aiBaseUrl: '',
      aiModel: 'custom-model',
    };
    const missingCredential = {
      ...missingBaseUrl,
      aiBaseUrl: 'https://custom.example/v1',
      aiApiKey: '',
    };
    const missingModel = {
      ...missingBaseUrl,
      aiBaseUrl: 'https://custom.example/v1',
      aiModel: '',
    };

    await expect(dependencies.probeAiProvider('custom', missingBaseUrl)).rejects.toThrow(
      'AI provider base URL is missing.'
    );
    await expect(dependencies.probeAiProvider('custom', missingCredential)).rejects.toThrow(
      'AI provider credential is missing.'
    );
    await expect(dependencies.probeAiProvider('custom', missingModel)).rejects.toThrow(
      'AI provider model is missing.'
    );
  });

  it('uses the default Wallet MCP probe without starting application services', async () => {
    const verifySpy = vi
      .spyOn(WalletMcpClientService.prototype, 'verifyClientProfile')
      .mockResolvedValue({} as never);
    const config = createConfiguration();

    await createDefaultDoctorDependencies().probeWalletMcp(config);

    expect(verifySpy).toHaveBeenCalledTimes(1);
  });

  it('checks WhatsApp session persistence using creds.json', () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-session-'));
    try {
      expect(createDefaultDoctorDependencies().hasWhatsAppSession(temporaryDirectory)).toBe(false);
      fs.writeFileSync(path.join(temporaryDirectory, 'creds.json'), '{}', 'utf8');
      expect(createDefaultDoctorDependencies().hasWhatsAppSession(temporaryDirectory)).toBe(true);
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('probes Telegram through getMe and rejects unsuccessful API responses', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: { ok: true } })
      .mockResolvedValueOnce({ data: { ok: false } });
    vi.spyOn(axios, 'create').mockReturnValue({ get } as never);
    const dependencies = createDefaultDoctorDependencies();

    await dependencies.probeTelegram('telegram-token');
    await expect(dependencies.probeTelegram('telegram-token')).rejects.toThrow(
      'Telegram API did not accept the bot token.'
    );

    expect(get).toHaveBeenCalledWith('/bottelegram-token/getMe');
  });

  it('connects to IMAP without scanning mail and closes an unusable client', async () => {
    const connectSpy = vi.spyOn(ImapFlow.prototype, 'connect').mockResolvedValue(undefined as never);
    const closeSpy = vi.spyOn(ImapFlow.prototype, 'close').mockImplementation(() => undefined);
    const config = {
      ...createConfiguration(),
      emailSyncEnabled: true,
      emailImapUser: 'user@example.com',
      emailImapPassword: 'app-password',
    };

    await createDefaultDoctorDependencies().probeEmail(config);

    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('reports successful granular Wallet MCP diagnostics when all permissions, sync, tools, and currency align', async () => {
    const config = createConfiguration();
    const mockProbeResult = {
      clientProfile: {
        grantedScopes: new Set([
          'records.create',
          'records.read',
          'accounts.read',
          'categories.read',
          'budgets.read',
        ]),
        syncState: 'complete',
        baseCurrency: 'IDR',
        usedCurrencies: ['IDR'],
        mcpTools: ['get_records'],
        fetchedAt: Date.now(),
        raw: {},
      },
      tools: [
        { name: 'get_records', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
        { name: 'create_records', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
        { name: 'get_accounts', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
        { name: 'get_categories', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
        { name: 'get_budgets', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
      ],
    };

    const dependencies = createDependencies({
      probeWalletMcp: vi.fn().mockResolvedValue(mockProbeResult),
    });

    const results = await runDoctorDiagnostics(config, dependencies);

    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Wallet MCP/Permissions',
      message: 'All recommended scopes are granted.',
    });
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Wallet MCP/Sync',
      message: 'Wallet synchronization is ready (state: complete).',
    });
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Wallet MCP/Tools',
      message: 'Advertised tools verified (5 tool(s) discovered).',
    });
    expect(results).toContainEqual({
      status: 'SUCCESS',
      check: 'Wallet MCP/Currency',
      message: "Configured currency matches Wallet base currency ('IDR').",
    });
  });

  it('warns on missing scopes, in-progress sync, missing core tools, and currency mismatch', async () => {
    const config = createConfiguration(); // defaultCurrency is IDR
    const mockProbeResult = {
      clientProfile: {
        grantedScopes: new Set(['records.read']),
        syncState: 'in_progress',
        baseCurrency: 'USD',
        usedCurrencies: ['USD'],
        mcpTools: ['get_records'],
        fetchedAt: Date.now(),
        raw: {},
      },
      tools: [
        { name: 'get_records', inputFields: [], isApplicationSupported: true, hasOutputSchema: true },
      ],
    };

    const dependencies = createDependencies({
      probeWalletMcp: vi.fn().mockResolvedValue(mockProbeResult),
    });

    const results = await runDoctorDiagnostics(config, dependencies);

    expect(results).toContainEqual({
      status: 'WARN',
      check: 'Wallet MCP/Permissions',
      message: 'Missing recommended scopes: records.create, accounts.read, categories.read, budgets.read.',
    });
    expect(results).toContainEqual({
      status: 'WARN',
      check: 'Wallet MCP/Sync',
      message: 'Wallet synchronization is currently in progress (state: in_progress).',
    });
    expect(results).toContainEqual({
      status: 'WARN',
      check: 'Wallet MCP/Tools',
      message: 'Some expected core tools are not advertised: create_records, get_accounts, get_categories, get_budgets.',
    });
    expect(results).toContainEqual({
      status: 'WARN',
      check: 'Wallet MCP/Currency',
      message: "Configured DEFAULT_CURRENCY ('IDR') differs from Wallet base currency ('USD').",
    });
  });

  it('reports error when Wallet synchronization state indicates error', async () => {
    const config = createConfiguration();
    const mockProbeResult = {
      clientProfile: {
        syncState: 'error',
        syncError: 'Bank sync credential expired',
        usedCurrencies: [],
        mcpTools: [],
        fetchedAt: Date.now(),
        raw: {},
      },
    };

    const dependencies = createDependencies({
      probeWalletMcp: vi.fn().mockResolvedValue(mockProbeResult),
    });

    const results = await runDoctorDiagnostics(config, dependencies);

    expect(results).toContainEqual({
      status: 'ERROR',
      check: 'Wallet MCP/Sync',
      message: 'Wallet synchronization is not ready (state: error: Bank sync credential expired).',
    });
  });

  it('warns when advertised tools array is empty and lists all missing expected core tools', async () => {
    const config = createConfiguration();
    const mockProbeResult = {
      tools: [], // Successful empty tools array from MCP listTools()
    };

    const dependencies = createDependencies({
      probeWalletMcp: vi.fn().mockResolvedValue(mockProbeResult),
    });

    const results = await runDoctorDiagnostics(config, dependencies);

    expect(results).toContainEqual({
      status: 'WARN',
      check: 'Wallet MCP/Tools',
      message: 'Some expected core tools are not advertised: get_records, create_records, get_accounts, get_categories, get_budgets.',
    });
  });
});
