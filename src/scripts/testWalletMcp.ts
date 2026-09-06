import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { WalletMcpClientService } from '../services/walletMcpClient.js';
import { applicationLogger } from '../utils/logger.js';

async function runWalletMcpVerification(): Promise<void> {
  applicationLogger.info('Starting BudgetBakers Wallet MCP Verification...');

  const environmentConfig = loadEnvironmentConfiguration();

  if (!environmentConfig.walletMcpAccessToken) {
    applicationLogger.error('WALLET_MCP_ACCESS_TOKEN is missing in .env file!');
    console.log('[hint] Please generate a Personal Access Token in https://web.budgetbakers.com/settings/mcp-server');
    process.exit(1);
  }

  applicationLogger.info(`Target Server: ${environmentConfig.walletMcpBaseUrl}`);
  const walletMcpClient = new WalletMcpClientService(
    environmentConfig.walletMcpBaseUrl,
    environmentConfig.walletMcpAccessToken
  );

  try {
    applicationLogger.info('1. Checking client profile...');
    const clientProfileResult = await walletMcpClient.verifyClientProfile();
    applicationLogger.success('Client Profile Verified:');
    console.log(JSON.stringify(clientProfileResult, null, 2));

    console.log('');
    applicationLogger.info('2. Fetching accounts...');
    const accountList = await walletMcpClient.fetchAccounts(true);
    applicationLogger.success(`Found ${accountList.length} accounts:`);
    accountList.forEach((accountItem, accountIndex) => {
      console.log(`   ${accountIndex + 1}. [${accountItem.name}] ID: ${accountItem.id} | Balance: ${accountItem.balance ?? 'N/A'} ${accountItem.currency ?? ''}`);
    });

    console.log('');
    applicationLogger.info('3. Fetching categories...');
    const categoryList = await walletMcpClient.fetchCategories(true);
    applicationLogger.success(`Found ${categoryList.length} categories.`);
    console.log('   Sample categories:', categoryList.slice(0, 5).map(c => c.name).join(', '));

    console.log('');
    applicationLogger.success('All Wallet MCP checks passed! Your token and permissions are ready.');
  } catch (error: unknown) {
    applicationLogger.error('Verification failed with error:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
  }
}

runWalletMcpVerification();
