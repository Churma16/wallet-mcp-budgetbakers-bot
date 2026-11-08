import type { PendingTransactionItem } from '../../core/pending.js';
import type { TransactionEvidence } from '../types.js';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
  isGenericCategory,
} from './predicates.js';
import { CommercePlatformRegistry } from '../../config/commercePlatforms.js';

export interface ResolvedTransactionFields {
  merchant?: string;
  accountId?: string;
  accountHint?: string;
  categoryId?: string;
  categoryName?: string;
  note?: string;
  referenceNumbers: string[];
  labels: string[];
}

/**
 * Implements the "Richest-Wins Principle" (Information Density Resolution)
 * to merge multi-source evidence into a single high-quality financial record.
 */
export class InformationDensityResolver {
  /**
   * Resolves the cleanest, most specific merchant name.
   * Specific store/restaurant beats platform aggregator, and platform aggregator beats generic debit/unknown.
   */
  public resolveMerchant(
    candidateMerchant?: string | null,
    evidenceMerchant?: string | null,
    candidateNote?: string | null,
    evidenceNote?: string | null,
    evidenceSourceType?: string | null
  ): string | undefined {
    const cpCandidate = (candidateMerchant || '').trim();
    const cpEvidence = (evidenceMerchant || '').trim();

    if (!cpCandidate && !cpEvidence) return undefined;
    if (!cpCandidate) return cpEvidence;
    if (!cpEvidence) return cpCandidate;

    const isCandGeneric = isGenericMerchant(cpCandidate);
    const isEvidGeneric = isGenericMerchant(cpEvidence);

    // 1. Specific beats generic placeholder
    if (isCandGeneric && !isEvidGeneric) {
      return cpEvidence;
    }
    if (!isCandGeneric && isEvidGeneric) {
      return cpCandidate;
    }
    if (isCandGeneric && isEvidGeneric) {
      return cpCandidate || cpEvidence;
    }

    // 2. Explicit itemized payment receipt beats bank acquirer memo
    if (
      (evidenceSourceType === 'EMAIL_PAYMENT' || evidenceSourceType === 'RECEIPT') &&
      !isEvidGeneric
    ) {
      return cpEvidence;
    }

    // 3. Natural mixed-case merchant name beats raw all-caps terminal/gateway settlement string
    // e.g. "Blibli Offline Store" beats "BLIBLI.COM KUDUS - ID"
    const isCandAllCaps =
      cpCandidate.length >= 4 &&
      cpCandidate === cpCandidate.toUpperCase() &&
      /[A-Z]/.test(cpCandidate);
    const isEvidAllCaps =
      cpEvidence.length >= 4 &&
      cpEvidence === cpEvidence.toUpperCase() &&
      /[A-Z]/.test(cpEvidence);
    if (isCandAllCaps && !isEvidAllCaps) {
      return cpEvidence;
    }
    if (!isCandAllCaps && isEvidAllCaps) {
      return cpCandidate;
    }

    // 4. Substring containment: the more specific / descriptive superstring wins
    const lowerCand = cpCandidate.toLowerCase();
    const lowerEvid = cpEvidence.toLowerCase();
    if (lowerCand.includes(lowerEvid) && lowerCand !== lowerEvid) {
      return cpCandidate;
    }
    if (lowerEvid.includes(lowerCand) && lowerCand !== lowerEvid) {
      return cpEvidence;
    }

    // 5. Richest field wins: longer, more descriptive name
    if (cpEvidence.length > cpCandidate.length) {
      return cpEvidence;
    }
    return cpCandidate;
  }

  /**
   * Resolves the authoritative funding account.
   * Concrete bank account ID/name beats generic card network hint (Visa, Mastercard) or platform cash.
   */
  public resolveAccount(
    candidate: { accountId?: string | null; accountHint?: string | null },
    evidence: { accountId?: string | null; accountHint?: string | null }
  ): { accountId?: string; accountHint?: string } {
    const isEvidGenericCard = isGenericCardAccountOrMethod(evidence.accountHint);
    const isCandGenericCard = isGenericCardAccountOrMethod(candidate.accountHint);

    const platformRegistry = CommercePlatformRegistry.getInstance();
    const isCandPlatformOrCash =
      !candidate.accountId ||
      candidate.accountId === 'acc-cash' ||
      (candidate.accountHint ? platformRegistry.isPlatformWallet(candidate.accountHint) : false);

    const isEvidPlatformOrCash =
      !evidence.accountId ||
      evidence.accountId === 'acc-cash' ||
      (evidence.accountHint ? platformRegistry.isPlatformWallet(evidence.accountHint) : false);

    // If one side has an authoritative bank account and other is platform wallet, cash, or generic card hint:
    // the authoritative bank account ALWAYS wins regardless of arrival order!
    if (isCandPlatformOrCash && !isEvidPlatformOrCash && evidence.accountId) {
      return {
        accountId: evidence.accountId,
        accountHint: evidence.accountHint || undefined,
      };
    }

    if (!isCandPlatformOrCash && isEvidPlatformOrCash && candidate.accountId) {
      return {
        accountId: candidate.accountId,
        accountHint: candidate.accountHint || undefined,
      };
    }

    // If candidate has a specific resolved account ID and evidence is generic card hint, candidate wins
    if (candidate.accountId && isEvidGenericCard) {
      return {
        accountId: candidate.accountId,
        accountHint: candidate.accountHint || undefined,
      };
    }

    // Vice versa
    if (evidence.accountId && isCandGenericCard) {
      return {
        accountId: evidence.accountId,
        accountHint: evidence.accountHint || undefined,
      };
    }

    // Default: Prefer candidate's existing matched account if valid, else evidence
    const resolvedId = candidate.accountId || evidence.accountId || undefined;
    const resolvedHint = candidate.accountHint || evidence.accountHint || undefined;
    return { accountId: resolvedId, accountHint: resolvedHint };
  }

  /**
   * Resolves the most concrete category.
   * Specific leaf categories (Food, Ojol, Snacks) beat generic parent categories (Shopping, Unknown, General).
   */
  public resolveCategory(
    candidate: { categoryId?: string | null; categoryName?: string | null },
    evidence: { categoryId?: string | null; categoryName?: string | null }
  ): { categoryId?: string; categoryName?: string } {
    const candCatName = (candidate.categoryName || '').trim();
    const evidCatName = (evidence.categoryName || '').trim();

    const isCandGeneric = isGenericCategory(candCatName) || !candidate.categoryId;
    const isEvidGeneric = isGenericCategory(evidCatName) || !evidence.categoryId;

    if (isCandGeneric && evidence.categoryId && evidCatName) {
      return { categoryId: evidence.categoryId, categoryName: evidCatName };
    }
    if (!isCandGeneric && isEvidGeneric && candidate.categoryId) {
      return { categoryId: candidate.categoryId, categoryName: candCatName };
    }

    // Prefer candidate's category if both specific or both generic
    return {
      categoryId: candidate.categoryId || evidence.categoryId || undefined,
      categoryName: candCatName || evidCatName || undefined,
    };
  }

  /**
   * Resolves the most informative note/description.
   * Itemized breakdown (e.g. "1x Paket Sadas...") beats boilerplate payment descriptions.
   */
  public resolveNote(
    candidateNote?: string | null,
    evidenceNote?: string | null,
    referenceNumbers: string[] = []
  ): string {
    const candNote = (candidateNote || '').trim();
    const evidNote = (evidenceNote || '').trim();

    const isCandGen = isGenericNote(candNote);
    const isEvidGen = isGenericNote(evidNote);

    let baseNote = '';
    if (isCandGen && !isEvidGen && evidNote) {
      baseNote = evidNote;
    } else if (!isCandGen && isEvidGen && candNote) {
      baseNote = candNote;
    } else if (candNote && evidNote) {
      if (candNote.includes(evidNote)) {
        baseNote = candNote;
      } else if (evidNote.includes(candNote)) {
        baseNote = evidNote;
      } else {
        baseNote = `${candNote} • ${evidNote}`;
      }
    } else {
      baseNote = candNote || evidNote;
    }

    return baseNote;
  }

  /**
   * Unifies and deduplicates all unique reference numbers.
   */
  public resolveReferences(
    candidateRefs?: string[] | null,
    evidenceRefs?: string[] | null
  ): string[] {
    const set = new Set<string>();
    const addAll = (refs?: string[] | null) => {
      if (!Array.isArray(refs)) return;
      for (const r of refs) {
        const clean = (r || '').trim().toUpperCase();
        if (clean && clean !== 'UNKNOWN' && clean.length >= 3) {
          set.add(clean);
        }
      }
    };

    addAll(candidateRefs);
    addAll(evidenceRefs);
    return Array.from(set);
  }

  /**
   * Unifies and deduplicates all transaction labels.
   */
  public resolveLabels(
    candidateLabels?: string[] | null,
    evidenceLabels?: string[] | null
  ): string[] {
    const set = new Set<string>();
    const addAll = (labels?: string[] | null) => {
      if (!Array.isArray(labels)) return;
      for (const l of labels) {
        const clean = (l || '').trim().toLowerCase();
        if (clean) set.add(clean);
      }
    };

    addAll(candidateLabels);
    addAll(evidenceLabels);
    return Array.from(set);
  }

  /**
   * Resolves all fields comprehensively from a pending candidate and incoming evidence.
   */
  public resolveAllFields(
    candidate: PendingTransactionItem,
    evidence: TransactionEvidence
  ): ResolvedTransactionFields {
    const references = this.resolveReferences(
      [...(candidate.referenceNumbers || []), ...(candidate.referenceNumber ? [candidate.referenceNumber] : [])],
      evidence.referenceNumbers
    );
    const labels = this.resolveLabels(candidate.labels, evidence.labels);

    const merchant = this.resolveMerchant(
      candidate.counterParty,
      evidence.merchant,
      candidate.note,
      evidence.note,
      evidence.sourceType
    );

    const account = this.resolveAccount(
      { accountId: candidate.matchedAccountId, accountHint: candidate.accountNameHint || candidate.bankDisplayName },
      { accountId: evidence.accountId, accountHint: evidence.accountHint }
    );

    const category = this.resolveCategory(
      { categoryId: candidate.matchedCategoryId, categoryName: candidate.matchedCategoryName },
      { categoryId: evidence.categoryId, categoryName: evidence.categoryName }
    );

    const note = this.resolveNote(candidate.note, evidence.note, references);

    return {
      merchant,
      accountId: account.accountId,
      accountHint: account.accountHint,
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      note,
      referenceNumbers: references,
      labels,
    };
  }

  /**
   * Fuses a pending transaction item with incoming evidence, updating all fields
   * using Information Density Resolution and tracking evidence sources.
   */
  public fusePendingItemWithEvidence(
    candidate: PendingTransactionItem,
    evidence: TransactionEvidence
  ): PendingTransactionItem {
    const resolved = this.resolveAllFields(candidate, evidence);

    const evidenceSourcesSet = new Set<string>(candidate.evidenceSources || [candidate.sourceType]);
    if (evidence.sourceType) {
      evidenceSourcesSet.add(evidence.sourceType);
    }

    const resolvedIsBankSynced = Boolean(
      candidate.isBankSyncedAccount || evidence.isBankSyncedAccount
    );

    return {
      ...candidate,
      counterParty: resolved.merchant || candidate.counterParty,
      matchedAccountId: resolved.accountId || candidate.matchedAccountId,
      accountNameHint: resolved.accountHint || candidate.accountNameHint,
      matchedCategoryId: resolved.categoryId || candidate.matchedCategoryId,
      matchedCategoryName: resolved.categoryName || candidate.matchedCategoryName,
      note: resolved.note || candidate.note,
      referenceNumbers: resolved.referenceNumbers,
      referenceNumber: resolved.referenceNumbers[0] || candidate.referenceNumber,
      labels: resolved.labels,
      evidenceSources: Array.from(evidenceSourcesSet),
      isBankSyncedAccount: resolvedIsBankSynced,
    };
  }
}
