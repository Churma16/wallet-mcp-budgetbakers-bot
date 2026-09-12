import { FinancialActionExecutor } from '../services/financialActionExecutor.js';
import { WalletMcpClientService } from '../services/walletMcpService.js';
import { WalletCacheService } from '../services/walletCacheService.js';
import { MessagingGatewayService } from '../services/messaging/index.js';
import { WalletRecordPreparationService } from '../services/walletRecordPreparationService.js';
import { AccountClarificationHandler } from '../handlers/accountClarificationHandler.js';
import { FinancialActionRegistry } from './financialActionRegistry.js';
import {
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
} from './readActionHandlers.js';
import { CreateRecordActionHandler } from './createRecordActionHandler.js';

export * from './types.js';
export * from './financialActionRegistry.js';
export * from './readActionHandlers.js';
export * from './createRecordActionHandler.js';

export interface DefaultFinancialActionRegistryDependencies {
  readonly financialActionExecutor: FinancialActionExecutor;
  readonly walletMcpClient: WalletMcpClientService;
  readonly walletCacheService: WalletCacheService;
  readonly messagingGateway: MessagingGatewayService;
  readonly recordPreparationService: WalletRecordPreparationService;
  readonly accountClarificationHandler: AccountClarificationHandler;
}

/**
 * Creates and initializes a default FinancialActionRegistry populated with all
 * core financial action handlers (balance, budget, help, history, summary, record creation).
 */
export function createDefaultFinancialActionRegistry(
  dependencies: DefaultFinancialActionRegistryDependencies
): FinancialActionRegistry {
  const registry = new FinancialActionRegistry();

  registry.register(new CheckBalanceActionHandler(dependencies.financialActionExecutor));
  registry.register(new CheckBudgetActionHandler(dependencies.financialActionExecutor));
  registry.register(new HelpMenuActionHandler(dependencies.financialActionExecutor));
  registry.register(new TransactionHistoryActionHandler(dependencies.financialActionExecutor));
  registry.register(new TransactionSummaryActionHandler(dependencies.financialActionExecutor));
  registry.register(
    new CreateRecordActionHandler(
      dependencies.walletMcpClient,
      dependencies.walletCacheService,
      dependencies.messagingGateway,
      dependencies.recordPreparationService,
      dependencies.accountClarificationHandler
    )
  );

  return registry;
}
