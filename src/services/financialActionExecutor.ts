import { WalletMcpClientService } from './walletMcpService.js';
import { WalletCacheService } from './walletCacheService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from './messaging/index.js';
import { TransactionHistoryService } from './transactionHistoryService.js';
import { TransactionSummaryService } from './transactionSummaryService.js';
import {
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatTransactionHistoryMessage,
} from '../utils/humanResponseFormatter.js';
import { formatTransactionSummaryMessage } from '../utils/transactionSummaryFormatter.js';
import {
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../types/walletTypes.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';

export interface FinancialActionExecutionContext {
  readonly processingStartTimestamp?: number;
  readonly routingSource?: 'fast-path' | 'ai' | 'direct';
}

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
      new TransactionSummaryService(this.transactionHistoryService);
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

    const freshAccounts = await this.walletCacheService.refreshAccounts();
    const replyMessage = formatBalanceSummaryMessage(freshAccounts);

    const routingDetailSuffix = executionContext?.routingSource === 'fast-path' ? ' (Fast-path)' : '';
    applicationLogger.fileDetail('mcp', `Dispatched Balance Summary Reply${routingDetailSuffix}`, {
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
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent balance summary for ${freshAccounts.length} account(s)${viaRoutingSuffix} (${processingDurationMs}ms).`
    );
  }

  /**
   * Executes a budget check by fetching active budgets, formatting the budget
   * summary, dispatching the message, and logging operational metrics.
   */
  public async executeCheckBudget(
    event: IncomingUserMessageEvent,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    applicationLogger.mcp('Fetching budget status...');

    const budgetList = await this.walletMcpClient.fetchBudgets();
    const replyMessage = formatBudgetSummaryMessage(budgetList);

    const routingDetailSuffix = executionContext?.routingSource === 'fast-path' ? ' (Fast-path)' : '';
    applicationLogger.fileDetail('mcp', `Dispatched Budget Summary Reply${routingDetailSuffix}`, {
      channel: event.channel,
      budgetCount: budgetList.length,
      budgets: budgetList,
      replyText: replyMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);

    const processingDurationMs = Date.now() - processingStartTimestamp;
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgetList.length} budget(s)${viaRoutingSuffix} (${processingDurationMs}ms).`
    );
  }

  /**
   * Executes transaction history retrieval, formatting, and dispatching.
   */
  public async executeTransactionHistory(
    event: IncomingUserMessageEvent,
    queryOptions?: TransactionHistoryQueryOptions,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    applicationLogger.mcp('Fetching transaction history...');

    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();
    const requestReferenceInstant = new Date(processingStartTimestamp);
    const historyPage = await this.transactionHistoryService.getTransactionHistory(
      queryOptions,
      requestReferenceInstant
    );
    const replyMessage = formatTransactionHistoryMessage(historyPage);

    const routingDetailSuffix = executionContext?.routingSource === 'fast-path' ? ' (Fast-path)' : '';
    applicationLogger.fileDetail('mcp', `Dispatched Transaction History Reply${routingDetailSuffix}`, {
      channel: event.channel,
      recordCount: historyPage.records.length,
      total: historyPage.total,
      page: historyPage.page,
      totalPages: historyPage.totalPages,
      sort: historyPage.sort,
      replyText: replyMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);

    const processingDurationMs = Date.now() - processingStartTimestamp;
    const totalCountSuffix = typeof historyPage.total === 'number' ? ` of ${historyPage.total}` : '';
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent transaction history (${historyPage.records.length}${totalCountSuffix})${viaRoutingSuffix} (${processingDurationMs}ms).`
    );
  }

  /**
   * Executes transaction summary retrieval, formatting, and dispatching.
   */
  public async executeTransactionSummary(
    event: IncomingUserMessageEvent,
    summaryOptions: TransactionSummaryQueryOptions,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    applicationLogger.mcp('Fetching transaction summary...');

    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();
    const requestReferenceInstant = new Date(processingStartTimestamp);
    const summaryResult = await this.transactionSummaryService.getTransactionSummary(
      summaryOptions,
      requestReferenceInstant
    );
    const replyMessage = formatTransactionSummaryMessage(summaryResult);

    const routingDetailSuffix = executionContext?.routingSource === 'fast-path' ? ' (Fast-path)' : '';
    applicationLogger.fileDetail('mcp', `Dispatched Transaction Summary Reply${routingDetailSuffix}`, {
      channel: event.channel,
      transactionCount: summaryResult.transactionCount,
      excludedTransferCount: summaryResult.excludedTransferCount,
      currencyCount: summaryResult.totals.length,
      groupBy: summaryResult.groupBy,
      isComplete: summaryResult.isComplete,
      replyText: replyMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);

    const processingDurationMs = Date.now() - processingStartTimestamp;
    const viaRoutingSuffix = executionContext?.routingSource === 'fast-path' ? ' via Fast-path' : '';
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent transaction summary for ${summaryResult.transactionCount} transaction(s)${viaRoutingSuffix} (${processingDurationMs}ms).`
    );
  }

  /**
   * Executes help guidance menu retrieval, formatting, and dispatching.
   */
  public async executeHelpMenu(
    event: IncomingUserMessageEvent,
    executionContext?: FinancialActionExecutionContext
  ): Promise<void> {
    const processingStartTimestamp = executionContext?.processingStartTimestamp ?? Date.now();

    const dictionary = getDictionary();
    const helpGuidanceMessage = [
      dictionary.help.welcomeGuidance,
      '',
      dictionary.help.quickCommandsTitle,
      dictionary.help.commandBalance,
      dictionary.help.commandBudget,
      dictionary.help.commandHistory,
      dictionary.help.commandMenu,
    ].join('\n');

    applicationLogger.fileDetail('chat', 'Dispatched Fast-path Help Guidance Reply', {
      channel: event.channel,
      recipientChatId: event.chatIdentifier,
      replyText: helpGuidanceMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, helpGuidanceMessage);

    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent help guidance menu via Fast-path (${processingDurationMs}ms).`
    );
  }
}
