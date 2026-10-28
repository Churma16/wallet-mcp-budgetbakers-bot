import type { PendingTransactionItem } from '../pendingTransactionService.js';
import type { TransactionEvidence } from '../../types/transactionCorrelationTypes.js';
import { CommercePlatformRegistry } from '../../config/commercePlatforms.js';
import { isGenericMerchant } from './merchantClassifier.js';
import { isGenericNote } from './noteClassifier.js';
import { isBankSource } from './transactionSourceClassifier.js';

export interface ResolvedAccountDetails {
  matchedAccountId?: string;
  accountNameHint?: string;
  bankDisplayName?: string;
}

export interface ResolvedCategoryDetails {
  matchedCategoryId?: string;
  matchedCategoryName?: string;
}

/**
 * Resolves account details where authoritative bank source takes precedence over platform wallets or cash.
 */
export function resolveAccount(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence,
  platformRegistry: CommercePlatformRegistry
): ResolvedAccountDetails {
  const isCandidateBank = isBankSource(candidate);
  const isIncomingBank = incoming.sourceType === 'EMAIL_BANK';

  let resolvedAccountId = candidate.matchedAccountId;
  let resolvedAccountName = candidate.accountNameHint;
  let resolvedBankDisplayName = candidate.bankDisplayName;

  const isCandidateAccountPlatform =
    !resolvedAccountName ||
    platformRegistry.isPlatformWallet(resolvedAccountName);

  if (
    isIncomingBank &&
    incoming.accountId &&
    (!isCandidateBank || isCandidateAccountPlatform)
  ) {
    resolvedAccountId = incoming.accountId;
    resolvedAccountName = incoming.accountHint || resolvedAccountName;
    resolvedBankDisplayName = incoming.merchant || incoming.accountHint || resolvedBankDisplayName;
  }

  return {
    matchedAccountId: resolvedAccountId,
    accountNameHint: resolvedAccountName,
    bankDisplayName: resolvedBankDisplayName,
  };
}

/**
 * Resolves merchant / counterparty name where cleaner merchant receipts take precedence.
 */
export function resolveCounterParty(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence
): string | undefined {
  let resolvedCounterParty = candidate.counterParty;
  const isIncomingPayment =
    incoming.sourceType === 'EMAIL_PAYMENT' || incoming.sourceType === 'RECEIPT';

  if (isIncomingPayment && incoming.merchant) {
    resolvedCounterParty = incoming.merchant;
  } else if (
    (!resolvedCounterParty || isGenericMerchant(resolvedCounterParty)) &&
    incoming.merchant &&
    !isGenericMerchant(incoming.merchant)
  ) {
    resolvedCounterParty = incoming.merchant;
  }

  return resolvedCounterParty;
}

/**
 * Resolves note / itemized breakdown where merchant receipt items enrich or take precedence over boilerplate.
 */
export function resolveNote(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence
): string | undefined {
  let resolvedNote = candidate.note;
  if (!incoming.note || incoming.note === candidate.note) {
    return resolvedNote;
  }

  if (!candidate.note) {
    return incoming.note;
  }

  const isCandidateNoteGeneric = isGenericNote(
    candidate.note,
    candidate.counterParty,
    candidate.emailSubject
  );
  const isIncomingNoteGeneric = isGenericNote(
    incoming.note,
    incoming.merchant,
    incoming.sourceId
  );

  if (isCandidateNoteGeneric && !isIncomingNoteGeneric) {
    return incoming.note;
  }
  if (!isCandidateNoteGeneric && isIncomingNoteGeneric) {
    return candidate.note;
  }
  if (incoming.note.includes(candidate.note)) {
    return incoming.note;
  }
  if (candidate.note.includes(incoming.note)) {
    return candidate.note;
  }

  return `${candidate.note} • ${incoming.note}`;
}

/**
 * Resolves transaction category where specific merchant categories take precedence over generic bank categories.
 */
export function resolveCategory(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence
): ResolvedCategoryDetails {
  let resolvedCategoryId = candidate.matchedCategoryId;
  let resolvedCategoryName = candidate.matchedCategoryName;

  if (incoming.categoryId && incoming.categoryName) {
    const isCandidateCategoryGeneric =
      !candidate.matchedCategoryName ||
      candidate.matchedCategoryName.toLowerCase().includes('umum') ||
      candidate.matchedCategoryName.toLowerCase().includes('lain') ||
      candidate.matchedCategoryName.toLowerCase().includes('belanja') ||
      candidate.matchedCategoryName.toLowerCase().includes('shopping') ||
      candidate.matchedCategoryName.toLowerCase().includes('general') ||
      candidate.matchedCategoryName.toLowerCase().includes('other') ||
      candidate.matchedCategoryName.toLowerCase().includes('others') ||
      candidate.matchedCategoryName.toLowerCase() === 'uncategorized';

    if (isCandidateCategoryGeneric) {
      resolvedCategoryId = incoming.categoryId;
      resolvedCategoryName = incoming.categoryName;
    }
  }

  return {
    matchedCategoryId: resolvedCategoryId,
    matchedCategoryName: resolvedCategoryName,
  };
}

/**
 * Combines reference numbers from both candidate and incoming evidence.
 */
export function resolveReferenceNumbers(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence
): string[] {
  return Array.from(
    new Set([
      ...(candidate.referenceNumbers || []),
      ...(candidate.referenceNumber ? [candidate.referenceNumber] : []),
      ...(incoming.referenceNumbers || []),
    ])
  ).filter(Boolean);
}

/**
 * Combines evidence sources from both candidate and incoming evidence.
 */
export function resolveEvidenceSources(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence
): string[] {
  return Array.from(
    new Set([
      ...(candidate.evidenceSources || []),
      incoming.sourceType,
    ])
  ).filter(Boolean);
}

/**
 * Fuses existing candidate state with incoming evidence according to field precedence rules.
 * Ensures arrival order invariance: (Bank + Receipt) produces the same outcome as (Receipt + Bank).
 */
export function fuseCandidateWithEvidence(
  candidate: PendingTransactionItem,
  incoming: TransactionEvidence,
  platformRegistry: CommercePlatformRegistry = CommercePlatformRegistry.getInstance()
): Partial<PendingTransactionItem> {
  const accountDetails = resolveAccount(candidate, incoming, platformRegistry);
  const resolvedCounterParty = resolveCounterParty(candidate, incoming);
  const resolvedNote = resolveNote(candidate, incoming);
  const categoryDetails = resolveCategory(candidate, incoming);
  const mergedReferences = resolveReferenceNumbers(candidate, incoming);
  const mergedSources = resolveEvidenceSources(candidate, incoming);

  const resolvedIsBankSynced = Boolean(
    candidate.isBankSyncedAccount || incoming.isBankSyncedAccount
  );

  return {
    matchedAccountId: accountDetails.matchedAccountId,
    accountNameHint: accountDetails.accountNameHint,
    bankDisplayName: accountDetails.bankDisplayName,
    counterParty: resolvedCounterParty,
    note: resolvedNote,
    matchedCategoryId: categoryDetails.matchedCategoryId,
    matchedCategoryName: categoryDetails.matchedCategoryName,
    referenceNumbers: mergedReferences,
    referenceNumber: mergedReferences[0] || candidate.referenceNumber,
    evidenceSources: mergedSources,
    isBankSyncedAccount: resolvedIsBankSynced,
  };
}
