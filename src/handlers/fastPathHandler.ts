import { FastPathAction } from '../utils/fastPathIntentDetector.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { TransactionHistoryService } from '../services/transactionHistoryService.js';
import { TransactionSummaryService } from '../services/transactionSummaryService.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../services/messaging/index.js';
import { FinancialActionExecutor } from '../services/financialActionExecutor.js';
import { PendingTransactionService } from '../services/pendingTransactionService.js';
import {
  FinancialActionRegistry,
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  CheckQueueActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
} from '../actions/index.js';
import {
  TransactionHistoryQueryOptions,
  TransactionSummaryQueryOptions,
} from '../types/walletTypes.js';
import { applicationLogger } from '../utils/logger.js';

export class FastPathHandler {
  private readonly transactionHistoryService: TransactionHistoryService;
  private readonly transactionSummaryService: TransactionSummaryService;
  private readonly financialActionExecutor: FinancialActionExecutor;
  private readonly financialActionRegistry: FinancialActionRegistry;

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    private readonly walletCacheService: WalletCacheService,
    private readonly messagingGateway: MessagingGatewayService,
    transactionHistoryService?: TransactionHistoryService,
    transactionSummaryService?: TransactionSummaryService,
    financialActionExecutor?: FinancialActionExecutor,
    financialActionRegistry?: FinancialActionRegistry,
    pendingTransactionService?: PendingTransactionService
  ) {
    this.transactionHistoryService =
      transactionHistoryService ||
      new TransactionHistoryService(walletMcpClient, walletCacheService);
    this.transactionSummaryService =
      transactionSummaryService ||
      new TransactionSummaryService(this.transactionHistoryService);
    this.financialActionExecutor =
      financialActionExecutor ||
      new FinancialActionExecutor(
        walletMcpClient,
        walletCacheService,
        messagingGateway,
        this.transactionHistoryService,
        this.transactionSummaryService
      );

    if (financialActionRegistry) {
      this.financialActionRegistry = financialActionRegistry;
    } else {
      this.financialActionRegistry = new FinancialActionRegistry();
      this.financialActionRegistry.register(new CheckBalanceActionHandler(this.financialActionExecutor));
      this.financialActionRegistry.register(new CheckBudgetActionHandler(this.financialActionExecutor));
      this.financialActionRegistry.register(new HelpMenuActionHandler(this.financialActionExecutor));
      this.financialActionRegistry.register(new TransactionHistoryActionHandler(this.financialActionExecutor));
      this.financialActionRegistry.register(new TransactionSummaryActionHandler(this.financialActionExecutor));
      if (pendingTransactionService) {
        this.financialActionRegistry.register(
          new CheckQueueActionHandler(pendingTransactionService, messagingGateway)
        );
      }
    }
  }

  /**
   * Handles zero-token instant actions like balance checks, budget status,
   * transaction history, transaction summaries, and help menu via the financial action registry.
   */
  public async handleFastPath(
    event: IncomingUserMessageEvent,
    fastPathAction: FastPathAction,
    processingStartTimestamp: number
  ): Promise<boolean> {
    if (
      typeof fastPathAction === 'object' &&
      fastPathAction !== null &&
      fastPathAction.type === 'TRANSACTION_SUMMARY'
    ) {
      applicationLogger.info('Fast-path matched: TRANSACTION_SUMMARY (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'TRANSACTION_SUMMARY',
        event,
        summaryOptions: fastPathAction.options,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

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
          ? (fastPathAction.options as TransactionHistoryQueryOptions)
          : undefined;
      applicationLogger.info('Fast-path matched: TRANSACTION_HISTORY (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'TRANSACTION_HISTORY',
        event,
        queryOptions: options,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

    if (fastPathAction === 'CHECK_BALANCE') {
      applicationLogger.info('Fast-path matched: CHECK_BALANCE (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'CHECK_BALANCE',
        event,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

    if (fastPathAction === 'CHECK_BUDGET') {
      applicationLogger.info('Fast-path matched: CHECK_BUDGET (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'CHECK_BUDGET',
        event,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

    if (fastPathAction === 'HELP_MENU') {
      applicationLogger.info('Fast-path matched: HELP_MENU (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'HELP_MENU',
        event,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

    if (fastPathAction === 'CHECK_QUEUE') {
      const registryWithCapabilities = this.financialActionRegistry as Partial<FinancialActionRegistry>;
      if (
        typeof registryWithCapabilities.hasHandler === 'function' &&
        !registryWithCapabilities.hasHandler.call(this.financialActionRegistry, 'CHECK_QUEUE')
      ) {
        return false;
      }
      applicationLogger.info('Fast-path matched: CHECK_QUEUE (0 AI tokens consumed)');
      await this.financialActionRegistry.execute({
        action: 'CHECK_QUEUE',
        event,
        processingStartTimestamp,
        routingSource: 'fast-path',
      });
      return true;
    }

    return false;
  }
}
