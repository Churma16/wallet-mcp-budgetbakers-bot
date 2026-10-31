import { FINANCIAL_ACTION_TYPES } from './constants.js';
import { ExtractedFinancialIntent } from './types.js';
import { TransactionHistoryQueryOptions, WalletCategoryItem } from '../wallet/types.js';
import {
  extractDynamicCategoryGroups,
  matchDynamicCategoryGroup,
  MAX_GROUP_CATEGORIES_LIMIT,
  DynamicCategoryGroupInfo,
} from '../wallet/transactionHistoryFilterNormalizer.js';
import {
  ALLOWED_HISTORY_ARGUMENT_KEYS,
  MONETARY_AMOUNT_PATTERN,
  RECORDING_COMMAND_PATTERN,
  RejectedSemanticToolBoundaryDecision,
  SemanticToolProposal,
  UntrustedSemanticToolResult,
  rejectSemanticBoundary,
} from './semanticBoundaryTypes.js';
import { containsOnlyAllowedKeys, isBoundedString, isPlainObject } from './semanticBoundaryTxValidator.js';

export function hasEmptyReadArguments(rawArguments: unknown): boolean {
  return isPlainObject(rawArguments) && Object.keys(rawArguments).length === 0;
}

export function hasTransactionRecordingShape(messageText: string | undefined): boolean {
  const normalizedText = messageText?.trim() || '';
  return (
    Boolean(normalizedText) &&
    (RECORDING_COMMAND_PATTERN.test(normalizedText) || MONETARY_AMOUNT_PATTERN.test(normalizedText))
  );
}

export function validateSemanticHistoryQueryOptions(
  rawArguments: unknown,
  availableCategoryList: WalletCategoryItem[] = []
): TransactionHistoryQueryOptions | RejectedSemanticToolBoundaryDecision {
  if (!isPlainObject(rawArguments) || !containsOnlyAllowedKeys(rawArguments, ALLOWED_HISTORY_ARGUMENT_KEYS)) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history proposal contains unsupported fields.');
  }

  const stringFields = ['accountName', 'categoryName', 'categoryGroup', 'startDate', 'endDate', 'searchQuery'] as const;
  for (const field of stringFields) {
    const value = rawArguments[field];
    if (value !== undefined && (!isBoundedString(value) || value.length > 200)) {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', `Transaction-history ${field} is malformed or too large.`);
    }
  }

  if (rawArguments.isGroupQuery !== undefined && typeof rawArguments.isGroupQuery !== 'boolean') {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history isGroupQuery is invalid.');
  }

  const dynamicGroupMap = extractDynamicCategoryGroups(availableCategoryList);
  let resolvedCategoryId: string | string[] | undefined = undefined;
  let resolvedCategoryGroup: string | undefined = undefined;
  let resolvedIsGroupQuery: boolean | undefined = rawArguments.isGroupQuery as boolean | undefined;

  if (rawArguments.categoryGroup !== undefined) {
    const rawGroup = (rawArguments.categoryGroup as string).trim();
    if (rawGroup.length === 0) {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history categoryGroup cannot be empty.');
    }
    const matchResult = matchDynamicCategoryGroup(rawGroup, dynamicGroupMap);
    if (matchResult.status === 'AMBIGUOUS') {
      return rejectSemanticBoundary(
        'INVALID_ENTITY_REFERENCE',
        'Transaction-history categoryGroup is ambiguous in the deterministic Wallet cache.'
      );
    }
    if (matchResult.status === 'NO_MATCH') {
      return rejectSemanticBoundary(
        'INVALID_ENTITY_REFERENCE',
        'Transaction-history categoryGroup is not present in the deterministic Wallet cache.'
      );
    }
    const matchedGroup = matchResult.group!;
    if (matchedGroup.categoryIds.length > MAX_GROUP_CATEGORIES_LIMIT) {
      return rejectSemanticBoundary(
        'INVALID_ARGUMENTS',
        `Transaction-history categoryGroup exceeds maximum supported limit of ${MAX_GROUP_CATEGORIES_LIMIT} categories.`
      );
    }

    resolvedCategoryGroup = matchedGroup.id;
    resolvedCategoryId = [...matchedGroup.categoryIds];
    resolvedIsGroupQuery = true;

    if (rawArguments.categoryId !== undefined) {
      if (!Array.isArray(rawArguments.categoryId)) {
        return rejectSemanticBoundary(
          'INVALID_ARGUMENTS',
          'Transaction-history categoryId must be an array matching the categoryGroup.'
        );
      }
      const proposedSet = new Set(rawArguments.categoryId);
      if (proposedSet.size !== rawArguments.categoryId.length) {
        return rejectSemanticBoundary(
          'INVALID_ARGUMENTS',
          'Transaction-history categoryId array contains duplicate category IDs.'
        );
      }
      const trustedSet = new Set(matchedGroup.categoryIds);
      if (proposedSet.size !== trustedSet.size || !matchedGroup.categoryIds.every(id => proposedSet.has(id))) {
        return rejectSemanticBoundary(
          'INVALID_ENTITY_REFERENCE',
          'Transaction-history categoryId array does not represent a complete trusted category group.'
        );
      }
    }
  } else if (rawArguments.categoryId !== undefined) {
    if (Array.isArray(rawArguments.categoryId)) {
      if (rawArguments.categoryId.length === 0 || rawArguments.categoryId.length > MAX_GROUP_CATEGORIES_LIMIT) {
        return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history categoryId array is empty or too large.');
      }
      const proposedSet = new Set(rawArguments.categoryId);
      if (proposedSet.size !== rawArguments.categoryId.length) {
        return rejectSemanticBoundary(
          'INVALID_ARGUMENTS',
          'Transaction-history categoryId array contains duplicate category IDs.'
        );
      }
      for (const idEntry of rawArguments.categoryId) {
        if (!isBoundedString(idEntry) || idEntry.length > 200) {
          return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history categoryId contains invalid identifier.');
        }
        if (!availableCategoryList.some(category => category.id === idEntry)) {
          return rejectSemanticBoundary(
            'INVALID_ENTITY_REFERENCE',
            'Transaction-history categoryId is not present in the deterministic Wallet cache.'
          );
        }
      }

      if (dynamicGroupMap.size === 0) {
        return rejectSemanticBoundary(
          'INVALID_ENTITY_REFERENCE',
          'Transaction-history multi-category arrays require trusted category group metadata, which is not available in the deterministic Wallet cache.'
        );
      }

      const firstCatId = rawArguments.categoryId[0];
      let matchedGroup: DynamicCategoryGroupInfo | undefined = undefined;
      for (const groupEntry of dynamicGroupMap.values()) {
        if (groupEntry.categoryIds.includes(firstCatId)) {
          matchedGroup = groupEntry;
          break;
        }
      }

      if (!matchedGroup) {
        return rejectSemanticBoundary(
          'INVALID_ENTITY_REFERENCE',
          'Transaction-history categoryId array does not belong to any trusted category group.'
        );
      }

      for (const idEntry of rawArguments.categoryId) {
        if (!matchedGroup.categoryIds.includes(idEntry)) {
          return rejectSemanticBoundary(
            'INVALID_ENTITY_REFERENCE',
            'Transaction-history categoryId array contains categories from multiple distinct groups.'
          );
        }
      }

      const trustedSet = new Set(matchedGroup.categoryIds);
      if (proposedSet.size !== trustedSet.size || !matchedGroup.categoryIds.every(id => proposedSet.has(id))) {
        return rejectSemanticBoundary(
          'INVALID_ENTITY_REFERENCE',
          'Transaction-history categoryId array does not represent a complete trusted category group.'
        );
      }

      resolvedCategoryGroup = matchedGroup.id;
      resolvedIsGroupQuery = true;
      resolvedCategoryId = [...rawArguments.categoryId];
    } else if (isBoundedString(rawArguments.categoryId) && rawArguments.categoryId.length <= 200) {
      if (!availableCategoryList.some(category => category.id === rawArguments.categoryId)) {
        return rejectSemanticBoundary(
          'INVALID_ENTITY_REFERENCE',
          'Transaction-history categoryId is not present in the deterministic Wallet cache.'
        );
      }
      if (rawArguments.isGroupQuery === true) {
        return rejectSemanticBoundary(
          'INVALID_ARGUMENTS',
          'Transaction-history isGroupQuery requires categoryGroup to identify the target category group, not a single categoryId.'
        );
      }
      resolvedCategoryId = rawArguments.categoryId;
    } else {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history categoryId is malformed or too large.');
    }
  }

  if (rawArguments.isGroupQuery === true && resolvedCategoryGroup === undefined) {
    return rejectSemanticBoundary(
      'INVALID_ARGUMENTS',
      'Transaction-history isGroupQuery requires a resolvable categoryGroup identity.'
    );
  }

  let matchedCategoryName: string | undefined = undefined;

  if (rawArguments.categoryName !== undefined) {
    const normalizedCategoryName = (rawArguments.categoryName as string).trim().toLowerCase();
    const exactNameMatches = availableCategoryList.filter(
      category => category.name.trim().toLowerCase() === normalizedCategoryName
    );

    if (resolvedCategoryId !== undefined) {
      if (typeof resolvedCategoryId === 'string') {
        const selectedCategory = availableCategoryList.find(
          category => category.id === resolvedCategoryId
        );
        if (selectedCategory?.name.trim().toLowerCase() !== normalizedCategoryName) {
          return rejectSemanticBoundary(
            'INVALID_ENTITY_REFERENCE',
            'Transaction-history categoryId does not match categoryName in the deterministic Wallet cache.'
          );
        }
        matchedCategoryName = selectedCategory.name;
      }
    } else if (exactNameMatches.length === 0) {
      return rejectSemanticBoundary(
        'INVALID_ENTITY_REFERENCE',
        'Transaction-history categoryName is not present in the deterministic Wallet cache.'
      );
    } else if (exactNameMatches.length > 1) {
      return rejectSemanticBoundary(
        'INVALID_ENTITY_REFERENCE',
        'Transaction-history categoryName is ambiguous in the deterministic Wallet cache.'
      );
    } else {
      resolvedCategoryId = exactNameMatches[0].id;
      matchedCategoryName = exactNameMatches[0].name;
    }
  }

  if (rawArguments.recordType !== undefined && !['expense', 'income'].includes(String(rawArguments.recordType))) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history record type is invalid.');
  }
  if (
    rawArguments.datePeriod !== undefined &&
    !['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_year'].includes(
      String(rawArguments.datePeriod)
    )
  ) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history date period is invalid.');
  }
  if (rawArguments.sort !== undefined && !['newest', 'oldest'].includes(String(rawArguments.sort))) {
    return rejectSemanticBoundary('INVALID_ARGUMENTS', 'Transaction-history sort is invalid.');
  }
  for (const field of ['limit', 'page'] as const) {
    const value = rawArguments[field];
    if (value !== undefined && (!Number.isInteger(value) || Number(value) <= 0)) {
      return rejectSemanticBoundary('INVALID_ARGUMENTS', `Transaction-history ${field} is invalid.`);
    }
  }

  return {
    ...rawArguments,
    ...(resolvedCategoryId !== undefined ? { categoryId: resolvedCategoryId } : {}),
    ...(resolvedCategoryGroup !== undefined ? { categoryGroup: resolvedCategoryGroup } : {}),
    ...(resolvedIsGroupQuery !== undefined ? { isGroupQuery: resolvedIsGroupQuery } : {}),
    ...(matchedCategoryName !== undefined ? { categoryName: matchedCategoryName } : {}),
  } as TransactionHistoryQueryOptions;
}

export function markSemanticToolResultUntrusted<T>(data: T): UntrustedSemanticToolResult<T> {
  return {
    trust: 'UNTRUSTED_TOOL_DATA',
    data,
  };
}

export function createSemanticToolProposalFromFinancialIntent(
  intent: ExtractedFinancialIntent
): SemanticToolProposal | null {
  switch (intent.action) {
    case FINANCIAL_ACTION_TYPES.CHECK_BALANCE:
      return { tool: 'get_balance', arguments: {} };
    case FINANCIAL_ACTION_TYPES.CHECK_BUDGET:
      return { tool: 'get_budgets', arguments: {} };
    case FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY:
      return { tool: 'get_transaction_history', arguments: intent.queryOptions };
    case FINANCIAL_ACTION_TYPES.CREATE_RECORD:
      if (!Array.isArray(intent.records) || intent.records.length === 0) {
        return null;
      }
      return {
        tool: 'propose_transaction',
        arguments: { records: intent.records },
      };
    default:
      return null;
  }
}
