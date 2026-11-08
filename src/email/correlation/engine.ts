import type { PendingTransactionItem } from '../../core/pending.js';
import type { WalletRecordItem } from '../../wallet/types.js';
import type { TransactionEvidence, CorrelationResult, CorrelationMatchTarget } from '../types.js';
import { INTERNAL_TRANSACTION_TYPES, WALLET_MCP_RECORD_TYPES } from '../../wallet/constants.js';
import { CommercePlatformRegistry } from '../../config/commercePlatforms.js';
import { isGenericMerchant, isGenericCardAccountOrMethod } from './predicates.js';
import { InboundReferenceRegistry, normalizeReferenceNumber } from '../../core/referenceRegistry.js';
import { TransactionMessageStore } from '../../wallet/records/transactionMessageStore.js';
import { InformationDensityResolver } from './densityResolver.js';
import {
  DEFAULT_CORRELATION_WEIGHTS,
  DEFAULT_TIME_HALF_LIFE_MS,
  DEFAULT_MAX_CORRELATION_WINDOW_MS,
  DEFAULT_HIGH_CONFIDENCE_THRESHOLD,
  DEFAULT_MEDIUM_CONFIDENCE_THRESHOLD,
  DEFAULT_DISAMBIGUATION_DELTA,
  ScoringWeights,
  CorrelationDimensionScores,
  Gate1Result,
  Gate2Result,
  ScoredCandidate,
  EngineCorrelationResult,
} from './types.js';

export interface CorrelationEngineDependencies {
  platformRegistry?: CommercePlatformRegistry;
  referenceRegistry?: InboundReferenceRegistry;
  transactionMessageStore?: TransactionMessageStore;
  densityResolver?: InformationDensityResolver;
}

export interface CorrelationEngineOptions {
  weights?: ScoringWeights;
  timeHalfLifeMs?: number;
  maxWindowMs?: number;
  maxCorrelationWindowMilliseconds?: number;
  tightWindowMs?: number;
  tightWindowMilliseconds?: number;
  highThreshold?: number;
  mediumThreshold?: number;
  disambiguationDelta?: number;
  platformRegistry?: CommercePlatformRegistry;
}

const GENERIC_FINANCIAL_TOKENS = new Set([
  'pembayaran',
  'payment',
  'transaksi',
  'transaction',
  'transfer',
  'debit',
  'kredit',
  'credit',
  'card',
  'kartu',
  'masuk',
  'keluar',
  'uang',
  'money',
  'edc',
  'pos',
  'qris',
  'merchant',
  'unknown',
  'dana',
  'gopay',
  'ovo',
  'shopeepay',
  'linkaja',
  'cash',
  'tunai',
  'bank',
  'livin',
  'jago',
  'bca',
  'mandiri',
  'bni',
  'bri',
  'cimb',
]);

/**
 * Unified Multi-Signal Transaction Correlation & Scoring Engine.
 * Combines fail-fast boundary gates, deterministic reference ID resolution,
 * continuous exponential decay scoring, and information density resolution.
 */
export class TransactionCorrelationEngine {
  private readonly platformRegistry: CommercePlatformRegistry;
  private readonly referenceRegistry: InboundReferenceRegistry;
  private readonly densityResolver: InformationDensityResolver;
  private readonly transactionMessageStore?: TransactionMessageStore;
  private readonly weights: ScoringWeights;
  private readonly timeHalfLifeMs: number;
  private readonly maxWindowMs: number;
  private readonly highThreshold: number;
  private readonly mediumThreshold: number;
  private readonly disambiguationDelta: number;

  constructor(
    depsOrOptions?: CorrelationEngineDependencies | (CorrelationEngineDependencies & CorrelationEngineOptions),
    options?: CorrelationEngineOptions
  ) {
    const isSingleArg =
      !options &&
      depsOrOptions &&
      ('maxWindowMs' in depsOrOptions ||
        'maxCorrelationWindowMilliseconds' in depsOrOptions ||
        'platformRegistry' in depsOrOptions);
    const deps = isSingleArg
      ? (depsOrOptions as CorrelationEngineDependencies)
      : (depsOrOptions as CorrelationEngineDependencies) ?? {};
    const opts =
      options ?? (isSingleArg ? (depsOrOptions as CorrelationEngineOptions) : {});

    this.platformRegistry =
      deps.platformRegistry ?? opts.platformRegistry ?? CommercePlatformRegistry.getInstance();
    this.referenceRegistry =
      deps.referenceRegistry ?? InboundReferenceRegistry.getInstance();
    this.densityResolver = deps.densityResolver ?? new InformationDensityResolver();
    this.transactionMessageStore = deps.transactionMessageStore;
    this.weights = opts.weights ?? DEFAULT_CORRELATION_WEIGHTS;
    this.timeHalfLifeMs = opts.timeHalfLifeMs ?? DEFAULT_TIME_HALF_LIFE_MS;
    this.maxWindowMs =
      opts.maxWindowMs ??
      opts.maxCorrelationWindowMilliseconds ??
      DEFAULT_MAX_CORRELATION_WINDOW_MS;
    this.highThreshold = opts.highThreshold ?? DEFAULT_HIGH_CONFIDENCE_THRESHOLD;
    this.mediumThreshold = opts.mediumThreshold ?? DEFAULT_MEDIUM_CONFIDENCE_THRESHOLD;
    this.disambiguationDelta = opts.disambiguationDelta ?? DEFAULT_DISAMBIGUATION_DELTA;
  }

  /**
   * Evaluates incoming evidence against existing pending candidates and recent Wallet records.
   */
  public correlateEvidence(
    incomingEvidence: TransactionEvidence,
    existingPendingItems: PendingTransactionItem[] = [],
    recentWalletRecords: WalletRecordItem[] = []
  ): EngineCorrelationResult {
    return this.correlate(incomingEvidence, existingPendingItems, recentWalletRecords);
  }

  /**
   * Gate 1: Boundary validation (Amount, Currency, Direction, Maximum Window).
   */
  public evaluateGate1(
    candidate: PendingTransactionItem | WalletRecordItem,
    evidence: TransactionEvidence
  ): Gate1Result {
    // 1. Currency equality
    const candCurrency = ((candidate as any).currency || 'IDR').toUpperCase();
    const evidCurrency = (evidence.currency || 'IDR').toUpperCase();
    if (candCurrency !== evidCurrency) {
      return { passed: false, reason: `Currency mismatch (${candCurrency} vs ${evidCurrency})` };
    }

    // 2. Amount absolute equality
    const candAmount = Math.abs(candidate.amount);
    const evidAmount = Math.abs(evidence.amount);
    if (candAmount !== evidAmount) {
      return { passed: false, reason: `Amount mismatch (${candAmount} vs ${evidAmount})` };
    }

    // 3. Direction / Sign compatibility
    const isEvidTransfer = evidence.transactionType === INTERNAL_TRANSACTION_TYPES.TRANSFER;
    const isCandTransfer =
      'transfer' in candidate
        ? Boolean(candidate.transfer)
        : 'recordType' in candidate
          ? candidate.recordType === WALLET_MCP_RECORD_TYPES.TRANSFER || Boolean(candidate.transfer)
          : false;

    if (isEvidTransfer !== isCandTransfer) {
      // Transfer vs non-transfer only valid if proposing counterpart pairing
      const isPotentialCounterpart =
        Boolean(evidence.destinationAccountId) || Boolean(evidence.destinationAccountHint);
      if (!isPotentialCounterpart) {
        return { passed: false, reason: 'Transaction direction mismatch (transfer vs non-transfer)' };
      }
    } else if (!isEvidTransfer) {
      const candRawAmount = candidate.amount;
      const candIsExpense =
        'recordType' in candidate
          ? candidate.recordType === WALLET_MCP_RECORD_TYPES.EXPENSE
          : 'transactionType' in candidate
            ? candidate.transactionType === INTERNAL_TRANSACTION_TYPES.EXPENSE
            : candRawAmount < 0;

      const evidIsExpense =
        evidence.transactionType
          ? evidence.transactionType === INTERNAL_TRANSACTION_TYPES.EXPENSE
          : evidence.amount < 0;

      if (candIsExpense !== evidIsExpense) {
        return { passed: false, reason: 'Transaction sign mismatch (income vs expense)' };
      }
    }

    // 4. Maximum Window check (default 120 mins)
    const candTime = new Date('recordDate' in candidate ? candidate.recordDate : (candidate as any).occurredAt).getTime();
    const evidTime = new Date(evidence.occurredAt).getTime();
    const timeDeltaMs = Math.abs(candTime - evidTime);

    if (timeDeltaMs > this.maxWindowMs) {
      return { passed: false, reason: `Exceeded maximum correlation window (${Math.round(timeDeltaMs / 60000)}m > ${Math.round(this.maxWindowMs / 60000)}m)` };
    }

    return { passed: true };
  }

  /**
   * Gate 2: Deterministic Reference ID Matching across shared registry and candidate sources.
   */
  public evaluateGate2(
    candidate: PendingTransactionItem | WalletRecordItem,
    evidence: TransactionEvidence
  ): Gate2Result {
    const evidenceRefs = (evidence.referenceNumbers || [])
      .map(normalizeReferenceNumber)
      .filter(r => r.length >= 3 && r !== 'UNKNOWN');

    if (evidenceRefs.length === 0) {
      return { matched: false, reasons: [] };
    }

    // Check candidate's own references and notes
    const isPending = 'ticketId' in candidate;
    const candRefs: string[] = [];

    if (isPending) {
      const p = candidate as PendingTransactionItem;
      if (p.referenceNumber) candRefs.push(normalizeReferenceNumber(p.referenceNumber));
      if (Array.isArray(p.referenceNumbers)) {
        p.referenceNumbers.forEach(r => candRefs.push(normalizeReferenceNumber(r)));
      }
    } else {
      const r = candidate as WalletRecordItem;
      candRefs.push(normalizeReferenceNumber(r.id));
      // Check message store mapping if available
      const messageMapping = this.transactionMessageStore?.findMappingByReference(evidenceRefs[0]);
      if (messageMapping && messageMapping.mapping.recordId === r.id) {
        return {
          matched: true,
          matchedReference: evidenceRefs[0],
          matchTarget: { type: 'WALLET_RECORD', record: r },
          suggestedAction: 'ATTACH_WALLET_RECORD',
          reasons: [`Persistent mapping matched reference ID (${evidenceRefs[0]}) to record (${r.id})`],
        };
      }
    }

    const candNoteUpper = ((candidate.note || '') + ' ' + ((candidate as any).counterParty || '')).toUpperCase();

    for (const ref of evidenceRefs) {
      // Direct ref equality
      if (candRefs.includes(ref) || candNoteUpper.includes(ref)) {
        if (isPending) {
          return {
            matched: true,
            matchedReference: ref,
            matchTarget: { type: 'PENDING_TRANSACTION', pendingItem: candidate as PendingTransactionItem },
            suggestedAction: 'MERGE_PENDING',
            reasons: [`Identical reference number: ${ref}`],
          };
        } else {
          return {
            matched: true,
            matchedReference: ref,
            matchTarget: { type: 'WALLET_RECORD', record: candidate as WalletRecordItem },
            suggestedAction: 'ATTACH_WALLET_RECORD',
            reasons: [`Matching reference ID in existing Wallet record (${ref})`],
          };
        }
      }

      // Check shared reference registry
      const regRecordId = this.referenceRegistry.getRecordIdForReference(ref);
      if (regRecordId && !isPending && (candidate as WalletRecordItem).id === regRecordId) {
        return {
          matched: true,
          matchedReference: ref,
          matchTarget: { type: 'WALLET_RECORD', record: candidate as WalletRecordItem },
          suggestedAction: 'ATTACH_WALLET_RECORD',
          reasons: [`Shared reference registry matched booking ID (${ref}) to record (${regRecordId})`],
        };
      }

      const regTicketId = this.referenceRegistry.getTicketIdForReference(ref);
      if (regTicketId && isPending && (candidate as PendingTransactionItem).ticketId === regTicketId) {
        return {
          matched: true,
          matchedReference: ref,
          matchTarget: { type: 'PENDING_TRANSACTION', pendingItem: candidate as PendingTransactionItem },
          suggestedAction: 'MERGE_PENDING',
          reasons: [`Shared reference registry matched reference ID (${ref}) to ticket #${regTicketId}`],
        };
      }
    }

    return { matched: false, reasons: [] };
  }

  /**
   * Calculates continuous dimension scores across Account, Time Decay, and Merchant Token Overlap.
   */
  public calculateDimensionScores(
    candidate: PendingTransactionItem | WalletRecordItem,
    evidence: TransactionEvidence
  ): CorrelationDimensionScores {
    const reasons: string[] = [];

    // --- 1. Account & Instrument Compatibility (Weight: 0.40) ---
    const candAccountId = 'matchedAccountId' in candidate ? candidate.matchedAccountId : candidate.accountId;
    const candAccountHint = 'accountNameHint' in candidate ? candidate.accountNameHint : (candidate as any).accountName;
    const isEvidCashOrPlatform = !evidence.accountId || evidence.accountId === 'acc-cash' || this.platformRegistry.isPlatformWallet(evidence.accountHint);
    const isCandCashOrPlatform = !candAccountId || candAccountId === 'acc-cash' || this.platformRegistry.isPlatformWallet(candAccountHint);

    let sAccount = 0.5;
    if (candAccountId && evidence.accountId && candAccountId === evidence.accountId) {
      sAccount = 1.0;
      reasons.push('Exact account ID match');
    } else if (
      isGenericCardAccountOrMethod(evidence.accountHint) ||
      (evidence.note || '').toLowerCase().includes('visa') ||
      (evidence.note || '').toLowerCase().includes('mastercard')
    ) {
      // Evidence is a card network charge on matching card account
      sAccount = 0.95;
      reasons.push('Card instrument mapping to account');
    } else if (isEvidCashOrPlatform || isCandCashOrPlatform) {
      sAccount = 0.90;
      reasons.push('Compatible platform wallet, cash, or unlinked instrument');
    } else if (candAccountId && evidence.accountId && candAccountId !== evidence.accountId) {
      sAccount = 0.0;
      reasons.push('Conflicting authoritative bank accounts');
    }

    // --- 2. Exponential Time Decay (Weight: 0.35) ---
    const candTime = new Date('recordDate' in candidate ? candidate.recordDate : (candidate as any).occurredAt).getTime();
    const evidTime = new Date(evidence.occurredAt).getTime();
    const timeDeltaMs = Math.abs(candTime - evidTime);
    const sTime = Math.exp(-timeDeltaMs / this.timeHalfLifeMs);
    reasons.push(`Time decay ${Math.round(timeDeltaMs / 60000)}m (score ${sTime.toFixed(2)})`);

    // --- 3. Merchant & Literal Token Overlap (Weight: 0.25) ---
    const candMerchant = ('counterParty' in candidate ? candidate.counterParty : '') || '';
    const candNote = candidate.note || '';
    const evidMerchant = evidence.merchant || '';
    const evidNote = evidence.note || '';

    const candText = `${candMerchant} ${candNote}`.toLowerCase().trim();
    const evidText = `${evidMerchant} ${evidNote}`.toLowerCase().trim();

    let sMerchant = 0.20;

    // Check distinct conflicting stores veto (e.g. Starbucks vs Indomaret)
    const isDistinctConflict = this.detectConflictingStores(candMerchant, evidMerchant, candNote, evidNote);
    if (isDistinctConflict) {
      sMerchant = -1.0;
      reasons.push(`Distinct conflicting stores veto (${candMerchant} vs ${evidMerchant})`);
    } else {
      // Token overlap check excluding generic financial stop words
      const candTokens = candText
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3 && !GENERIC_FINANCIAL_TOKENS.has(t));
      const evidTokens = evidText
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3 && !GENERIC_FINANCIAL_TOKENS.has(t));

      const hasTokenMatch = candTokens.some(ct =>
        evidTokens.some(et => ct === et || ct.includes(et) || et.includes(ct))
      );
      const hasSubstringMatch =
        (candMerchant.length >= 3 &&
          !GENERIC_FINANCIAL_TOKENS.has(candMerchant.toLowerCase()) &&
          evidText.includes(candMerchant.toLowerCase())) ||
        (evidMerchant.length >= 3 &&
          !GENERIC_FINANCIAL_TOKENS.has(evidMerchant.toLowerCase()) &&
          candText.includes(evidMerchant.toLowerCase()));

      const isCandGeneric = isGenericMerchant(candMerchant);
      const isEvidGeneric = isGenericMerchant(evidMerchant);

      const isPending = 'ticketId' in candidate;
      const isDualChannelBank =
        isPending &&
        candAccountId &&
        evidence.accountId &&
        candAccountId === evidence.accountId &&
        ((candidate.sourceType === 'PUSH_NOTIFICATION' && evidence.sourceType === 'EMAIL_BANK') ||
          (candidate.evidenceSources?.includes('PUSH_NOTIFICATION') && evidence.sourceType === 'EMAIL_BANK') ||
          (candidate.sourceType === 'EMAIL' && evidence.sourceType === 'PUSH_NOTIFICATION'));

      if (hasTokenMatch || hasSubstringMatch) {
        sMerchant = 1.0;
        reasons.push('Literal merchant token overlap / substring containment');
      } else if (isDualChannelBank) {
        sMerchant = 0.85;
        reasons.push('Identical bank debit across push notification and email channels');
      } else if ((isCandGeneric && !isEvidGeneric) || (!isCandGeneric && isEvidGeneric)) {
        sMerchant = 0.85;
        reasons.push('Generic bank debit placeholder paired with specific merchant receipt');
      } else if (isCandGeneric && isEvidGeneric) {
        sMerchant = 0.0;
        reasons.push('Both candidate and evidence are generic debit placeholders');
      } else {
        reasons.push('Uncorrelated merchant text');
      }
    }

    // Composite Calculation
    let composite = 0.0;
    if (sMerchant < 0) {
      composite = 0.0; // Veto halts matching immediately
    } else {
      composite =
        this.weights.account * sAccount +
        this.weights.time * sTime +
        this.weights.merchant * sMerchant;
    }

    return {
      account: sAccount,
      time: sTime,
      merchant: sMerchant,
      composite: Math.min(1.0, Math.max(0.0, composite)),
      reasons,
    };
  }

  /**
   * Evaluates incoming evidence against multiple candidate records or pending items,
   * applying boundary gates, reference locks, scoring, and multi-candidate disambiguation.
   */
  public correlate(
    evidence: TransactionEvidence,
    pendingItems: PendingTransactionItem[] = [],
    walletRecords: WalletRecordItem[] = []
  ): EngineCorrelationResult {
    // Stage 1: Try Gate 2 Deterministic Reference Match first across all candidates
    for (const record of walletRecords) {
      const g1 = this.evaluateGate1(record, evidence);
      if (g1.passed) {
        const g2 = this.evaluateGate2(record, evidence);
        if (g2.matched) {
          return {
            confidence: 'HIGH',
            matchTarget: g2.matchTarget!,
            reasons: g2.reasons,
            suggestedAction: g2.suggestedAction || 'ATTACH_WALLET_RECORD',
          };
        }
      }
    }

    // Transfer pairing counterpart check (pairingMode: 'existing')
    const transferPairingResult = this.checkTransferPairingCounterpart(evidence, walletRecords);
    if (transferPairingResult) {
      return transferPairingResult;
    }

    for (const pending of pendingItems) {
      const g1 = this.evaluateGate1(pending, evidence);
      if (g1.passed) {
        const g2 = this.evaluateGate2(pending, evidence);
        if (g2.matched) {
          const fused = this.densityResolver.fusePendingItemWithEvidence(pending, evidence);
          return {
            confidence: 'HIGH',
            matchTarget: g2.matchTarget!,
            reasons: g2.reasons,
            suggestedAction: g2.suggestedAction || 'MERGE_PENDING',
            fusedPendingItem: fused,
          };
        }
      }
    }

    // Stage 2: Probabilistic Scoring across Gate-1 eligible candidates
    const scoredCandidates: ScoredCandidate[] = [];
    const boundaryVetoReasons: string[] = [];

    for (const record of walletRecords) {
      const g1 = this.evaluateGate1(record, evidence);
      if (g1.passed) {
        const scores = this.calculateDimensionScores(record, evidence);
        if (scores.merchant < 0) {
          boundaryVetoReasons.push(...scores.reasons.filter(r => r.includes('conflicting stores veto')));
        }
        if (scores.composite >= this.mediumThreshold) {
          scoredCandidates.push({
            target: { type: 'WALLET_RECORD', record },
            candidateItem: record,
            scores,
          });
        }
      }
    }

    for (const pending of pendingItems) {
      const g1 = this.evaluateGate1(pending, evidence);
      if (g1.passed) {
        const scores = this.calculateDimensionScores(pending, evidence);
        if (scores.merchant < 0) {
          boundaryVetoReasons.push(...scores.reasons.filter(r => r.includes('conflicting stores veto')));
        }
        if (scores.composite >= this.mediumThreshold) {
          scoredCandidates.push({
            target: { type: 'PENDING_TRANSACTION', pendingItem: pending },
            candidateItem: pending,
            scores,
          });
        }
      }
    }

    if (scoredCandidates.length === 0) {
      const reasons = [
        ...boundaryVetoReasons,
        'No matching candidates within gate boundaries or minimum confidence threshold',
      ];
      if (evidence.isBankSyncedAccount) {
        reasons.push('Account is bank-synced; Wallet record may arrive later with sync delay');
      }
      return {
        confidence: 'LOW',
        matchTarget: { type: 'NONE' },
        reasons,
        suggestedAction: 'CREATE_INDEPENDENT',
      };
    }

    // Sort: If both have HIGH confidence (>= highThreshold), prioritize WALLET_RECORD to attach to existing records,
    // otherwise sort descending by composite score.
    scoredCandidates.sort((a, b) => {
      const aHigh = a.scores.composite >= this.highThreshold;
      const bHigh = b.scores.composite >= this.highThreshold;
      if (aHigh && bHigh) {
        if (a.target.type === 'WALLET_RECORD' && b.target.type !== 'WALLET_RECORD') return -1;
        if (b.target.type === 'WALLET_RECORD' && a.target.type !== 'WALLET_RECORD') return 1;
      }
      return b.scores.composite - a.scores.composite;
    });
    const top = scoredCandidates[0];
    const runnerUp = scoredCandidates[1];

    // Stage 3: Multi-Candidate Disambiguation Circuit Breaker
    // Disambiguation applies when two candidates of the same target type are ambiguous
    const isCrossTargetTypesWithHighRecord =
      top.target.type === 'WALLET_RECORD' &&
      runnerUp?.target.type === 'PENDING_TRANSACTION' &&
      top.scores.composite >= this.highThreshold;

    if (
      runnerUp &&
      !isCrossTargetTypesWithHighRecord &&
      top.scores.composite - runnerUp.scores.composite < this.disambiguationDelta
    ) {
      const topTitle = ('note' in top.candidateItem ? top.candidateItem.note : '') || (top.candidateItem as any).counterParty || 'Transaksi 1';
      const runnerTitle = ('note' in runnerUp.candidateItem ? runnerUp.candidateItem.note : '') || (runnerUp.candidateItem as any).counterParty || 'Transaksi 2';
      return {
        confidence: 'MEDIUM',
        matchTarget: top.target,
        reasons: [
          `Multiple plausible candidates within disambiguation delta (${top.scores.composite.toFixed(2)} vs ${runnerUp.scores.composite.toFixed(2)})`,
          ...top.scores.reasons,
        ],
        suggestedAction: 'CLARIFY',
        clarificationPrompt: `Transaksi ${evidence.currency} ${Math.abs(evidence.amount)} memiliki nominal dan waktu yang serupa dengan dua transaksi:\n1. ${topTitle}\n2. ${runnerTitle}\nApakah ini transaksi yang sama?`,
        scores: top.scores,
      };
    }

    // Stage 4: Threshold Evaluation
    if (top.scores.composite >= this.highThreshold) {
      const isPending = top.target.type === 'PENDING_TRANSACTION';
      const fused = isPending
        ? this.densityResolver.fusePendingItemWithEvidence(
            (top.target as { type: 'PENDING_TRANSACTION'; pendingItem: PendingTransactionItem }).pendingItem,
            evidence
          )
        : undefined;

      return {
        confidence: 'HIGH',
        matchTarget: top.target,
        reasons: [
          `High composite correlation score (${top.scores.composite.toFixed(2)} >= ${this.highThreshold.toFixed(2)})`,
          ...top.scores.reasons,
        ],
        suggestedAction: isPending ? 'MERGE_PENDING' : 'ATTACH_WALLET_RECORD',
        fusedPendingItem: fused,
        scores: top.scores,
      };
    }

    // Medium Confidence (0.55 <= Score < 0.80)
    if (top.target.type === 'WALLET_RECORD') {
      const reasons = [
        `Moderate score (${top.scores.composite.toFixed(2)}) against existing Wallet record is below high confidence threshold; retaining independent transaction`,
        ...top.scores.reasons,
      ];
      if (evidence.isBankSyncedAccount) {
        reasons.push('Account is bank-synced; Wallet record may arrive later with sync delay');
      }
      return {
        confidence: 'LOW',
        matchTarget: { type: 'NONE' },
        reasons,
        suggestedAction: 'CREATE_INDEPENDENT',
        scores: top.scores,
      };
    }

    const candidateTitle = ('note' in top.candidateItem ? top.candidateItem.note : '') || (top.candidateItem as any).counterParty || 'transaksi sebelumnya';
    const targetLabel =
      top.target.type === 'PENDING_TRANSACTION'
        ? `tiket #${top.target.pendingItem.ticketId} ("${candidateTitle}")`
        : `"${candidateTitle}"`;
    return {
      confidence: 'MEDIUM',
      matchTarget: top.target,
      reasons: [
        `Moderate composite correlation score (${top.scores.composite.toFixed(2)})`,
        ...top.scores.reasons,
      ],
      suggestedAction: 'CLARIFY',
      clarificationPrompt: `Transaksi ${evidence.currency} ${Math.abs(evidence.amount)} terdeteksi serupa dengan ${targetLabel}. Apakah ini transaksi yang sama?`,
      scores: top.scores,
    };
  }

  /**
   * Determines whether candidate and evidence point to mutually exclusive distinct physical stores.
   * Compares literal non-stopword tokens across merchant names and notes without hardcoded platform lists.
   */
  private detectConflictingStores(
    candMerchant: string,
    evidMerchant: string,
    candNote: string,
    evidNote: string
  ): boolean {
    const cm = candMerchant.trim().toLowerCase();
    const em = evidMerchant.trim().toLowerCase();

    if (!cm || !em) return false;
    if (isGenericMerchant(cm) || isGenericMerchant(em)) return false;

    // Substring match
    if (cm.includes(em) || em.includes(cm)) return false;

    // Check token overlap across combined merchant and note bodies
    const candTokens = `${candMerchant} ${candNote}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !GENERIC_FINANCIAL_TOKENS.has(t));
    const evidTokens = `${evidMerchant} ${evidNote}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 4 && !GENERIC_FINANCIAL_TOKENS.has(t));

    if (
      candTokens.some(ct =>
        evidTokens.some(et => ct === et || ct.includes(et) || et.includes(ct))
      )
    ) {
      return false;
    }

    // Both are specific, distinct store names that share zero tokens across merchant & notes
    return true;
  }

  /**
   * Checks for unlinked counterpart records to bind via pairingMode: 'existing'.
   */
  private checkTransferPairingCounterpart(
    evidence: TransactionEvidence,
    records: WalletRecordItem[]
  ): EngineCorrelationResult | null {
    const isTransferEvidence = evidence.transactionType === INTERNAL_TRANSACTION_TYPES.TRANSFER;
    const isPotentialTransfer =
      isTransferEvidence ||
      Boolean(evidence.destinationAccountId) ||
      Boolean(evidence.destinationAccountHint);

    if (!isPotentialTransfer || !records || records.length === 0) {
      return null;
    }

    const evidenceAmount = Math.abs(evidence.amount);
    const evidenceTime = new Date(evidence.occurredAt).getTime();
    const evidenceCurrency = (evidence.currency || 'IDR').toUpperCase();
    const evidenceRefs = (evidence.referenceNumbers || []).map(normalizeReferenceNumber);
    const tightWindowMs = 15 * 60 * 1000;

    for (const record of records) {
      const recordCurrency = (record.currency || 'IDR').toUpperCase();
      if (recordCurrency !== evidenceCurrency) {
        continue;
      }

      // Must be on a different account
      if (evidence.accountId && record.accountId === evidence.accountId) {
        continue;
      }

      // Must NOT already be a paired transfer
      const isAlreadyPairedTransfer =
        record.recordType === WALLET_MCP_RECORD_TYPES.TRANSFER || Boolean(record.transfer);
      if (isAlreadyPairedTransfer) {
        continue;
      }

      // Must have opposite sign and same absolute amount
      const recordAmount = Math.abs(record.amount);
      if (recordAmount !== evidenceAmount) {
        continue;
      }

      const isOppositeSign = Math.sign(record.amount) === -Math.sign(evidence.amount);
      if (!isOppositeSign) {
        continue;
      }

      // Time proximity check
      const recordTime = new Date(record.recordDate).getTime();
      const timeDiffMs = Math.abs(evidenceTime - recordTime);
      if (timeDiffMs > this.maxWindowMs) {
        continue;
      }

      // Reference number match gives immediate HIGH confidence
      const recordNoteUpper = (record.note || '').toUpperCase();
      const hasRefMatch = evidenceRefs.some(
        ref => recordNoteUpper.includes(ref) || record.id.toUpperCase() === ref
      );

      const matchesDestinationAccount =
        Boolean(evidence.destinationAccountId) && record.accountId === evidence.destinationAccountId;

      if (hasRefMatch || matchesDestinationAccount || timeDiffMs <= tightWindowMs) {
        return {
          confidence: 'HIGH',
          matchTarget: { type: 'WALLET_RECORD', record },
          reasons: [
            `Existing unlinked Wallet record (${record.id}) on account (${record.accountId}) matches transfer counterpart (${record.amount}) within window. Proposing pairingMode: 'existing'.`,
          ],
          suggestedAction: 'PAIR_TRANSFER_EXISTING',
          proposedTransfer: {
            pairingMode: 'existing',
            recordId: record.id,
            accountId: record.accountId,
          },
          fusedPendingItem: {
            transactionType: INTERNAL_TRANSACTION_TYPES.TRANSFER,
            matchedDestinationAccountId: record.accountId,
            transfer: {
              pairingMode: 'existing',
              recordId: record.id,
              accountId: record.accountId,
            },
          },
        };
      } else if (timeDiffMs <= this.maxWindowMs) {
        return {
          confidence: 'MEDIUM',
          matchTarget: { type: 'WALLET_RECORD', record },
          reasons: [
            `Existing unlinked Wallet record (${record.id}) on account (${record.accountId}) has matching transfer amount and opposite sign, but outside tight window. Proposing pairingMode: 'existing'.`,
          ],
          suggestedAction: 'PAIR_TRANSFER_EXISTING',
          proposedTransfer: {
            pairingMode: 'existing',
            recordId: record.id,
            accountId: record.accountId,
          },
          fusedPendingItem: {
            transactionType: INTERNAL_TRANSACTION_TYPES.TRANSFER,
            matchedDestinationAccountId: record.accountId,
            transfer: {
              pairingMode: 'existing',
              recordId: record.id,
              accountId: record.accountId,
            },
          },
        };
      }
    }

    return null;
  }
}
