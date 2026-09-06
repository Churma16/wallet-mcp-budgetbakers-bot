import dotenv from 'dotenv';

dotenv.config();

export interface ApplicationEnvironmentConfiguration {
  geminiApiKey: string;
  walletMcpBaseUrl: string;
  walletMcpAccessToken: string;
  allowedPhoneNumber: string;
  whatsappSessionPath: string;
}

export function loadEnvironmentConfiguration(): ApplicationEnvironmentConfiguration {
  const geminiApiKey = process.env.GEMINI_API_KEY || '';
  const walletMcpBaseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
  const walletMcpAccessToken = process.env.WALLET_MCP_ACCESS_TOKEN || '';
  const allowedPhoneNumber = (process.env.ALLOWED_PHONE_NUMBER || process.env.OWNER_PHONE_NUMBER || '').replace('@s.whatsapp.net', '');
  const whatsappSessionPath = process.env.WHATSAPP_SESSION_PATH || './auth_session';

  return {
    geminiApiKey,
    walletMcpBaseUrl,
    walletMcpAccessToken,
    allowedPhoneNumber,
    whatsappSessionPath,
  };
}
