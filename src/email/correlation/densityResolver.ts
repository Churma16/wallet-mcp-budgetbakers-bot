import type { PendingTransactionItem } from '../../core/pending.js';
import type { TransactionEvidence } from '../types.js';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  isGenericNote,
  isGenericCategory,
} from '../transactionFusion.js';
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

    const isCandGeneric = isGenericMerchant(cpCandidate);
    const isEvidGeneric = isGenericMerchant(cpEvidence);

    // 1. If one side is generic and the other is specific, the specific one wins immediately
    if (isCandGeneric && !isEvidGeneric && cpEvidence) {
      return cpEvidence;
    }
    if (!isCandGeneric && isEvidGeneric && cpCandidate) {
      return cpCandidate;
    }

    // 2. Check for bank settlement strings vs human merchant names
    const isCandSettlement =
      /([A-Z0-9]+\.COM|[A-Z]{3,}\s*-\s*[A-Z]{2,}|[A-Z\s]+(ID|JAKARTA|KUDUS))/i.test(cpCandidate) &&
      cpCandidate === cpCandidate.toUpperCase();
    const isEvidSettlement =
      /([A-Z0-9]+\.COM|[A-Z]{3,}\s*-\s*[A-Z]{2,}|[A-Z\s]+(ID|JAKARTA|KUDUS))/i.test(cpEvidence) &&
      cpEvidence === cpEvidence.toUpperCase();

    if (isCandSettlement && !isEvidSettlement && cpEvidence) {
      return cpEvidence;
    }
    if (!isCandSettlement && isEvidSettlement && cpCandidate) {
      return cpCandidate;
    }

    // 3. If evidence is an explicit payment/receipt, prefer evidence's merchant name
    if (
      evidenceSourceType === 'EMAIL_PAYMENT' ||
      evidenceSourceType === 'RECEIPT'
    ) {
      if (cpEvidence && !isEvidGeneric) {
        return cpEvidence;
      }
    }

    // 4. If both are specific, check if one is a platform and the other is an itemized merchant
    const platformKeywords = ['grab', 'gojek', 'shopee', 'tokopedia', 'blibli'];
    const isCandPlatform = platformKeywords.some(p => cpCandidate.toLowerCase().includes(p));
    const isEvidPlatform = platformKeywords.some(p => cpEvidence.toLowerCase().includes(p));

    if (isCandPlatform && !isEvidPlatform && cpEvidence) {
      return cpEvidence; // e.g. "d'BestO - RSUD Koja" beats "Grab"
    }
    if (!isCandPlatform && isEvidPlatform && cpCandidate) {
      return cpCandidate; // e.g. "d'BestO - RSUD Koja" beats "Grab"
    }

    // 5. Fallback: Longer, more descriptive name wins
    if (cpEvidence.length > cpCandidate.length) {
      return cpEvidence;
    }
    return cpCandidate || cpEvidence || undefined;
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

    if (isCandGeneric && !isEvidGeneric && evidence.categoryId) {
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
