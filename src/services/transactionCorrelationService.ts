import type { PendingTransactionItem } from './pendingTransactionService.js';
import type { WalletRecordItem } from '../types/walletTypes.js';
import type {
  TransactionEvidence,
  CorrelationResult,
} from '../types/transactionCorrelationTypes.js';
import { CommercePlatformRegistry } from '../config/commercePlatforms.js';
import {
  isGenericMerchant,
  isGenericCardAccountOrMethod,
  detectConflictingMerchants,
} from './correlation/merchantClassifier.js';
import { isGenericNote } from './correlation/noteClassifier.js';
import { evaluateComplementarySources } from './correlation/complementarySourceEvaluator.js';
import { fuseCandidateWithEvidence } from './correlation/transactionFuser.js';

export interface TransactionCorrelationOptions {
  /**
   * Maximum time difference in milliseconds to consider two sources as matching.
   * Default: 120 minutes (7,200,000 ms) to support ride-hailing/delivery completion latency.
   */
  maxCorrelationWindowMilliseconds?: number;
  /**
   * Tight time window in milliseconds for complementary QRIS / merchant matching.
   * Default: 15 minutes (900,000 ms).
   */
  tightWindowMilliseconds?: number;
  /**
   * Optional platform registry instance (defaults to singleton).
   */
  platformRegistry?: CommercePlatformRegistry;
}

export class TransactionCorrelationService {
  private readonly maxCorrelationWindowMilliseconds: number;
  private readonly tightWindowMilliseconds: number;
  private readonly platformRegistry: CommercePlatformRegistry;

  constructor(options?: TransactionCorrelationOptions) {
    this.maxCorrelationWindowMilliseconds =
      options?.maxCorrelationWindowMilliseconds ?? 120 * 60 * 1000; // 120 mins (2 hours)
    this.tightWindowMilliseconds =
      options?.tightWindowMilliseconds ?? 15 * 60 * 1000; // 15 mins
    this.platformRegistry =
      options?.platformRegistry ?? CommercePlatformRegistry.getInstance();
  }

  /**
   * Checks whether a merchant or counterparty name is generic or placeholder (e.g. "Unknown", "Kartu Debit").
   */
  public isGenericMerchant(merchant: string | undefined | null): boolean {
    return isGenericMerchant(merchant);
  }

  /**
   * Checks whether an account hint, payment method, or account name refers to a generic card network
   * (e.g. "Visa", "Mastercard", "Debit Card", "Kartu Debit").
   */
  public isGenericCardAccountOrMethod(text?: string | null): boolean {
    return isGenericCardAccountOrMethod(text);
  }

  /**
   * Checks whether a transaction note is boilerplate / generic payment metadata
   * (e.g. "Transaction using Jago debit card", "Pembayaran QRIS") rather than rich itemized details.
   */
  public isGenericNote(
    note: string | undefined | null,
    merchantOrCounterParty?: string | null,
    subject?: string | null
  ): boolean {
    return isGenericNote(note, merchantOrCounterParty, subject);
  }

  /**
   * Evaluates incoming evidence against existing pending candidates and recent Wallet records.
   * Produces a deterministic correlation decision with confidence and suggested action.
   */
  public correlateEvidence(
    incomingEvidence: TransactionEvidence,
    existingPendingItems: PendingTransactionItem[],
    recentWalletRecords: WalletRecordItem[] = []
  ): CorrelationResult {
    // 1. Check against existing native/bank-synced Wallet records first
    const walletRecordResult = this.correlateAgainstWalletRecords(
      incomingEvidence,
      recentWalletRecords
    );
    if (walletRecordResult) {
      return walletRecordResult;
    }

    // 2. Check against unresolved pending transactions
    return this.correlateAgainstPendingTransactions(
      incomingEvidence,
      existingPendingItems
    );
  }

  /**
   * Checks whether incoming evidence matches an existing Wallet record
   * (e.g. native bank sync already imported the debit or user already entered it manually).
   */
  private correlateAgainstWalletRecords(
    evidence: TransactionEvidence,
    records: WalletRecordItem[]
  ): CorrelationResult | null {
    if (!records || records.length === 0) {
      return null;
    }

    const evidenceAmount = Math.abs(evidence.amount);
    const isTransferEvidence = evidence.transactionType === 'TRANSFER';
    const evidenceSign = isTransferEvidence
      ? 'transfer'
      : evidence.amount < 0
      ? 'expense'
      : 'income';
    const evidenceTime = new Date(evidence.occurredAt).getTime();
    const evidenceCurrency = (evidence.currency || 'IDR').toUpperCase();
    const evidenceRefs = (evidence.referenceNumbers || []).map(ref => ref.toUpperCase());

    for (const record of records) {
      // 1. Currency & direction check
      const recordCurrency = (record.currency || 'IDR').toUpperCase();
      if (recordCurrency !== evidenceCurrency) {
        continue;
      }
      const isRecordTransfer = record.recordType === 'transfer' || Boolean(record.transfer);
      if (isTransferEvidence) {
        if (!isRecordTransfer) {
          continue;
        }
      } else {
        if (record.recordType !== evidenceSign || isRecordTransfer) {
          continue;
        }
      }

      // 2. Amount check
      const recordAmount = Math.abs(record.amount);
      if (recordAmount !== evidenceAmount) {
        continue;
      }

      // 3. Time proximity check (2-hour bounded window for Wallet sync latency)
      const recordTime = new Date(record.recordDate).getTime();
      const timeDiffMs = Math.abs(evidenceTime - recordTime);
      if (timeDiffMs > 2 * 60 * 60 * 1000) {
        continue;
      }

      // 4. Strong correlation: explicit reference number match
      const recordNoteUpper = (record.note || '').toUpperCase();
      const hasRefMatch = evidenceRefs.some(
        ref => recordNoteUpper.includes(ref) || record.id.toUpperCase() === ref
      );

      // Determine confidence for reference match immediately
      if (hasRefMatch) {
        return {
          confidence: 'HIGH',
          matchTarget: { type: 'WALLET_RECORD', record },
          reasons: [`Matching reference ID in existing Wallet record (${record.id})`],
          suggestedAction: 'ATTACH_WALLET_RECORD',
        };
      }

      // Check distinct merchant conflict (e.g. Alfamart vs Starbucks)
      const recordCounterPartyOrNote = record.counterParty || record.note || '';
      const isConflicting = detectConflictingMerchants(
        { counterParty: recordCounterPartyOrNote },
        evidence,
        this.platformRegistry
      );
      if (isConflicting) {
        continue;
      }

      // 5. Account match: either account ID matches or incoming is platform wallet/cash
      const isEvidencePlatformOrCash =
        !evidence.accountId ||
        evidence.accountId === 'acc-cash' ||
        this.platformRegistry.isPlatformWallet(evidence.accountHint);

      const hasAccountMatch =
        (Boolean(evidence.accountId) && record.accountId === evidence.accountId) ||
        isEvidencePlatformOrCash;

      // 6. Semantic merchant match
      const recordMerchant = `${record.counterParty || ''} ${record.note || ''}`.toLowerCase();
      const evidenceMerchant = (evidence.merchant || '').toLowerCase();
      const hasMerchantMatch =
        evidenceMerchant.length > 2 &&
        (recordMerchant.includes(evidenceMerchant) || evidenceMerchant.includes(recordMerchant));

      const isRecordMerchantGeneric = isGenericMerchant(record.counterParty);
      const isBankSynced = record.source === 'bank_sync' || Boolean(evidence.isBankSyncedAccount);

      const isIncomingSpecificPayment =
        (evidence.sourceType === 'EMAIL_PAYMENT' || evidence.sourceType === 'RECEIPT') &&
        Boolean(evidence.merchant) &&
        !isGenericMerchant(evidence.merchant) &&
        (evidence.merchant?.length ?? 0) >= 2;

      if (
        hasAccountMatch &&
        (hasMerchantMatch ||
          (isRecordMerchantGeneric &&
            isIncomingSpecificPayment &&
            timeDiffMs <= this.maxCorrelationWindowMilliseconds) ||
          (isBankSynced && timeDiffMs <= this.tightWindowMilliseconds))
      ) {
        return {
          confidence: 'HIGH',
          matchTarget: { type: 'WALLET_RECORD', record },
          reasons: [
            `Existing Wallet record (${record.id}) matches account, amount, and ${
              hasMerchantMatch
                ? 'merchant'
                : isRecordMerchantGeneric
                ? 'generic bank debit record paired with specific merchant receipt'
                : 'bank-sync source within tight window'
            }`,
          ],
          suggestedAction: 'ATTACH_WALLET_RECORD',
        };
      }
    }

    return null;
  }

  /**
   * Checks whether incoming evidence correlates with an active pending candidate.
   */
  private correlateAgainstPendingTransactions(
    evidence: TransactionEvidence,
    pendingItems: PendingTransactionItem[]
  ): CorrelationResult {
    const evidenceAmount = Math.abs(evidence.amount);
    const evidenceIsExpense = evidence.amount < 0 || evidence.transactionType === 'EXPENSE';
    const evidenceCurrency = (evidence.currency || 'IDR').toUpperCase();
    const evidenceTime = new Date(evidence.occurredAt).getTime();
    const evidenceRefs = (evidence.referenceNumbers || []).map(ref => ref.toUpperCase());

    let mediumConfidenceCandidate: {
      item: PendingTransactionItem;
      reasons: string[];
    } | null = null;

    for (const candidate of pendingItems) {
      // 1. Currency check - different currencies NEVER merge
      const candidateCurrency = (candidate.currency || 'IDR').toUpperCase();
      if (candidateCurrency !== evidenceCurrency) {
        continue;
      }

      // 2. Transaction sign / direction check - expense and income NEVER merge
      const candidateIsExpense = candidate.amount < 0 || candidate.transactionType === 'EXPENSE';
      if (candidateIsExpense !== evidenceIsExpense) {
        continue;
      }

      // 3. Amount equality check
      const candidateAmount = Math.abs(candidate.amount);
      if (candidateAmount !== evidenceAmount) {
        continue;
      }

      // 4. Time proximity check (compare normalized UTC instants)
      const candidateTime = new Date(candidate.recordDate).getTime();
      const timeDiffMs = Math.abs(evidenceTime - candidateTime);
      if (timeDiffMs > this.maxCorrelationWindowMilliseconds) {
        continue;
      }

      // Collect candidate reference IDs
      const candidateRefs = [
        candidate.referenceNumber,
        ...(candidate.referenceNumbers || []),
      ]
        .filter((ref): ref is string => Boolean(ref))
        .map(ref => ref.toUpperCase());

      // Check explicit reference match
      const matchingRef = evidenceRefs.find(ref => candidateRefs.includes(ref));
      if (matchingRef) {
        const fused = this.fuseCandidateWithEvidence(candidate, evidence);
        return {
          confidence: 'HIGH',
          matchTarget: { type: 'PENDING_TRANSACTION', pendingItem: candidate },
          reasons: [`Identical reference number: ${matchingRef}`],
          suggestedAction: 'MERGE_PENDING',
          fusedPendingItem: fused,
        };
      }

      // Check distinct merchant conflict (e.g. Indomaret vs Starbucks)
      const isConflictingMerchant = detectConflictingMerchants(
        candidate,
        evidence,
        this.platformRegistry
      );
      if (isConflictingMerchant) {
        continue; // Must remain separate
      }

      // Check cross-source complementarity (e.g. Bank Debit + Merchant Receipt)
      const complementarityResult = evaluateComplementarySources(
        candidate,
        evidence,
        timeDiffMs,
        {
          platformRegistry: this.platformRegistry,
          tightWindowMilliseconds: this.tightWindowMilliseconds,
        }
      );

      if (complementarityResult.isHighConfidence) {
        const fused = this.fuseCandidateWithEvidence(candidate, evidence);
        return {
          confidence: 'HIGH',
          matchTarget: { type: 'PENDING_TRANSACTION', pendingItem: candidate },
          reasons: complementarityResult.reasons,
          suggestedAction: 'MERGE_PENDING',
          fusedPendingItem: fused,
        };
      }

      // If plausible but ambiguous within tight window, mark for medium confidence
      // For merchant payments/receipts (e.g. food delivery GrabFood/GoFood), delays up to 45 mins between bank debit and final receipt are normal
      const effectiveTightWindow =
        evidence.sourceType === 'EMAIL_PAYMENT' || evidence.sourceType === 'RECEIPT'
          ? Math.max(this.tightWindowMilliseconds, 45 * 60 * 1000)
          : this.tightWindowMilliseconds;

      if (timeDiffMs <= effectiveTightWindow && !mediumConfidenceCandidate) {
        mediumConfidenceCandidate = {
          item: candidate,
          reasons: [
            `Same amount (${candidateAmount}) within ${Math.round(
              timeDiffMs / 1000
            )}s window, but merchant evidence is ambiguous`,
          ],
        };
      }
    }

    if (mediumConfidenceCandidate) {
      return {
        confidence: 'MEDIUM',
        matchTarget: {
          type: 'PENDING_TRANSACTION',
          pendingItem: mediumConfidenceCandidate.item,
        },
        reasons: mediumConfidenceCandidate.reasons,
        suggestedAction: 'CLARIFY',
        clarificationPrompt: `Transaksi ${evidenceCurrency} ${evidenceAmount} terdeteksi memiliki nominal dan waktu yang sama dengan tiket #${mediumConfidenceCandidate.item.ticketId}. Apakah ini transaksi yang sama?`,
      };
    }

    const reasons = ['No matching pending transaction or Wallet record found'];
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

  /**
   * Fuses existing candidate state with incoming evidence according to field precedence rules.
   * Ensures arrival order invariance: (Bank + Receipt) produces the same outcome as (Receipt + Bank).
   */
  public fuseCandidateWithEvidence(
    candidate: PendingTransactionItem,
    incoming: TransactionEvidence
  ): Partial<PendingTransactionItem> {
    return fuseCandidateWithEvidence(candidate, incoming, this.platformRegistry);
  }
}
