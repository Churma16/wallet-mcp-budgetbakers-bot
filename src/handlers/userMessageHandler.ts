import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import {
  FinancialAiProvider,
  ExtractedFinancialIntent,
  SemanticToolBoundary,
  SemanticToolAuthorizationContext,
  createSemanticToolProposalFromFinancialIntent,
} from '../services/ai/index.js';
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
} from '../actions/index.js';
import {
  detectFastPathAction,
  FastPathTransactionHistoryAction,
  detectPendingConfirmationAction,
  detectReconciliationAction,
} from '../utils/fastPathIntentDetector.js';
import { normalizeTransactionHistoryFilters } from '../utils/transactionHistoryFilterNormalizer.js';
import {
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
} from '../utils/humanResponseFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';
import { WalletRecordPreparationService } from '../services/walletRecordPreparationService.js';
import { TransactionHistoryQueryOptions } from '../types/walletTypes.js';

export type SemanticToolAuthorizationResolver = (
  event: IncomingUserMessageEvent
) => SemanticToolAuthorizationContext;

/**
 * Messaging adapters own sender authorization and fail closed before they emit
 * an IncomingUserMessageEvent. The semantic layer receives only this
 * application-owned decision; the model cannot set or override it.
 */
function resolveGatewayAuthorization(
  event: IncomingUserMessageEvent
): SemanticToolAuthorizationContext {
  return {
    isAuthorized: true,
    source: `${event.channel}-gateway-authorization`,
  };
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

function hasPendingTransactions(manager: PendingTransactionService): boolean {
  const managerWithPendingQueries = manager as Partial<PendingTransactionService>;
  return typeof managerWithPendingQueries.hasPendingTransactions === 'function'
    ? managerWithPendingQueries.hasPendingTransactions.call(manager)
    : false;
}

/**
 * Keep canonical history queries on the fast path. Only an otherwise valid
 * history command with a category that deterministic resolution cannot find,
 * or purchase/subscription description intent queries (such as "beli wifi" or
 * "langganan wifi") that must not be hijacked by broad category matches (e.g. "Internet & Wifi"),
 * may use the guarded semantic fallback. True category intent cases (such as "beli obat")
 * resolve cleanly and remain on the fast path.
 */
export function shouldDeferHistoryCategoryToSemanticResolver(
  fastPathAction: ReturnType<typeof detectFastPathAction>,
  availableCategories: ReturnType<WalletCacheService['getCategories']>,
  referenceDate: Date,
  rawMessageText?: string
): boolean {
  if (
    !fastPathAction ||
    typeof fastPathAction !== 'object' ||
    fastPathAction.type !== 'TRANSACTION_HISTORY'
  ) {
    return false;
  }

  const historyAction = fastPathAction as FastPathTransactionHistoryAction;
  if (!historyAction.options.categoryName || historyAction.options.searchQuery) {
    return false;
  }

  const normalizedCategoryHint = historyAction.options.categoryName.trim().toLowerCase();

  // Known description intent keywords from purchase or subscription queries that
  // must bypass deterministic category capture (e.g. preventing "wifi" from matching
  // an "Internet & Wifi" category) and enter the guarded description-search path.
  const isPurchaseOrSubscriptionIntent =
    historyAction.options.recordType === 'expense' ||
    (rawMessageText ? /\b(?:beli|pembelian|bayar|pembayaran|langganan)\b/i.test(rawMessageText) : false);

  if (isPurchaseOrSubscriptionIntent) {
    const KNOWN_PURCHASE_DESCRIPTION_KEYWORDS = new Set([
      'wifi',
      'wi-fi',
      'vps',
      'ai',
      'hangry',
    ]);
    if (KNOWN_PURCHASE_DESCRIPTION_KEYWORDS.has(normalizedCategoryHint)) {
      return true;
    }
  }

  if (rawMessageText) {
    const lowerRaw = rawMessageText.toLowerCase();
    if (
      /\b(?:beli|pembelian|bayar|pembayaran|langganan)\s+(?:wifi|wi-fi|vps|ai)\b/i.test(lowerRaw) ||
      /\bmakan\s+hangry\b/i.test(lowerRaw)
    ) {
      return true;
    }
  }

  const resolution = normalizeTransactionHistoryFilters(
    historyAction.options,
    [],
    availableCategories,
    referenceDate
  );
  return resolution.unresolvedFilters.some(
    issue => issue.filterKey === 'category' && issue.reason === 'NOT_FOUND'
  );
}

export class UserMessageHandler {
  private readonly accountClarificationHandler: AccountClarificationHandler;
  private readonly financialActionExecutor: FinancialActionExecutor;
  private readonly recordPreparationService: WalletRecordPreparationService;
  private readonly financialActionRegistry: FinancialActionRegistry;
  private readonly semanticToolBoundary: SemanticToolBoundary;
  private readonly semanticToolAuthorizationResolver: SemanticToolAuthorizationResolver;

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
    accountClarificationHandler?: AccountClarificationHandler,
    semanticToolBoundary?: SemanticToolBoundary,
    semanticToolAuthorizationResolver?: SemanticToolAuthorizationResolver
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
    this.semanticToolBoundary = semanticToolBoundary || new SemanticToolBoundary();
    this.semanticToolAuthorizationResolver =
      semanticToolAuthorizationResolver || resolveGatewayAuthorization;

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

    await this.messagingGateway.sendTypingPresence(event.channel, event.chatIdentifier);

    try {
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        hasPendingTransactions(this.pendingTransactionManager)
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

      // Explicit reconciliation phrases are a bounded protocol. They may be parsed even when
      // the referenced item has already been resolved so the handler can return a deterministic
      // not-found/already-resolved response. Free-form aliases never enter this path.
      if (
        event.messageType === 'text' &&
        event.textPayload &&
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

      if (
        event.messageType === 'text' &&
        event.textPayload &&
        hasPendingTransactions(this.pendingTransactionManager)
      ) {
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

      let deferredHistoryFastPathOptions: FastPathTransactionHistoryAction['options'] | undefined;

      if (event.messageType === 'text' && event.textPayload) {
        const fastPathAction = detectFastPathAction(event.textPayload);
        if (fastPathAction) {
          const cachedCategories = this.walletCacheService.getCategories();
          if (shouldDeferHistoryCategoryToSemanticResolver(
            fastPathAction,
            cachedCategories,
            requestReferenceInstant,
            event.textPayload
          )) {
            deferredHistoryFastPathOptions = (fastPathAction as FastPathTransactionHistoryAction).options;
          } else {
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
      }

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

      const semanticToolProposal = createSemanticToolProposalFromFinancialIntent(extractedIntent);
      if (semanticToolProposal) {
        const boundaryDecision = this.semanticToolBoundary.evaluate({
          proposal: semanticToolProposal,
          authorization: this.semanticToolAuthorizationResolver(event),
          event,
          availableAccountList: cachedAccounts,
          availableCategoryList: cachedCategories,
          processingStartTimestamp,
          requestReferenceInstant,
        });

        if (boundaryDecision.accepted) {
          if (!this.financialActionRegistry.hasHandler(boundaryDecision.context.action)) {
            applicationLogger.error(
              `[SemanticToolBoundary] Accepted action has no registered handler: ${boundaryDecision.context.action}.`
            );
            return;
          }

          if (deferredHistoryFastPathOptions) {
            if (boundaryDecision.context.action !== 'TRANSACTION_HISTORY') {
              // Deterministic parsing has already established a history
              // request. Semantic fallback may resolve its category only; it
              // cannot broaden authority into a different financial action.
              applicationLogger.warn(
                `Semantic history resolution proposed ${boundaryDecision.context.action}; action was not executed.`
              );
              const rawCategory = deferredHistoryFastPathOptions.categoryName || event.textPayload || '';
              const unresolvedMessage = getDictionary().history.unresolvedFilters([
                {
                  filterKey: 'category',
                  rawValue: rawCategory,
                  reason: 'NOT_FOUND',
                  message: `Category "${rawCategory}" not found in Wallet cache.`,
                },
              ]);
              await this.messagingGateway.sendMessage(
                event.channel,
                event.chatIdentifier,
                unresolvedMessage
              );
              return;
            } else {
              const semanticCategoryId = boundaryDecision.context.queryOptions?.categoryId;
              const semanticSearchQuery = boundaryDecision.context.queryOptions?.searchQuery;
              if (!semanticCategoryId && !semanticSearchQuery) {
                // A deferred request contains an unresolved category concept. It
                // must never degrade into an unfiltered history request merely
                // because the semantic provider omitted both category and search selection.
                applicationLogger.warn(
                  'Semantic category resolution omitted categoryId and searchQuery; history query was not executed.'
                );
                const rawCategory = deferredHistoryFastPathOptions.categoryName || event.textPayload || '';
                const unresolvedMessage = getDictionary().history.unresolvedFilters([
                  {
                    filterKey: 'category',
                    rawValue: rawCategory,
                    reason: 'NOT_FOUND',
                    message: `Category "${rawCategory}" not found in Wallet cache.`,
                  },
                ]);
                await this.messagingGateway.sendMessage(
                  event.channel,
                  event.chatIdentifier,
                  unresolvedMessage
                );
                return;
              } else {
                const semanticRecordType = boundaryDecision.context.queryOptions?.recordType;
                const mergedRecordType = deferredHistoryFastPathOptions.recordType || semanticRecordType;
                const mergedQueryOptions: TransactionHistoryQueryOptions = {
                  ...deferredHistoryFastPathOptions,
                  ...(mergedRecordType ? { recordType: mergedRecordType } : {}),
                  ...(semanticCategoryId ? { categoryId: semanticCategoryId } : {}),
                  ...(boundaryDecision.context.queryOptions?.categoryGroup
                    ? { categoryGroup: boundaryDecision.context.queryOptions.categoryGroup }
                    : {}),
                  ...(boundaryDecision.context.queryOptions?.isGroupQuery !== undefined
                    ? { isGroupQuery: boundaryDecision.context.queryOptions.isGroupQuery }
                    : {}),
                  ...(semanticSearchQuery ? { searchQuery: semanticSearchQuery } : {}),
                };
                delete mergedQueryOptions.categoryName;
                await this.financialActionRegistry.execute({
                  ...boundaryDecision.context,
                  queryOptions: mergedQueryOptions,
                });
                return;
              }
            }
          } else {
            await this.financialActionRegistry.execute(boundaryDecision.context);
            return;
          }
        } else {
          applicationLogger.warn(
            `[SemanticToolBoundary] Rejected ${semanticToolProposal.tool}: ${boundaryDecision.code}.`
          );
          applicationLogger.fileDetail('security', 'Rejected Semantic Tool Proposal', {
            tool: semanticToolProposal.tool,
            rejectionCode: boundaryDecision.code,
            rejectionReason: boundaryDecision.reason,
            channel: event.channel,
            senderIdentifier: event.senderIdentifier,
          });

          if (deferredHistoryFastPathOptions) {
            const rawCategory = deferredHistoryFastPathOptions.categoryName || event.textPayload || '';
            const unresolvedMessage = getDictionary().history.unresolvedFilters([
              {
                filterKey: 'category',
                rawValue: rawCategory,
                reason: 'NOT_FOUND',
                message: `Category "${rawCategory}" not found in Wallet cache.`,
              },
            ]);
            await this.messagingGateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              unresolvedMessage
            );
            return;
          }

          if (semanticToolProposal.tool === 'propose_transaction') {
            await this.messagingGateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              getDictionary().errors.validationRejected(
                getDictionary().errors.accountResolutionFallback
              )
            );
            return;
          }
        }
      } else if (deferredHistoryFastPathOptions && extractedIntent.action !== 'GENERAL_REPLY') {
        applicationLogger.warn(
          'Semantic fallback for deferred history failed to provide an actionable tool proposal; history query was not executed.'
        );
        const rawCategory = deferredHistoryFastPathOptions.categoryName || event.textPayload || '';
        const unresolvedMessage = getDictionary().history.unresolvedFilters([
          {
            filterKey: 'category',
            rawValue: rawCategory,
            reason: 'NOT_FOUND',
            message: `Category "${rawCategory}" not found in Wallet cache.`,
          },
        ]);
        await this.messagingGateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          unresolvedMessage
        );
        return;
      }

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
      await this.messagingGateway.clearTypingPresence(event.channel, event.chatIdentifier);
    }
  }
}
