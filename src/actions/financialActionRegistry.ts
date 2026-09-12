import {
  FinancialActionContext,
  FinancialActionHandler,
  FinancialActionType,
  UnknownFinancialActionError,
} from './types.js';
import { applicationLogger } from '../utils/logger.js';

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
