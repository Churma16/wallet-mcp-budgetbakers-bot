import { loadEnvironmentConfiguration } from './config/environmentConfig.js';
import { WalletMcpClientService } from './services/walletMcpClient.js';
import { GeminiAiService, ExtractedFinancialIntent } from './services/geminiAiService.js';
import { WhatsappBotService, IncomingUserMessageEvent } from './services/whatsappBotService.js';
import { EmailListenerService, EmailTransactionCallback } from './services/emailListenerService.js';
import { PendingTransactionManager, PendingTransactionItem } from './services/pendingTransactionManager.js';
import { applicationLogger, purgeExpiredLogFiles } from './utils/logger.js';
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
  applicationLogger.info('Starting WhatsApp AI Bookkeeper for Wallet');
  console.log('====================================================');

  const environmentConfig = loadEnvironmentConfiguration();

  // Enforce file logger retention policy on startup
  purgeExpiredLogFiles(environmentConfig.logRetentionDays);

  // Validate critical configuration variables
  if (!environmentConfig.geminiApiKey) {
    applicationLogger.error('GEMINI_API_KEY is not defined in .env file!');
    console.log('[hint] Get your free API key at: https://aistudio.google.com');
  }

  if (!environmentConfig.walletMcpAccessToken) {
    applicationLogger.error('WALLET_MCP_ACCESS_TOKEN is not defined in .env file!');
    console.log('[hint] Generate your personal access token at: https://web.budgetbakers.com/settings/mcp-server');
  }

  if (!environmentConfig.allowedPhoneNumber) {
    applicationLogger.error('ALLOWED_PHONE_NUMBER is not defined in .env file! Refusing to start for security.');
    console.log('[hint] Set your WhatsApp phone number in .env: ALLOWED_PHONE_NUMBER=6281234567890');
  }

  if (
    !environmentConfig.geminiApiKey ||
    !environmentConfig.walletMcpAccessToken ||
    !environmentConfig.allowedPhoneNumber
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

  // 2. Initialize Gemini AI Service with fallback models and timeout
  const geminiAiService = new GeminiAiService(
    environmentConfig.geminiApiKey,
    environmentConfig.geminiModel,
    environmentConfig.geminiFallbackModels,
    environmentConfig.geminiRequestTimeoutMilliseconds
  );

  // 3. Initialize Pending Transaction Manager
  const pendingTransactionManager = new PendingTransactionManager();

  // Forward declaration for emailListenerService so handlers can access it
  let emailListenerService: EmailListenerService | null = null;

  // 4. Define email transaction detection handler
  const handleEmailTransactionDetected: EmailTransactionCallback = async detectedEvent => {
    applicationLogger.info(`Processing detected email transaction: "${detectedEvent.emailSubject}"`);

    const parsedData = await geminiAiService.processEmailTransactionMessage(
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

    const recipientJid = `${environmentConfig.allowedPhoneNumber}@s.whatsapp.net`;
    await whatsappBot.sendTextMessageReply(recipientJid, notificationText);
    applicationLogger.success(`Dispatched pending transaction notification (#${pendingItem.ticketId}) to WhatsApp.`);
  };

  // 5. Define message processing handler
  const handleIncomingUserMessage = async (event: IncomingUserMessageEvent): Promise<void> => {
    applicationLogger.chat(`Message received from ${event.senderPhoneNumber} (${event.messageType}): "${event.textPayload || '[Image]'}"`);

    applicationLogger.fileDetail('chat', 'Incoming User Message Event', {
      senderPhoneNumber: event.senderPhoneNumber,
      remoteJid: event.remoteJid,
      messageType: event.messageType,
      textPayload: event.textPayload,
      hasImageBuffer: Boolean(event.imageBuffer),
      imageMimeType: event.imageMimeType,
    });

    // Notify user on WhatsApp with typing indicator
    await whatsappBot.sendTypingPresence(event.remoteJid);

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
              await whatsappBot.sendTextMessageReply(
                event.remoteJid,
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

            await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
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
              await whatsappBot.sendTextMessageReply(
                event.remoteJid,
                '⚠️ Tiket transaksi pending tersebut tidak ditemukan atau sudah kadaluarsa.'
              );
              return;
            }

            const replyMessage = formatPendingCancellationMessage(
              rejectedItems.length === 1 ? rejectedItems[0] : rejectedItems
            );
            await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
            return;
          }
        }
      }

      // Fast-path intent classifier: Skip Gemini AI entirely for simple balance/budget/help queries (0 tokens used)
      if (event.messageType === 'text' && event.textPayload) {
        const fastPathAction = detectFastPathAction(event.textPayload);

        if (fastPathAction === 'CHECK_BALANCE') {
          applicationLogger.info('Fast-path matched: CHECK_BALANCE (0 Gemini tokens consumed)');
          applicationLogger.mcp('Fetching updated balances...');
          const freshAccounts = await walletMcpClient.fetchAccounts(true);
          cachedAccounts = freshAccounts;

          const replyMessage = formatBalanceSummaryMessage(freshAccounts);
          applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply (Fast-path)', {
            freshAccountsCount: freshAccounts.length,
            replyText: replyMessage,
          });

          await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
          return;
        }

        if (fastPathAction === 'CHECK_BUDGET') {
          applicationLogger.info('Fast-path matched: CHECK_BUDGET (0 Gemini tokens consumed)');
          applicationLogger.mcp('Fetching budget status...');
          const budgetList = await walletMcpClient.fetchBudgets();
          const replyMessage = formatBudgetSummaryMessage(budgetList);

          applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply (Fast-path)', {
            budgetCount: budgetList.length,
            replyText: replyMessage,
          });

          await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
          return;
        }

        if (fastPathAction === 'HELP_MENU') {
          applicationLogger.info('Fast-path matched: HELP_MENU (0 Gemini tokens consumed)');
          const helpGuidanceMessage = [
            '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.',
            '',
            '*Perintah Cepat (0 Token AI):*',
            '• *Saldo* / *Cek Saldo*: Cek saldo semua rekening',
            '• *Budget* / *Cek Budget*: Cek status limit anggaran',
            '• *Menu* / *Bantuan*: Menampilkan petunjuk ini',
          ].join('\n');

          applicationLogger.fileDetail('chat', 'Dispatched Fast-path Help Guidance Reply', {
            recipientJid: event.remoteJid,
            replyText: helpGuidanceMessage,
          });

          await whatsappBot.sendTextMessageReply(event.remoteJid, helpGuidanceMessage);
          return;
        }
      }

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

          await whatsappBot.sendTextMessageReply(
            event.remoteJid,
            `⚠️ Transaksi tidak dapat disimpan karena data tidak valid:\n${validationErrorMessage}`
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
          recipientJid: event.remoteJid,
          replyText: replyMessage,
        });

        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage.trim());
        return;
      }

      if (extractedIntent.action === 'CHECK_BALANCE') {
        applicationLogger.mcp('Fetching updated balances...');
        const freshAccounts = await walletMcpClient.fetchAccounts(true);
        cachedAccounts = freshAccounts;

        const replyMessage = formatBalanceSummaryMessage(freshAccounts);

        applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply', {
          freshAccountsCount: freshAccounts.length,
          balanceList: freshAccounts.map(account => ({ name: account.name, balance: account.balance, currency: account.currency })),
          replyText: replyMessage,
        });

        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
        return;
      }

      if (extractedIntent.action === 'CHECK_BUDGET') {
        applicationLogger.mcp('Fetching budget status...');
        const budgetList = await walletMcpClient.fetchBudgets();
        const replyMessage = formatBudgetSummaryMessage(budgetList);

        applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply', {
          budgetCount: budgetList.length,
          budgets: budgetList,
          replyText: replyMessage,
        });

        await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);
        return;
      }

      // Default: general reply or guidance
      const replyMessage = extractedIntent.explanation || '👋 Halo! Kirimkan pengeluaran Anda (misal: "Makan siang 25rb pakai Cash") atau foto struk belanja untuk dicatat ke Wallet.';
      
      applicationLogger.fileDetail('chat', 'Dispatched General Guidance Reply', {
        recipientJid: event.remoteJid,
        replyText: replyMessage,
      });

      await whatsappBot.sendTextMessageReply(event.remoteJid, replyMessage);

    } catch (processingError: unknown) {
      applicationLogger.error(`Error while processing user message: ${processingError}`);
      
      applicationLogger.fileDetail('error', 'User Message Processing Error Details', {
        error: processingError instanceof Error
          ? {
              name: processingError.name,
              message: processingError.message,
              stack: processingError.stack,
            }
          : String(processingError),
        incomingEvent: {
          senderPhoneNumber: event.senderPhoneNumber,
          remoteJid: event.remoteJid,
          messageType: event.messageType,
          textPayload: event.textPayload,
        },
        cachedAccountsCount: cachedAccounts.length,
        cachedCategoriesCount: cachedCategories.length,
      });

      const humanErrorMessage = formatErrorMessageForHuman(processingError, getHumanReadableTimestamp());
      await whatsappBot.sendTextMessageReply(
        event.remoteJid,
        humanErrorMessage
      );
    } finally {
      // Clear WhatsApp typing indicator
      await whatsappBot.clearTypingPresence(event.remoteJid);
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

  // 6. Initialize & Start Email Listener (if toggled on in .env)
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
    applicationLogger.info('Email sync is disabled (EMAIL_SYNC_ENABLED=false). Bot running in WhatsApp-only mode.');
  }
}

bootstrapApplication().catch(error => {
  applicationLogger.error(`Application encountered an unhandled fatal error: ${error}`);
  applicationLogger.fileDetail('fatal', 'Bootstrap Unhandled Fatal Error', {
    error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
  });
});
