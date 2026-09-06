import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { WalletMcpClientService } from '../services/walletMcpClient.js';

async function runWalletMcpVerification(): Promise<void> {
  console.log('[info] Starting BudgetBakers Wallet MCP Verification...');

  const environmentConfig = loadEnvironmentConfiguration();

  if (!environmentConfig.walletMcpAccessToken) {
    console.error('[error] WALLET_MCP_ACCESS_TOKEN is missing in .env file!');
    console.log('[hint] Please generate a Personal Access Token in https://web.budgetbakers.com/settings/mcp-server');
    process.exit(1);
  }

  console.log(`[info] Target Server: ${environmentConfig.walletMcpBaseUrl}`);
  const walletMcpClient = new WalletMcpClientService(
    environmentConfig.walletMcpBaseUrl,
    environmentConfig.walletMcpAccessToken
  );

  try {
    console.log('[info] 1. Checking client profile...');
    const clientProfileResult = await walletMcpClient.verifyClientProfile();
    console.log('[success] Client Profile Verified:');
    console.log(JSON.stringify(clientProfileResult, null, 2));

    console.log('\n[info] 2. Fetching accounts...');
    const accountList = await walletMcpClient.fetchAccounts(true);
    console.log(`[success] Found ${accountList.length} accounts:`);
    accountList.forEach((accountItem, accountIndex) => {
      console.log(`   ${accountIndex + 1}. [${accountItem.name}] ID: ${accountItem.id} | Balance: ${accountItem.balance ?? 'N/A'} ${accountItem.currency ?? ''}`);
    });

    console.log('\n[info] 3. Fetching categories...');
    const categoryList = await walletMcpClient.fetchCategories(true);
    console.log(`[success] Found ${categoryList.length} categories.`);
    console.log('   Sample categories:', categoryList.slice(0, 5).map(c => c.name).join(', '));

    console.log('\n[success] All Wallet MCP checks passed! Your token and permissions are ready.');
  } catch (error: unknown) {
    console.error('[error] Verification failed with error:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
  }
}

runWalletMcpVerification();
