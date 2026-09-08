import { loadEnvironmentConfiguration, ApplicationEnvironmentConfiguration } from './config/environmentConfig.js';
import { WalletMcpClientService } from './services/walletMcpClient.js';
import { WalletCacheService } from './services/walletCacheService.js';
import { createFinancialAiProvider, FinancialAiProvider } from './services/ai/index.js';
import {
  MessagingGatewayService,
  WhatsappMessagingAdapter,
  TelegramMessagingAdapter,
} from './services/messaging/index.js';
import { EmailListenerService } from './services/emailListenerService.js';
import { PendingTransactionManager } from './services/pendingTransactionManager.js';
import {
  EmailTransactionHandler,
  PendingActionHandler,
  FastPathHandler,
  UserMessageHandler,
} from './handlers/index.js';
import { applicationLogger, purgeExpiredLogFiles } from './utils/logger.js';
import { setActiveLanguage } from './i18n/index.js';

export class Application {
  private readonly environmentConfig: ApplicationEnvironmentConfiguration;
  private readonly walletMcpClient: WalletMcpClientService;
  private readonly walletCacheService: WalletCacheService;
  private readonly financialAiProvider: FinancialAiProvider;
  private readonly pendingTransactionManager: PendingTransactionManager;
  private readonly messagingGateway: MessagingGatewayService;
  private emailListenerService: EmailListenerService | null = null;
  private readonly emailTransactionHandler: EmailTransactionHandler;
  private readonly pendingActionHandler: PendingActionHandler;
  private readonly fastPathHandler: FastPathHandler;
  private readonly userMessageHandler: UserMessageHandler;
  private isRunning: boolean = false;

  constructor(customConfig?: ApplicationEnvironmentConfiguration) {
    this.environmentConfig = customConfig || loadEnvironmentConfiguration();
    setActiveLanguage(this.environmentConfig.appLanguage);

    this.walletMcpClient = new WalletMcpClientService(
      this.environmentConfig.walletMcpBaseUrl,
      this.environmentConfig.walletMcpAccessToken
    );

    this.walletCacheService = new WalletCacheService(this.walletMcpClient);
    this.financialAiProvider = createFinancialAiProvider(this.environmentConfig);
    this.pendingTransactionManager = new PendingTransactionManager();
    this.messagingGateway = new MessagingGatewayService();

    this.emailTransactionHandler = new EmailTransactionHandler(
      this.financialAiProvider,
      this.walletCacheService,
      this.pendingTransactionManager,
      this.messagingGateway,
      this.environmentConfig.defaultCurrency
    );

    this.pendingActionHandler = new PendingActionHandler(
      this.pendingTransactionManager,
      this.walletMcpClient,
      this.messagingGateway,
      () => this.emailListenerService
    );

    this.fastPathHandler = new FastPathHandler(
      this.walletMcpClient,
      this.walletCacheService,
      this.messagingGateway
    );

    this.userMessageHandler = new UserMessageHandler(
      this.messagingGateway,
      this.pendingTransactionManager,
      this.pendingActionHandler,
      this.fastPathHandler,
      this.financialAiProvider,
      this.walletCacheService,
      this.walletMcpClient
    );
  }

  /**
   * Validates mandatory environment variables before starting services
   */
  private validateConfiguration(): void {
    const isAiConfigured =
      (this.environmentConfig.aiProvider === 'gemini' && Boolean(this.environmentConfig.geminiApiKey)) ||
      (this.environmentConfig.aiProvider === 'ollama') ||
      Boolean(this.environmentConfig.aiApiKey);

    if (!isAiConfigured) {
      if (this.environmentConfig.aiProvider === 'gemini') {
        applicationLogger.error('GEMINI_API_KEY is not defined in .env file!');
        console.log('[hint] Get your free API key at: https://aistudio.google.com');
      } else {
        applicationLogger.error(
          `API key for provider '${this.environmentConfig.aiProvider}' (AI_API_KEY / ${this.environmentConfig.aiProvider.toUpperCase()}_API_KEY) is not defined in .env file!`
        );
      }
    }

    if (!this.environmentConfig.walletMcpAccessToken) {
      applicationLogger.error('WALLET_MCP_ACCESS_TOKEN is not defined in .env file!');
      console.log('[hint] Generate your personal access token at: https://web.budgetbakers.com/settings/mcp-server');
    }

    const isWhatsAppConfigured =
      this.environmentConfig.enabledMessengerChannels.includes('whatsapp') &&
      Boolean(this.environmentConfig.allowedPhoneNumber);
    const isTelegramConfigured =
      this.environmentConfig.enabledMessengerChannels.includes('telegram') &&
      Boolean(this.environmentConfig.telegramBotToken);

    if (!isWhatsAppConfigured && !isTelegramConfigured) {
      applicationLogger.error(
        'No messaging channels are properly configured! Configure either WhatsApp (ALLOWED_PHONE_NUMBER) or Telegram (TELEGRAM_BOT_TOKEN) in .env.'
      );
    }

    if (
      !isAiConfigured ||
      !this.environmentConfig.walletMcpAccessToken ||
      (!isWhatsAppConfigured && !isTelegramConfigured)
    ) {
      applicationLogger.warn('Please configure all required environment variables in your .env file before running the bot.');
      applicationLogger.info('You can test the Wallet MCP connection independently with: npm run test:mcp\n');
      process.exit(1);
    }
  }

  /**
   * Bootstraps the application, caches data, registers adapters, and starts listeners
   */
  public async start(): Promise<void> {
    console.log('====================================================');
    applicationLogger.info('Starting AI Bookkeeper for Wallet');
    console.log('====================================================');

    applicationLogger.info(`Configured Response Language: ${this.environmentConfig.appLanguage.toUpperCase()}`);

    // Enforce file logger retention policy on startup
    purgeExpiredLogFiles(this.environmentConfig.logRetentionDays);

    // Validate critical configuration variables
    this.validateConfiguration();

    // 1. Initialize Wallet MCP Client & Pre-cache accounts & categories
    applicationLogger.info('Connecting to BudgetBakers Wallet MCP Server...');
    await this.walletCacheService.initialize();

    // 2. Register Messaging Adapters in Gateway
    if (this.environmentConfig.enabledMessengerChannels.includes('whatsapp')) {
      if (this.environmentConfig.allowedPhoneNumber) {
        const whatsappAdapter = new WhatsappMessagingAdapter(
          this.environmentConfig.whatsappSessionPath,
          this.environmentConfig.allowedPhoneNumber,
          event => this.userMessageHandler.handleIncomingUserMessage(event),
          {
            maxReconnectAttempts: this.environmentConfig.whatsappMaxReconnectAttempts,
            maxBackoffSeconds: this.environmentConfig.whatsappReconnectMaxBackoffSeconds,
            messageQueueIntervalMs: this.environmentConfig.whatsappMessageQueueIntervalMs,
            typingPresenceCooldownMs: this.environmentConfig.whatsappTypingPresenceCooldownMs,
          }
        );
        this.messagingGateway.registerAdapter(whatsappAdapter);
      } else {
        applicationLogger.warn(
          'WhatsApp is enabled in configuration but ALLOWED_PHONE_NUMBER is not set. WhatsApp adapter skipped.'
        );
      }
    }

    if (this.environmentConfig.enabledMessengerChannels.includes('telegram')) {
      if (this.environmentConfig.telegramBotToken) {
        const telegramAdapter = new TelegramMessagingAdapter(
          this.environmentConfig.telegramBotToken,
          this.environmentConfig.telegramAllowedUserId,
          event => this.userMessageHandler.handleIncomingUserMessage(event),
          {
            maxStartupAttempts: this.environmentConfig.telegramMaxStartupAttempts,
            startupRetryBaseDelayMs: this.environmentConfig.telegramStartupRetryDelayMs,
          }
        );

        this.messagingGateway.registerAdapter(telegramAdapter);
      } else {
        applicationLogger.warn(
          'Telegram is enabled in configuration but TELEGRAM_BOT_TOKEN is not set. Telegram adapter skipped.'
        );
      }
    }

    // 3. Start registered messaging adapter connections
    applicationLogger.info('Starting registered messaging adapter connections...');
    await this.messagingGateway.startAll();

    // 4. Initialize & Start Email Listener (if toggled on in .env)
    if (this.environmentConfig.emailSyncEnabled) {
      if (!this.environmentConfig.emailImapUser || !this.environmentConfig.emailImapPassword) {
        applicationLogger.warn(
          'EMAIL_SYNC_ENABLED is true, but EMAIL_IMAP_USER or EMAIL_IMAP_PASSWORD is not set. Email listener is disabled.'
        );
      } else {
        this.emailListenerService = new EmailListenerService(
          this.environmentConfig.emailImapHost,
          this.environmentConfig.emailImapPort,
          this.environmentConfig.emailImapUser,
          this.environmentConfig.emailImapPassword,
          this.environmentConfig.emailLookbackMinutes,
          detectedEvent => this.emailTransactionHandler.handleEmailTransactionDetected(detectedEvent)
        );

        this.emailListenerService.startListening().catch(emailStartError => {
          applicationLogger.error(`Failed to start Gmail IMAP listener: ${emailStartError.message}`);
        });
      }
    } else {
      applicationLogger.info('Email sync is disabled (EMAIL_SYNC_ENABLED=false).');
    }

    this.isRunning = true;
  }

  /**
   * Gracefully shuts down all active services, adapters, and listeners
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    applicationLogger.info('Shutting down application services...');

    if (this.emailListenerService) {
      await this.emailListenerService.stop();
    }

    await this.messagingGateway.stopAll();

    this.isRunning = false;
    applicationLogger.info('All services stopped gracefully.');
  }
}
