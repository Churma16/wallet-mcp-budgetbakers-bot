import { FinancialActionContext } from '../../actions/types.js';
import { WalletAccountItem, WalletCategoryItem } from '../../types/walletTypes.js';
import { IncomingUserMessageEvent } from '../messaging/index.js';
import {
  ExtractedFinancialIntent,
  ExtractedFinancialRecordItem,
} from './financialAiProvider.js';

export const SEMANTIC_TOOL_ALLOWLIST = {
  get_balance: { access: 'read' },
  get_budgets: { access: 'read' },
  propose_transaction: { access: 'mutation' },
} as const;

export type SemanticToolName = keyof typeof SEMANTIC_TOOL_ALLOWLIST;
export type SemanticToolAccess = (typeof SEMANTIC_TOOL_ALLOWLIST)[SemanticToolName]['access'];

export interface SemanticToolProposal {
  readonly tool: string;
  readonly arguments: unknown;
}

export interface SemanticToolAuthorizationContext {
  readonly isAuthorized: boolean;
  /**
   * Trusted application-owned provenance. This value must never be copied from
   * model output or user-controlled text.
   */
  readonly source: string;
}

export interface SemanticToolBoundaryRequest {
  readonly proposal: SemanticToolProposal;
  readonly authorization: SemanticToolAuthorizationContext;
  readonly event: IncomingUserMessageEvent;
  readonly availableAccountList: WalletAccountItem[];
  readonly availableCategoryList: WalletCategoryItem[];
  readonly processingStartTimestamp?: number;
  readonly requestReferenceInstant?: Date;
}

export type SemanticToolBoundaryRejectionCode =
  | 'UNAUTHORIZED'
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_ENTITY_REFERENCE';

export interface AcceptedSemanticToolBoundaryDecision {
  readonly accepted: true;
  readonly tool: SemanticToolName;
  readonly access: SemanticToolAccess;
  readonly context: FinancialActionContext;
}

export interface RejectedSemanticToolBoundaryDecision {
  readonly accepted: false;
  readonly code: SemanticToolBoundaryRejectionCode;
  readonly reason: string;
}

export type SemanticToolBoundaryDecision =
  | AcceptedSemanticToolBoundaryDecision
  | RejectedSemanticToolBoundaryDecision;

export interface UntrustedSemanticToolResult<T> {
  readonly trust: 'UNTRUSTED_TOOL_DATA';
  readonly data: T;
}

const ALLOWED_TRANSACTION_ARGUMENT_KEYS = new Set(['records']);
const ALLOWED_RECORD_KEYS = new Set([
  'accountId',
  'categoryId',
  'amount',
  'recordDate',
  'note',
  'counterParty',
  'labels',
  'currency',
]);
const MAXIMUM_PROPOSED_RECORDS = 20;
const MAXIMUM_TEXT_FIELD_LENGTH = 2_000;
const MAXIMUM_LABELS_PER_RECORD = 20;
const MAXIMUM_LABEL_LENGTH = 100;

// Structured identifier recognition is intentionally finite grammar. It is not
// used to infer natural-language meaning.
const UUID_IDENTIFIER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXPLICIT_NAMED_IDENTIFIER_PATTERN = /^(?:acc|account|cat|category)[-_][a-z0-9_-]+$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

function isBoundedString(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > MAXIMUM_TEXT_FIELD_LENGTH) {
    return false;
  }

  return allowEmpty || value.trim().length > 0;
}

function isValidLabels(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= MAXIMUM_LABELS_PER_RECORD &&
    value.every(label =>
      typeof label === 'string' &&
      label.trim().length > 0 &&
      label.length <= MAXIMUM_LABEL_LENGTH
    );
}

function looksLikeExplicitIdentifier(value: string): boolean {
  const trimmedValue = value.trim();
  return UUID_IDENTIFIER_PATTERN.test(trimmedValue) ||
    EXPLICIT_NAMED_IDENTIFIER_PATTERN.test(trimmedValue);
}

function reject(
  code: SemanticToolBoundaryRejectionCode,
  reason: string
): RejectedSemanticToolBoundaryDecision {
  return { accepted: false, code, reason };
}

function validateKnownExplicitIdentifier(
  rawReference: string | undefined,
  knownIds: ReadonlySet<string>,
  referenceType: 'account' | 'category'
): RejectedSemanticToolBoundaryDecision | null {
  if (!rawReference || !looksLikeExplicitIdentifier(rawReference)) {
    return null;
  }

  if (knownIds.has(rawReference.trim())) {
    return null;
  }

  return reject(
    'INVALID_ENTITY_REFERENCE',
    `Proposed ${referenceType} identifier is not present in the deterministic Wallet cache.`
  );
}

function validateAndCloneRecord(
  rawRecord: unknown,
  knownAccountIds: ReadonlySet<string>,
  knownCategoryIds: ReadonlySet<string>
): ExtractedFinancialRecordItem | RejectedSemanticToolBoundaryDecision {
  if (!isPlainObject(rawRecord) || !containsOnlyAllowedKeys(rawRecord, ALLOWED_RECORD_KEYS)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal contains unsupported record fields.');
  }

  if (!isBoundedString(rawRecord.accountId)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal requires a bounded account reference.');
  }

  if (typeof rawRecord.amount !== 'number' || !Number.isFinite(rawRecord.amount)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal amount must be a finite number.');
  }

  if (!isBoundedString(rawRecord.note, true)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal note is malformed or too large.');
  }

  if (rawRecord.categoryId !== undefined && !isBoundedString(rawRecord.categoryId)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal category reference is malformed.');
  }

  if (rawRecord.recordDate !== undefined && !isBoundedString(rawRecord.recordDate)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal record date is malformed.');
  }

  if (rawRecord.counterParty !== undefined && !isBoundedString(rawRecord.counterParty, true)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal counterparty is malformed.');
  }

  if (rawRecord.currency !== undefined) {
    if (typeof rawRecord.currency !== 'string' || !/^[A-Za-z]{3}$/.test(rawRecord.currency.trim())) {
      return reject('INVALID_ARGUMENTS', 'Transaction proposal currency must be a three-letter code.');
    }
  }

  if (rawRecord.labels !== undefined && !isValidLabels(rawRecord.labels)) {
    return reject('INVALID_ARGUMENTS', 'Transaction proposal labels are malformed or exceed limits.');
  }

  const accountReferenceRejection = validateKnownExplicitIdentifier(
    rawRecord.accountId,
    knownAccountIds,
    'account'
  );
  if (accountReferenceRejection) {
    return accountReferenceRejection;
  }

  const categoryReferenceRejection = validateKnownExplicitIdentifier(
    typeof rawRecord.categoryId === 'string' ? rawRecord.categoryId : undefined,
    knownCategoryIds,
    'category'
  );
  if (categoryReferenceRejection) {
    return categoryReferenceRejection;
  }

  return {
    accountId: rawRecord.accountId.trim(),
    categoryId: typeof rawRecord.categoryId === 'string'
      ? rawRecord.categoryId.trim()
      : undefined,
    amount: rawRecord.amount,
    recordDate: typeof rawRecord.recordDate === 'string'
      ? rawRecord.recordDate.trim()
      : undefined,
    note: rawRecord.note,
    counterParty: typeof rawRecord.counterParty === 'string'
      ? rawRecord.counterParty
      : undefined,
    labels: rawRecord.labels ? [...rawRecord.labels] : undefined,
    currency: typeof rawRecord.currency === 'string'
      ? rawRecord.currency.trim().toUpperCase()
      : undefined,
  };
}

function validateTransactionArguments(
  rawArguments: unknown,
  availableAccountList: WalletAccountItem[],
  availableCategoryList: WalletCategoryItem[]
): ExtractedFinancialRecordItem[] | RejectedSemanticToolBoundaryDecision {
  if (
    !isPlainObject(rawArguments) ||
    !containsOnlyAllowedKeys(rawArguments, ALLOWED_TRANSACTION_ARGUMENT_KEYS) ||
    !Array.isArray(rawArguments.records) ||
    rawArguments.records.length === 0 ||
    rawArguments.records.length > MAXIMUM_PROPOSED_RECORDS
  ) {
    return reject(
      'INVALID_ARGUMENTS',
      'Transaction proposal must contain only a bounded non-empty records array.'
    );
  }

  const knownAccountIds = new Set(availableAccountList.map(account => account.id));
  const knownCategoryIds = new Set(availableCategoryList.map(category => category.id));
  const validatedRecords: ExtractedFinancialRecordItem[] = [];

  for (const rawRecord of rawArguments.records) {
    const validatedRecord = validateAndCloneRecord(
      rawRecord,
      knownAccountIds,
      knownCategoryIds
    );

    if ('accepted' in validatedRecord && validatedRecord.accepted === false) {
      return validatedRecord;
    }

    validatedRecords.push(validatedRecord as ExtractedFinancialRecordItem);
  }

  return validatedRecords;
}

function hasEmptyReadArguments(rawArguments: unknown): boolean {
  return isPlainObject(rawArguments) && Object.keys(rawArguments).length === 0;
}

/**
 * Marks data returned by an external semantic tool as untrusted. Callers may
 * feed the data back to a model for summarization, but must never derive
 * authorization or mutation authority from its contents.
 */
export function markSemanticToolResultUntrusted<T>(data: T): UntrustedSemanticToolResult<T> {
  return {
    trust: 'UNTRUSTED_TOOL_DATA',
    data,
  };
}

/**
 * Adapts the current AI intent contract into the narrow semantic capability
 * contract. This adapter is deliberately allowlisted and never accepts a
 * model-supplied MCP tool name.
 */
export function createSemanticToolProposalFromFinancialIntent(
  intent: ExtractedFinancialIntent
): SemanticToolProposal | null {
  switch (intent.action) {
    case 'CHECK_BALANCE':
      return { tool: 'get_balance', arguments: {} };
    case 'CHECK_BUDGET':
      return { tool: 'get_budgets', arguments: {} };
    case 'CREATE_RECORD':
      return {
        tool: 'propose_transaction',
        arguments: { records: intent.records },
      };
    default:
      return null;
  }
}

/**
 * Guarded trust boundary between semantic model output and deterministic
 * financial action execution. The boundary can construct an application-owned
 * action context, but it cannot call Wallet MCP directly.
 */
export class SemanticToolBoundary {
  public evaluate(request: SemanticToolBoundaryRequest): SemanticToolBoundaryDecision {
    if (!request.authorization.isAuthorized) {
      return reject(
        'UNAUTHORIZED',
        `Semantic tool execution was denied by ${request.authorization.source}.`
      );
    }

    if (!(request.proposal.tool in SEMANTIC_TOOL_ALLOWLIST)) {
      return reject('UNKNOWN_TOOL', 'Semantic tool is not explicitly allowlisted.');
    }

    const tool = request.proposal.tool as SemanticToolName;
    const access = SEMANTIC_TOOL_ALLOWLIST[tool].access;

    if (tool === 'get_balance') {
      if (!hasEmptyReadArguments(request.proposal.arguments)) {
        return reject('INVALID_ARGUMENTS', 'Balance lookup does not accept model-controlled arguments.');
      }

      return {
        accepted: true,
        tool,
        access,
        context: {
          action: 'CHECK_BALANCE',
          event: request.event,
          processingStartTimestamp: request.processingStartTimestamp,
          routingSource: 'ai',
        },
      };
    }

    if (tool === 'get_budgets') {
      if (!hasEmptyReadArguments(request.proposal.arguments)) {
        return reject('INVALID_ARGUMENTS', 'Budget lookup does not accept model-controlled arguments.');
      }

      return {
        accepted: true,
        tool,
        access,
        context: {
          action: 'CHECK_BUDGET',
          event: request.event,
          processingStartTimestamp: request.processingStartTimestamp,
          routingSource: 'ai',
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
        action: 'CREATE_RECORD',
        event: request.event,
        records: validatedRecords,
        processingStartTimestamp: request.processingStartTimestamp,
        routingSource: 'ai',
        requestReferenceInstant: request.requestReferenceInstant,
      },
    };
  }
}
