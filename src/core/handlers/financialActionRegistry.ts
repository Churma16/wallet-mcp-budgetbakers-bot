import {
  FinancialActionContext,
  FinancialActionHandler,
  FinancialActionType,
  UnknownFinancialActionError,
} from '../types.js';
import { applicationLogger } from '../../lib/logger.js';
import { AppContext } from '../context.js';
import { FinancialActionExecutor } from '../executor.js';
import { PendingTransactionService } from '../pending.js';
import { AccountClarificationHandler } from './accountClarificationHandler.js';
import { CategoryClarificationHandler } from './categoryClarificationHandler.js';
import { CreateRecordActionHandler } from './createRecordHandler.js';
import {
  CheckBalanceActionHandler,
  CheckBudgetActionHandler,
  CheckQueueActionHandler,
  HelpMenuActionHandler,
  TransactionHistoryActionHandler,
  TransactionSummaryActionHandler,
} from './readActionHandlers.js';

/**
 * Registry and dispatcher for financial actions.
 * Decouples intent routing from business action execution and provides
 * explicit handler registration, dispatching, and safe unknown-action handling.
 */
export class FinancialActionRegistry {
  private readonly handlers = new Map<FinancialActionType, FinancialActionHandler<any>>();

  /**
   * Registers an action handler for its designated action type.
   * Logs a warning if an existing handler is overwritten.
   */
  public register<TType extends FinancialActionType>(handler: FinancialActionHandler<TType>): void {
    if (this.handlers.has(handler.action)) {
      applicationLogger.warn(
        `[FinancialActionRegistry] Overwriting existing action handler for "${handler.action}".`
      );
    }
    this.handlers.set(handler.action, handler);
  }

  /**
   * Retrieves the registered handler for a specific action type.
   */
  public getHandler<TType extends FinancialActionType>(action: TType): FinancialActionHandler<TType> | undefined {
    return this.handlers.get(action) as FinancialActionHandler<TType> | undefined;
  }

  /**
   * Checks whether a handler is registered for a given action string.
   */
  public hasHandler(action: string): boolean {
    return this.handlers.has(action as FinancialActionType);
  }

  /**
   * Returns a list of all currently registered action types.
   */
  public getAllRegisteredActions(): FinancialActionType[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Dispatches an action context to its registered handler.
   * Fails safely and observably by logging an error and throwing UnknownFinancialActionError
   * if no handler is registered for the action.
   */
  public async execute<TContext extends FinancialActionContext>(context: TContext): Promise<void> {
    const handler = this.handlers.get(context.action);
    if (!handler) {
      applicationLogger.error(
        `[FinancialActionRegistry] No financial action handler registered for action "${context.action}".`
      );
      applicationLogger.fileDetail('error', 'Unregistered Financial Action Execution Attempt', {
        action: context.action,
        channel: context.event.channel,
        senderIdentifier: context.event.senderIdentifier,
        chatIdentifier: context.event.chatIdentifier,
        registeredActions: this.getAllRegisteredActions(),
      });
      throw new UnknownFinancialActionError(context.action);
    }

    await handler.execute(context);
  }

  /**
   * Attempts to dispatch an action context without throwing if unregistered.
   * Returns true if handled, false if no handler was registered.
   */
  public async tryExecute(context: FinancialActionContext): Promise<boolean> {
    const handler = this.handlers.get(context.action);
    if (!handler) {
      applicationLogger.warn(
        `[FinancialActionRegistry] Unregistered action received in tryExecute: "${context.action}".`
      );
      return false;
    }

    await handler.execute(context);
    return true;
  }
}

/**
 * Dependencies required to construct the standard financial action registry.
 */
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
  readonly transactionMessageStore?: AppContext['wallet']['transactionMessages'];
}

/**
 * Creates and populates the default FinancialActionRegistry with standard handlers
 * for balance, budget, help, history, summary, queue, and record creation actions.
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
      dependencies.categoryClarificationConversationService,
      dependencies.transactionMessageStore
    )
  );

  return registry;
}
