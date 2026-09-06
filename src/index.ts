import { loadEnvironmentConfiguration } from './config/environmentConfig.js';
import { WalletMcpClientService } from './services/walletMcpClient.js';
import {
  createFinancialAiProvider,
  FinancialAiProvider,
  ExtractedFinancialIntent,
} from './services/ai/index.js';
import {
  MessagingGatewayService,
  WhatsappMessagingAdapter,
  TelegramMessagingAdapter,
  IncomingUserMessageEvent,
} from './services/messaging/index.js';
import { EmailListenerService, EmailTransactionCallback } from './services/emailListenerService.js';
import { PendingTransactionManager, PendingTransactionItem } from './services/pendingTransactionManager.js';
import { applicationLogger, purgeExpiredLogFiles, formatConciseErrorMessage } from './utils/logger.js';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
  formatPendingEmailTransactionNotification,
  formatPendingConfirmationSuccess,
  formatBulkPendingConfirmationSuccess,
  formatPendingCancellationMessage,
} from './utils/humanResponseFormatter.js';
import { validateAndSanitizeFinancialRecords } from './utils/recordValidator.js';
import { detectFastPathAction, detectPendingConfirmationAction } from './utils/fastPathIntentDetector.js';
import { CreateRecordInputPayload } from './types/walletTypes.js';

async function bootstrapApplication(): Promise<void> {
  console.log('====================================================');
  applicationLogger.info('Starting AI Bookkeeper for Wallet');
  console.log('====================================================');

  const environmentConfig = loadEnvironmentConfiguration();

  // Enforce file logger retention policy on startup
  purgeExpiredLogFiles(environmentConfig.logRetentionDays);

  // Validate critical configuration variables
  const isAiConfigured =
    (environmentConfig.aiProvider === 'gemini' && Boolean(environmentConfig.geminiApiKey)) ||
    (environmentConfig.aiProvider === 'ollama') ||
    (Boolean(environmentConfig.aiApiKey));

  if (!isAiConfigured) {
    if (environmentConfig.aiProvider === 'gemini') {
      applicationLogger.error('GEMINI_API_KEY is not defined in .env file!');
      console.log('[hint] Get your free API key at: https://aistudio.google.com');
    } else {
      applicationLogger.error(
        `API key for provider '${environmentConfig.aiProvider}' (AI_API_KEY / ${environmentConfig.aiProvider.toUpperCase()}_API_KEY) is not defined in .env file!`
      );
    }
  }

  if (!environmentConfig.walletMcpAccessToken) {
    applicationLogger.error('WALLET_MCP_ACCESS_TOKEN is not defined in .env file!');
    console.log('[hint] Generate your personal access token at: https://web.budgetbakers.com/settings/mcp-server');
  }

  const isWhatsAppConfigured =
    environmentConfig.enabledMessengerChannels.includes('whatsapp') &&
    Boolean(environmentConfig.allowedPhoneNumber);
  const isTelegramConfigured =
    environmentConfig.enabledMessengerChannels.includes('telegram') &&
    Boolean(environmentConfig.telegramBotToken);

  if (!isWhatsAppConfigured && !isTelegramConfigured) {
    applicationLogger.error(
      'No messaging channels are properly configured! Configure either WhatsApp (ALLOWED_PHONE_NUMBER) or Telegram (TELEGRAM_BOT_TOKEN) in .env.'
    );
  }

  if (
    !isAiConfigured ||
    !environmentConfig.walletMcpAccessToken ||
    (!isWhatsAppConfigured && !isTelegramConfigured)
  ) {
    applicationLogger.warn('Please configure all required environment variables in your .env file before running the bot.');
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

  // 2. Initialize Agnostic Financial AI Provider via Factory
  const financialAiProvider: FinancialAiProvider = createFinancialAiProvider(environmentConfig);

  // 3. Initialize Pending Transaction Manager
  const pendingTransactionManager = new PendingTransactionManager();

  // 4. Initialize Channel-Agnostic Messaging Gateway
  const messagingGateway = new MessagingGatewayService();

  // Forward declaration for emailListenerService so handlers can access it
  let emailListenerService: EmailListenerService | null = null;

  // 5. Define email transaction detection handler
  const handleEmailTransactionDetected: EmailTransactionCallback = async detectedEvent => {
    applicationLogger.info(`Processing detected email transaction: "${detectedEvent.emailSubject}"`);

    const parsedData = await financialAiProvider.processEmailTransactionMessage(
      detectedEvent.gateResult,
      detectedEvent.emailSubject,
      detectedEvent.emailSender,
      detectedEvent.cleanedBodyText,
      detectedEvent.emailDate,
      cachedAccounts,
      cachedCategories
    );

    if (!parsedData.isTransaction) {
      applicationLogger.info(`[Gate 2 Filtered Out] ${parsedData.explanation}`);
      return;
    }

    let resolvedAccountId = parsedData.matchedAccountId;
    let resolvedAccountName = parsedData.accountNameHint;
    if (!resolvedAccountId) {
      const defaultAccount = cachedAccounts[0];
      resolvedAccountId = defaultAccount?.id || '';
      resolvedAccountName = defaultAccount?.name || 'Cash';
    }

    let resolvedDestinationAccountId = parsedData.matchedDestinationAccountId;
    let resolvedDestinationAccountName = parsedData.destinationAccountNameHint;
    if (parsedData.transactionType === 'TRANSFER' && !resolvedDestinationAccountId && parsedData.destinationAccountNameHint) {
      const matchedDest = cachedAccounts.find(acc =>
        acc.name.toLowerCase().includes(parsedData.destinationAccountNameHint!.toLowerCase())
      );
      if (matchedDest) {
        resolvedDestinationAccountId = matchedDest.id;
        resolvedDestinationAccountName = matchedDest.name;
      }
    }

    const pendingItem = pendingTransactionManager.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: detectedEvent.gateResult.matchedBankRule?.displayName || 'Bank / E-Wallet',
      accountNameHint: resolvedAccountName,
      matchedAccountId: resolvedAccountId,
      destinationAccountNameHint: resolvedDestinationAccountName,
      matchedDestinationAccountId: resolvedDestinationAccountId,
      counterParty: parsedData.counterParty || '',
      amount: parsedData.amount,
      transactionType: parsedData.transactionType,
      matchedCategoryId: parsedData.matchedCategoryId,
      matchedCategoryName: parsedData.matchedCategoryName,
      note: parsedData.note || detectedEvent.emailSubject,
      recordDate: parsedData.recordDate || detectedEvent.emailDate.toISOString(),
      referenceNumber: parsedData.referenceNumber || detectedEvent.gateResult.referenceNumber,
      emailSubject: detectedEvent.emailSubject,
    });

    const totalPendingCount = pendingTransactionManager.getAllPendingTransactions().length;
    const notificationText = formatPendingEmailTransactionNotification(pendingItem, totalPendingCount);

    await messagingGateway.broadcastNotification(notificationText);
    applicationLogger.success(`Dispatched pending transaction notification (#${pendingItem.ticketId}) to active messaging channels.`);
  };

  // 6. Define unified message processing handler
  const handleIncomingUserMessage = async (event: IncomingUserMessageEvent): Promise<void> => {
    const processingStartTimestamp = Date.now();
    applicationLogger.chat(
      `[${event.channel.toUpperCase()}] Message received from ${event.senderIdentifier} (${event.messageType}): "${event.textPayload || '[Image]'}"`
    );

    applicationLogger.fileDetail('chat', 'Incoming User Message Event', {
      channel: event.channel,
      senderIdentifier: event.senderIdentifier,
      chatIdentifier: event.chatIdentifier,
      messageType: event.messageType,
      textPayload: event.textPayload,
      hasImageBuffer: Boolean(event.imageBuffer),
      imageMimeType: event.imageMimeType,
    });

    // Notify user with typing presence indicator
    await messagingGateway.sendTypingPresence(event.channel, event.chatIdentifier);

    try {
      // 0. Pending confirmation handler (checks if user is confirming or canceling a pending ticket)
      if (event.messageType === 'text' && event.textPayload && pendingTransactionManager.hasPendingTransactions()) {
        const confirmationIntent = detectPendingConfirmationAction(event.textPayload);

        if (confirmationIntent) {
          if (confirmationIntent.actionType === 'CONFIRM') {
            let itemsToRecord: PendingTransactionItem[] = [];

            if (confirmationIntent.targetScope === 'ALL') {
              itemsToRecord = pendingTransactionManager.resolveAllPendingTransactions();
            } else if (typeof confirmationIntent.targetScope === 'number') {
              const item = pendingTransactionManager.resolvePendingTransaction(confirmationIntent.targetScope);
              if (item) {
                itemsToRecord.push(item);
              }
            } else {
              const item = pendingTransactionManager.getLatestPendingTransaction();
              if (item) {
                pendingTransactionManager.resolvePendingTransaction(item.ticketId);
                itemsToRecord.push(item);
              }
            }

            if (itemsToRecord.length === 0) {
              await messagingGateway.sendMessage(
                event.channel,
                event.chatIdentifier,
                '⚠️ Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
              );
              return;
            }

            const recordsToCreate: CreateRecordInputPayload[] = [];
            for (const item of itemsToRecord) {
              if (item.transactionType === 'TRANSFER') {
                recordsToCreate.push({
                  accountId: item.matchedAccountId,
                  amount: -Math.abs(item.amount),
                  recordDate: item.recordDate,
                  note: item.note || `Transfer ke ${item.destinationAccountNameHint || 'akun lain'}`,
                  counterParty: item.destinationAccountNameHint || '',
                });

                if (item.matchedDestinationAccountId) {
                  recordsToCreate.push({
                    accountId: item.matchedDestinationAccountId,
                    amount: Math.abs(item.amount),
                    recordDate: item.recordDate,
                    note: item.note || `Transfer dari ${item.accountNameHint || 'akun lain'}`,
                    counterParty: item.accountNameHint || '',
                  });
                }
              } else {
                const finalAmount = item.transactionType === 'EXPENSE'
                  ? -Math.abs(item.amount)
                  : Math.abs(item.amount);

                recordsToCreate.push({
                  accountId: item.matchedAccountId,
                  categoryId: item.matchedCategoryId,
                  amount: finalAmount,
                  recordDate: item.recordDate,
                  note: item.note,
                  counterParty: item.counterParty,
                });
              }

              if (emailListenerService) {
                emailListenerService.recordProcessedTransaction(undefined, item.referenceNumber);
              }
            }

            applicationLogger.mcp(`Recording ${recordsToCreate.length} confirmed transaction(s) to Wallet MCP...`);
            await walletMcpClient.createRecords(recordsToCreate);

            const replyMessage = itemsToRecord.length === 1
              ? formatPendingConfirmationSuccess(itemsToRecord[0])
              : formatBulkPendingConfirmationSuccess(itemsToRecord);

            await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
            const processingDurationMs = Date.now() - processingStartTimestamp;
            applicationLogger.success(
              `[${event.channel.toUpperCase()}] Confirmed & recorded ${recordsToCreate.length} pending transaction(s) to Wallet (${processingDurationMs}ms).`
            );
            return;
          }

          if (confirmationIntent.actionType === 'REJECT') {
            let rejectedItems: PendingTransactionItem[] = [];

            if (confirmationIntent.targetScope === 'ALL') {
              rejectedItems = pendingTransactionManager.rejectAllPendingTransactions();
            } else if (typeof confirmationIntent.targetScope === 'number') {
              const item = pendingTransactionManager.rejectPendingTransaction(confirmationIntent.targetScope);
              if (item) {
                rejectedItems.push(item);
              }
            } else {
              const item = pendingTransactionManager.getLatestPendingTransaction();
              if (item) {
                pendingTransactionManager.rejectPendingTransaction(item.ticketId);
                rejectedItems.push(item);
              }
            }

            if (rejectedItems.length === 0) {
              await messagingGateway.sendMessage(
                event.channel,
                event.chatIdentifier,
                '⚠️ Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
              );
              return;
            }

            const replyMessage = formatPendingCancellationMessage(
              rejectedItems.length === 1 ? rejectedItems[0] : rejectedItems
            );
            await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
            const processingDurationMs = Date.now() - processingStartTimestamp;
            applicationLogger.success(
              `[${event.channel.toUpperCase()}] Cancelled ${rejectedItems.length} pending transaction(s) (${processingDurationMs}ms).`
            );
            return;
          }
        }
      }

      // Fast-path intent classifier: Skip AI entirely for simple balance/budget/help queries (0 tokens used)
      if (event.messageType === 'text' && event.textPayload) {
        const fastPathAction = detectFastPathAction(event.textPayload);

        if (fastPathAction === 'CHECK_BALANCE') {
          applicationLogger.info('Fast-path matched: CHECK_BALANCE (0 AI tokens consumed)');
          applicationLogger.mcp('Fetching updated balances...');
          const freshAccounts = await walletMcpClient.fetchAccounts(true);
          cachedAccounts = freshAccounts;

          const replyMessage = formatBalanceSummaryMessage(freshAccounts);
          applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply (Fast-path)', {
            channel: event.channel,
            freshAccountsCount: freshAccounts.length,
            replyText: replyMessage,
          });

          await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
          const processingDurationMs = Date.now() - processingStartTimestamp;
          applicationLogger.success(
            `[${event.channel.toUpperCase()}] Sent balance summary for ${freshAccounts.length} account(s) via Fast-path (${processingDurationMs}ms).`
          );
          return;
        }

        if (fastPathAction === 'CHECK_BUDGET') {
          applicationLogger.info('Fast-path matched: CHECK_BUDGET (0 AI tokens consumed)');
          applicationLogger.mcp('Fetching budget status...');
          const budgetList = await walletMcpClient.fetchBudgets();
          const replyMessage = formatBudgetSummaryMessage(budgetList);

          applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply (Fast-path)', {
            channel: event.channel,
            budgetCount: budgetList.length,
            replyText: replyMessage,
          });

          await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
          const processingDurationMs = Date.now() - processingStartTimestamp;
          applicationLogger.success(
            `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgetList.length} budget(s) via Fast-path (${processingDurationMs}ms).`
          );
          return;
        }

        if (fastPathAction === 'HELP_MENU') {
          applicationLogger.info('Fast-path matched: HELP_MENU (0 AI tokens consumed)');
          const helpGuidanceMessage = [
            '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.',
            '',
            '*Perintah Cepat (0 Token AI):*',
            '• *Saldo* / *Cek Saldo*: Cek saldo semua rekening',
            '• *Budget* / *Cek Budget*: Cek status limit anggaran',
            '• *Menu* / *Bantuan*: Menampilkan petunjuk ini',
          ].join('\n');

          applicationLogger.fileDetail('chat', 'Dispatched Fast-path Help Guidance Reply', {
            channel: event.channel,
            recipientChatId: event.chatIdentifier,
            replyText: helpGuidanceMessage,
          });

          await messagingGateway.sendMessage(event.channel, event.chatIdentifier, helpGuidanceMessage);
          const processingDurationMs = Date.now() - processingStartTimestamp;
          applicationLogger.success(
            `[${event.channel.toUpperCase()}] Sent help guidance menu via Fast-path (${processingDurationMs}ms).`
          );
          return;
        }
      }

      let extractedIntent: ExtractedFinancialIntent;

      if (event.messageType === 'image' && event.imageBuffer) {
        applicationLogger.ai(`Processing receipt photo with ${financialAiProvider.providerName.toUpperCase()} Vision...`);
        extractedIntent = await financialAiProvider.processImageMessage(
          event.imageBuffer,
          event.imageMimeType || 'image/jpeg',
          event.textPayload || '',
          cachedAccounts,
          cachedCategories
        );
      } else {
        applicationLogger.ai(`Analyzing message intent with ${financialAiProvider.providerName.toUpperCase()}...`);
        extractedIntent = await financialAiProvider.processTextMessage(
          event.textPayload || '',
          cachedAccounts,
          cachedCategories
        );
      }

      applicationLogger.ai(`Decision: ${extractedIntent.action} | ${extractedIntent.explanation || ''}`);
      applicationLogger.fileDetail('ai', 'Parsed Financial Intent Result', {
        action: extractedIntent.action,
        explanation: extractedIntent.explanation,
        records: extractedIntent.records,
      });

      // Route actions based on AI analysis
      if (extractedIntent.action === 'CREATE_RECORD' && extractedIntent.records && extractedIntent.records.length > 0) {
        const validationResult = validateAndSanitizeFinancialRecords(
          extractedIntent.records,
          cachedAccounts,
          cachedCategories
        );

        if (!validationResult.isValid || validationResult.sanitizedRecords.length === 0) {
          const validationErrorMessage = validationResult.validationErrors.join('\n');
          applicationLogger.warn(`Financial record validation rejected:\n${validationErrorMessage}`);

          applicationLogger.fileDetail('error', 'Financial Record Validation Failure', {
            originalRecords: extractedIntent.records,
            validationErrors: validationResult.validationErrors,
          });

          await messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            `⚠️ Transaksi tidak dapat disimpan karena data tidak valid:\n${validationErrorMessage}`
          );
          const processingDurationMs = Date.now() - processingStartTimestamp;
          applicationLogger.warn(
            `[${event.channel.toUpperCase()}] Validation rejected: ${validationErrorMessage} (${processingDurationMs}ms).`
          );
          return;
        }

        const validRecordsToCreate = validationResult.sanitizedRecords;
        applicationLogger.mcp(`Creating ${validRecordsToCreate.length} record(s) in Wallet...`);

        applicationLogger.fileDetail('mcp', 'Dispatching Record Creation to Wallet MCP', {
          recordsCount: validRecordsToCreate.length,
          records: validRecordsToCreate,
        });

        await walletMcpClient.createRecords(validRecordsToCreate);

        const replyMessage = formatRecordSuccessMessage(
          validRecordsToCreate,
          cachedAccounts,
          cachedCategories
        );

        applicationLogger.fileDetail('chat', 'Dispatched Record Creation Success Reply', {
          channel: event.channel,
          recipientChatId: event.chatIdentifier,
          replyText: replyMessage,
        });

        await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage.trim());
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Successfully recorded ${validRecordsToCreate.length} transaction(s) to Wallet & sent confirmation (${processingDurationMs}ms).`
        );
        return;
      }

      if (extractedIntent.action === 'CHECK_BALANCE') {
        applicationLogger.mcp('Fetching updated balances...');
        const freshAccounts = await walletMcpClient.fetchAccounts(true);
        cachedAccounts = freshAccounts;

        const replyMessage = formatBalanceSummaryMessage(freshAccounts);

        applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply', {
          channel: event.channel,
          freshAccountsCount: freshAccounts.length,
          balanceList: freshAccounts.map(account => ({ name: account.name, balance: account.balance, currency: account.currency })),
          replyText: replyMessage,
        });

        await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Sent balance summary for ${freshAccounts.length} account(s) (${processingDurationMs}ms).`
        );
        return;
      }

      if (extractedIntent.action === 'CHECK_BUDGET') {
        applicationLogger.mcp('Fetching budget status...');
        const budgetList = await walletMcpClient.fetchBudgets();
        const replyMessage = formatBudgetSummaryMessage(budgetList);

        applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply', {
          channel: event.channel,
          budgetCount: budgetList.length,
          budgets: budgetList,
          replyText: replyMessage,
        });

        await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgetList.length} budget(s) (${processingDurationMs}ms).`
        );
        return;
      }

      // Default: general reply or guidance
      const replyMessage = extractedIntent.explanation || '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.';

      applicationLogger.fileDetail('chat', 'Dispatched General Guidance Reply', {
        channel: event.channel,
        recipientChatId: event.chatIdentifier,
        replyText: replyMessage,
      });

      await messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      const processingDurationMs = Date.now() - processingStartTimestamp;
      applicationLogger.success(
        `[${event.channel.toUpperCase()}] Sent guidance / general reply (${processingDurationMs}ms).`
      );

    } catch (processingError: unknown) {
      const conciseErrorMessage = formatConciseErrorMessage(processingError);
      applicationLogger.error(`Error while processing user message: ${conciseErrorMessage}`);

      applicationLogger.fileDetail('error', 'User Message Processing Error Details', {
        error: processingError instanceof Error
          ? {
              name: processingError.name,
              message: processingError.message,
              stack: processingError.stack,
            }
          : String(processingError),
        incomingEvent: {
          channel: event.channel,
          senderIdentifier: event.senderIdentifier,
          chatIdentifier: event.chatIdentifier,
          messageType: event.messageType,
          textPayload: event.textPayload,
        },
        cachedAccountsCount: cachedAccounts.length,
        cachedCategoriesCount: cachedCategories.length,
      });

      const humanErrorMessage = formatErrorMessageForHuman(processingError, getHumanReadableTimestamp());
      await messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        humanErrorMessage
      );
    } finally {
      // Clear typing presence indicator
      await messagingGateway.clearTypingPresence(event.channel, event.chatIdentifier);
    }
  };

  // 7. Register & Start Messaging Adapters in Gateway
  if (environmentConfig.enabledMessengerChannels.includes('whatsapp')) {
    if (environmentConfig.allowedPhoneNumber) {
      const whatsappAdapter = new WhatsappMessagingAdapter(
        environmentConfig.whatsappSessionPath,
        environmentConfig.allowedPhoneNumber,
        handleIncomingUserMessage
      );
      messagingGateway.registerAdapter(whatsappAdapter);
    } else {
      applicationLogger.warn('WhatsApp is enabled in configuration but ALLOWED_PHONE_NUMBER is not set. WhatsApp adapter skipped.');
    }
  }

  if (environmentConfig.enabledMessengerChannels.includes('telegram')) {
    if (environmentConfig.telegramBotToken) {
      const telegramAdapter = new TelegramMessagingAdapter(
        environmentConfig.telegramBotToken,
        environmentConfig.telegramAllowedUserId,
        handleIncomingUserMessage
      );
      messagingGateway.registerAdapter(telegramAdapter);
    } else {
      applicationLogger.warn('Telegram is enabled in configuration but TELEGRAM_BOT_TOKEN is not set. Telegram adapter skipped.');
    }
  }

  applicationLogger.info('Starting registered messaging adapter connections...');
  await messagingGateway.startAll();

  // 8. Initialize & Start Email Listener (if toggled on in .env)
  if (environmentConfig.emailSyncEnabled) {
    if (!environmentConfig.emailImapUser || !environmentConfig.emailImapPassword) {
      applicationLogger.warn(
        'EMAIL_SYNC_ENABLED is true, but EMAIL_IMAP_USER or EMAIL_IMAP_PASSWORD is not set. Email listener is disabled.'
      );
    } else {
      emailListenerService = new EmailListenerService(
        environmentConfig.emailImapHost,
        environmentConfig.emailImapPort,
        environmentConfig.emailImapUser,
        environmentConfig.emailImapPassword,
        environmentConfig.emailLookbackMinutes,
        handleEmailTransactionDetected
      );

      emailListenerService.startListening().catch(emailStartError => {
        applicationLogger.error(`Failed to start Gmail IMAP listener: ${emailStartError.message}`);
      });
    }
  } else {
    applicationLogger.info('Email sync is disabled (EMAIL_SYNC_ENABLED=false).');
  }
}

bootstrapApplication().catch(error => {
  applicationLogger.error(`Application encountered an unhandled fatal error: ${error}`);
  applicationLogger.fileDetail('fatal', 'Bootstrap Unhandled Fatal Error', {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
