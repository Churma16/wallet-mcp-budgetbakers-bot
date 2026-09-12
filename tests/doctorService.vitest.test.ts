import { describe, expect, it, vi } from 'vitest';
import { ApplicationEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import {
  DoctorDependencies,
  renderDoctorResult,
  runDoctorDiagnostics,
} from '../src/diagnostics/doctorService.js';

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

  it('does not expose secrets even when a dependency error contains them', async () => {
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
});
