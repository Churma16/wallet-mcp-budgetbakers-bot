import type { PendingTransactionItem } from './pendingTransactionService.js';
import type { WalletRecordItem } from '../types/walletTypes.js';
import type {
  TransactionEvidence,
  CorrelationResult,
} from '../types/transactionCorrelationTypes.js';
import { CommercePlatformRegistry } from '../config/commercePlatforms.js';

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
    if (!merchant) return true;
    const lower = merchant.trim().toLowerCase();
    if (!lower || lower === 'unknown') return true;

    // Special case: legitimate registered couriers and merchants
    if (lower.includes('pos indonesia')) {
      return false;
    }

    // Exact phrase checks
    const exactPhrases = [
      'kartu debit',
      'debit card',
      'pembayaran qris',
      'edc/pos',
      'pos debit',
      'transaksi domestik',
    ];
    if (exactPhrases.some(phrase => lower.includes(phrase))) {
      return true;
    }

    // Word-token boundary checks for identifiers
    const words = lower.split(/[^a-z0-9]+/);
    const genericWords = new Set([
      'unknown',
      'debit',
      'card',
      'kartu',
      'qris',
      'edc',
      'pos',
      'payment',
      'pembayaran',
      'bank',
      'transfer',
      'transaksi',
      'merchant',
    ]);

    return words.some(w => genericWords.has(w));
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
    if (!note) return true;
    const trimmed = note.trim();
    if (!trimmed) return true;

    // Detailed receipt notes containing order IDs (#), bullets, or item lines are NEVER generic
    if (trimmed.includes('#') || trimmed.includes('•') || trimmed.includes('\n')) {
      return false;
    }

    const lower = trimmed.toLowerCase();
    if (
      merchantOrCounterParty &&
      lower === merchantOrCounterParty.trim().toLowerCase()
    ) {
      return true;
    }
    if (subject && lower === subject.trim().toLowerCase()) {
      return true;
    }

    const genericExactPhrases = [
      'unknown',
      'pembayaran',
      'pembayaran qris',
      'pembayaran berhasil',
      'pembayaran merchant',
      'transaksi',
      'transaksi berhasil',
      'transaksi domestik',
      'transaksi merchant',
      'transaksi menggunakan kartu debit',
      'transaksi menggunakan kartu debit jago',
      'transaction using debit card',
      'transaction using jago debit card',
      'kartu debit',
      'debit card',
      'debit',
      'pos/edc',
      'pos debit',
      'edc/pos',
      'edc',
      'qris',
      'transfer',
      'transfer dana',
      'transfer masuk',
      'transfer keluar',
    ];

    if (genericExactPhrases.includes(lower)) {
      return true;
    }

    // Generic prefix / boilerplate patterns without specific product details
    const genericPrefixes = [
      'transaksi menggunakan kartu debit',
      'transaction using debit card',
      'transaction using jago debit card',
      'pembayaran qris di',
      'pembayaran qris',
    ];

    for (const prefix of genericPrefixes) {
      if (lower.startsWith(prefix) && lower.length < prefix.length + 15) {
        return true;
      }
    }

    return false;
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
    const evidenceRefs = (evidence.referenceNumbers || []).map(r => r.toUpperCase());

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
      const hasRefMatch = evidenceRefs.some(ref => recordNoteUpper.includes(ref) || record.id.toUpperCase() === ref);

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
      const isConflicting = this.detectConflictingMerchants(
        { counterParty: recordCounterPartyOrNote } as PendingTransactionItem,
        evidence
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

      const isRecordMerchantGeneric = this.isGenericMerchant(record.counterParty);
      const isBankSynced = record.source === 'bank_sync' || Boolean(evidence.isBankSyncedAccount);

      const isIncomingSpecificPayment =
        (evidence.sourceType === 'EMAIL_PAYMENT' || evidence.sourceType === 'RECEIPT') &&
        Boolean(evidence.merchant) &&
        !this.isGenericMerchant(evidence.merchant) &&
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
    const evidenceRefs = (evidence.referenceNumbers || []).map(r => r.toUpperCase());

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
      const isConflictingMerchant = this.detectConflictingMerchants(candidate, evidence);
      if (isConflictingMerchant) {
        continue; // Must remain separate
      }

      // Check cross-source complementarity (e.g. Bank Debit + Merchant Receipt)
      const complementarityResult = this.evaluateComplementarySources(
        candidate,
        evidence,
        timeDiffMs
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
      if (timeDiffMs <= this.tightWindowMilliseconds && !mediumConfidenceCandidate) {
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
   * Determines whether candidate and incoming evidence point to distinctly different merchants.
   */
  private detectConflictingMerchants(
    candidate: PendingTransactionItem,
    evidence: TransactionEvidence
  ): boolean {
    const candidateMerchant = (candidate.counterParty || '').trim().toLowerCase();
    const evidenceMerchant = (evidence.merchant || '').trim().toLowerCase();

    if (!candidateMerchant || !evidenceMerchant) {
      return false;
    }

    // If either merchant is generic / placeholder, they cannot be in conflict
    if (this.isGenericMerchant(candidateMerchant) || this.isGenericMerchant(evidenceMerchant)) {
      return false;
    }

    // Known brands registered in CommercePlatformRegistry
    const knownBrands = this.platformRegistry.getAllMerchantKeywords();
    for (const brand of knownBrands) {
      if (candidateMerchant.includes(brand) && evidenceMerchant.includes(brand)) {
        return false;
      }
    }

    // Substring match
    if (
      candidateMerchant.includes(evidenceMerchant) ||
      evidenceMerchant.includes(candidateMerchant)
    ) {
      return false;
    }

    // Token overlap match (e.g. "blibli.com kudus" vs "blibli offline store")
    const candidateTokens = candidateMerchant.split(/[^a-z0-9]+/).filter(t => t.length >= 4);
    const evidenceTokens = evidenceMerchant.split(/[^a-z0-9]+/).filter(t => t.length >= 4);
    if (candidateTokens.some(t => evidenceTokens.includes(t))) {
      return false;
    }

    // Both have distinct specific merchant names that do not match
    return true;
  }

  /**
   * Evaluates if one source is a bank debit and the other is a merchant/payment receipt
   * whose details semantically match.
   */
  private evaluateComplementarySources(
    candidate: PendingTransactionItem,
    evidence: TransactionEvidence,
    timeDiffMs: number
  ): { isHighConfidence: boolean; reasons: string[] } {
    const isCandidateBank = this.isBankSource(candidate);
    const isEvidenceBank = evidence.sourceType === 'EMAIL_BANK';

    const isCandidatePayment = this.isPaymentOrReceiptSource(candidate);
    const isEvidencePayment =
      evidence.sourceType === 'EMAIL_PAYMENT' || evidence.sourceType === 'RECEIPT';

    const isCrossSource =
      (isCandidateBank && isEvidencePayment) || (isCandidatePayment && isEvidenceBank);

    if (!isCrossSource) {
      // Check if both are same merchant within tight window
      const candidateMerchant = (candidate.counterParty || '').toLowerCase();
      const evidenceMerchant = (evidence.merchant || '').toLowerCase();
      if (
        candidateMerchant &&
        evidenceMerchant &&
        (candidateMerchant.includes(evidenceMerchant) || evidenceMerchant.includes(candidateMerchant)) &&
        timeDiffMs <= this.tightWindowMilliseconds
      ) {
        return {
          isHighConfidence: true,
          reasons: [
            `Same merchant (${candidate.counterParty}) within tight window (${Math.round(
              timeDiffMs / 1000
            )}s)`,
          ],
        };
      }

      return { isHighConfidence: false, reasons: [] };
    }

    // Disambiguate which side is bank and which side is payment/receipt
    // When evidence is EMAIL_BANK, evidence is strictly the bank side and candidate is the payment side.
    const isBankFromCandidate = isEvidencePayment || (isCandidateBank && !isEvidenceBank);

    const bankCounterParty = isBankFromCandidate
      ? candidate.counterParty || ''
      : evidence.merchant || '';
    const bankNote = isBankFromCandidate
      ? candidate.note || ''
      : evidence.note || '';
    const bankDisplayName = isBankFromCandidate
      ? candidate.bankDisplayName || ''
      : evidence.accountHint || evidence.merchant || '';
    const bankAccountId = isBankFromCandidate
      ? candidate.matchedAccountId
      : evidence.accountId;
    const bankAccountName = isBankFromCandidate
      ? candidate.accountNameHint || ''
      : evidence.accountHint || '';

    const paymentCounterParty = isBankFromCandidate
      ? evidence.merchant || ''
      : candidate.counterParty || '';
    const paymentNote = isBankFromCandidate
      ? evidence.note || ''
      : candidate.note || '';
    const paymentAccountId = isBankFromCandidate
      ? evidence.accountId
      : candidate.matchedAccountId;
    const paymentAccountName = isBankFromCandidate
      ? evidence.accountHint || ''
      : candidate.accountNameHint || '';

    const bankText = `${bankCounterParty} ${bankNote} ${bankDisplayName}`.toLowerCase();
    const paymentMerchant = paymentCounterParty.toLowerCase().trim();
    const paymentText = `${paymentCounterParty} ${paymentNote}`.toLowerCase();

    // Check 1: Bank counterparty mentions the merchant name (e.g. "BLIBLI.COM KUDUS - ID" mentions "blibli")
    if (paymentMerchant.length >= 3 && bankText.includes(paymentMerchant)) {
      return {
        isHighConfidence: true,
        reasons: [
          `Bank transaction records merchant '${paymentMerchant}' within ${Math.round(
            timeDiffMs / 1000
          )}s window`,
        ],
      };
    }

    // Check 2: Known merchant keyword extraction from platform registry
    const knownMerchants = this.platformRegistry.getAllMerchantKeywords();
    for (const merchantKeyword of knownMerchants) {
      if (paymentText.includes(merchantKeyword) && bankText.includes(merchantKeyword)) {
        return {
          isHighConfidence: true,
          reasons: [
            `Shared merchant keyword '${merchantKeyword}' across bank debit and payment receipt (${Math.round(
              timeDiffMs / 1000
            )}s window)`,
          ],
        };
      }
    }

    // Check 3: Tight QRIS payment window (bank counterparty is QRIS and payment receipt arrives within 15 mins)
    const isBankQris = bankText.includes('qris');
    const isPaymentQris = paymentText.includes('qris') || paymentText.includes('offline store');
    if (isBankQris && isPaymentQris && timeDiffMs <= this.tightWindowMilliseconds) {
      return {
        isHighConfidence: true,
        reasons: [
          `QRIS payment receipt correlates with bank QRIS debit within ${Math.round(
            timeDiffMs / 1000
          )}s window`,
        ],
      };
    }

    // Check 4: Generic bank debit + specific merchant receipt
    // When bank notification lacks merchant text (e.g. Bank Jago debit card "Unknown")
    // but accounts are compatible, amounts match, and evidence provides a specific merchant receipt.
    const isBankMerchantGeneric = this.isGenericMerchant(bankCounterParty);
    const isPaymentMerchantSpecific =
      Boolean(paymentMerchant) &&
      paymentMerchant.length >= 2 &&
      !this.isGenericMerchant(paymentMerchant);

    if (isBankMerchantGeneric && isPaymentMerchantSpecific) {
      const accountsMatch = Boolean(
        bankAccountId && paymentAccountId && bankAccountId === paymentAccountId
      );

      // Payment platform wallets (ShopeePay, GoPay, OVO, DANA) or cash/tunai
      // are compatible with authoritative bank debits
      const isPaymentAccountPlatformOrCash =
        !paymentAccountId ||
        paymentAccountId === 'acc-cash' ||
        this.platformRegistry.isPlatformWallet(paymentAccountName);

      const isAccountCompatible =
        !bankAccountId ||
        !paymentAccountId ||
        accountsMatch ||
        isPaymentAccountPlatformOrCash;

      if (isAccountCompatible) {
        return {
          isHighConfidence: true,
          reasons: [
            `Authoritative bank debit with generic merchant '${
              bankCounterParty || 'Unknown'
            }' correlates with ${paymentMerchant} receipt${
              accountsMatch ? ' on verified account' : ''
            } within ${Math.round(timeDiffMs / 1000)}s window`,
          ],
        };
      }
    }

    return { isHighConfidence: false, reasons: [] };
  }

  private isBankSource(candidate: PendingTransactionItem): boolean {
    if (candidate.evidenceSources?.includes('EMAIL_BANK')) {
      return true;
    }
    const lowerName = (candidate.bankDisplayName || '').toLowerCase();
    const lowerAccount = (candidate.accountNameHint || '').toLowerCase();
    const bankKeywords = [
      'bank',
      'mandiri',
      'bca',
      'bni',
      'bri',
      'jago',
      'seabank',
      'dana',
      'ovo',
      'gopay',
      'shopeepay',
      'blu',
      'jenius',
      'cimb',
    ];
    return bankKeywords.some(k => lowerName.includes(k) || lowerAccount.includes(k));
  }

  private isPaymentOrReceiptSource(candidate: PendingTransactionItem): boolean {
    if (
      candidate.evidenceSources?.includes('EMAIL_PAYMENT') ||
      candidate.evidenceSources?.includes('RECEIPT')
    ) {
      return true;
    }
    const lowerName = (candidate.bankDisplayName || '').toLowerCase();
    const lowerCounter = (candidate.counterParty || '').toLowerCase();
    if (
      lowerName.includes('receipt') ||
      lowerName.includes('struk') ||
      lowerCounter.includes('receipt') ||
      lowerCounter.includes('struk')
    ) {
      return true;
    }
    return (
      this.platformRegistry.isCommerceMerchant(lowerName) ||
      this.platformRegistry.isCommerceMerchant(lowerCounter)
    );
  }

  /**
   * Fuses existing candidate state with incoming evidence according to field precedence rules.
   * Ensures arrival order invariance: (Bank + Receipt) produces the same outcome as (Receipt + Bank).
   */
  public fuseCandidateWithEvidence(
    candidate: PendingTransactionItem,
    incoming: TransactionEvidence
  ): Partial<PendingTransactionItem> {
    const isCandidateBank = this.isBankSource(candidate);
    const isIncomingBank = incoming.sourceType === 'EMAIL_BANK';

    // 1. Account resolution: authoritative bank source takes precedence
    let resolvedAccountId = candidate.matchedAccountId;
    let resolvedAccountName = candidate.accountNameHint;
    let resolvedBankDisplayName = candidate.bankDisplayName;

    const isCandidateAccountPlatform =
      !resolvedAccountName ||
      this.platformRegistry.isPlatformWallet(resolvedAccountName);

    if (
      isIncomingBank &&
      incoming.accountId &&
      (!isCandidateBank || isCandidateAccountPlatform)
    ) {
      resolvedAccountId = incoming.accountId;
      resolvedAccountName = incoming.accountHint || resolvedAccountName;
      resolvedBankDisplayName = incoming.merchant || incoming.accountHint || resolvedBankDisplayName;
    }

    // 2. CounterParty / Merchant resolution: cleaner merchant receipt name takes precedence
    let resolvedCounterParty = candidate.counterParty;
    const isIncomingPayment =
      incoming.sourceType === 'EMAIL_PAYMENT' || incoming.sourceType === 'RECEIPT';

    if (isIncomingPayment && incoming.merchant) {
      resolvedCounterParty = incoming.merchant;
    } else if (
      (!resolvedCounterParty || this.isGenericMerchant(resolvedCounterParty)) &&
      incoming.merchant &&
      !this.isGenericMerchant(incoming.merchant)
    ) {
      resolvedCounterParty = incoming.merchant;
    }

    // 3. Note / Itemized breakdown resolution: merchant receipt items take precedence or enrich
    let resolvedNote = candidate.note;
    if (incoming.note && incoming.note !== candidate.note) {
      if (!candidate.note) {
        resolvedNote = incoming.note;
      } else {
        const isCandidateNoteGeneric = this.isGenericNote(
          candidate.note,
          candidate.counterParty,
          candidate.emailSubject
        );
        const isIncomingNoteGeneric = this.isGenericNote(
          incoming.note,
          incoming.merchant,
          incoming.sourceId
        );

        if (isCandidateNoteGeneric && !isIncomingNoteGeneric) {
          resolvedNote = incoming.note;
        } else if (!isCandidateNoteGeneric && isIncomingNoteGeneric) {
          resolvedNote = candidate.note;
        } else if (incoming.note.includes(candidate.note)) {
          resolvedNote = incoming.note;
        } else if (candidate.note.includes(incoming.note)) {
          resolvedNote = candidate.note;
        } else {
          resolvedNote = `${candidate.note} • ${incoming.note}`;
        }
      }
    }

    // 4. Category resolution: specific merchant category takes precedence over generic bank category
    let resolvedCategoryId = candidate.matchedCategoryId;
    let resolvedCategoryName = candidate.matchedCategoryName;

    if (incoming.categoryId && incoming.categoryName) {
      const isCandidateCatGeneric =
        !candidate.matchedCategoryName ||
        candidate.matchedCategoryName.toLowerCase().includes('umum') ||
        candidate.matchedCategoryName.toLowerCase().includes('lain') ||
        candidate.matchedCategoryName.toLowerCase().includes('belanja') ||
        candidate.matchedCategoryName.toLowerCase().includes('shopping') ||
        candidate.matchedCategoryName.toLowerCase().includes('general') ||
        candidate.matchedCategoryName.toLowerCase().includes('other') ||
        candidate.matchedCategoryName.toLowerCase().includes('others') ||
        candidate.matchedCategoryName.toLowerCase() === 'uncategorized';

      if (isCandidateCatGeneric) {
        resolvedCategoryId = incoming.categoryId;
        resolvedCategoryName = incoming.categoryName;
      }
    }

    // 5. Reference numbers: union of all references
    const mergedReferences = Array.from(
      new Set([
        ...(candidate.referenceNumbers || []),
        ...(candidate.referenceNumber ? [candidate.referenceNumber] : []),
        ...(incoming.referenceNumbers || []),
      ])
    ).filter(Boolean);

    // 6. Evidence provenance: union of all sources
    const mergedSources = Array.from(
      new Set([
        ...(candidate.evidenceSources || []),
        incoming.sourceType,
      ])
    ).filter(Boolean);

    const resolvedIsBankSynced = Boolean(
      candidate.isBankSyncedAccount || incoming.isBankSyncedAccount
    );

    return {
      matchedAccountId: resolvedAccountId,
      accountNameHint: resolvedAccountName,
      bankDisplayName: resolvedBankDisplayName,
      counterParty: resolvedCounterParty,
      note: resolvedNote,
      matchedCategoryId: resolvedCategoryId,
      matchedCategoryName: resolvedCategoryName,
      referenceNumbers: mergedReferences,
      referenceNumber: mergedReferences[0] || candidate.referenceNumber,
      evidenceSources: mergedSources,
      isBankSyncedAccount: resolvedIsBankSynced,
    };
  }
}
