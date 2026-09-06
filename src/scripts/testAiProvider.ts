import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { WalletMcpClientService } from '../services/walletMcpClient.js';
import { createFinancialAiProvider } from '../services/ai/index.js';
import { applicationLogger } from '../utils/logger.js';
import { WalletAccountItem, WalletCategoryItem } from '../types/walletTypes.js';
import { GateEvaluationResult } from '../utils/emailLogicGate.js';

async function runAiProviderVerification(): Promise<void> {
  applicationLogger.info('Starting Agnostic AI Provider Diagnostic Test...');

  const environmentConfig = loadEnvironmentConfiguration();
  applicationLogger.info(`Configured AI Provider: '${environmentConfig.aiProvider.toUpperCase()}'`);
  applicationLogger.info(`Active Model: '${environmentConfig.aiModel || environmentConfig.geminiModel}'`);

  const financialAiProvider = createFinancialAiProvider(environmentConfig);

  let accountList: WalletAccountItem[] = [];
  let categoryList: WalletCategoryItem[] = [];

  if (environmentConfig.walletMcpAccessToken) {
    try {
      const walletMcpClient = new WalletMcpClientService(
        environmentConfig.walletMcpBaseUrl,
        environmentConfig.walletMcpAccessToken
      );
      accountList = await walletMcpClient.fetchAccounts(true);
      categoryList = await walletMcpClient.fetchCategories(true);
      applicationLogger.success(`Fetched ${accountList.length} accounts & ${categoryList.length} categories from Wallet MCP.`);
    } catch (mcpError: any) {
      applicationLogger.warn(`Wallet MCP fetch failed (${mcpError.message}). Using mock accounts & categories for test.`);
    }
  }

  if (accountList.length === 0) {
    accountList = [
      { id: 'acc-1', name: 'Cash', currency: 'IDR' },
      { id: 'acc-2', name: 'BCA', currency: 'IDR' },
      { id: 'acc-3', name: 'Mandiri', currency: 'IDR' },
      { id: 'acc-4', name: 'GoPay', currency: 'IDR' },
    ];
    categoryList = [
      { id: 'cat-1', name: 'Food & Beverage' },
      { id: 'cat-2', name: 'Transportation' },
      { id: 'cat-3', name: 'Shopping' },
      { id: 'cat-4', name: 'Utilities' },
    ];
  }

  // Test 1: Natural Language Text Message Processing
  console.log('\n======================================================');
  applicationLogger.info('TEST 1: Processing Natural Language Expense Text');
  console.log('======================================================');

  const testUserMessage = 'Makan siang di nasi padang sederhana 35rb bayar pakai BCA';
  applicationLogger.chat(`Simulated WhatsApp Message: "${testUserMessage}"`);

  const textExtractionResult = await financialAiProvider.processTextMessage(
    testUserMessage,
    accountList,
    categoryList
  );

  applicationLogger.success(`AI Response Action: ${textExtractionResult.action}`);
  console.log(JSON.stringify(textExtractionResult, null, 2));

  if (textExtractionResult.records && textExtractionResult.records.length > 0) {
    const record = textExtractionResult.records[0];
    const matchedAccount = accountList.find(acc => acc.id === record.accountId);
    const matchedCategory = categoryList.find(cat => cat.id === record.categoryId);
    applicationLogger.info(`[MATCH] Account: ${matchedAccount?.name || record.accountId}`);
    applicationLogger.info(`[MATCH] Category: ${matchedCategory?.name || record.categoryId || 'Uncategorized'}`);
    applicationLogger.info(`[MATCH] Amount: ${record.amount} (Negative: ${record.amount < 0})`);
  }

  // Test 2: Bank Notification Email Parsing (Gate 2)
  console.log('\n======================================================');
  applicationLogger.info('TEST 2: Processing Bank Notification Email (Gate 2)');
  console.log('======================================================');

  const simulatedGate1Result: GateEvaluationResult = {
    passed: true,
    matchedBankRule: {
      bankKey: 'mandiri',
      displayName: 'Bank Mandiri (Livin)',
      accountNameHint: 'Mandiri',
      senderDomains: ['bankmandiri.co.id'],
      subjectKeywords: ['notifikasi transaksi'],
      blacklistKeywords: [],
      bodyRequiredPatterns: [],
      amountPriorityPatterns: [],
      referencePatterns: [],
      transferOrTopupKeywords: [],
    },
    candidateAmount: 48000,
    referenceNumber: 'MN20260906001',
    isTransferCandidate: false,
  };

  const simulatedSubject = 'Notifikasi Transaksi QRIS Livin Mandiri';
  const simulatedSender = 'no-reply@bankmandiri.co.id';
  const simulatedBody = `
    Transaksi QRIS Berhasil
    Tanggal: 06 Sep 2026 12:30:00 WIB
    Merchant: KOPI KENANGAN SENAYAN
    Nominal: Rp 48.000
    No Referensi: MN20260906001
    Status: Berhasil
  `;

  const emailExtractionResult = await financialAiProvider.processEmailTransactionMessage(
    simulatedGate1Result,
    simulatedSubject,
    simulatedSender,
    simulatedBody,
    new Date(),
    accountList,
    categoryList
  );

  applicationLogger.success('Email Gate 2 Extraction Output:');
  console.log(JSON.stringify(emailExtractionResult, null, 2));

  console.log('\n======================================================');
  applicationLogger.success('All AI Provider Diagnostic Tests Completed Successfully!');
  console.log('======================================================\n');
}

runAiProviderVerification().catch(err => {
  applicationLogger.error(`AI Provider Test Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
