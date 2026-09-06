import dotenv from 'dotenv';

dotenv.config();

export interface ApplicationEnvironmentConfiguration {
  geminiApiKey: string;
  geminiModel: string;
  geminiFallbackModels: string[];
  geminiRequestTimeoutMilliseconds: number;
  walletMcpBaseUrl: string;
  walletMcpAccessToken: string;
  allowedPhoneNumber: string;
  whatsappSessionPath: string;
  logRetentionDays: number;
  emailSyncEnabled: boolean;
  emailImapHost: string;
  emailImapPort: number;
  emailImapUser: string;
  emailImapPassword: string;
  emailLookbackMinutes: number;
}

export function loadEnvironmentConfiguration(): ApplicationEnvironmentConfiguration {
  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const geminiFallbackModels = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite')
    .split(',')
    .map(modelItem => modelItem.trim())
    .filter(Boolean);
  const geminiRequestTimeoutSeconds = parseInt(process.env.GEMINI_TIMEOUT_SECONDS || '20', 10) || 20;
  const geminiRequestTimeoutMilliseconds = geminiRequestTimeoutSeconds * 1000;
  const walletMcpBaseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
  const walletMcpAccessToken = process.env.WALLET_MCP_ACCESS_TOKEN || '';
  const rawAllowedPhoneNumber = (process.env.ALLOWED_PHONE_NUMBER || process.env.OWNER_PHONE_NUMBER || '')
    .replace('@s.whatsapp.net', '')
    .trim();
  const allowedPhoneNumber = rawAllowedPhoneNumber.replace(/[^0-9]/g, '');
  const whatsappSessionPath = process.env.WHATSAPP_SESSION_PATH || './auth_session';
  const logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS || '7', 10) || 7;
  const emailSyncEnabled = process.env.EMAIL_SYNC_ENABLED === 'true';
  const emailImapHost = process.env.EMAIL_IMAP_HOST || 'imap.gmail.com';
  const emailImapPort = parseInt(process.env.EMAIL_IMAP_PORT || '993', 10) || 993;
  const emailImapUser = process.env.EMAIL_IMAP_USER || '';
  const emailImapPassword = process.env.EMAIL_IMAP_PASSWORD || '';
  const emailLookbackMinutes = parseInt(process.env.EMAIL_LOOKBACK_MINUTES || '10', 10) || 10;

  return {
    geminiApiKey,
    geminiModel,
    geminiFallbackModels,
    geminiRequestTimeoutMilliseconds,
    walletMcpBaseUrl,
    walletMcpAccessToken,
    allowedPhoneNumber,
    whatsappSessionPath,
    logRetentionDays,
    emailSyncEnabled,
    emailImapHost,
    emailImapPort,
    emailImapUser,
    emailImapPassword,
    emailLookbackMinutes,
  };
}
