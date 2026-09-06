import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { WalletMcpClientService } from '../services/walletMcpClient.js';
import { GeminiAiService } from '../services/geminiAiService.js';
import { applicationLogger } from '../utils/logger.js';

async function runGeminiAiVerification(): Promise<void> {
  applicationLogger.info('Testing Gemini AI Service & Transaction Parsing...');

  const environmentConfig = loadEnvironmentConfiguration();
  const walletMcpClient = new WalletMcpClientService(
    environmentConfig.walletMcpBaseUrl,
    environmentConfig.walletMcpAccessToken
  );

  const accountList = await walletMcpClient.fetchAccounts(true);
  const categoryList = await walletMcpClient.fetchCategories(true);

  const geminiAiService = new GeminiAiService(
    environmentConfig.geminiApiKey,
    environmentConfig.geminiModel,
    environmentConfig.geminiFallbackModels
  );

  const testUserMessage = 'Makan siang di bakso solo 35rb bayar pakai Gopay';
  console.log('');
  applicationLogger.chat(`Simulated User Message: "${testUserMessage}"`);

  const extractionResult = await geminiAiService.processTextMessage(
    testUserMessage,
    accountList,
    categoryList
  );

  console.log('');
  applicationLogger.success('Gemini Extraction Output:');
  console.log(JSON.stringify(extractionResult, null, 2));

  if (extractionResult.records && extractionResult.records.length > 0) {
    const matchedAccount = accountList.find(acc => acc.id === extractionResult.records![0].accountId);
    console.log('');
    applicationLogger.info(`Matched Account: ${matchedAccount?.name} (${matchedAccount?.id})`);
    applicationLogger.info(`Extracted Amount: ${extractionResult.records[0].amount} (Negative for expense: ${extractionResult.records[0].amount < 0})`);
  }
}

runGeminiAiVerification().catch(err => applicationLogger.error(String(err)));
