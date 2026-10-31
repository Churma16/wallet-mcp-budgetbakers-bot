import {
  WalletMcpClientService,
  WalletCacheService,
  TransactionHistoryService,
  TransactionSummaryService,
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../wallet/index.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../gateway/index.js';
import {
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatTransactionHistoryMessage,
} from '../wallet/formatters/humanResponseFormatter.js';
import { formatTransactionSummaryMessage } from '../wallet/formatters/transactionSummaryFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../lib/logger.js';

export interface FinancialActionExecutionContext {
  readonly processingStartTimestamp?: number;
  readonly routingSource?: 'fast-path' | 'ai' | 'direct';
}

/**
 * Coordinates read-only and query-based financial action execution across accounts,
 * budgets, history, summaries, and guidance.
 */
export class FinancialActionExecutor {
  private readonly transactionHistoryService: TransactionHistoryService;
  private readonly transactionSummaryService: TransactionSummaryService;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    transactionHistoryService?: TransactionHistoryService,
    transactionSummaryService?: TransactionSummaryService
  ) {
    this.transactionHistoryService =
      transactionHistoryService ||
      new TransactionHistoryService(walletMcpClient, walletCacheService);
    this.transactionSummaryService =
      transactionSummaryService ||
      new TransactionSummaryService(
        walletMcpClient,
        walletCacheService,
        this.transactionHistoryService
      );
  }

  /**
   * Executes a balance check by refreshing cached accounts, formatting the balance
   * overview, dispatching the message, and logging operational metrics.
   */
  public async executeCheckBalance(
    event: IncomingUserMessageEvent,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    applicationLogger.mcp('Fetching updated balances...');
    const accounts = await this.walletCacheService.refreshAccounts();
    const dictionary = getDictionary();
    const balanceReplyMessage = formatBalanceSummaryMessage(accounts, dictionary.languageCode);

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, balanceReplyMessage);

    const executionDurationMilliseconds = Date.now() - processingStartTimestamp;
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent balance summary for ${accounts.length} account(s)${viaRoutingSuffix} (${executionDurationMilliseconds}ms).`
    );
  }

  /**
   * Executes a budget check by querying current active budgets and their spend status.
   */
  public async executeCheckBudget(
    event: IncomingUserMessageEvent,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    applicationLogger.mcp('Fetching current budgets...');
    const budgets = await this.walletMcpClient.fetchBudgets();
    const dictionary = getDictionary();
    const budgetReplyMessage = formatBudgetSummaryMessage(budgets, dictionary.languageCode);

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, budgetReplyMessage);

    const executionDurationMilliseconds = Date.now() - processingStartTimestamp;
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgets.length} budget(s)${viaRoutingSuffix} (${executionDurationMilliseconds}ms).`
    );
  }

  /**
   * Executes a transaction history query using parsed or default filter criteria.
   */
  public async executeTransactionHistory(
    event: IncomingUserMessageEvent,
    queryOptions?: TransactionHistoryQueryOptions,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    applicationLogger.mcp('Fetching transaction history page...');
    const dictionary = getDictionary();

    const historyPage = await this.transactionHistoryService.getTransactionHistory(queryOptions);
    const historyReplyMessage = formatTransactionHistoryMessage(historyPage, dictionary.languageCode);

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, historyReplyMessage);

    const executionDurationMilliseconds = Date.now() - processingStartTimestamp;
    const totalCountSuffix = typeof historyPage.total === 'number' ? ` of ${historyPage.total}` : '';
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent transaction history (${historyPage.records.length}${totalCountSuffix})${viaRoutingSuffix} (${executionDurationMilliseconds}ms).`
    );
  }

  /**
   * Executes a transaction summary aggregation query.
   */
  public async executeTransactionSummary(
    event: IncomingUserMessageEvent,
    queryOptions?: TransactionSummaryQueryOptions,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    applicationLogger.mcp('Computing transaction summary aggregation...');
    const dictionary = getDictionary();
    const summaryResult = await this.transactionSummaryService.getTransactionSummary(queryOptions, new Date(processingStartTimestamp));

    const summaryReplyMessage = formatTransactionSummaryMessage(
      summaryResult,
      dictionary.languageCode
    );

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, summaryReplyMessage);

    const executionDurationMilliseconds = Date.now() - processingStartTimestamp;
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent transaction summary for ${summaryResult.transactionCount} transaction(s)${viaRoutingSuffix} (${executionDurationMilliseconds}ms).`
    );
  }

  /**
   * Dispatches the application help and command overview menu.
   */
  public async executeHelpMenu(
    event: IncomingUserMessageEvent,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();
    const dictionary = getDictionary();

    const menuText = [
      dictionary.help.welcomeGuidance,
      '',
      dictionary.help.quickCommandsTitle,
      dictionary.help.commandBalance,
      dictionary.help.commandBudget,
      dictionary.help.commandHistory,
      dictionary.help.commandMenu,
    ].join('\n');

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, menuText);

    const executionDurationMilliseconds = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent help guidance menu via Fast-path (${executionDurationMilliseconds}ms).`
    );
  }
}
