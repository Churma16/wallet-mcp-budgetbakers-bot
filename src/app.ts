import {
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from './config/index.js';
import {
  AppContext,
  createAppContext,
  initializeAppContext,
  closeAppContext,
  MessageDispatcher,
} from './core/index.js';
import {
  WhatsappMessagingAdapter,
  TelegramMessagingAdapter,
  ConsoleMessagingAdapter,
  NotificationWebhookServer,
} from './gateway/index.js';
import { EmailListenerService } from './email/index.js';
import {
  CategoryContextService,
  CategoryContextValidationResult,
} from './brain/index.js';
import { WalletMcpCapabilityService } from './wallet/index.js';
import {
  applicationLogger,
  installConsoleInterceptors,
  purgeExpiredLogFiles,
} from './lib/index.js';

/**
 * Root application orchestrator managing lifecycle startup, adapter registration,
 * and graceful shutdown via unified AppContext and MessageDispatcher.
 */
export class Application {
  public readonly context: AppContext;
  public readonly dispatcher: MessageDispatcher;
  private isRunning: boolean = false;

  constructor(customConfig?: ApplicationEnvironmentConfiguration) {
    this.context = createAppContext(customConfig);
    this.dispatcher = new MessageDispatcher(this.context);
  }

  /**
   * Validates mandatory environment variables before starting services.
   */
  private validateConfiguration(): void {
    const validationResult = validateApplicationConfiguration(this.context.config);

    if (!validationResult.isValid) {
      for (const errorIssue of validationResult.errors) {
        applicationLogger.error(errorIssue.message);
        if (errorIssue.hint) {
          console.log(`[hint] ${errorIssue.hint}`);
        }
      }

      applicationLogger.warn(
        'Please configure all required environment variables in your .env file before running the bot.'
      );
      applicationLogger.info(
        'You can test the Wallet MCP connection independently with: npm run test:mcp\n'
      );
      process.exit(1);
    }
  }

  /**
   * Bootstraps the application, caches data, registers adapters, and starts listeners.
   */
  public async start(): Promise<void> {
    installConsoleInterceptors();

    console.log('====================================================');
    applicationLogger.info('Starting AI Bookkeeper for Wallet');
    console.log('====================================================');

    applicationLogger.info(
      `Configured Response Language: ${this.context.config.appLanguage.toUpperCase()}`
    );

    // Enforce file logger retention policy on startup
    purgeExpiredLogFiles(this.context.config.logRetentionDays);

    // Validate critical configuration variables
    this.validateConfiguration();

    // 1. Initialize Wallet MCP Client & Pre-cache accounts & categories
    await initializeAppContext(this.context);

    // 2. Register enabled messaging adapters
    if (this.context.config.enabledMessengerChannels.includes('whatsapp')) {
      const allowedPhoneList =
        this.context.config.allowedPhoneNumbers?.length > 0
          ? this.context.config.allowedPhoneNumbers
          : this.context.config.allowedPhoneNumber
            ? [this.context.config.allowedPhoneNumber]
            : [];
      if (allowedPhoneList.length > 0) {
        const whatsappAdapter = new WhatsappMessagingAdapter(
          this.context.config.whatsappSessionPath,
          allowedPhoneList,
          event => this.dispatcher.handleIncomingUserMessage(event),
          {
            maxReconnectAttempts: this.context.config.whatsappMaxReconnectAttempts,
            maxBackoffSeconds: this.context.config.whatsappReconnectMaxBackoffSeconds,
            messageQueueIntervalMs: this.context.config.whatsappMessageQueueIntervalMs,
            typingPresenceCooldownMs: this.context.config.whatsappTypingPresenceCooldownMs,
            maxMediaDownloadBytes: this.context.config.maxMediaDownloadMb * 1024 * 1024,
          }
        );
        this.context.gateway.registerAdapter(whatsappAdapter);
      } else {
        applicationLogger.warn(
          'WhatsApp is enabled in configuration but ALLOWED_PHONE_NUMBER is not set. WhatsApp adapter skipped.'
        );
      }
    }

    if (this.context.config.enabledMessengerChannels.includes('telegram')) {
      if (
        this.context.config.telegramBotToken &&
        this.context.config.telegramAllowedUserId
      ) {
        const telegramAdapter = new TelegramMessagingAdapter(
          this.context.config.telegramBotToken,
          this.context.config.telegramAllowedUserId,
          event => this.dispatcher.handleIncomingUserMessage(event),
          {
            maxStartupAttempts: this.context.config.telegramMaxStartupAttempts,
            startupRetryBaseDelayMs: this.context.config.telegramStartupRetryDelayMs,
            maxMediaDownloadBytes: this.context.config.maxMediaDownloadMb * 1024 * 1024,
          }
        );
        this.context.gateway.registerAdapter(telegramAdapter);
      } else {
        applicationLogger.warn(
          'Telegram is enabled in configuration but TELEGRAM_BOT_TOKEN or TELEGRAM_ALLOWED_USER_ID is not set. Telegram adapter skipped.'
        );
      }
    }

    if (this.context.config.enabledMessengerChannels.includes('console')) {
      const consoleAdapter = new ConsoleMessagingAdapter(
        event => this.dispatcher.handleIncomingUserMessage(event),
        {
          onExitRequested: () => {
            void this.stop().then(() => process.exit(0));
          },
        }
      );
      this.context.gateway.registerAdapter(consoleAdapter);
    }

    // 3. Start registered messaging adapter connections
    applicationLogger.info('Starting registered messaging adapter connections...');
    await this.context.gateway.startAll();

    // 4. Initialize & Start Email Listener (if toggled on in .env)
    if (this.context.config.emailSyncEnabled) {
      if (
        !this.context.config.emailImapUser ||
        !this.context.config.emailImapPassword
      ) {
        applicationLogger.warn(
          'EMAIL_SYNC_ENABLED is true, but EMAIL_IMAP_USER or EMAIL_IMAP_PASSWORD is not set. Email listener is disabled.'
        );
      } else {
        this.context.email.listener = new EmailListenerService(
          this.context.config.emailImapHost,
          this.context.config.emailImapPort,
          this.context.config.emailImapUser,
          this.context.config.emailImapPassword,
          this.context.config.emailLookbackMinutes,
          detectedEvent => this.dispatcher.handleEmailTransactionDetected(detectedEvent),
          undefined,
          undefined,
          undefined,
          3,
          async dlqItem => {
            const alertText = `⚠️ *[Gagal Ekstraksi Email]*\nEmail transaksi gagal diproses AI setelah ${dlqItem.attempts}x percobaan.\nSubjek: *${dlqItem.subject}*\nPengirim: \`${dlqItem.sender}\`\nError: \`${dlqItem.lastError}\``;
            await this.context.gateway.broadcastNotification(alertText);
          }
        );

        this.context.email.listener.startListening().catch(emailStartError => {
          applicationLogger.error(
            `Failed to start Gmail IMAP listener: ${emailStartError.message}`
          );
        });
      }
    } else {
      applicationLogger.info('Email sync is disabled (EMAIL_SYNC_ENABLED=false).');
    }

    // 5. Initialize & Start Notification Webhook Receiver (if toggled on in .env)
    if (this.context.config.notificationWebhookEnabled) {
      this.context.webhook = new NotificationWebhookServer({
        port: this.context.config.notificationWebhookPort,
        host: this.context.config.notificationWebhookHost,
        secret: this.context.config.notificationWebhookSecret,
        onNotificationReceived: payload =>
          this.dispatcher.handleNotificationReceived(payload),
      });

      await this.context.webhook.start().catch(webhookStartError => {
        applicationLogger.error(
          `Failed to start notification webhook server: ${webhookStartError.message}`
        );
      });
    }

    this.isRunning = true;
  }

  /**
   * Gracefully shuts down all active services, adapters, and listeners.
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    applicationLogger.info('Shutting down application services...');
    await closeAppContext(this.context);
    this.isRunning = false;
    applicationLogger.info('All services stopped gracefully.');
  }

  /**
   * Returns the active notification webhook server instance, or null if disabled.
   */
  public getNotificationWebhookServer(): NotificationWebhookServer | null {
    return this.context.webhook;
  }

  /**
   * Reloads category context configuration from disk.
   */
  public reloadCategoryContext(): CategoryContextValidationResult {
    return this.context.brain.categoryContext.reload();
  }

  /**
   * Returns the active category context service instance.
   */
  public getCategoryContextService(): CategoryContextService {
    return this.context.brain.categoryContext;
  }

  /**
   * Returns the active Wallet MCP capability service instance.
   */
  public getWalletCapabilityService(): WalletMcpCapabilityService {
    return this.context.wallet.capabilities;
  }

  // Accessor compatibility properties for direct test access
  public get walletMcpClient(): AppContext['wallet']['client'] {
    return this.context.wallet.client;
  }
  public get walletCacheService(): AppContext['wallet']['cache'] {
    return this.context.wallet.cache;
  }
  public get walletCapabilityService(): AppContext['wallet']['capabilities'] {
    return this.context.wallet.capabilities;
  }
  public get messagingGateway(): AppContext['gateway'] {
    return this.context.gateway;
  }
  public get pendingTransactionManager(): AppContext['pending'] {
    return this.context.pending;
  }
  public get userMessageHandler(): MessageDispatcher {
    return this.dispatcher;
  }
  public get financialActionExecutor(): MessageDispatcher['financialActionExecutor'] {
    return this.dispatcher.financialActionExecutor;
  }
  public get financialActionRegistry(): MessageDispatcher['financialActionRegistry'] {
    return this.dispatcher.financialActionRegistry;
  }
  public get fastPathHandler(): MessageDispatcher['fastPathHandler'] {
    return this.dispatcher.fastPathHandler;
  }
  public get pendingActionHandler(): MessageDispatcher['pendingActionHandler'] {
    return this.dispatcher.pendingActionHandler;
  }
  public get accountClarificationHandler(): MessageDispatcher['accountClarificationHandler'] {
    return this.dispatcher.accountClarificationHandler;
  }
  public get categoryClarificationHandler(): MessageDispatcher['categoryClarificationHandler'] {
    return this.dispatcher.categoryClarificationHandler;
  }
  public get transactionHistoryService(): AppContext['wallet']['history'] {
    return this.context.wallet.history;
  }
  public get transactionSummaryService(): AppContext['wallet']['summary'] {
    return this.context.wallet.summary;
  }
  public get emailListenerService(): AppContext['email']['listener'] {
    return this.context.email.listener;
  }
}
