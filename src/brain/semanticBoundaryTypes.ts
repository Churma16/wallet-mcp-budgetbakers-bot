import { FinancialActionContext } from '../core/types.js';
import { IncomingUserMessageEvent } from '../gateway/index.js';
import { WalletAccountItem, WalletCategoryItem } from '../wallet/types.js';

export const SEMANTIC_TOOL_ALLOWLIST = {
  get_balance: { access: 'read' },
  get_budgets: { access: 'read' },
  get_transaction_history: { access: 'read' },
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

export interface AcceptedRecordShapeDecision {
  readonly accepted: true;
  readonly record: Record<string, unknown>;
}

export type RecordShapeDecision =
  | AcceptedRecordShapeDecision
  | RejectedSemanticToolBoundaryDecision;

export const ALLOWED_TRANSACTION_ARGUMENT_KEYS = new Set(['records']);
export const ALLOWED_HISTORY_ARGUMENT_KEYS = new Set([
  'accountName',
  'categoryId',
  'categoryName',
  'categoryGroup',
  'isGroupQuery',
  'recordType',
  'startDate',
  'endDate',
  'datePeriod',
  'searchQuery',
  'limit',
  'page',
  'sort',
]);
export const ALLOWED_RECORD_KEYS = new Set([
  'accountId',
  'accountHint',
  'categoryId',
  'categoryHint',
  'amount',
  'recordDate',
  'note',
  'counterParty',
  'labels',
  'labelIds',
  'currency',
  'transfer',
]);
export const ALLOWED_TRANSFER_KEYS = new Set(['pairingMode', 'accountId', 'accountHint', 'counterAmount']);
export const ALLOWED_COUNTER_AMOUNT_KEYS = new Set(['value', 'currencyCode']);
export const MAXIMUM_PROPOSED_RECORDS = 20;
export const MAXIMUM_TEXT_FIELD_LENGTH = 2_000;
export const MAXIMUM_LABELS_PER_RECORD = 20;
export const MAXIMUM_LABEL_LENGTH = 100;

export const RECORDING_COMMAND_PATTERN =
  /^(?:(?:tolong|please|mohon|bisa\s+tolong)\s+)?(?:beli|bayar|catat|tambahkan|tambah|masukkan|record|add|transfer|top\s*up|topup)\b/i;
export const MONETARY_AMOUNT_PATTERN =
  /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b/i;

export const UUID_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const EXPLICIT_NAMED_IDENTIFIER_PATTERN =
  /^(?:acc|account|cat|category)[-_][a-z0-9_-]+$/i;

export function rejectSemanticBoundary(
  code: SemanticToolBoundaryRejectionCode,
  reason: string
): RejectedSemanticToolBoundaryDecision {
  return { accepted: false, code, reason };
}
