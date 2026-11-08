import { AppContext } from './context.js';
import {
  IncomingUserMessageEvent,
  PushNotificationPayload,
  SentMessageReceipt,
} from '../gateway/index.js';
import { createTelegramRescanInlineKeyboard } from '../gateway/telegramMenu.js';
import { EmailTransactionDetectedEvent } from '../email/index.js';
import {
  ExtractedFinancialIntent,
  SemanticToolBoundary,
  SemanticToolAuthorizationContext,
  createSemanticToolProposalFromFinancialIntent,
  validateReceiptFinancialIntentEnvelope,
  detectFastPathAction,
  FastPathTransactionHistoryAction,
  detectPendingConfirmationAction,
  detectReconciliationAction,
} from '../brain/index.js';
import { FINANCIAL_ACTION_TYPES } from '../brain/constants.js';
import { PendingTransactionService } from './pending.js';
import { PendingActionHandler } from './handlers/pendingHandler.js';
import { FastPathHandler } from './handlers/fastPathHandler.js';
import { FinancialActionExecutor } from './executor.js';
import { AccountClarificationHandler } from './handlers/accountClarificationHandler.js';
import { CategoryClarificationHandler } from './handlers/categoryClarificationHandler.js';
import { DeleteRecordHandler } from './handlers/deleteRecordHandler.js';
import { ModifyRecordHandler } from './handlers/modifyRecordHandler.js';
import {
  ReconciliationHandler,
  isReconciliationCommand,
} from './handlers/reconciliationHandler.js';
import {
  FinancialActionRegistry,
  createDefaultFinancialActionRegistry,
  DefaultFinancialActionRegistryDependencies,
} from './handlers/financialActionRegistry.js';
import { coordinateInboundTransactionCandidate } from './inboundCoordinator.js';
import { NotificationTransactionHandler } from './handlers/inboundHandlers.js';
import { InboundRescanService, parseRescanDurationMinutes, type InboundRescanStage } from './inboundRescanService.js';
import { formatInboundRescanResponse } from '../wallet/formatters/inboundRescanFormatter.js';
import { TransactionCorrelationEngine } from '../email/index.js';
import {
  normalizeTransactionHistoryFilters,
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
  TransactionHistoryQueryOptions,
  WalletRecordPreparationService,
} from '../wallet/index.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../lib/logger.js';
import { ModelFallbackProgressTracker } from './modelFallbackProgressTracker.js';

export {
  FinancialActionRegistry,
  createDefaultFinancialActionRegistry,
  DefaultFinancialActionRegistryDependencies,
};

export type SemanticToolAuthorizationResolver = (
  event: IncomingUserMessageEvent
) => SemanticToolAuthorizationContext;

function resolveGatewayAuthorization(
  event: IncomingUserMessageEvent
): SemanticToolAuthorizationContext {
  return {
    isAuthorized: true,
    source: `${event.channel}-gateway-authorization`,
  };
}

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

export function shouldDeferHistoryCategoryToSemanticResolver(
  fastPathAction: ReturnType<typeof detectFastPathAction>,
  availableCategories: ReturnType<AppContext['wallet']['cache']['getCategories']>,
  referenceDate: Date
): boolean {
  if (
    !fastPathAction ||
    typeof fastPathAction !== 'object' ||
    fastPathAction.type !== FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY
  ) {
    return false;
  }

  const historyAction = fastPathAction as FastPathTransactionHistoryAction;
  if (!historyAction.options.categoryName || historyAction.options.searchQuery) {
    return false;
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

/**
 * Optional handler and service overrides for MessageDispatcher dependency injection.
 */
export interface DispatcherOverrides {
  pendingActionHandler?: PendingActionHandler;
  fastPathHandler?: FastPathHandler;
  financialActionExecutor?: FinancialActionExecutor;
  recordPreparationService?: AppContext['wallet']['recordPreparation'];
  financialActionRegistry?: FinancialActionRegistry;
  accountClarificationHandler?: AccountClarificationHandler;
  categoryClarificationHandler?: CategoryClarificationHandler;
  semanticToolBoundary?: SemanticToolBoundary;
  semanticToolAuthorizationResolver?: SemanticToolAuthorizationResolver;
  categoryResolutionMode?: 'ask' | 'auto';
  deleteRecordHandler?: DeleteRecordHandler;
  modifyRecordHandler?: ModifyRecordHandler;
  notificationHandler?: NotificationTransactionHandler;
  inboundRescanService?: InboundRescanService;
  reconciliationHandler?: ReconciliationHandler;
}

/**
 * Linear message and event dispatcher coordinating incoming messaging ingress,
 * clarification dialogues, fast-path shortcuts, AI intent extraction, and ledger actions.
 */
export class MessageDispatcher {
  public readonly accountClarificationHandler: AccountClarificationHandler;
  public readonly categoryClarificationHandler: CategoryClarificationHandler;
  public readonly financialActionExecutor: FinancialActionExecutor;
  public readonly pendingActionHandler: PendingActionHandler;
  public readonly fastPathHandler: FastPathHandler;
  public readonly financialActionRegistry: FinancialActionRegistry;
  public readonly deleteRecordHandler: DeleteRecordHandler;
  public readonly modifyRecordHandler: ModifyRecordHandler;
  public readonly reconciliationHandler: ReconciliationHandler;
  public readonly semanticToolBoundary: SemanticToolBoundary;
  public readonly semanticToolAuthorizationResolver: SemanticToolAuthorizationResolver;
  public readonly notificationHandler: NotificationTransactionHandler;
  public readonly inboundRescanService: InboundRescanService;

  public readonly context: AppContext;
  public readonly recordPreparationService?: WalletRecordPreparationService;

  constructor(
    context: AppContext,
    overrides?: Partial<DispatcherOverrides>
  ) {
    this.context = context;

    this.financialActionExecutor =
      overrides?.financialActionExecutor ||
      new FinancialActionExecutor(
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        context.wallet.history,
        context.wallet.summary
      );

    const recordPrep =
      overrides?.recordPreparationService ||
      context.wallet?.recordPreparation ||
      (context.wallet?.cache && context.wallet?.client
        ? new WalletRecordPreparationService(context.wallet.cache, context.wallet.client)
        : ({
            prepareRecordsForDispatch: async (records: any) => records,
          } as any));
    this.recordPreparationService = recordPrep;

    this.accountClarificationHandler =
      overrides?.accountClarificationHandler ||
      new AccountClarificationHandler(
        context.pending,
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        recordPrep,
        context.brain?.categoryContext,
        context.brain?.accountClarification
      );

    this.categoryClarificationHandler =
      overrides?.categoryClarificationHandler ||
      new CategoryClarificationHandler(
        context.pending,
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        recordPrep,
        context.brain?.categoryContext,
        context.brain?.categoryClarification
      );

    this.pendingActionHandler =
      overrides?.pendingActionHandler ||
      new PendingActionHandler(
        context.pending,
        context.wallet.client,
        context.gateway,
        () => context.email?.listener ?? null,
        context.wallet.cache,
        context.wallet.transactionMessages,
        context.brain?.categoryContext,
        context.brain?.provider,
        context.wallet.enrichmentPool
      );

    this.financialActionRegistry =
      overrides?.financialActionRegistry ||
      createDefaultFinancialActionRegistry({
        financialActionExecutor: this.financialActionExecutor,
        walletMcpClient: context.wallet.client,
        walletCacheService: context.wallet.cache,
        messagingGateway: context.gateway,
        recordPreparationService: recordPrep,
        accountClarificationHandler: this.accountClarificationHandler,
        categoryClarificationHandler: this.categoryClarificationHandler,
        categoryContextService: context.brain?.categoryContext,
        categoryResolutionMode: overrides?.categoryResolutionMode,
        categoryClarificationConversationService: context.brain?.categoryClarification,
        pendingTransactionService: context.pending,
        transactionMessageStore: context.wallet?.transactionMessages,
      });

    this.deleteRecordHandler =
      overrides?.deleteRecordHandler ||
      new DeleteRecordHandler(
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        context.wallet.transactionMessages,
        context.pending
      );

    this.modifyRecordHandler =
      overrides?.modifyRecordHandler ||
      new ModifyRecordHandler(
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        context.wallet.transactionMessages,
        context.brain?.categoryContext,
        context.brain?.provider
      );

    this.fastPathHandler =
      overrides?.fastPathHandler ||
      new FastPathHandler(
        context.wallet.client,
        context.wallet.cache,
        context.gateway,
        context.wallet.history,
        context.wallet.summary,
        this.financialActionExecutor,
        this.financialActionRegistry,
        context.pending
      );

    this.semanticToolBoundary =
      overrides?.semanticToolBoundary ||
      context.brain?.semanticBoundary ||
      new SemanticToolBoundary();

    this.semanticToolAuthorizationResolver =
      overrides?.semanticToolAuthorizationResolver || resolveGatewayAuthorization;

    this.notificationHandler =
      overrides?.notificationHandler ||
      new NotificationTransactionHandler(
        context.brain.provider,
        context.wallet.cache,
        context.pending,
        context.gateway,
        context.config?.defaultCurrency || 'IDR',
        context.email?.correlation || new TransactionCorrelationEngine(),
        context.wallet?.client,
        context.wallet?.transactionMessages,
        context.wallet?.enrichmentPool,
        context.notificationStore
      );

    this.inboundRescanService =
      overrides?.inboundRescanService ||
      new InboundRescanService({
        notificationStore: context.notificationStore,
        notificationHandler: this.notificationHandler,
        emailListener: () => context.email?.listener,
        pendingTransactionManager: context.pending,
        correlationService: context.email?.correlation || new TransactionCorrelationEngine(),
        walletCacheService: context.wallet.cache,
        messagingGateway: context.gateway,
        walletMcpClient: context.wallet?.client,
        transactionMessageStore: context.wallet?.transactionMessages,
        enrichmentPoolService: context.wallet?.enrichmentPool,
        defaultCurrency: context.config?.defaultCurrency || 'IDR',
      });

    this.reconciliationHandler =
      overrides?.reconciliationHandler ||
      new ReconciliationHandler({
        gateway: context.gateway,
        walletClient: context.wallet.client,
        walletCache: context.wallet.cache,
        pendingTransactionManager: context.pending,
        brainProvider: context.brain.provider,
      });
  }

  /**
   * Primary entry point for all incoming user messages (WhatsApp, Telegram, and Console).
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

    await this.context.gateway.sendTypingPresence(event.channel, event.chatIdentifier);

    try {
      // 0. Explicit /reconciliation statement audit command
      if (isReconciliationCommand(event.textPayload)) {
        const handledRecon = await this.reconciliationHandler.handleReconciliationRequest(event);
        if (handledRecon) {
          return;
        }
      }

      // 0a. Explicit /recon_spawn command triggered from inline button callback
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        event.textPayload.startsWith('/recon_spawn ')
      ) {
        const sessionId = event.textPayload.slice('/recon_spawn '.length).trim();
        const handledSpawn = await this.reconciliationHandler.handleSpawnMissingRequest(event, sessionId);
        if (handledSpawn) {
          return;
        }
      }

      // 0a. Explicit transaction delete confirmation or cancellation commands (e.g. from inline button callback)
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        this.deleteRecordHandler.isDeleteConfirmationCommand(event.textPayload)
      ) {
        const handled = await this.deleteRecordHandler.handleDeleteConfirmationCommand(event);
        if (handled) {
          return;
        }
      }

      if (
        event.messageType === 'text' &&
        event.textPayload &&
        this.deleteRecordHandler.isDeleteCancellationCommand(event.textPayload)
      ) {
        const handled = await this.deleteRecordHandler.handleDeleteCancellationCommand(event);
        if (handled) {
          return;
        }
      }

      // 0b. Conversational reply to an active deletion confirmation prompt (e.g. "ya", "batal")
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        this.deleteRecordHandler.hasActiveConfirmation(event.chatIdentifier)
      ) {
        const handledConversational = await this.deleteRecordHandler.handleConversationalReply(event);
        if (handledConversational) {
          return;
        }
      }

      // 0. Reply-to-message transaction deletion (e.g. "hapus", "delete") or edit command (e.g. "c: Makan t: #jajan n: Kopi" or "e c:...")
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        event.replyToMessageId
      ) {
        const handledDelete = await this.deleteRecordHandler.handleDeleteRecordReply(
          event,
          processingStartTimestamp
        );
        if (handledDelete) {
          return;
        }

        const handledEdit = await this.modifyRecordHandler.handleModifyRecordReply(
          event,
          processingStartTimestamp
        );
        if (handledEdit) {
          return;
        }
      }

      // 1. Pending cancellation disambiguation
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        hasPendingTransactions(this.context.pending)
      ) {
        let genericPendingIntent = detectPendingConfirmationAction(event.textPayload);
        if (event.replyToMessageId) {
          const pendingManager = this.context.pending as PendingTransactionService;
          if (typeof pendingManager.getAllPendingTransactions === 'function') {
            const matchedPendingItem = pendingManager.getAllPendingTransactions().find(
              item =>
                item.notificationMessageIds &&
                Object.values(item.notificationMessageIds).includes(event.replyToMessageId!)
            );
            if (matchedPendingItem && genericPendingIntent && genericPendingIntent.targetScope === 'LATEST') {
              genericPendingIntent.targetScope = matchedPendingItem.ticketId;
            }
          }
        }
        if (
          genericPendingIntent &&
          (genericPendingIntent.targetScope === 'LATEST' || genericPendingIntent.targetScope === 'ALL')
        ) {
          const isBareCancellation =
            genericPendingIntent.actionType === 'REJECT' &&
            genericPendingIntent.targetScope === 'LATEST' &&
            /^(?:batal|cancel)$/i.test(event.textPayload.trim());

          if (isBareCancellation) {
            const manager = this.context.pending as Partial<PendingTransactionService>;
            const hasRequiredMethods =
              typeof manager.getLatestPendingAccountSelectionDraft === 'function' &&
              typeof manager.getPendingAccountSelectionDraftState === 'function' &&
              typeof manager.getAllPendingTransactions === 'function' &&
              typeof manager.getPendingTransactionState === 'function';

            if (hasRequiredMethods) {
              const accountDraft = manager.getLatestPendingAccountSelectionDraft?.(
                event.channel,
                event.chatIdentifier,
                event.senderIdentifier
              );
              const categoryDraft = manager.getLatestPendingCategorySelectionDraft?.(
                event.channel,
                event.chatIdentifier,
                event.senderIdentifier
              );

              let clarificationDraft = accountDraft;
              let clarificationIsPending = Boolean(
                clarificationDraft &&
                (this.accountClarificationHandler?.isCancellablePreDispatch
                  ? this.accountClarificationHandler.isCancellablePreDispatch(clarificationDraft.ticketId)
                  : manager.getPendingAccountSelectionDraftState?.(clarificationDraft.ticketId) === 'PENDING')
              );

              if (categoryDraft && (!accountDraft || categoryDraft.ticketId > accountDraft.ticketId)) {
                clarificationDraft = categoryDraft as any;
                clarificationIsPending = Boolean(
                  categoryDraft &&
                  (this.categoryClarificationHandler?.isCancellablePreDispatch
                    ? this.categoryClarificationHandler.isCancellablePreDispatch(categoryDraft.ticketId)
                    : manager.getPendingCategorySelectionDraftState?.(categoryDraft.ticketId) === 'PENDING')
                );
              }

              const pendingStandardItems = (manager.getAllPendingTransactions?.() || []).filter(
                item => manager.getPendingTransactionState?.(item.ticketId) === 'PENDING'
              );
              const standardPendingItem = pendingStandardItems[pendingStandardItems.length - 1];

              if (clarificationDraft && clarificationIsPending && standardPendingItem) {
                const dictionary = getDictionary();
                const disambiguationMessage = dictionary.languageCode === 'id'
                  ? `[WARN] Ada dua transaksi yang bisa dibatalkan. Tidak ada yang dibatalkan.\nBalas *batal #${clarificationDraft.ticketId}* untuk membatalkan draft klarifikasi, atau *batal #${standardPendingItem.ticketId}* untuk membatalkan tiket transaksi.`
                  : `[WARN] Two transactions can be cancelled. Nothing was cancelled.\nReply *cancel #${clarificationDraft.ticketId}* to cancel the clarification draft, or *cancel #${standardPendingItem.ticketId}* to cancel the pending transaction ticket.`;
                await this.context.gateway.sendMessage(
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

      // 2. Explicit reconciliation commands (sudah ada, belum ada)
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

      // 2.1 Inbound Rescan / Replay command (e.g. /rescan, /rescan 30, /replay 2h, /rescan 1d)
      if (event.messageType === 'text' && event.textPayload) {
        const trimmedText = event.textPayload.trim();
        const rescanMatch = trimmedText.match(/^(?:\/)?(?:rescan|replay)(?:@\w+)?(?:\s+(.+))?$/i);
        if (rescanMatch) {
          const dictionary = getDictionary();
          if (this.inboundRescanService.isRunning()) {
            const inProgressMsg =
              dictionary.languageCode === 'en'
                ? '⚠️ *Inbound rescan is currently in progress.* Please wait until it completes.'
                : '⚠️ *Proses rescan transaksi sedang berjalan.* Mohon tunggu hingga selesai.';
            await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, inProgressMsg);
            return;
          }

          const durationArg = rescanMatch[1];
          if (!durationArg && event.channel === 'telegram') {
            const rescanPrompt =
              dictionary.languageCode === 'en'
                ? '🔄 *Choose Rescan Lookback Range*\nSelect how far back to rescan incoming push notifications and emails:'
                : '🔄 *Pilih Rentang Waktu Rescan*\nPilih rentang waktu untuk memeriksa ulang notifikasi dan email masuk:';

            await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, rescanPrompt, {
              replyMarkup: createTelegramRescanInlineKeyboard(dictionary.languageCode as any),
            });
            return;
          }

          const durationMinutes = parseRescanDurationMinutes(durationArg);
          const durationLabel =
            durationMinutes >= 60
              ? durationMinutes % 60 === 0
                ? `${durationMinutes / 60} ${dictionary.languageCode === 'en' ? 'hour(s)' : 'jam'}`
                : `${durationMinutes} ${dictionary.languageCode === 'en' ? 'minutes' : 'menit'}`
              : `${durationMinutes} ${dictionary.languageCode === 'en' ? 'minutes' : 'menit'}`;

          const startMsg =
            dictionary.languageCode === 'en'
              ? `⏳ *Starting inbound rescan (last ${durationLabel})...*`
              : `⏳ *Memulai rescan transaksi (${durationLabel} terakhir)...*`;
          const receipt = await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, startMsg);
          const startMessageId = (receipt as SentMessageReceipt | undefined)?.messageId;

          const progressLabels: Record<InboundRescanStage, string> =
            dictionary.languageCode === 'en'
              ? {
                  notifications: '📲 _Checking push notifications..._',
                  emails: '📬 _Scanning inbound emails..._',
                  pending: '🎫 _Reconciling pending tickets..._',
                  completed: '✅ _Rescan completed._',
                }
              : {
                  notifications: '📲 _Memeriksa push notification..._',
                  emails: '📬 _Memindai email masuk..._',
                  pending: '🎫 _Menyelaraskan tiket pending..._',
                  completed: '✅ _Selesai._',
                };

          const onProgress = async (stage: InboundRescanStage) => {
            if (startMessageId && typeof this.context.gateway.editMessage === 'function') {
              const updatedText = `${startMsg}\n${progressLabels[stage]}`;
              await this.context.gateway.editMessage(
                event.channel,
                event.chatIdentifier,
                startMessageId,
                updatedText
              );
            }
          };

          const result = await this.inboundRescanService.rescanInbound(durationMinutes, { onProgress });
          const responseMsg = formatInboundRescanResponse(result, dictionary.languageCode as any);
          await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, responseMsg);
          return;
        }
      }

      // 3. Clarification replies
      if (event.messageType === 'text' && event.textPayload) {
        const latestAccountDraft = this.context.pending.getLatestPendingAccountSelectionDraft?.(
          event.channel,
          event.chatIdentifier,
          event.senderIdentifier
        );
        const latestCategoryDraft = this.context.pending.getLatestPendingCategorySelectionDraft?.(
          event.channel,
          event.chatIdentifier,
          event.senderIdentifier
        );

        const categoryIsNewer = Boolean(
          latestCategoryDraft &&
          (!latestAccountDraft || latestCategoryDraft.ticketId > latestAccountDraft.ticketId)
        );

        if (categoryIsNewer) {
          const handledCategory = await this.categoryClarificationHandler.handlePendingCategorySelectionReply(
            event,
            event.textPayload,
            processingStartTimestamp
          );
          if (handledCategory) {
            return;
          }

          const handledAccount = await this.accountClarificationHandler.handlePendingAccountSelectionReply(
            event,
            event.textPayload,
            processingStartTimestamp
          );
          if (handledAccount) {
            return;
          }
        } else {
          const handledAccount = await this.accountClarificationHandler.handlePendingAccountSelectionReply(
            event,
            event.textPayload,
            processingStartTimestamp
          );
          if (handledAccount) {
            return;
          }

          const handledCategory = await this.categoryClarificationHandler.handlePendingCategorySelectionReply(
            event,
            event.textPayload,
            processingStartTimestamp
          );
          if (handledCategory) {
            return;
          }
        }
      }

      // 4. Pending confirmation actions (ya, ok, lanjut, etc.)
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        hasPendingTransactions(this.context.pending)
      ) {
        let confirmationIntent = detectPendingConfirmationAction(event.textPayload);

        // Resolve swipe-reply to a specific pending transaction message
        if (event.replyToMessageId) {
          const pendingManager = this.context.pending as PendingTransactionService;
          if (typeof pendingManager.getAllPendingTransactions === 'function') {
            const matchedPendingItem = pendingManager.getAllPendingTransactions().find(
              item =>
                item.notificationMessageIds &&
                Object.values(item.notificationMessageIds).includes(event.replyToMessageId!)
            );
            if (matchedPendingItem) {
              if (!confirmationIntent) {
                confirmationIntent = detectPendingConfirmationAction(
                  `Ya ${matchedPendingItem.ticketId} ${event.textPayload}`
                );
              } else if (confirmationIntent.targetScope === 'LATEST') {
                confirmationIntent.targetScope = matchedPendingItem.ticketId;
              }
            }
          }
        }

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

      // 5. Fast-Path execution
      let deferredHistoryFastPathOptions: FastPathTransactionHistoryAction['options'] | undefined;

      if (event.messageType === 'text' && event.textPayload) {
        const fastPathAction = detectFastPathAction(event.textPayload);
        if (fastPathAction) {
          const cachedCategories = this.context.wallet.cache.getCategories();
          if (
            shouldDeferHistoryCategoryToSemanticResolver(
              fastPathAction,
              cachedCategories,
              requestReferenceInstant
            )
          ) {
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

      // 6. AI Intent Analysis
      const cachedAccounts = this.context.wallet.cache.getAccounts();
      const cachedCategories = this.context.wallet.cache.getCategories();

      let extractedIntent: ExtractedFinancialIntent;

      const primaryModel =
        typeof this.context.brain?.provider?.getPrimaryModel === 'function'
          ? this.context.brain.provider.getPrimaryModel()
          : undefined;

      const fallbackTracker = new ModelFallbackProgressTracker({
        gateway: this.context.gateway,
        channel: event.channel,
        chatIdentifier: event.chatIdentifier,
        primaryModel,
      });

      fallbackTracker.start();

      try {
        if (event.messageType === 'image' && event.imageBuffer) {
          applicationLogger.ai(
            `Processing receipt photo with ${this.context.brain.provider.providerName.toUpperCase()} Vision...`
          );
          const rawExtractedIntent = await this.context.brain.provider.processImageMessage(
            event.imageBuffer,
            event.imageMimeType || 'image/jpeg',
            event.textPayload || '',
            cachedAccounts,
            cachedCategories,
            requestReferenceInstant,
            { onFallback: (evt) => fallbackTracker.handleFallback(evt) }
          );
          extractedIntent = validateReceiptFinancialIntentEnvelope(rawExtractedIntent);
        } else {
          applicationLogger.ai(
            `Analyzing message intent with ${this.context.brain.provider.providerName.toUpperCase()}...`
          );
          extractedIntent = await this.context.brain.provider.processTextMessage(
            event.textPayload || '',
            cachedAccounts,
            cachedCategories,
            requestReferenceInstant,
            { onFallback: (evt) => fallbackTracker.handleFallback(evt) }
          );
        }
      } finally {
        await fallbackTracker.cleanup();
      }

      applicationLogger.ai(`Decision: ${extractedIntent.action}`);
      applicationLogger.fileDetail('ai', 'Parsed Financial Intent Result', {
        action: extractedIntent.action,
        explanation: extractedIntent.explanation,
        records: extractedIntent.records,
      });

      if (
        event.messageType === 'image' &&
        extractedIntent.action === FINANCIAL_ACTION_TYPES.CREATE_RECORD &&
        (!extractedIntent.records || extractedIntent.records.length === 0)
      ) {
        applicationLogger.warn('Receipt extraction returned CREATE_RECORD with 0 records.');
        await this.context.gateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          getDictionary().errors.receiptExtractionFailed(getHumanReadableTimestamp())
        );
        return;
      }

      // 7. Semantic Tool Boundary
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

        if (!boundaryDecision.accepted) {
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
            await this.context.gateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              unresolvedMessage
            );
            return;
          }

          if (semanticToolProposal.tool === 'propose_transaction') {
            await this.context.gateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              getDictionary().errors.validationRejected(
                getDictionary().errors.accountResolutionFallback
              )
            );
            return;
          }
        } else if (!this.financialActionRegistry.hasHandler(boundaryDecision.context.action)) {
          applicationLogger.error(
            `[SemanticToolBoundary] Accepted action has no registered handler: ${boundaryDecision.context.action}.`
          );
          return;
        } else if (!deferredHistoryFastPathOptions) {
          await this.financialActionRegistry.execute(boundaryDecision.context);
          return;
        } else {
          if (boundaryDecision.context.action !== FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY) {
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
            await this.context.gateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              unresolvedMessage
            );
            return;
          }

          const semanticCategoryId = boundaryDecision.context.queryOptions?.categoryId;
          const semanticSearchQuery = boundaryDecision.context.queryOptions?.searchQuery;
          if (!semanticCategoryId && !semanticSearchQuery) {
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
            await this.context.gateway.sendMessage(
              event.channel,
              event.chatIdentifier,
              unresolvedMessage
            );
            return;
          }

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
        await this.context.gateway.sendMessage(
          event.channel,
          event.chatIdentifier,
          unresolvedMessage
        );
        return;
      }

      if (event.messageType === 'image') {
        const receiptReplyMessage =
          extractedIntent.explanation?.trim() ||
          getDictionary().errors.receiptExtractionFailed(getHumanReadableTimestamp());
        await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, receiptReplyMessage);
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

      await this.context.gateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
      const processingDurationMs = Date.now() - processingStartTimestamp;
      applicationLogger.success(
        `[${event.channel.toUpperCase()}] Sent guidance / general reply (${processingDurationMs}ms).`
      );
    } catch (processingError: unknown) {
      const errorName = processingError instanceof Error ? processingError.name : 'UnknownError';
      applicationLogger.error(`Error while processing user message (${errorName}).`);

      applicationLogger.fileDetail('error', 'User Message Processing Error Details', {
        error:
          processingError instanceof Error
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
        cachedAccountsCount: this.context.wallet.cache.getAccounts().length,
        cachedCategoriesCount: this.context.wallet.cache.getCategories().length,
      });

      const humanErrorMessage = formatErrorMessageForHuman(
        processingError,
        getHumanReadableTimestamp(),
        undefined,
        { isImageMessage: event.messageType === 'image' }
      );
      await this.context.gateway.sendMessage(
        event.channel,
        event.chatIdentifier,
        humanErrorMessage
      );
    } finally {
      if (typeof this.context.gateway.clearTypingPresence === 'function') {
        await this.context.gateway.clearTypingPresence(event.channel, event.chatIdentifier);
      }
    }
  }

  /**
   * Processes bank notification emails from the IMAP listener service.
   */
  public async handleEmailTransactionDetected(detectedEvent: EmailTransactionDetectedEvent): Promise<void> {
    applicationLogger.info('Processing detected email transaction candidate.');
    applicationLogger.fileDetail('email', 'Detected Email Transaction Candidate', {
      emailSubject: detectedEvent.emailSubject,
      emailSender: detectedEvent.emailSender,
      gateResult: detectedEvent.gateResult,
    });

    const cachedAccounts = this.context.wallet.cache.getAccounts();
    const cachedCategories = this.context.wallet.cache.getCategories();

    const parsedData = await this.context.brain.provider.processEmailTransactionMessage(
      detectedEvent.gateResult,
      detectedEvent.emailSubject,
      detectedEvent.emailSender,
      detectedEvent.cleanedBodyText,
      detectedEvent.emailDate,
      cachedAccounts,
      cachedCategories
    );

    if (!parsedData.isTransaction) {
      applicationLogger.info('[Gate 2 Filtered Out] AI classified candidate as non-transaction.');
      applicationLogger.fileDetail('ai', 'Gate 2 Filtered Email Candidate', {
        explanation: parsedData.explanation,
      });
      return;
    }

    const ruleCategory = detectedEvent.gateResult.matchedBankRule?.ruleCategory;
    const evidenceSourceType =
      ruleCategory === 'MERCHANT_RECEIPT'
        ? 'EMAIL_PAYMENT'
        : 'EMAIL_BANK';

    await coordinateInboundTransactionCandidate(
      {
        parsedData,
        gateResult: detectedEvent.gateResult,
        sourceType: 'EMAIL',
        evidenceSourceType,
        sourceId: `email-${detectedEvent.emailDate.getTime()}-${Math.abs(parsedData.amount)}`,
        sourceDate: detectedEvent.emailDate,
        sourceDisplayName: detectedEvent.gateResult.matchedBankRule?.displayName || detectedEvent.emailSender,
        fallbackNote: detectedEvent.emailSubject,
        onRecordProcessed: ref => {
          if (this.context.email.listener) {
            this.context.email.listener.recordProcessedTransaction(undefined, ref);
          }
        },
      },
      {
        walletCacheService: this.context.wallet.cache,
        pendingTransactionManager: this.context.pending,
        messagingGateway: this.context.gateway,
        defaultCurrency: this.context.config.defaultCurrency,
        correlationService: this.context.email.correlation,
        walletMcpClient: this.context.wallet.client,
        transactionMessageStore: this.context.wallet?.transactionMessages,
        enrichmentPoolService: this.context.wallet?.enrichmentPool,
      }
    );
  }

  /**
   * Processes mobile push notifications from the webhook receiver.
   */
  public async handleNotificationReceived(
    payload: PushNotificationPayload,
    options?: { skipStoreRecord?: boolean; isReplay?: boolean }
  ): Promise<void> {
    await this.notificationHandler.handleNotificationReceived(payload, options);
  }
}

/**
 * Convenience alias for MessageDispatcher to ensure seamless backward compatibility
 * across test suites referencing UserMessageHandler.
 */
export { MessageDispatcher as UserMessageHandler };
