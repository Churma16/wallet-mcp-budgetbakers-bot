import { FINANCIAL_ACTION_TYPES, ROUTING_SOURCES } from './constants.js';
import {
  SEMANTIC_TOOL_ALLOWLIST,
  SemanticToolBoundaryDecision,
  SemanticToolBoundaryRequest,
  SemanticToolName,
  rejectSemanticBoundary,
} from './semanticBoundaryTypes.js';
import {
  hasEmptyReadArguments,
  hasTransactionRecordingShape,
  validateSemanticHistoryQueryOptions,
  validateTransactionArguments,
} from './semanticBoundaryValidator.js';

function isAllowlistedToolName(toolName: string): toolName is SemanticToolName {
  return Object.prototype.hasOwnProperty.call(SEMANTIC_TOOL_ALLOWLIST, toolName);
}

/**
 * Guarded trust boundary between semantic model output and deterministic
 * financial action execution.
 *
 * Core Purpose & Responsibility:
 * Validates untrusted semantic tool proposals, verifying authorizations, tool allowlists,
 * argument schemas, and entity references against the deterministic Wallet cache before
 * converting them into trusted application-owned financial action contexts.
 *
 * Architectural Role:
 * Sits between the AI provider layer (model output) and the financial action handlers.
 * It ensures model-directed requests cannot bypass business validations, access unauthorized
 * tools, or execute direct mutations on Wallet MCP without deterministic validation.
 */
export class SemanticToolBoundary {
  public evaluate(request: SemanticToolBoundaryRequest): SemanticToolBoundaryDecision {
    if (!request.authorization.isAuthorized) {
      return rejectSemanticBoundary(
        'UNAUTHORIZED',
        `Semantic tool execution was denied by ${request.authorization.source}.`
      );
    }

    if (!isAllowlistedToolName(request.proposal.tool)) {
      return rejectSemanticBoundary('UNKNOWN_TOOL', 'Semantic tool is not explicitly allowlisted.');
    }

    const tool = request.proposal.tool;
    const access = SEMANTIC_TOOL_ALLOWLIST[tool].access;

    if (tool === 'get_balance') {
      if (!hasEmptyReadArguments(request.proposal.arguments)) {
        return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Balance lookup does not accept model-controlled arguments.');
      }

      return {
        accepted: true,
        tool,
        access,
        context: {
          action: FINANCIAL_ACTION_TYPES.CHECK_BALANCE,
          event: request.event,
          processingStartTimestamp: request.processingStartTimestamp,
          routingSource: ROUTING_SOURCES.AI,
        },
      };
    }

    if (tool === 'get_budgets') {
      if (!hasEmptyReadArguments(request.proposal.arguments)) {
        return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Budget lookup does not accept model-controlled arguments.');
      }

      return {
        accepted: true,
        tool,
        access,
        context: {
          action: FINANCIAL_ACTION_TYPES.CHECK_BUDGET,
          event: request.event,
          processingStartTimestamp: request.processingStartTimestamp,
          routingSource: ROUTING_SOURCES.AI,
        },
      };
    }

    if (tool === 'get_transaction_history') {
      if (hasTransactionRecordingShape(request.event.textPayload)) {
        return rejectSemanticBoundary(
          'INVALID_ARGUMENTS',
          'Transaction-history lookup was denied because the message is structurally shaped like a recording request.'
        );
      }
      const queryOptions = validateSemanticHistoryQueryOptions(
        request.proposal.arguments,
        request.availableCategoryList
      );
      if ('accepted' in queryOptions) {
        return queryOptions;
      }
      return {
        accepted: true,
        tool,
        access,
        context: {
          action: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
          event: request.event,
          queryOptions,
          processingStartTimestamp: request.processingStartTimestamp,
          routingSource: ROUTING_SOURCES.AI,
        },
      };
    }

    const validatedRecords = validateTransactionArguments(
      request.proposal.arguments,
      request.availableAccountList,
      request.availableCategoryList
    );

    if (!Array.isArray(validatedRecords)) {
      return validatedRecords;
    }

    return {
      accepted: true,
      tool,
      access,
      context: {
        action: FINANCIAL_ACTION_TYPES.CREATE_RECORD,
        event: request.event,
        records: validatedRecords,
        processingStartTimestamp: request.processingStartTimestamp,
        routingSource: ROUTING_SOURCES.AI,
        requestReferenceInstant: request.requestReferenceInstant,
      },
    };
  }
}
