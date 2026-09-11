import { FastPathAction } from '../utils/fastPathIntentDetector.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { TransactionHistoryService } from '../services/transactionHistoryService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import {
  formatBalanceSummaryMessage,
  formatBudgetSummaryMessage,
  formatTransactionHistoryMessage,
} from '../utils/humanResponseFormatter.js';
import { TransactionHistoryQueryOptions } from '../types/walletTypes.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';

export class FastPathHandler {
  private readonly transactionHistoryService: TransactionHistoryService;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    transactionHistoryService?: TransactionHistoryService
  ) {
    this.transactionHistoryService =
      transactionHistoryService ||
      new TransactionHistoryService(walletMcpClient, walletCacheService);
  }

  /**
   * Handles zero-token instant actions like balance checks, budget status, transaction history, and help menu
   */
  public async handleFastPath(
    event: IncomingUserMessageEvent,
    fastPathAction: FastPathAction,
    processingStartTimestamp: number
  ): Promise<boolean> {
    if (
      (typeof fastPathAction === 'object' &&
        fastPathAction !== null &&
        fastPathAction.type === 'TRANSACTION_HISTORY') ||
      (fastPathAction as unknown) === 'TRANSACTION_HISTORY'
    ) {
      const options =
        typeof fastPathAction === 'object' &&
        fastPathAction !== null &&
        'options' in fastPathAction
          ? fastPathAction.options
          : undefined;
      return await this.handleTransactionHistory(event, options, processingStartTimestamp);
    }

    if (fastPathAction === 'CHECK_BALANCE') {
      return await this.handleCheckBalance(event, processingStartTimestamp);
    }

    if (fastPathAction === 'CHECK_BUDGET') {
      return await this.handleCheckBudget(event, processingStartTimestamp);
    }

    if (fastPathAction === 'HELP_MENU') {
      return await this.handleHelpMenu(event, processingStartTimestamp);
    }

    return false;
  }

  private async handleCheckBalance(
    event: IncomingUserMessageEvent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    applicationLogger.info('Fast-path matched: CHECK_BALANCE (0 AI tokens consumed)');
    applicationLogger.mcp('Fetching updated balances...');

    const freshAccounts = await this.walletCacheService.refreshAccounts();
    const replyMessage = formatBalanceSummaryMessage(freshAccounts);

    applicationLogger.fileDetail('mcp', 'Dispatched Balance Summary Reply (Fast-path)', {
      channel: event.channel,
      freshAccountsCount: freshAccounts.length,
      replyText: replyMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent balance summary for ${freshAccounts.length} account(s) via Fast-path (${processingDurationMs}ms).`
    );

    return true;
  }

  private async handleCheckBudget(
    event: IncomingUserMessageEvent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    applicationLogger.info('Fast-path matched: CHECK_BUDGET (0 AI tokens consumed)');
    applicationLogger.mcp('Fetching budget status...');

    const budgetList = await this.walletMcpClient.fetchBudgets();
    const replyMessage = formatBudgetSummaryMessage(budgetList);

    applicationLogger.fileDetail('mcp', 'Dispatched Budget Summary Reply (Fast-path)', {
      channel: event.channel,
      budgetCount: budgetList.length,
      replyText: replyMessage,
    });

    await this.messagingGateway.sendMessage(event.channel, event.chatIdentifier, replyMessage);
    const processingDurationMs = Date.now() - processingStartTimestamp;
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent budget status summary for ${budgetList.length} budget(s) via Fast-path (${processingDurationMs}ms).`
    );

    return true;
  }

  private async handleTransactionHistory(
    event: IncomingUserMessageEvent,
    options: TransactionHistoryQueryOptions | undefined,
    processingStartTimestamp: number
  ): Promise<boolean> {
    applicationLogger.info('Fast-path matched: TRANSACTION_HISTORY (0 AI tokens consumed)');
    applicationLogger.mcp('Fetching transaction history...');

    const historyPage = await this.transactionHistoryService.getTransactionHistory(options);
    const replyMessage = formatTransactionHistoryMessage(historyPage);

    applicationLogger.fileDetail('mcp', 'Dispatched Transaction History Reply (Fast-path)', {
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
    applicationLogger.success(
      `[${event.channel.toUpperCase()}] Sent transaction history (${historyPage.records.length}${totalCountSuffix}) via Fast-path (${processingDurationMs}ms).`
    );

    return true;
  }

  private async handleHelpMenu(
    event: IncomingUserMessageEvent,
    processingStartTimestamp: number
  ): Promise<boolean> {
    applicationLogger.info('Fast-path matched: HELP_MENU (0 AI tokens consumed)');
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

    return true;
  }
}
