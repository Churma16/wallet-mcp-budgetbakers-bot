import {
  loadEnvironmentConfiguration,
  setRuntimeApplicationConfig,
  ApplicationEnvironmentConfiguration,
} from '../config/index.js';
import { setActiveLanguage } from '../i18n/index.js';
import {
  WalletMcpClientService,
  WalletCacheService,
  WalletMcpCapabilityService,
  TransactionHistoryService,
  TransactionSummaryService,
  WalletRecordPreparationService,
} from '../wallet/index.js';
import {
  createFinancialAiProvider,
  FinancialAiProvider,
  CategoryContextService,
  AccountClarificationConversationService,
  CategoryClarificationConversationService,
  SemanticToolBoundary,
} from '../brain/index.js';
import {
  MessagingGatewayService,
  NotificationWebhookServer,
} from '../gateway/index.js';
import { EmailListenerService, TransactionCorrelationService } from '../email/index.js';
import { PendingTransactionService } from './pending.js';
import { applicationLogger } from '../lib/logger.js';

/**
 * Unified application context holding initialized domain references and shared runtime configuration.
 * Adopts an idiomatic Go-style context interface to eliminate verbose constructor dependency chains.
 */
export interface AppContext {
  readonly config: ApplicationEnvironmentConfiguration;
  readonly wallet: {
    readonly client: WalletMcpClientService;
    readonly cache: WalletCacheService;
    readonly capabilities: WalletMcpCapabilityService;
    readonly history: TransactionHistoryService;
    readonly summary: TransactionSummaryService;
    readonly recordPreparation: WalletRecordPreparationService;
  };
  readonly brain: {
    readonly provider: FinancialAiProvider;
    readonly categoryContext: CategoryContextService;
    readonly accountClarification: AccountClarificationConversationService;
    readonly categoryClarification: CategoryClarificationConversationService;
    readonly semanticBoundary: SemanticToolBoundary;
  };
  readonly gateway: MessagingGatewayService;
  readonly pending: PendingTransactionService;
  readonly email: {
    readonly correlation: TransactionCorrelationService;
    listener: EmailListenerService | null;
  };
  webhook: NotificationWebhookServer | null;
}

/**
 * Instantiates all domain collaborators and returns a unified AppContext struct.
 *
 * @param customConfig Optional pre-loaded application environment configuration.
 * @returns Fully constructed AppContext.
 */
export function createAppContext(customConfig?: ApplicationEnvironmentConfiguration): AppContext {
  const config = customConfig || loadEnvironmentConfiguration();
  setRuntimeApplicationConfig(config);
  setActiveLanguage(config.appLanguage);

  const walletClient = new WalletMcpClientService(
    config.walletMcpBaseUrl,
    config.walletMcpAccessToken
  );
  const walletCapabilities = new WalletMcpCapabilityService(walletClient);
  const walletCache = new WalletCacheService(walletClient);
  const walletHistory = new TransactionHistoryService(walletClient, walletCache);
  const walletSummary = new TransactionSummaryService(
    walletClient,
    walletCache,
    walletHistory,
    walletCapabilities
  );
  const walletRecordPreparation = new WalletRecordPreparationService(walletCache, walletClient);

  const categoryContext = new CategoryContextService(config.categoryContextFilePath);
  const brainProvider = createFinancialAiProvider(config, categoryContext);
  const accountClarification = new AccountClarificationConversationService(brainProvider);
  const categoryClarification = new CategoryClarificationConversationService(brainProvider);
  const semanticBoundary = new SemanticToolBoundary();

  const gateway = new MessagingGatewayService();
  const pending = new PendingTransactionService(config.pendingTransactionsStoragePath);
  const emailCorrelation = new TransactionCorrelationService();

  return {
    config,
    wallet: {
      client: walletClient,
      cache: walletCache,
      capabilities: walletCapabilities,
      history: walletHistory,
      summary: walletSummary,
      recordPreparation: walletRecordPreparation,
    },
    brain: {
      provider: brainProvider,
      categoryContext,
      accountClarification,
      categoryClarification,
      semanticBoundary,
    },
    gateway,
    pending,
    email: {
      correlation: emailCorrelation,
      listener: null,
    },
    webhook: null,
  };
}

/**
 * Connects to upstream servers, initialises caches, and refreshes discovered capabilities.
 *
 * @param context The active application context.
 */
export async function initializeAppContext(context: AppContext): Promise<void> {
  applicationLogger.info('Connecting to BudgetBakers Wallet MCP Server...');
  await context.wallet.cache.initialize();

  try {
    await context.wallet.capabilities.refreshCapabilities();
    applicationLogger.info('Discovered Wallet MCP capabilities and client profile.');
  } catch (capabilityError) {
    applicationLogger.warn(
      'Best-effort capability discovery failed during startup; continuing with conservative fallback',
      {
        error: capabilityError instanceof Error ? capabilityError.message : String(capabilityError),
      }
    );
  }
}

/**
 * Closes all active connections, listeners, and server sockets.
 *
 * @param context The active application context.
 */
export async function closeAppContext(context: AppContext): Promise<void> {
  if (context.email.listener) {
    await context.email.listener.stop();
    context.email.listener = null;
  }

  if (context.webhook) {
    await context.webhook.stop();
    context.webhook = null;
  }

  await context.gateway.stopAll();
  await context.wallet.client.close();
}
