import { AppContext } from './context.js';
import { IncomingUserMessageEvent, PushNotificationPayload, MessagingGatewayService } from '../gateway/index.js';
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
  FinancialAiProvider,
  CategoryContextService,
  ClarificationService,
} from '../brain/index.js';
import { FINANCIAL_ACTION_TYPES } from '../brain/constants.js';
import { PendingTransactionService } from './pending.js';
import { PendingActionHandler } from './pendingHandler.js';
import { FastPathHandler } from './fastPathHandler.js';
import { FinancialActionExecutor } from './executor.js';
import { AccountClarificationHandler } from './accountClarificationHandler.js';
import { CategoryClarificationHandler } from './categoryClarificationHandler.js';
import { CreateRecordActionHandler } from './createRecordHandler.js';
import {
  FinancialActionRegistry,
} from './financialActionRegistry.js';
import {
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  CheckQueueActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
} from './readActionHandlers.js';
import { coordinateInboundTransactionCandidate } from './inboundCoordinator.js';
import { evaluateNotificationThroughGate } from '../config/notificationRules.js';
import {
  normalizeTransactionHistoryFilters,
  formatErrorMessageForHuman,
  getHumanReadableTimestamp,
  TransactionHistoryQueryOptions,
  WalletRecordPreparationService,
  WalletCacheService,
  WalletMcpClientService,
} from '../wallet/index.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../lib/logger.js';

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

export interface DefaultFinancialActionRegistryDependencies {
  readonly financialActionExecutor: FinancialActionExecutor;
  readonly walletMcpClient: AppContext['wallet']['client'];
  readonly walletCacheService: AppContext['wallet']['cache'];
  readonly messagingGateway: AppContext['gateway'];
  readonly recordPreparationService: AppContext['wallet']['recordPreparation'];
  readonly accountClarificationHandler: AccountClarificationHandler;
  readonly pendingTransactionService?: PendingTransactionService;
  readonly categoryContextService?: AppContext['brain']['categoryContext'];
  readonly categoryClarificationHandler?: CategoryClarificationHandler;
  readonly categoryResolutionMode?: 'ask' | 'auto';
  readonly categoryClarificationConversationService?: AppContext['brain']['categoryClarification'];
}

export function createDefaultFinancialActionRegistry(
  dependencies: DefaultFinancialActionRegistryDependencies
): FinancialActionRegistry {
  const registry = new FinancialActionRegistry();

  registry.register(new CheckBalanceActionHandler(dependencies.financialActionExecutor));
  registry.register(new CheckBudgetActionHandler(dependencies.financialActionExecutor));
  registry.register(new HelpMenuActionHandler(dependencies.financialActionExecutor));
  registry.register(new TransactionHistoryActionHandler(dependencies.financialActionExecutor));
  registry.register(new TransactionSummaryActionHandler(dependencies.financialActionExecutor));

  if (dependencies.pendingTransactionService) {
    registry.register(
      new CheckQueueActionHandler(
        dependencies.pendingTransactionService,
        dependencies.messagingGateway
      )
    );
  }

  registry.register(
    new CreateRecordActionHandler(
      dependencies.walletMcpClient,
      dependencies.walletCacheService,
      dependencies.messagingGateway,
      dependencies.recordPreparationService,
      dependencies.accountClarificationHandler,
      dependencies.categoryContextService,
      dependencies.categoryClarificationHandler,
      dependencies.categoryResolutionMode,
      dependencies.categoryClarificationConversationService
    )
  );

  return registry;
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
  public readonly semanticToolBoundary: SemanticToolBoundary;
  public readonly semanticToolAuthorizationResolver: SemanticToolAuthorizationResolver;

  public readonly context: AppContext;
  public readonly recordPreparationService?: WalletRecordPreparationService;

  constructor(
    context: AppContext,
    overrides?: {
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
    }
  );
  constructor(
    messagingGateway: MessagingGatewayService,
    pendingTransactionManager: PendingTransactionService,
    pendingActionHandler?: PendingActionHandler,
    fastPathHandler?: FastPathHandler,
    financialAiProvider?: FinancialAiProvider,
    walletCacheService?: WalletCacheService,
    walletMcpClient?: WalletMcpClientService,
    financialActionExecutor?: FinancialActionExecutor,
    recordPreparationService?: WalletRecordPreparationService,
    financialActionRegistry?: FinancialActionRegistry,
    accountClarificationHandler?: AccountClarificationHandler,
    semanticToolBoundary?: SemanticToolBoundary,
    semanticToolAuthorizationResolver?: SemanticToolAuthorizationResolver,
    categoryClarificationHandler?: CategoryClarificationHandler,
    categoryResolutionMode?: 'ask' | 'auto',
    categoryContextService?: CategoryContextService
  );
  constructor(
    contextOrGateway: AppContext | MessagingGatewayService,
    pendingOrOverrides?: any,
    pendingActionHandler?: PendingActionHandler,
    fastPathHandler?: FastPathHandler,
    financialAiProvider?: FinancialAiProvider,
    walletCacheService?: WalletCacheService,
    walletMcpClient?: WalletMcpClientService,
    financialActionExecutor?: FinancialActionExecutor,
    recordPreparationService?: WalletRecordPreparationService,
    financialActionRegistry?: FinancialActionRegistry,
    accountClarificationHandler?: AccountClarificationHandler,
    semanticToolBoundary?: SemanticToolBoundary,
    semanticToolAuthorizationResolver?: SemanticToolAuthorizationResolver,
    categoryClarificationHandler?: CategoryClarificationHandler,
    categoryResolutionMode?: 'ask' | 'auto',
    categoryContextService?: CategoryContextService
  ) {
    if (contextOrGateway && 'wallet' in contextOrGateway && 'gateway' in contextOrGateway) {
      const context = contextOrGateway as AppContext;
      const overrides = pendingOrOverrides as {
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
      } | undefined;

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
        overrides?.recordPreparationService || context.wallet.recordPreparation;
      this.recordPreparationService = recordPrep;

      this.accountClarificationHandler =
        overrides?.accountClarificationHandler ||
        new AccountClarificationHandler(
          context.pending,
          context.wallet.client,
          context.wallet.cache,
          context.gateway,
          recordPrep,
          context.brain.categoryContext,
          context.brain.accountClarification
        );

      this.categoryClarificationHandler =
        overrides?.categoryClarificationHandler ||
        new CategoryClarificationHandler(
          context.pending,
          context.wallet.client,
          context.wallet.cache,
          context.gateway,
          recordPrep,
          context.brain.categoryContext,
          context.brain.categoryClarification
        );

      this.pendingActionHandler =
        overrides?.pendingActionHandler ||
        new PendingActionHandler(
          context.pending,
          context.wallet.client,
          context.gateway,
          () => context.email.listener,
          context.wallet.cache
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
          categoryContextService: context.brain.categoryContext,
          categoryResolutionMode: overrides?.categoryResolutionMode,
          pendingTransactionService: context.pending,
        });

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
        overrides?.semanticToolBoundary || context.brain.semanticBoundary;
      this.semanticToolAuthorizationResolver =
        overrides?.semanticToolAuthorizationResolver || resolveGatewayAuthorization;
    } else {
      const messagingGateway = contextOrGateway as MessagingGatewayService;
      const pendingTransactionManager = pendingOrOverrides as PendingTransactionService;

      const recordPrep =
        recordPreparationService ||
        (walletCacheService && walletMcpClient
          ? new WalletRecordPreparationService(walletCacheService, walletMcpClient)
          : ({} as any));
      this.recordPreparationService = recordPrep;

      const historyService =
        (financialActionExecutor as any)?.transactionHistoryService ||
        (fastPathHandler as any)?.transactionHistoryService;
      const summaryService =
        (financialActionExecutor as any)?.transactionSummaryService ||
        (fastPathHandler as any)?.transactionSummaryService;

      const clarificationService = new ClarificationService(financialAiProvider);

      this.context = {
        config: { defaultCurrency: 'IDR' } as any,
        gateway: messagingGateway,
        pending: pendingTransactionManager,
        wallet: {
          client: walletMcpClient as any,
          cache: walletCacheService as any,
          recordPreparation: recordPrep,
          history: historyService,
          summary: summaryService,
          capabilities: undefined as any,
        },
        brain: {
          provider: financialAiProvider as any,
          categoryContext: categoryContextService as any,
          semanticBoundary: semanticToolBoundary || new SemanticToolBoundary(),
          accountClarification: clarificationService,
          categoryClarification: clarificationService,
        },
        email: {
          listener: null,
          correlation: undefined as any,
        },
        webhook: null,
      };

      this.financialActionExecutor =
        financialActionExecutor ||
        new FinancialActionExecutor(
          walletMcpClient as any,
          walletCacheService as any,
          messagingGateway,
          historyService,
          summaryService
        );

      this.accountClarificationHandler =
        accountClarificationHandler ||
        new AccountClarificationHandler(
          pendingTransactionManager,
          walletMcpClient as any,
          walletCacheService as any,
          messagingGateway,
          recordPrep,
          categoryContextService,
          clarificationService
        );

      this.categoryClarificationHandler =
        categoryClarificationHandler ||
        new CategoryClarificationHandler(
          pendingTransactionManager,
          walletMcpClient as any,
          walletCacheService as any,
          messagingGateway,
          recordPrep,
          categoryContextService,
          clarificationService
        );

      this.pendingActionHandler =
        pendingActionHandler ||
        new PendingActionHandler(
          pendingTransactionManager,
          walletMcpClient as any,
          messagingGateway,
          () => null,
          walletCacheService as any
        );

      this.semanticToolBoundary = semanticToolBoundary || new SemanticToolBoundary();
      this.semanticToolAuthorizationResolver =
        semanticToolAuthorizationResolver || resolveGatewayAuthorization;

      if (financialActionRegistry) {
        this.financialActionRegistry = financialActionRegistry;
      } else {
        this.financialActionRegistry = createDefaultFinancialActionRegistry({
          financialActionExecutor: this.financialActionExecutor,
          walletMcpClient: walletMcpClient as any,
          walletCacheService: walletCacheService as any,
          messagingGateway,
          recordPreparationService: recordPrep,
          accountClarificationHandler: this.accountClarificationHandler,
          categoryClarificationHandler: this.categoryClarificationHandler,
          categoryResolutionMode,
          categoryContextService,
          pendingTransactionService: pendingTransactionManager,
        });
      }

      this.fastPathHandler =
        fastPathHandler ||
        new FastPathHandler(
          walletMcpClient as any,
          walletCacheService as any,
          messagingGateway,
          historyService,
          summaryService,
          this.financialActionExecutor,
          this.financialActionRegistry,
          pendingTransactionManager
        );
    }
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
      // 1. Pending cancellation disambiguation
      if (
        event.messageType === 'text' &&
        event.textPayload &&
        hasPendingTransactions(this.context.pending)
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
            const manager = this.context.pending as Partial<PendingTransactionService>;
            if (
              typeof manager.getLatestPendingAccountSelectionDraft === 'function' &&
              typeof manager.getPendingAccountSelectionDraftState === 'function' &&
              typeof manager.getAllPendingTransactions === 'function' &&
              typeof manager.getPendingTransactionState === 'function'
            ) {
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

              const pendingStandardItems = manager.getAllPendingTransactions().filter(
                item => manager.getPendingTransactionState?.(item.ticketId) === 'PENDING'
              );
              const standardPendingItem = pendingStandardItems[pendingStandardItems.length - 1];

              if (clarificationDraft && clarificationIsPending && standardPendingItem) {
                const dictionary = getDictionary();
                const disambiguationMessage = dictionary.languageCode === 'id'
                  ? `⚠️ Ada dua transaksi yang bisa dibatalkan. Tidak ada yang dibatalkan.\nBalas *batal #${clarificationDraft.ticketId}* untuk membatalkan draft klarifikasi, atau *batal #${standardPendingItem.ticketId}* untuk membatalkan tiket transaksi.`
                  : `⚠️ Two transactions can be cancelled. Nothing was cancelled.\nReply *cancel #${clarificationDraft.ticketId}* to cancel the clarification draft, or *cancel #${standardPendingItem.ticketId}* to cancel the pending transaction ticket.`;
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
          requestReferenceInstant
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

        if (boundaryDecision.accepted) {
          if (!this.financialActionRegistry.hasHandler(boundaryDecision.context.action)) {
            applicationLogger.error(
              `[SemanticToolBoundary] Accepted action has no registered handler: ${boundaryDecision.context.action}.`
            );
            return;
          }

          if (deferredHistoryFastPathOptions) {
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
            } else {
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
      await this.context.gateway.clearTypingPresence(event.channel, event.chatIdentifier);
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
      }
    );
  }

  /**
   * Processes mobile push notifications from the webhook receiver.
   */
  public async handleNotificationReceived(payload: PushNotificationPayload): Promise<void> {
    applicationLogger.info(`[NotificationWebhook] Processing notification from package: ${payload.packageName}`);
    applicationLogger.fileDetail('notification', 'Detected Push Notification Candidate', {
      packageName: payload.packageName,
      title: payload.title,
      text: payload.text,
      timestamp: payload.timestamp,
    });

    const gateResult = evaluateNotificationThroughGate(payload);
    if (!gateResult.passed) {
      applicationLogger.info(`[Gate 1 Skip] Push notification rejected: ${gateResult.reason}`);
      return;
    }

    applicationLogger.info(
      `[Gate 1 Passed] Matched package rule: ${gateResult.matchedBankRule?.displayName || payload.packageName}`
    );

    const cachedAccounts = this.context.wallet.cache.getAccounts();
    const cachedCategories = this.context.wallet.cache.getCategories();
    const notificationDate = gateResult.originalDate || (payload.timestamp ? new Date(payload.timestamp) : new Date());

    const parsedData = await this.context.brain.provider.processEmailTransactionMessage(
      gateResult,
      payload.title,
      payload.packageName,
      payload.text,
      notificationDate,
      cachedAccounts,
      cachedCategories
    );

    if (!parsedData.isTransaction) {
      applicationLogger.info('[Gate 2 Filtered Out] Notification classified as non-transaction.');
      return;
    }

    const evidenceSourceType = 'PUSH_NOTIFICATION';

    await coordinateInboundTransactionCandidate(
      {
        parsedData,
        gateResult,
        sourceType: 'PUSH_NOTIFICATION',
        evidenceSourceType,
        sourceId: `notif-${payload.packageName}-${notificationDate.getTime()}-${Math.abs(parsedData.amount)}`,
        sourceDate: notificationDate,
        sourceDisplayName: gateResult.matchedBankRule?.displayName || payload.packageName,
        fallbackNote: payload.title ? `${payload.title} - ${payload.text}` : payload.text,
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
      }
    );
  }
}

/**
 * Convenience alias for MessageDispatcher to ensure seamless backward compatibility
 * across test suites referencing UserMessageHandler.
 */
export { MessageDispatcher as UserMessageHandler };
