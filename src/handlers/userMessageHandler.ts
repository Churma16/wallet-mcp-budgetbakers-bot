import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import { FinancialAiProvider, ExtractedFinancialIntent } from '../services/ai/index.js';
import { validateReceiptFinancialIntentEnvelope } from '../services/ai/jsonExtractionHelper.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { AccountClarificationHandler } from './accountClarificationHandler.js';
import { PendingActionHandler } from './pendingActionHandler.js';
import { FastPathHandler } from './fastPathHandler.js';
import { FinancialActionExecutor } from '../services/financialActionExecutor.js';
import {
  FinancialActionRegistry,
  createDefaultFinancialActionRegistry,
  FinancialActionContext,
} from '../actions/index.js';
import {
  detectFastPathAction,
  detectPendingConfirmationAction,
  detectReconciliationAction,
} from '../utils/fastPathIntentDetector.js';
import {
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
} from '../utils/humanResponseFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';
import { WalletRecordPreparationService } from '../services/walletRecordPreparationService.js';

/**
 * Builds a strongly-typed FinancialActionContext from an extracted AI intent.
 * Ensures CREATE_RECORD actions cannot reach the registry unless records are present and non-empty,
 * allowing incomplete intents (e.g. text queries with records: [] or undefined) to fall through safely
 * to the default explanation or guidance response.
 */
function buildAiFinancialActionContext(
  intent: ExtractedFinancialIntent,
  event: IncomingUserMessageEvent,
  processingStartTimestamp: number,
  requestReferenceInstant: Date
): FinancialActionContext | null {
  if (intent.action === 'CREATE_RECORD') {
    if (intent.records && intent.records.length > 0) {
      return {
        action: 'CREATE_RECORD',
        event,
        records: intent.records,
        processingStartTimestamp,
        routingSource: 'ai',
        requestReferenceInstant,
      };
    }
    return null;
  }

  if (intent.action === 'CHECK_BALANCE') {
    return {
      action: 'CHECK_BALANCE',
      event,
      processingStartTimestamp,
      routingSource: 'ai',
    };
  }

  if (intent.action === 'CHECK_BUDGET') {
    return {
      action: 'CHECK_BUDGET',
      event,
      processingStartTimestamp,
      routingSource: 'ai',
    };
  }

  return null;
}

/**
 * Reconciliation is a finite user protocol, not natural-language interpretation.
 * Keep routing constrained to the explicit commands shown by the bot. The detector
 * still supports legacy aliases for direct callers, but free-form chat must never
 * reach it through this path.
 */
function isExplicitReconciliationProtocolCommand(messageText: string): boolean {
  return /^(?:sudah\s+ada|belum\s+ada|already\s+exists?|not\s+there)(?:\s+#?\d+)?$/i.test(
    messageText.trim()
  );
}

export class UserMessageHandler {
  private readonly accountClarificationHandler: AccountClarificationHandler;
  private readonly financialActionExecutor: FinancialActionExecutor;
  private readonly recordPreparationService: WalletRecordPreparationService;
  private readonly financialActionRegistry: FinancialActionRegistry;

  constructor(
    private readonly messagingGateway: MessagingGatewayService,
    private readonly pendingTransactionManager: PendingTransactionService,
    private readonly pendingActionHandler: PendingActionHandler,
    private readonly fastPathHandler: FastPathHandler,
    private readonly financialAiProvider: FinancialAiProvider,
    private readonly walletCacheService: WalletCacheService,
    private readonly walletMcpClient: WalletMcpClientService,
    financialActionExecutor?: FinancialActionExecutor,
    recordPreparationService?: WalletRecordPreparationService,
    financialActionRegistry?: FinancialActionRegistry,
    accountClarificationHandler?: AccountClarificationHandler
  ) {
    this.financialActionExecutor =
      financialActionExecutor ||
      new FinancialActionExecutor(
        walletMcpClient,
        walletCacheService,
        messagingGateway
      );
    this.recordPreparationService =
      recordPreparationService ||
      new WalletRecordPreparationService(walletCacheService, walletMcpClient);
    this.accountClarificationHandler =
      accountClarificationHandler ||
      new AccountClarificationHandler(
        pendingTransactionManager,
        walletMcpClient,
        walletCacheService,
        messagingGateway,
        this.recordPreparationService
      );

    if (financialActionRegistry) {
      this.financialActionRegistry = financialActionRegistry;
    } else {
      this.financialActionRegistry = createDefaultFinancialActionRegistry({
        financialActionExecutor: this.financialActionExecutor,
        walletMcpClient: this.walletMcpClient,
        walletCacheService: this.walletCacheService,
        messagingGateway: this.messagingGateway,
        recordPreparationService: this.recordPreparationService,
        accountClarificationHandler: this.accountClarificationHandler,
      });
    }
  }

  /**
   * Primary entry point for all incoming user messages (WhatsApp & Telegram)
   */
  public async handleIncomingUserMessage(event: IncomingUserMessageEvent): Promise<void> {
    const processingStartTimestamp = Date.now();
    const requestReferenceInstant = new Date(processingStartTimestamp);
    applicationLogger.chat(
      `[${event.channel.toUpperCase()}] ${event.messageType} message received.`
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
      // 0. Generic standard-pending commands (LATEST / ALL) must remain reachable even when an
      // unrelated account-clarification draft exists. A bare `batal` / `cancel` is the exception:
      // when both workflows have a PENDING item, it is ambiguous and must not mutate either one.
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        this.pendingTransactionManager.hasPendingTransactions()
      ) {
        const genericPendingIntent = detectPendingConfirmationAction(event.textPayload);
        if (
          genericPendingIntent &&
          (genericPendingIntent.targetScope === 'LATEST' || genericPendingIntent.targetScope === 'ALL')
        ) {
          const isBareCancellation =
            genericPendingIntent.actionType === 'REJECT' &&
            genericPendingIntent.targetScope === 'LATEST' &&
            /^(?:batal|cancel)$/i.test(event.textPayload.trim());

          if (isBareCancellation) {
            const manager = this.pendingTransactionManager as Partial<PendingTransactionService>;
            if (
              typeof manager.getLatestPendingAccountSelectionDraft === 'function' &&
              typeof manager.getPendingAccountSelectionDraftState === 'function' &&
              typeof manager.getAllPendingTransactions === 'function' &&
              typeof manager.getPendingTransactionState === 'function'
            ) {
              const clarificationDraft = manager.getLatestPendingAccountSelectionDraft(
                event.channel,
                event.chatIdentifier,
                event.senderIdentifier
              );
              const pendingStandardItems = manager.getAllPendingTransactions().filter(
                item => manager.getPendingTransactionState?.(item.ticketId) === 'PENDING'
              );
              const standardPendingItem = pendingStandardItems[pendingStandardItems.length - 1];
              const clarificationIsPending = Boolean(
                clarificationDraft &&
                manager.getPendingAccountSelectionDraftState(clarificationDraft.ticketId) === 'PENDING'
              );

              if (clarificationDraft && clarificationIsPending && standardPendingItem) {
                const dictionary = getDictionary();
                const disambiguationMessage = dictionary.languageCode === 'id'
                  ? `⚠️ Ada dua transaksi yang bisa dibatalkan. Tidak ada yang dibatalkan.\nBalas *batal #${clarificationDraft.ticketId}* untuk membatalkan draft klarifikasi, atau *batal #${standardPendingItem.ticketId}* untuk membatalkan tiket transaksi.`
                  : `⚠️ Two transactions can be cancelled. Nothing was cancelled.\nReply *cancel #${clarificationDraft.ticketId}* to cancel the clarification draft, or *cancel #${standardPendingItem.ticketId}* to cancel the pending transaction ticket.`;
                await this.messagingGateway.sendMessage(
                  event.channel,
                  event.chatIdentifier,
                  disambiguationMessage
                );
                applicationLogger.info(
                  `[${event.channel.toUpperCase()}] Bare cancellation was ambiguous between clarification #${clarificationDraft.ticketId} and pending ticket #${standardPendingItem.ticketId}; no state changed.`
                );
                return;
              }
            }
          }

          const handled = await this.pendingActionHandler.handlePendingAction(
            event,
            genericPendingIntent,
            processingStartTimestamp
          );
          if (handled) {
            return;
          }
        }
      }

      // 1. Reconciliation is only active while an uncertain item exists, and only for the
      // explicit finite command grammar shown in the uncertain-outcome response.
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        this.pendingTransactionManager.hasUncertainTransactions() &&
        isExplicitReconciliationProtocolCommand(event.textPayload)
      ) {
        const reconciliationIntent = detectReconciliationAction(event.textPayload);
        if (reconciliationIntent) {
          const handled = await this.pendingActionHandler.handleReconciliationAction(
            event,
            reconciliationIntent,
            processingStartTimestamp
          );
          if (handled) {
            return;
          }
        }
      }

      // 2. Account-clarification drafts consume free-form account replies before other routing.
      if (event.messageType === 'text' && event.textPayload) {
        const handled = await this.accountClarificationHandler.handlePendingAccountSelectionReply(
          event,
          event.textPayload,
          processingStartTimestamp
        );
        if (handled) {
          return;
        }
      }

      // 2. Pending confirmation handler (checks if user is confirming or canceling a pending ticket)
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

      // 3. Fast-path intent classifier: Skip AI entirely for simple balance/budget/help queries (0 tokens used)
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

      // 4. AI Intent Extraction (Gemini / Ollama / Vision)
      const cachedAccounts = this.walletCacheService.getAccounts();
      const cachedCategories = this.walletCacheService.getCategories();

      let extractedIntent: ExtractedFinancialIntent;

      if (event.messageType === 'image' && event.imageBuffer) {
        applicationLogger.ai(`Processing receipt photo with ${this.financialAiProvider.providerName.toUpperCase()} Vision...`);
        const rawExtractedIntent = await this.financialAiProvider.processImageMessage(
          event.imageBuffer,
          event.imageMimeType || 'image/jpeg',
          event.textPayload || '',
          cachedAccounts,
          cachedCategories,
          requestReferenceInstant
        );
        extractedIntent = validateReceiptFinancialIntentEnvelope(rawExtractedIntent);
      } else {
        applicationLogger.ai(`Analyzing message intent with ${this.financialAiProvider.providerName.toUpperCase()}...`);
        extractedIntent = await this.financialAiProvider.processTextMessage(
          event.textPayload || '',
          cachedAccounts,
          cachedCategories,
          requestReferenceInstant
        );
      }

      applicationLogger.ai(`Decision: ${extractedIntent.action}`);
      applicationLogger.fileDetail('ai', 'Parsed Financial Intent Result', {
        action: extractedIntent.action,
        explanation: extractedIntent.explanation,
        records: extractedIntent.records,
      });

      // 5. Route actions based on AI analysis
      if (
        event.messageType === 'image' &&
        extractedIntent.action === 'CREATE_RECORD' &&
        (!extractedIntent.records || extractedIntent.records.length === 0)
      ) {
        applicationLogger.warn('Receipt extraction returned CREATE_RECORD with 0 records.');
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          getDictionary().errors.receiptExtractionFailed(getHumanReadableTimestamp())
        );
        return;
      }

      const financialActionContext = buildAiFinancialActionContext(
        extractedIntent,
        event,
        processingStartTimestamp,
        requestReferenceInstant
      );

      if (financialActionContext && this.financialActionRegistry.hasHandler(financialActionContext.action)) {
        await this.financialActionRegistry.execute(financialActionContext);
        return;
      }

      // Default: general reply or guidance
      if (event.messageType === 'image') {
        const receiptReplyMessage = extractedIntent.explanation?.trim() ||
          getDictionary().errors.receiptExtractionFailed(getHumanReadableTimestamp());
        await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, receiptReplyMessage);
        const processingDurationMs = Date.now() - processingStartTimestamp;
        applicationLogger.success(
          `[${event.channel.toUpperCase()}] Sent receipt extraction response (${processingDurationMs}ms).`
        );
        return;
      }

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
      const errorName = processingError instanceof Error ? processingError.name : 'UnknownError';
      applicationLogger.error(`Error while processing user message (${errorName}).`);

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

      const humanErrorMessage = formatErrorMessageForHuman(
        processingError,
        getHumanReadableTimestamp(),
        undefined,
        { isImageMessage: event.messageType === 'image' }
      );
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
