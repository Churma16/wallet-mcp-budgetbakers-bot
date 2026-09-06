import { loadEnvironmentConfiguration } from './config/environmentConfig.js';
import { WalletMcpClientService } from './services/walletMcpClient.js';
import { GeminiAiService, ExtractedFinancialIntent } from './services/geminiAiService.js';
import { WhatsappBotService, IncomingUserMessageEvent } from './services/whatsappBotService.js';
import { applicationLogger, getFormattedTimestamp } from './utils/logger.js';

async function bootstrapApplication(): Promise<void> {
  console.log('====================================================');
  applicationLogger.info('Starting WhatsApp AI Bookkeeper for Wallet');
  console.log('====================================================');

  const environmentConfig = loadEnvironmentConfiguration();

  // Validate critical configuration variables
  if (!environmentConfig.geminiApiKey) {
    applicationLogger.error('GEMINI_API_KEY is not defined in .env file!');
    console.log('[hint] Get your free API key at: https://aistudio.google.com');
  }

  if (!environmentConfig.walletMcpAccessToken) {
    applicationLogger.error('WALLET_MCP_ACCESS_TOKEN is not defined in .env file!');
    console.log('[hint] Generate your personal access token at: https://web.budgetbakers.com/settings/mcp-server');
  }

  if (!environmentConfig.geminiApiKey || !environmentConfig.walletMcpAccessToken) {
    applicationLogger.warn('Please configure the required environment variables in your .env file before running the bot.');
    applicationLogger.info('You can test the Wallet MCP connection independently with: npm run test:mcp\n');
    process.exit(1);
  }

  // 1. Initialize Wallet MCP Client & Pre-cache accounts & categories
  applicationLogger.info('Connecting to BudgetBakers Wallet MCP Server...');
  const walletMcpClient = new WalletMcpClientService(
    environmentConfig.walletMcpBaseUrl,
    environmentConfig.walletMcpAccessToken
  );

  let cachedAccounts = await walletMcpClient.fetchAccounts(true).catch(error => {
    applicationLogger.error(`Failed to fetch accounts during startup: ${error.message}`);
    return [];
  });

  let cachedCategories = await walletMcpClient.fetchCategories(true).catch(error => {
    applicationLogger.error(`Failed to fetch categories during startup: ${error.message}`);
    return [];
  });

  applicationLogger.success(`Cached ${cachedAccounts.length} accounts and ${cachedCategories.length} categories.`);

  // 2. Initialize Gemini AI Service
  const geminiAiService = new GeminiAiService(environmentConfig.geminiApiKey);

  // 3. Define message processing handler
  const handleIncomingUserMessage = async (event: IncomingUserMessageEvent): Promise<void> => {
    applicationLogger.chat(`Message received from ${event.senderPhoneNumber} (${event.messageType}): "${event.textPayload || '[Image]'}"`);

    try {
      let extractedIntent: ExtractedFinancialIntent;

      if (event.messageType === 'image' && event.imageBuffer) {
        applicationLogger.ai('Processing receipt photo with Gemini Vision...');
        extractedIntent = await geminiAiService.processImageMessage(
          event.imageBuffer,
          event.imageMimeType || 'image/jpeg',
          event.textPayload || '',
          cachedAccounts,
          cachedCategories
        );
      } else {
        applicationLogger.ai('Analyzing message intent with Gemini...');
        extractedIntent = await geminiAiService.processTextMessage(
          event.textPayload || '',
          cachedAccounts,
          cachedCategories
        );
      }

      applicationLogger.ai(`Decision: ${extractedIntent.action} | ${extractedIntent.explanation || ''}`);

      // Route actions based on AI analysis
      if (extractedIntent.action === 'CREATE_RECORD' && extractedIntent.records && extractedIntent.records.length > 0) {
        applicationLogger.mcp(`Creating ${extractedIntent.records.length} record(s) in Wallet...`);

        await walletMcpClient.createRecords(extractedIntent.records);

        const currentFormattedTime = new Date().toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });

        const recordDetailsList = extractedIntent.records.map(record => {
          const accountName = cachedAccounts.find(acc => acc.id === record.accountId)?.name || 'Account';
          const categoryName = cachedCategories.find(cat => cat.id === record.categoryId)?.name || 'General';
          const formattedAmount = new Intl.NumberFormat('id-ID', {
            style: 'currency',
            currency: 'IDR',
            maximumFractionDigits: 0,
          }).format(Math.abs(record.amount));

          const recordTypeSign = record.amount < 0 ? '💸 [Pengeluaran]' : '💰 [Pemasukan]';
          return `${recordTypeSign} *${formattedAmount}*\n  🏷️ Kategori: ${categoryName}\n  💳 Akun: ${accountName}\n  📝 Catatan: ${record.note || '-'}`;
        }).join('\n\n');

        const replyMessage = `[success] ✅ *Transaksi Berhasil Dicatat!*\n\n${recordDetailsList}\n\n⏰ Waktu: ${getFormattedTimestamp()}\n${extractedIntent.explanation ? `💡 ${extractedIntent.explanation}` : ''}`;
        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage.trim());
        return;
      }

      if (extractedIntent.action === 'CHECK_BALANCE') {
        applicationLogger.mcp('Fetching updated balances...');
        const freshAccounts = await walletMcpClient.fetchAccounts(true);
        cachedAccounts = freshAccounts;

        const balanceSummary = freshAccounts
          .map(acc => `• *${acc.name}*: ${acc.balance !== undefined ? new Intl.NumberFormat('id-ID', { style: 'currency', currency: acc.currency || 'IDR', maximumFractionDigits: 0 }).format(acc.balance) : 'N/A'}`)
          .join('\n');

        const replyMessage = `[info] 📊 *Saldo Rekening Saat Ini* (${getFormattedTimestamp()}):\n\n${balanceSummary || 'Tidak ada data rekening'}`;
        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
        return;
      }

      if (extractedIntent.action === 'CHECK_BUDGET') {
        applicationLogger.mcp('Fetching budget status...');
        const budgetList = await walletMcpClient.fetchBudgets();
        const budgetSummary = budgetList.map(budget => {
          const spent = budget.spentAmount || 0;
          const limit = budget.limitAmount || 0;
          const remaining = limit - spent;
          return `• *${budget.name}*: Terpakai ${spent.toLocaleString('id-ID')} / ${limit.toLocaleString('id-ID')} (Sisa: ${remaining.toLocaleString('id-ID')})`;
        }).join('\n');

        const replyMessage = `[info] 📈 *Status Anggaran* (${getFormattedTimestamp()}):\n\n${budgetSummary || 'Belum ada anggaran yang aktif'}`;
        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
        return;
      }

      // Default: general reply or guidance
      const replyMessage = extractedIntent.explanation || '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.';
      await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);

    } catch (processingError: unknown) {
      applicationLogger.error(`Error while processing user message: ${processingError}`);
      const errorMessage = processingError instanceof Error ? processingError.message : 'Terjadi kesalahan sistem';
      await whatsappBot.sendTextMessageReply(
        event.remoteJid,
        `[error] ❌ Maaf, gagal memproses transaksi (${getFormattedTimestamp()}):\n${errorMessage}`
      );
    }
  };

  // 4. Initialize & Start WhatsApp Bot Gateway
  const whatsappBot = new WhatsappBotService(
    environmentConfig.whatsappSessionPath,
    environmentConfig.allowedPhoneNumber,
    handleIncomingUserMessage
  );

  applicationLogger.info('Initializing WhatsApp Socket...');
  await whatsappBot.startConnection();
}

bootstrapApplication().catch(error => {
  applicationLogger.error(`Application encountered an unhandled fatal error: ${error}`);
});
