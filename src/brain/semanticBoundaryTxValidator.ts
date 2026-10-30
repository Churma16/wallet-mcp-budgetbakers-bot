import { ExtractedFinancialRecordItem } from './types.js';
import { WalletAccountItem, WalletCategoryItem } from '../types/walletTypes.js';
import {
  ALLOWED_COUNTER_AMOUNT_KEYS,
  ALLOWED_RECORD_KEYS,
  ALLOWED_TRANSACTION_ARGUMENT_KEYS,
  ALLOWED_TRANSFER_KEYS,
  EXPLICIT_NAMED_IDENTIFIER_PATTERN,
  MAXIMUM_LABELS_PER_RECORD,
  MAXIMUM_LABEL_LENGTH,
  MAXIMUM_PROPOSED_RECORDS,
  MAXIMUM_TEXT_FIELD_LENGTH,
  RecordShapeDecision,
  RejectedSemanticToolBoundaryDecision,
  UUID_IDENTIFIER_PATTERN,
  rejectSemanticBoundary,
} from './semanticBoundaryTypes.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function containsOnlyAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: ReadonlySet<string>
): boolean {
  return Object.keys(value).every(key => allowedKeys.has(key));
}

export function isBoundedString(value: unknown, allowEmpty = false): value is string {
  if (typeof value !== 'string' || value.length > MAXIMUM_TEXT_FIELD_LENGTH) {
    return false;
  }
  return allowEmpty || value.trim().length > 0;
}

function isValidLabels(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAXIMUM_LABELS_PER_RECORD &&
    value.every(
      label => typeof label === 'string' && label.trim().length > 0 && label.length <= MAXIMUM_LABEL_LENGTH
    )
  );
}

function looksLikeExplicitIdentifier(value: string): boolean {
  const trimmedValue = value.trim();
  return UUID_IDENTIFIER_PATTERN.test(trimmedValue) || EXPLICIT_NAMED_IDENTIFIER_PATTERN.test(trimmedValue);
}

function validateKnownExplicitIdentifier(
  rawReference: string | undefined,
  knownIds: ReadonlySet<string>,
  referenceType: 'account' | 'category'
): RejectedSemanticToolBoundaryDecision | null {
  if (!rawReference || knownIds.size === 0 || !looksLikeExplicitIdentifier(rawReference)) {
    return null;
  }
  if (knownIds.has(rawReference.trim())) {
    return null;
  }
  return rejectSemanticBoundary(
    'INVALID_ENTITY_REFERENCE',
    `Proposed ${referenceType} identifier is not present in the deterministic Wallet cache.`
  );
}

export function validateAndCloneRecord(
  rawRecord: unknown,
  knownAccountIds: ReadonlySet<string>,
  knownCategoryIds: ReadonlySet<string>
): RecordShapeDecision {
  if (!isPlainObject(rawRecord) || !containsOnlyAllowedKeys(rawRecord, ALLOWED_RECORD_KEYS)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal contains unsupported record fields.');
  }

  if (rawRecord.accountId !== undefined && !isBoundedString(rawRecord.accountId, true)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal account reference is malformed or too large.');
  }

  if (rawRecord.accountHint !== undefined && !isBoundedString(rawRecord.accountHint, true)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal account hint is malformed or too large.');
  }

  if (rawRecord.categoryHint !== undefined && !isBoundedString(rawRecord.categoryHint, true)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal category hint is malformed or too large.');
  }

  if (
    !(
      (typeof rawRecord.amount === 'number' && Number.isFinite(rawRecord.amount)) ||
      isBoundedString(rawRecord.amount)
    )
  ) {
    return rejectSemanticBoundary(
      'INVALID_ARGUMENTS',
      'Transaction proposal amount must be a finite number or bounded amount string.'
    );
  }

  for (const fieldName of ['categoryId', 'recordDate', 'note', 'counterParty'] as const) {
    const fieldValue = rawRecord[fieldName];
    if (fieldValue !== undefined && !isBoundedString(fieldValue, true)) {
      return rejectSemanticBoundary(
        'INVALID_ARGUMENTS',
        `Transaction proposal ${fieldName} field is malformed or too large.`
      );
    }
  }

  if (rawRecord.currency !== undefined) {
    if (typeof rawRecord.currency !== 'string' || !/^[A-Za-z]{3}$/.test(rawRecord.currency.trim())) {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal currency must be a three-letter code.');
    }
  }

  if (rawRecord.labels !== undefined && !isValidLabels(rawRecord.labels)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal labels are malformed or exceed limits.');
  }

  if (rawRecord.transfer !== undefined) {
    if (
      !isPlainObject(rawRecord.transfer) ||
      !containsOnlyAllowedKeys(rawRecord.transfer, ALLOWED_TRANSFER_KEYS) ||
      rawRecord.transfer.pairingMode !== 'new'
    ) {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal transfer shape is unsupported.');
    }
    for (const fieldName of ['accountId', 'accountHint'] as const) {
      const fieldValue = rawRecord.transfer[fieldName];
      if (fieldValue !== undefined && !isBoundedString(fieldValue, true)) {
        return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal transfer account reference is malformed.');
      }
    }
    if (rawRecord.transfer.counterAmount !== undefined) {
      const counterAmount = rawRecord.transfer.counterAmount;
      if (
        !isPlainObject(counterAmount) ||
        !containsOnlyAllowedKeys(counterAmount, ALLOWED_COUNTER_AMOUNT_KEYS) ||
        typeof counterAmount.value !== 'number' ||
        !Number.isFinite(counterAmount.value) ||
        typeof counterAmount.currencyCode !== 'string' ||
        !/^[A-Za-z]{3}$/.test(counterAmount.currencyCode.trim())
      ) {
        return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction proposal transfer counter amount is malformed.');
      }
    }
    const destinationReferenceRejection = validateKnownExplicitIdentifier(
      typeof rawRecord.transfer.accountId === 'string' ? rawRecord.transfer.accountId : undefined,
      knownAccountIds,
      'account'
    );
    if (destinationReferenceRejection) {
      return destinationReferenceRejection;
    }
  }

  const accountReferenceRejection = validateKnownExplicitIdentifier(
    typeof rawRecord.accountId === 'string' ? rawRecord.accountId : undefined,
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

  const clonedRecord = { ...rawRecord };
  if (!clonedRecord.accountId && typeof clonedRecord.accountHint === 'string') {
    clonedRecord.accountId = clonedRecord.accountHint;
  }
  if (!clonedRecord.categoryId && typeof clonedRecord.categoryHint === 'string') {
    clonedRecord.categoryId = clonedRecord.categoryHint;
  }
  delete clonedRecord.labelIds;
  if (Array.isArray(rawRecord.labels)) {
    clonedRecord.labels = [...rawRecord.labels];
  }
  if (isPlainObject(rawRecord.transfer)) {
    clonedRecord.transfer = {
      ...rawRecord.transfer,
      ...(isPlainObject(rawRecord.transfer.counterAmount)
        ? { counterAmount: { ...rawRecord.transfer.counterAmount } }
        : {}),
    };
  }

  return { accepted: true, record: clonedRecord };
}

export function validateTransactionArguments(
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
    return rejectSemanticBoundary(
      'INVALID_ARGUMENTS',
      'Transaction proposal must contain only a bounded non-empty records array.'
    );
  }

  const knownAccountIds = new Set(availableAccountList.map(account => account.id));
  const knownCategoryIds = new Set(availableCategoryList.map(category => category.id));
  const validatedRecords: ExtractedFinancialRecordItem[] = [];

  for (const rawRecord of rawArguments.records) {
    const recordDecision = validateAndCloneRecord(rawRecord, knownAccountIds, knownCategoryIds);
    if (!recordDecision.accepted) {
      return recordDecision;
    }
    validatedRecords.push(recordDecision.record as unknown as ExtractedFinancialRecordItem);
  }

  return validatedRecords;
}
