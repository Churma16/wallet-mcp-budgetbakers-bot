import { Bot } from 'grammy';
import { loadEnvironmentConfiguration } from '../src/config/environmentConfig.js';
import { applicationLogger } from '../src/utils/logger.js';
import { convertWhatsAppMarkupToTelegramHtml } from '../src/services/messaging/messageFormatHelper.js';

async function runTelegramBotVerification(): Promise<void> {
  console.log('====================================================');
  applicationLogger.info('Starting Telegram Bot Verification Test');
  console.log('====================================================');

  const environmentConfig = loadEnvironmentConfiguration();

  if (!environmentConfig.telegramBotToken) {
    applicationLogger.error('TELEGRAM_BOT_TOKEN is not defined in .env file!');
    console.log('[hint] Create a bot via @BotFather on Telegram and get your Bot Token.');
    console.log('[hint] Add to your .env: TELEGRAM_BOT_TOKEN=123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ');
    process.exit(1);
  }

  applicationLogger.info('Connecting to Telegram Bot API...');
  const testBot = new Bot(environmentConfig.telegramBotToken);

  try {
    const botInfo = await testBot.api.getMe();
    applicationLogger.success(`Successfully connected to Telegram Bot API!`);
    console.log(`- Bot Name:     ${botInfo.first_name}`);
    console.log(`- Bot Username: @${botInfo.username}`);
    console.log(`- Bot ID:       ${botInfo.id}`);

    if (environmentConfig.telegramAllowedUserId) {
      applicationLogger.info(`Testing test notification to whitelisted user: ${environmentConfig.telegramAllowedUserId}...`);
      const sampleWhatsAppText = '*[TEST]* Halo! Bot BudgetBakers Wallet berhasil terhubung ke Telegram.\n_Semua sistem beroperasi normal._';
      const formattedHtmlText = convertWhatsAppMarkupToTelegramHtml(sampleWhatsAppText);

      await testBot.api.sendMessage(environmentConfig.telegramAllowedUserId, formattedHtmlText, {
        parse_mode: 'HTML',
      });
      applicationLogger.success(`Test message successfully dispatched to Telegram user ${environmentConfig.telegramAllowedUserId}!`);
    } else {
      applicationLogger.warn('TELEGRAM_ALLOWED_USER_ID is not set in .env. Skipped test message delivery.');
      console.log('[hint] Get your Telegram user ID from @userinfobot or @raw_data_bot and set TELEGRAM_ALLOWED_USER_ID in .env.');
    }

    console.log('\n[success] Telegram Bot verification completed successfully!');
  } catch (connectionError: unknown) {
    applicationLogger.error(`Failed to verify Telegram Bot: ${connectionError}`);
    process.exit(1);
  }
}

runTelegramBotVerification().catch(fatalError => {
  applicationLogger.error(`Unexpected test failure: ${fatalError}`);
  process.exit(1);
});
