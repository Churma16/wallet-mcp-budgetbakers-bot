import { AppContext } from '../../src/core/context.js';
import { UserMessageHandler, DispatcherOverrides } from '../../src/core/dispatcher.js';
import {
  SemanticToolBoundary,
  ClarificationService,
} from '../../src/brain/index.js';
import { TransactionMessageStore, WalletRecordPreparationService } from '../../src/wallet/index.js';
import { TransactionCorrelationEngine } from '../../src/email/index.js';
import { InboundNotificationStore } from '../../src/gateway/notificationStore.js';

export interface TestAppContextOptions {
  config?: any;
  gateway?: any;
  pending?: any;
  wallet?: {
    client?: any;
    cache?: any;
    capabilities?: any;
    history?: any;
    summary?: any;
    recordPreparation?: any;
    transactionMessages?: any;
  };
  brain?: {
    provider?: any;
    categoryContext?: any;
    accountClarification?: any;
    categoryClarification?: any;
    semanticBoundary?: any;
  };
  email?: {
    correlation?: any;
    listener?: any;
  };
  webhook?: any;
}

/**
 * Creates a stubbed AppContext for test execution without starting external services.
 */
export function createTestAppContext(options: TestAppContextOptions = {}): AppContext {
  const client = options.wallet?.client;
  const cache = options.wallet?.cache;
  const recordPreparation =
    options.wallet?.recordPreparation ||
    (cache && client
      ? new WalletRecordPreparationService(cache, client)
      : ({
          prepareRecordsForDispatch: async (records: any) => records,
        } as any));

  const provider = options.brain?.provider;
  const clarification = provider ? new ClarificationService(provider) : undefined;

  return {
    config: options.config || ({ defaultCurrency: 'IDR' } as any),
    gateway: options.gateway || ({} as any),
    pending: options.pending || ({} as any),
    wallet: {
      client,
      cache,
      capabilities: options.wallet?.capabilities,
      history: options.wallet?.history,
      summary: options.wallet?.summary,
      recordPreparation,
      transactionMessages: options.wallet?.transactionMessages || new TransactionMessageStore(),
    } as any,
    brain: {
      provider,
      categoryContext: options.brain?.categoryContext,
      accountClarification: options.brain?.accountClarification || clarification,
      categoryClarification: options.brain?.categoryClarification || clarification,
      semanticBoundary: options.brain?.semanticBoundary || new SemanticToolBoundary(),
    } as any,
    email: options.email || {
      correlation: new TransactionCorrelationEngine(),
      listener: null,
    },
    webhook: options.webhook || null,
    notificationStore: (options as any).notificationStore || new InboundNotificationStore(),
  };
}

export interface LegacyTestHandlerArgs {
  messagingGateway?: any;
  pendingTransactionManager?: any;
  pendingActionHandler?: any;
  fastPathHandler?: any;
  financialAiProvider?: any;
  walletCacheService?: any;
  walletMcpClient?: any;
  financialActionExecutor?: any;
  recordPreparationService?: any;
  financialActionRegistry?: any;
  accountClarificationHandler?: any;
  semanticToolBoundary?: any;
  semanticToolAuthorizationResolver?: any;
  categoryClarificationHandler?: any;
  categoryResolutionMode?: 'ask' | 'auto';
  categoryContextService?: any;
  deleteRecordHandler?: any;
  modifyRecordHandler?: any;
}

/**
 * Helper to instantiate UserMessageHandler / MessageDispatcher from legacy test arguments.
 */
export function createTestUserMessageHandler(
  args: LegacyTestHandlerArgs
): UserMessageHandler {
  const context = createTestAppContext({
    gateway: args.messagingGateway,
    pending: args.pendingTransactionManager,
    wallet: {
      client: args.walletMcpClient,
      cache: args.walletCacheService,
      recordPreparation: args.recordPreparationService,
    },
    brain: {
      provider: args.financialAiProvider,
      categoryContext: args.categoryContextService,
      semanticBoundary: args.semanticToolBoundary,
    },
  });

  const overrides: Partial<DispatcherOverrides> = {};
  if (args.pendingActionHandler) overrides.pendingActionHandler = args.pendingActionHandler;
  if (args.fastPathHandler) overrides.fastPathHandler = args.fastPathHandler;
  if (args.financialActionExecutor) overrides.financialActionExecutor = args.financialActionExecutor;
  if (args.recordPreparationService) overrides.recordPreparationService = args.recordPreparationService;
  if (args.financialActionRegistry) overrides.financialActionRegistry = args.financialActionRegistry;
  if (args.accountClarificationHandler) overrides.accountClarificationHandler = args.accountClarificationHandler;
  if (args.categoryClarificationHandler) overrides.categoryClarificationHandler = args.categoryClarificationHandler;
  if (args.semanticToolBoundary) overrides.semanticToolBoundary = args.semanticToolBoundary;
  if (args.semanticToolAuthorizationResolver) overrides.semanticToolAuthorizationResolver = args.semanticToolAuthorizationResolver;
  if (args.categoryResolutionMode) overrides.categoryResolutionMode = args.categoryResolutionMode;
  if (args.deleteRecordHandler) overrides.deleteRecordHandler = args.deleteRecordHandler;
  if (args.modifyRecordHandler) overrides.modifyRecordHandler = args.modifyRecordHandler;

  return new UserMessageHandler(context, overrides);
}
