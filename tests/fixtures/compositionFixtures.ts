import { vi } from 'vitest';
import { FinancialActionExecutor } from '../../src/services/financialActionExecutor.js';
import { FastPathHandler } from '../../src/handlers/fastPathHandler.js';
import {
  UserMessageHandler,
  UserMessageHandlerDependencies,
  SemanticToolAuthorizationResolver,
} from '../../src/handlers/userMessageHandler.js';
import {
  FinancialActionRegistry,
  createDefaultFinancialActionRegistry,
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
} from '../../src/actions/index.js';
import { WalletMcpClientService } from '../../src/services/walletMcpService.js';
import { WalletCacheService } from '../../src/services/walletCacheService.js';
import { TransactionHistoryService } from '../../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../../src/services/transactionSummaryService.js';
import { MessagingGatewayService } from '../../src/services/messaging/index.js';
import { PendingTransactionService } from '../../src/services/pendingTransactionService.js';
import { PendingActionHandler } from '../../src/handlers/pendingActionHandler.js';
import { FinancialAiProvider, SemanticToolBoundary } from '../../src/services/ai/index.js';
import { AccountClarificationHandler } from '../../src/handlers/accountClarificationHandler.js';
import { WalletRecordPreparationService } from '../../src/services/walletRecordPreparationService.js';
import { CategoryContextService } from '../../src/services/categoryContextService.js';
import { AccountClarificationConversationService } from '../../src/services/ai/index.js';
import { ApplicationEnvironmentConfiguration } from '../../src/config/index.js';

export interface TestFinancialActionExecutorOptions {
  readonly walletMcpClient?: WalletMcpClientService;
  readonly walletCacheService?: WalletCacheService;
  readonly messagingGateway?: MessagingGatewayService;
  readonly transactionHistoryService?: TransactionHistoryService;
  readonly transactionSummaryService?: TransactionSummaryService;
}

export function createTestFinancialActionExecutor(
  options: TestFinancialActionExecutorOptions = {}
): FinancialActionExecutor {
  const client =
    options.walletMcpClient ??
    ({
      fetchBudgets: vi.fn().mockResolvedValue([]),
      callMcpTool: vi.fn().mockResolvedValue({}),
    } as unknown as WalletMcpClientService);

  const cache =
    options.walletCacheService ??
    ({
      getAccounts: vi.fn().mockReturnValue([]),
      getCategories: vi.fn().mockReturnValue([]),
      refreshAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as WalletCacheService);

  const messagingGateway =
    options.messagingGateway ??
    ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagingGatewayService);

  const historyService =
    options.transactionHistoryService ??
    new TransactionHistoryService(client, cache);

  const summaryService =
    options.transactionSummaryService ??
    new TransactionSummaryService(client, cache, historyService);

  return new FinancialActionExecutor(
    client,
    cache,
    messagingGateway,
    historyService,
    summaryService
  );
}

export interface TestFastPathHandlerOptions {
  readonly financialActionRegistry?: FinancialActionRegistry;
  readonly financialActionExecutor?: FinancialActionExecutor;
  readonly walletMcpClient?: WalletMcpClientService;
  readonly walletCacheService?: WalletCacheService;
  readonly messagingGateway?: MessagingGatewayService;
  readonly transactionHistoryService?: TransactionHistoryService;
  readonly transactionSummaryService?: TransactionSummaryService;
}

export function createTestFastPathHandler(
  options: TestFastPathHandlerOptions = {}
): FastPathHandler {
  if (options.financialActionRegistry) {
    return new FastPathHandler(options.financialActionRegistry);
  }

  const executor =
    options.financialActionExecutor ??
    createTestFinancialActionExecutor({
      walletMcpClient: options.walletMcpClient,
      walletCacheService: options.walletCacheService,
      messagingGateway: options.messagingGateway,
      transactionHistoryService: options.transactionHistoryService,
      transactionSummaryService: options.transactionSummaryService,
    });

  const registry = new FinancialActionRegistry();
  registry.register(new CheckBalanceActionHandler(executor));
  registry.register(new CheckBudgetActionHandler(executor));
  registry.register(new HelpMenuActionHandler(executor));
  registry.register(new TransactionHistoryActionHandler(executor));
  registry.register(new TransactionSummaryActionHandler(executor));

  return new FastPathHandler(registry);
}

export interface TestUserMessageHandlerOptions {
  readonly messagingGateway?: MessagingGatewayService;
  readonly pendingTransactionManager?: PendingTransactionService;
  readonly pendingActionHandler?: PendingActionHandler;
  readonly fastPathHandler?: FastPathHandler;
  readonly financialAiProvider?: FinancialAiProvider;
  readonly walletCacheService?: WalletCacheService;
  readonly financialActionRegistry?: FinancialActionRegistry;
  readonly accountClarificationHandler?: AccountClarificationHandler;
  readonly walletMcpClient?: WalletMcpClientService;
  readonly financialActionExecutor?: FinancialActionExecutor;
  readonly recordPreparationService?: WalletRecordPreparationService;
  readonly categoryContextService?: CategoryContextService;
  readonly semanticToolBoundary?: SemanticToolBoundary;
  readonly semanticToolAuthorizationResolver?: SemanticToolAuthorizationResolver;
}

export function createTestUserMessageHandler(
  options: TestUserMessageHandlerOptions = {}
): UserMessageHandler {
  const messagingGateway =
    options.messagingGateway ??
    ({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagingGatewayService);

  const pendingTransactionManager =
    options.pendingTransactionManager ?? new PendingTransactionService();

  const pendingActionHandler =
    options.pendingActionHandler ??
    ({
      handlePendingAction: vi.fn().mockResolvedValue(false),
    } as unknown as PendingActionHandler);

  const fastPathHandler =
    options.fastPathHandler ??
    ({
      handleFastPath: vi.fn().mockResolvedValue(false),
    } as unknown as FastPathHandler);

  const financialAiProvider =
    options.financialAiProvider ??
    ({
      providerName: 'mock-ai',
      processTextMessage: vi.fn().mockResolvedValue({
        action: 'GENERAL_REPLY',
        explanation: 'Mock general reply',
      }),
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'GENERAL_REPLY',
        explanation: 'Mock image reply',
      }),
    } as unknown as FinancialAiProvider);

  const walletCacheService =
    options.walletCacheService ??
    ({
      getAccounts: vi.fn().mockReturnValue([]),
      getCategories: vi.fn().mockReturnValue([]),
      refreshAccounts: vi.fn().mockResolvedValue([]),
    } as unknown as WalletCacheService);

  const client =
    options.walletMcpClient ??
    ({
      createRecords: vi.fn().mockResolvedValue({ summary: { total: 0, succeeded: 0, failed: 0 } }),
      callMcpTool: vi.fn().mockResolvedValue({}),
    } as unknown as WalletMcpClientService);

  const recordPreparationService =
    options.recordPreparationService ??
    new WalletRecordPreparationService(walletCacheService, client);

  const accountClarificationHandler =
    options.accountClarificationHandler ??
    new AccountClarificationHandler(
      pendingTransactionManager,
      client,
      walletCacheService,
      messagingGateway,
      recordPreparationService,
      options.categoryContextService,
      new AccountClarificationConversationService(financialAiProvider)
    );

  const financialActionExecutor =
    options.financialActionExecutor ??
    createTestFinancialActionExecutor({
      walletMcpClient: client,
      walletCacheService,
      messagingGateway,
    });

  const financialActionRegistry =
    options.financialActionRegistry ??
    createDefaultFinancialActionRegistry({
      financialActionExecutor,
      walletMcpClient: client,
      walletCacheService,
      messagingGateway,
      recordPreparationService,
      accountClarificationHandler,
      pendingTransactionService: pendingTransactionManager,
      categoryContextService: options.categoryContextService,
    });

  const dependencies: UserMessageHandlerDependencies = {
    messagingGateway,
    pendingTransactionManager,
    pendingActionHandler,
    fastPathHandler,
    financialAiProvider,
    walletCacheService,
    financialActionRegistry,
    accountClarificationHandler,
    semanticToolBoundary: options.semanticToolBoundary,
    semanticToolAuthorizationResolver: options.semanticToolAuthorizationResolver,
  };

  return new UserMessageHandler(dependencies);
}

export function createTestApplicationConfiguration(
  overrides?: Partial<ApplicationEnvironmentConfiguration>
): ApplicationEnvironmentConfiguration {
  return {
    aiProvider: 'gemini',
    aiProviders: ['gemini'],
    aiApiKey: '',
    aiBaseUrl: '',
    aiModel: 'gemini-3.6-flash',
    aiFallbackModels: [],
    aiRequestTimeoutMilliseconds: 20000,
    geminiApiKey: 'test-gemini-key',
    geminiModel: 'gemini-3.6-flash',
    geminiFallbackModels: [],
    geminiRequestTimeoutMilliseconds: 20000,
    walletMcpBaseUrl: 'https://mcp.wallet.budgetbakers.com',
    walletMcpAccessToken: 'test-wallet-token',
    allowedPhoneNumber: '6281234567890',
    whatsappSessionPath: './test_session',
    telegramBotToken: '123456:TEST_TELEGRAM_TOKEN',
    telegramAllowedUserId: '987654321',
    enabledMessengerChannels: ['whatsapp'],
    logRetentionDays: 7,
    emailSyncEnabled: false,
    emailImapHost: 'imap.gmail.com',
    emailImapPort: 993,
    emailImapUser: 'test@example.com',
    emailImapPassword: 'password',
    emailPollIntervalSeconds: 60,
    emailAllowedSenders: ['bank@example.com'],
    emailTransactionLookbackDays: 7,
    defaultCurrency: 'IDR',
    whatsappMaxReconnectAttempts: 5,
    whatsappReconnectMaxBackoffSeconds: 60,
    whatsappMessageQueueIntervalMs: 50,
    whatsappTypingPresenceCooldownMs: 1000,
    maxMediaDownloadMb: 15,
    telegramMaxStartupAttempts: 5,
    telegramStartupRetryDelayMs: 2000,
    categoryContextFilePath: './test-category-context.json',
    appLanguage: 'id',
    ...overrides,
  };
}

