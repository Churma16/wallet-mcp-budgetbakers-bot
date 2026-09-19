import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';
import { ImapFlow } from 'imapflow';
import {
  ApplicationEnvironmentConfiguration,
  PROVIDER_CONFIG_STRATEGIES,
  SupportedAiProviderType,
  validateApplicationConfiguration,
} from '../config/environmentConfig.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import {
  WalletClientProfile,
  WalletMcpCapabilityQuery,
  WalletMcpToolCapability,
} from '../types/walletCapabilityTypes.js';
import { WalletMcpCapabilityService } from '../services/walletMcpCapabilityService.js';
import { normalizeWalletClientProfile } from '../services/walletProfileNormalizer.js';

export type DoctorStatus = 'SUCCESS' | 'WARN' | 'ERROR';

export const MINIMUM_SUPPORTED_NODE_MAJOR_VERSION = 22;


export interface DoctorCheckResult {
  readonly status: DoctorStatus;
  readonly check: string;
  readonly message: string;
}

export interface WalletMcpDoctorProbeResult {
  readonly clientProfile?: WalletClientProfile;
  readonly tools?: WalletMcpToolCapability[];
  readonly capabilityService?: WalletMcpCapabilityQuery;
}

export interface DoctorDependencies {
  readonly nodeVersion: string;
  readonly probeWalletMcp: (config: ApplicationEnvironmentConfiguration) => Promise<WalletMcpDoctorProbeResult | void>;
  readonly probeAiProvider: (
    provider: SupportedAiProviderType,
    config: ApplicationEnvironmentConfiguration
  ) => Promise<void>;
  readonly probeTelegram: (token: string) => Promise<void>;
  readonly probeEmail: (config: ApplicationEnvironmentConfiguration) => Promise<void>;
  readonly hasWhatsAppSession: (sessionPath: string) => boolean;
}

function trimTrailingSlashes(inputUrl: string): string {
  let endIndex = inputUrl.length;
  while (endIndex > 0 && inputUrl[endIndex - 1] === '/') {
    endIndex--;
  }
  return inputUrl.slice(0, endIndex);
}

function resolveProviderConnectionConfiguration(
  provider: SupportedAiProviderType,
  config: ApplicationEnvironmentConfiguration
): { baseUrl: string; apiKey: string; model: string } {
  if (provider === 'gemini') {
    return {
      baseUrl: '',
      apiKey: config.geminiApiKey,
      model: config.geminiModel,
    };
  }

  const strategy = PROVIDER_CONFIG_STRATEGIES[provider] || PROVIDER_CONFIG_STRATEGIES.custom;
  const isPrimaryProvider = config.aiProvider === provider;

  return {
    baseUrl: isPrimaryProvider
      ? config.aiBaseUrl
      : (strategy.getDefaultBaseUrl() || config.aiBaseUrl),
    apiKey: isPrimaryProvider
      ? config.aiApiKey
      : (strategy.getDefaultApiKey(config.geminiApiKey) || config.aiApiKey),
    model: isPrimaryProvider
      ? config.aiModel
      : (strategy.getDefaultModel(config.geminiModel) || config.aiModel),
  };
}

async function probeWalletMcp(config: ApplicationEnvironmentConfiguration): Promise<WalletMcpDoctorProbeResult> {
  const walletClient = new WalletMcpClientService(
    config.walletMcpBaseUrl,
    config.walletMcpAccessToken
  );
  try {
    const capabilityService = new WalletMcpCapabilityService(walletClient);
    await capabilityService.refreshCapabilities(true);

    const clientProfile = capabilityService.getClientProfile();
    const advertisedToolNames = capabilityService.getAdvertisedToolNames();
    const tools = advertisedToolNames
      .map(toolName => capabilityService.getToolCapability(toolName))
      .filter((tool): tool is WalletMcpToolCapability => tool !== undefined);

    const toolsDiscovered = capabilityService.supportsTool('get_records') !== 'unknown';

    return {
      clientProfile,
      tools: toolsDiscovered ? tools : undefined,
      capabilityService,
    };
  } finally {
    await walletClient.close();
  }
}

async function probeAiProvider(
  provider: SupportedAiProviderType,
  config: ApplicationEnvironmentConfiguration
): Promise<void> {
  const connection = resolveProviderConnectionConfiguration(provider, config);

  if (provider === 'gemini') {
    if (!connection.apiKey) {
      throw new Error('Gemini credential is missing.');
    }

    const client = new GoogleGenAI({ apiKey: connection.apiKey });
    await client.models.generateContent({
      model: connection.model,
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      config: {
        temperature: 0,
        maxOutputTokens: 4,
        httpOptions: {
          timeout: config.geminiRequestTimeoutMilliseconds,
        },
      },
    });
    return;
  }

  if (!connection.baseUrl) {
    throw new Error('AI provider base URL is missing.');
  }
  if (!connection.apiKey && provider !== 'ollama') {
    throw new Error('AI provider credential is missing.');
  }
  if (!connection.model) {
    throw new Error('AI provider model is missing.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/Churma16/wallet-mcp-budgetbakers-bot',
    'X-Title': 'Wallet MCP Bookkeeper Doctor',
  };
  if (connection.apiKey) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  }

  const httpClient = axios.create({
    baseURL: trimTrailingSlashes(connection.baseUrl),
    headers,
    timeout: config.aiRequestTimeoutMilliseconds,
  });

  await httpClient.post('/chat/completions', {
    model: connection.model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    temperature: 0,
    max_tokens: 4,
  });
}

async function probeTelegram(token: string): Promise<void> {
  const httpClient = axios.create({
    baseURL: 'https://api.telegram.org',
    timeout: 10000,
  });
  const response = await httpClient.get(`/bot${token}/getMe`);
  if (!response.data?.ok) {
    throw new Error('Telegram API did not accept the bot token.');
  }
}

async function probeEmail(config: ApplicationEnvironmentConfiguration): Promise<void> {
  const client = new ImapFlow({
    host: config.emailImapHost,
    port: config.emailImapPort,
    secure: true,
    auth: {
      user: config.emailImapUser,
      pass: config.emailImapPassword,
    },
    logger: false,
  });

  try {
    await client.connect();
  } finally {
    try {
      if (client.usable) {
        await client.logout();
      } else {
        client.close();
      }
    } catch {
      client.close();
    }
  }
}

function hasWhatsAppSession(sessionPath: string): boolean {
  const resolvedSessionPath = path.resolve(process.cwd(), sessionPath);
  return fs.existsSync(path.join(resolvedSessionPath, 'creds.json'));
}

export function createDefaultDoctorDependencies(): DoctorDependencies {
  return {
    nodeVersion: process.versions.node,
    probeWalletMcp,
    probeAiProvider,
    probeTelegram,
    probeEmail,
    hasWhatsAppSession,
  };
}

export function renderDoctorResult(result: DoctorCheckResult): string {
  return `[${result.status}] ${result.check}: ${result.message}`;
}

function parseNodeMajorVersion(version: string): number {
  const normalizedVersion = version.trim().replace(/^v/, '');
  return Number.parseInt(normalizedVersion.split('.')[0] || '', 10);
}

async function resolveDoctorCapabilityService(
  probeResult: WalletMcpDoctorProbeResult
): Promise<WalletMcpCapabilityQuery> {
  if (probeResult.capabilityService) {
    return probeResult.capabilityService;
  }

  const syntheticClient = {
    listTools: probeResult.tools !== undefined
      ? async () => probeResult.tools!
      : async () => { throw new Error('Tools unavailable'); },
    getClientProfile: probeResult.clientProfile !== undefined
      ? async () => probeResult.clientProfile!
      : async () => { throw new Error('Profile unavailable'); },
    callMcpTool: async () => { throw new Error('Not implemented'); },
  } as unknown as WalletMcpClientService;

  const syntheticCapabilityService = new WalletMcpCapabilityService(syntheticClient);
  try {
    await syntheticCapabilityService.refreshCapabilities(true);
  } catch {
    // Partial or total failure handled by query tri-state
  }
  return syntheticCapabilityService;
}

export async function runDoctorDiagnostics(
  config: ApplicationEnvironmentConfiguration,
  dependencies: DoctorDependencies = createDefaultDoctorDependencies()
): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  const nodeMajorVersion = parseNodeMajorVersion(dependencies.nodeVersion);

  if (Number.isFinite(nodeMajorVersion) && nodeMajorVersion >= MINIMUM_SUPPORTED_NODE_MAJOR_VERSION) {
    results.push({
      status: 'SUCCESS',
      check: 'Runtime',
      message: `Node.js ${dependencies.nodeVersion} is supported.`,
    });
  } else {
    results.push({
      status: 'ERROR',
      check: 'Runtime',
      message: `Node.js ${MINIMUM_SUPPORTED_NODE_MAJOR_VERSION} or newer is required; current version is ${dependencies.nodeVersion}.`,
    });
  }

  const configurationValidation = validateApplicationConfiguration(config);
  if (configurationValidation.isValid) {
    results.push({
      status: 'SUCCESS',
      check: 'Configuration',
      message: 'Required configuration is valid.',
    });
  } else {
    for (const issue of configurationValidation.errors) {
      results.push({
        status: 'ERROR',
        check: `Configuration/${issue.variableName}`,
        message: issue.hint || 'The configured value is missing or invalid.',
      });
    }
  }

  if (config.walletMcpAccessToken) {
    try {
      const probeResult = await dependencies.probeWalletMcp(config);
      results.push({
        status: 'SUCCESS',
        check: 'Wallet MCP',
        message: 'Connection and access token were accepted.',
      });

      if (probeResult && typeof probeResult === 'object') {
        const capabilityService = await resolveDoctorCapabilityService(probeResult);
        const profile = probeResult.clientProfile ?? capabilityService.getClientProfile();

        // 1. Permissions / Scopes
        const recommendedScopes = [
          'records.create',
          'records.read',
          'accounts.read',
          'categories.read',
          'budgets.read',
        ];
        const primaryScopeStatus = capabilityService.hasScope(recommendedScopes[0]);
        if (primaryScopeStatus === 'unknown') {
          results.push({
            status: 'WARN',
            check: 'Wallet MCP/Permissions',
            message: 'Granted scopes were omitted or unavailable in the Wallet profile.',
          });
        } else {
          const missingScopes = recommendedScopes.filter(
            scope => capabilityService.hasScope(scope) !== true
          );
          if (missingScopes.length === 0) {
            results.push({
              status: 'SUCCESS',
              check: 'Wallet MCP/Permissions',
              message: 'All recommended scopes are granted.',
            });
          } else {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Permissions',
              message: `Missing recommended scopes: ${missingScopes.join(', ')}.`,
            });
          }
        }

        // 2. Sync Readiness
        const syncReadyState = capabilityService.isSyncReady();
        if (syncReadyState === true) {
          results.push({
            status: 'SUCCESS',
            check: 'Wallet MCP/Sync',
            message: `Wallet synchronization is ready (state: ${profile?.syncState || 'ready'}).`,
          });
        } else if (syncReadyState === false) {
          const normalizedSyncState = (profile?.syncState || '').trim().toLowerCase();
          if (
            normalizedSyncState === 'in_progress' ||
            normalizedSyncState === 'syncing' ||
            normalizedSyncState === 'pending'
          ) {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Sync',
              message: `Wallet synchronization is currently in progress (state: ${profile?.syncState}).`,
            });
          } else {
            const syncErrorMessage = profile?.syncError ? `: ${profile.syncError}` : '';
            results.push({
              status: 'ERROR',
              check: 'Wallet MCP/Sync',
              message: `Wallet synchronization is not ready (state: ${profile?.syncState}${syncErrorMessage}).`,
            });
          }
        } else {
          if (profile?.syncState) {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Sync',
              message: `Wallet synchronization state is unrecognized: ${profile.syncState}.`,
            });
          } else {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Sync',
              message: 'Wallet synchronization state was omitted or unavailable in the profile.',
            });
          }
        }

        // 3. Advertised Tools
        const expectedCoreTools = [
          'get_records',
          'create_records',
          'get_accounts',
          'get_categories',
          'get_budgets',
        ];
        const sampleToolSupport = capabilityService.supportsTool(expectedCoreTools[0]);
        if (sampleToolSupport === 'unknown') {
          results.push({
            status: 'WARN',
            check: 'Wallet MCP/Tools',
            message: 'Advertised tools could not be discovered or are unavailable.',
          });
        } else {
          const missingCoreTools = expectedCoreTools.filter(
            toolName => capabilityService.supportsTool(toolName) !== true
          );
          if (missingCoreTools.length === 0) {
            const discoveredTools = probeResult.tools ?? capabilityService.getAdvertisedToolNames()
              .map(name => capabilityService.getToolCapability(name))
              .filter((tool): tool is WalletMcpToolCapability => tool !== undefined);
            const toolCount = discoveredTools.length > 0 ? discoveredTools.length : expectedCoreTools.length;
            results.push({
              status: 'SUCCESS',
              check: 'Wallet MCP/Tools',
              message: `Advertised tools verified (${toolCount} tool(s) discovered).`,
            });
          } else {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Tools',
              message: `Some expected core tools are not advertised: ${missingCoreTools.join(', ')}.`,
            });
          }
        }

        // 4. Currency Alignment
        const walletBaseCurrency = capabilityService.getBaseCurrency();
        if (walletBaseCurrency) {
          const configuredDefault = (config.defaultCurrency || '').trim().toUpperCase();
          const walletBase = walletBaseCurrency.trim().toUpperCase();
          if (configuredDefault && walletBase && configuredDefault !== walletBase) {
            results.push({
              status: 'WARN',
              check: 'Wallet MCP/Currency',
              message: `Configured DEFAULT_CURRENCY ('${configuredDefault}') differs from Wallet base currency ('${walletBase}').`,
            });
          } else if (configuredDefault && walletBase) {
            results.push({
              status: 'SUCCESS',
              check: 'Wallet MCP/Currency',
              message: `Configured currency matches Wallet base currency ('${walletBase}').`,
            });
          }
        }
      }
    } catch {
      results.push({
        status: 'ERROR',
        check: 'Wallet MCP',
        message: 'Connection failed. Check the MCP URL, access token, required scopes, and network access.',
      });
    }
  }

  for (const provider of config.aiProviders) {
    try {
      await dependencies.probeAiProvider(provider, config);
      results.push({
        status: 'SUCCESS',
        check: `AI/${provider}`,
        message: 'Provider connection and model request succeeded.',
      });
    } catch {
      results.push({
        status: 'ERROR',
        check: `AI/${provider}`,
        message: 'Provider probe failed. Check the credential, model, base URL, quota, and network access.',
      });
    }
  }

  if (config.enabledMessengerChannels.includes('whatsapp')) {
    if (!config.allowedPhoneNumber) {
      results.push({
        status: 'ERROR',
        check: 'WhatsApp',
        message: 'ALLOWED_PHONE_NUMBER is required when WhatsApp is enabled.',
      });
    } else if (dependencies.hasWhatsAppSession(config.whatsappSessionPath)) {
      results.push({
        status: 'SUCCESS',
        check: 'WhatsApp',
        message: 'Configuration is valid and an existing Baileys session was found.',
      });
    } else {
      results.push({
        status: 'WARN',
        check: 'WhatsApp',
        message: 'Configuration is valid, but no paired session was found. Start the bot once and scan the QR code.',
      });
    }
  }

  if (config.enabledMessengerChannels.includes('telegram')) {
    if (!config.telegramBotToken || !config.telegramAllowedUserId) {
      results.push({
        status: 'ERROR',
        check: 'Telegram',
        message: 'Bot token and numeric allowed user ID are required when Telegram is enabled.',
      });
    } else {
      try {
        await dependencies.probeTelegram(config.telegramBotToken);
        results.push({
          status: 'SUCCESS',
          check: 'Telegram',
          message: 'Bot token was accepted by the Telegram API.',
        });
      } catch {
        results.push({
          status: 'ERROR',
          check: 'Telegram',
          message: 'Telegram probe failed. Check the bot token and network access.',
        });
      }
    }
  }

  if (config.enabledMessengerChannels.includes('console')) {
    results.push({
      status: 'SUCCESS',
      check: 'Console',
      message: 'Console messaging channel is enabled.',
    });
  }

  if (config.emailSyncEnabled) {
    if (!config.emailImapUser || !config.emailImapPassword) {
      results.push({
        status: 'ERROR',
        check: 'Email IMAP',
        message: 'IMAP user and App Password are required when email sync is enabled.',
      });
    } else {
      try {
        await dependencies.probeEmail(config);
        results.push({
          status: 'SUCCESS',
          check: 'Email IMAP',
          message: 'IMAP authentication and connection succeeded.',
        });
      } catch {
        results.push({
          status: 'ERROR',
          check: 'Email IMAP',
          message: 'IMAP probe failed. Check host, port, account, App Password, and network access.',
        });
      }
    }
  } else {
    results.push({
      status: 'SUCCESS',
      check: 'Email IMAP',
      message: 'Email sync is disabled; connectivity check skipped.',
    });
  }

  return results;
}
