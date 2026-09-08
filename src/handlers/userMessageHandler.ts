import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { FinancialAiProvider, ExtractedFinancialIntent } from '../services/ai/index.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { PendingActionHandler } from './pendingActionHandler.js';
import { FastPathHandler } from './fastPathHandler.js';
import { detectFastPathAction, detectPendingConfirmationAction } from '../utils/fastPathIntentDetector.js';
import { validateAndSanitizeFinancialRecords } from '../utils/recordValidator.js';
import {
  formatRecordSuccessMessage,
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
} from '../utils/humanResponseFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger, formatConciseErrorMessage } from '../utils/logger.js';

export class UserMessageHandler {
  constructor(
    private readonly messagingGateway: MessagingGatewayService,
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly pendingActionHandler: PendingActionHandler,
    private readonly fastPathHandler: FastPathHandler,
    private readonly financialAiProvider: FinancialAiProvider,
    private readonly walletCacheService: WalletCacheService,
    private readonly walletMcpClient: WalletMcpClientService
  ) {}

  /**
   * Primary entry point for all incoming user messages (WhatsApp & Telegram)
   */
  public async handleIncomingUserMessage(event: IncomingUserMessageEvent): Promise<void> {
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
    await this.messagingGateway.sendTypingPresence(event.channel, event.chatIdentifier);

    try {
      // 0. Pending confirmation handler (checks if user is confirming or canceling a pending ticket)
      if (event.messageType === 'text' && event.textPayload && this.pendingTransactionManager.hasPendingTransactions()) {
        const confirmationIntent = detectPendingConfirmationAction(event.textPayload);
        if (confirmationIntent) {
          const handled = await this.pendingActionHandler.handlePendingAction(
            event,
            confirmationIntent,
            processingStartTimestamp
          );
          if (handled) {
            return;
          }
        }
      }

      // 1. Fast-path intent classifier: Skip AI entirely for simple balance/budget/help queries (0 tokens used)
      if (event.messageType === 'text' && event.textPayload) {
        const fastPathAction = detectFastPathAction(event.textPayload);
        if (fastPathAction) {
          const handled = await this.fastPathHandler.handleFastPath(
            event,
            fastPathAction,
            processingStartTimestamp
          );
          if (handled) {
            return;
          }
        }
      }

      // 2. AI Intent Extraction (Gemini / Ollama / Vision)
      const cachedAccounts = this.walletCacheService.getAccounts();
      const cachedCategories = this.walletCacheService.getCategories();

      let extractedIntent: ExtractedFinancialIntent;

      if (event.messageType === 'image' && event.imageBuffer) {
        applicationLogger.ai(`Processing receipt photo with ${this.financialAiProvider.providerName.toUpperCase()} Vision...`);
        extractedIntent = await this.financialAiProvider.processImageMessage(
          event.imageBuffer,
          event.imageMimeType || 'image/jpeg',
          event.textPayload || '',
          cachedAccounts,
          cachedCategories
        );
      } else {
        applicationLogger.ai(`Analyzing message intent with ${this.financialAiProvider.providerName.toUpperCase()}...`);
        extractedIntent = await this.financialAiProvider.processTextMessage(
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

      // 3. Route actions based on AI analysis
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

          await this.messagingGateway.sendMessage(
            event.channel,
            event.chatIdentifier,
            getDictionary().errors.validationRejected(validationErrorMessage)
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

        await this.walletMcpClient.createRecords(validRecordsToCreate);

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

        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage.trim());
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Successfully recorded ${validRecordsToCreate.length} transaction(s) to Wallet & sent confirmation (${processingDurationMs}ms).`
        );
        return;
      }

      if (extractedIntent.action === 'CHECK_BALANCE') {
        applicationLogger.mcp('Fetching updated balances...');
        const freshAccounts = await this.walletCacheService.refreshAccounts();

        const replyMessage = formatBalanceSummaryMessage(freshAccounts);

        applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply', {
          channel: event.channel,
          freshAccountsCount: freshAccounts.length,
          balanceList: freshAccounts.map(account => ({
            name: account.name,
            balance: account.balance,
            currency: account.currency,
          })),
          replyText: replyMessage,
        });

        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Sent balance summary for ${freshAccounts.length} account(s) (${processingDurationMs}ms).`
        );
        return;
      }

      if (extractedIntent.action === 'CHECK_BUDGET') {
        applicationLogger.mcp('Fetching budget status...');
        const budgetList = await this.walletMcpClient.fetchBudgets();
        const replyMessage = formatBudgetSummaryMessage(budgetList);

        applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply', {
          channel: event.channel,
          budgetCount: budgetList.length,
          budgets: budgetList,
          replyText: replyMessage,
        });

        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgetList.length} budget(s) (${processingDurationMs}ms).`
        );
        return;
      }

      // Default: general reply or guidance
      const replyMessage = extractedIntent.explanation || getDictionary().help.welcomeGuidance;

      applicationLogger.fileDetail('chat', 'Dispatched General Guidance Reply', {
        channel: event.channel,
        recipientChatId: event.chatIdentifier,
        replyText: replyMessage,
      });

      await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
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
        cachedAccountsCount: this.walletCacheService.getAccounts().length,
        cachedCategoriesCount: this.walletCacheService.getCategories().length,
      });

      const humanErrorMessage = formatErrorMessageForHuman(processingError, getHumanReadableTimestamp());
      await this.messagingGateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        humanErrorMessage
      );
    } finally {
      // Clear typing presence indicator
      await this.messagingGateway.clearTypingPresence(event.channel, event.chatIdentifier);
    }
  }
}
