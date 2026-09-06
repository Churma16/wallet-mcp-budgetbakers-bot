import { FastPathAction } from '../utils/fastPathIntentDetector.js';
import { WalletMcpClientService } from '../services/walletMcpClient.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { formatBalanceSummaryMessage, formatBudgetSummaryMessage } from '../utils/humanResponseFormatter.js';
import { getDictionary } from '../i18n/index.js';
import { applicationLogger } from '../utils/logger.js';

export class FastPathHandler {
  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService
  ) {}

  /**
   * Handles zero-token instant actions like balance checks, budget status, and help menu
   */
  public async handleFastPath(
    event: IncomingUserMessageEvent,
    fastPathAction: FastPathAction,
    processingStartTimestamp: number
  ): Promise<boolean> {
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
