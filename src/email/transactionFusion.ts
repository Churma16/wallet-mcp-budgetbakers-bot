import type { PendingTransactionItem } from '../core/pending.js';
import type {
  TransactionEvidence,
  BankSourceCandidate,
  PaymentSourceCandidate,
  ResolvedAccountDetails,
  ResolvedCategoryDetails,
  ComplementaryEvaluationOptions,
  ComplementaryEvaluationResult,
} from './types.js';
import { CommercePlatformRegistry } from '../config/commercePlatforms.js';

export type {
  BankSourceCandidate,
  PaymentSourceCandidate,
  ResolvedAccountDetails,
  ResolvedCategoryDetails,
  ComplementaryEvaluationOptions,
  ComplementaryEvaluationResult,
};

/**
 * Checks whether a merchant or counterparty name is generic or placeholder (e.g. "Unknown", "Kartu Debit").
 */
export function isGenericMerchant(merchant: string | undefined | null): boolean {
  if (!merchant) return true;
  const lowerMerchant = merchant.trim().toLowerCase();
  if (!lowerMerchant || lowerMerchant === 'unknown') return true;

  // Special case: legitimate registered couriers and merchants
  if (lowerMerchant.includes('pos indonesia')) {
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
  if (exactPhrases.some(phrase => lowerMerchant.includes(phrase))) {
    return true;
  }

  // Word-token boundary checks for identifiers
  const words = lowerMerchant.split(/[^a-z0-9]+/);
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
    'mandiri',
    'jago',
    'bca',
    'bni',
    'bri',
    'cimb',
    'dana',
    'gopay',
    'ovo',
    'shopeepay',
    'flip',
  ]);

  return words.some(word => genericWords.has(word));
}

/**
 * Checks whether an account hint, payment method, or account name refers to a generic card network
 * (e.g. "Visa", "Mastercard", "Debit Card", "Kartu Debit").
 */
export function isGenericCardAccountOrMethod(text?: string | null): boolean {
  if (!text) return false;
  const lowerText = text.toLowerCase().trim();
  const genericCardTokens = [
    'visa',
    'mastercard',
    'jcb',
    'amex',
    'american express',
    'debit card',
    'credit card',
    'kartu debit',
    'kartu kredit',
  ];
  return genericCardTokens.some(token => {
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escapedToken}([^a-z0-9]|$)`, 'i').test(lowerText);
  });
}

/**
 * Determines whether candidate and incoming evidence point to distinctly different merchants.
 */
export function detectConflictingMerchants(
  candidate: { counterParty?: string | null },
  evidence: { merchant?: string | null },
  platformRegistry: CommercePlatformRegistry
): boolean {
  const candidateMerchant = (candidate.counterParty || '').trim().toLowerCase();
  const evidenceMerchant = (evidence.merchant || '').trim().toLowerCase();

  if (!candidateMerchant || !evidenceMerchant) {
    return false;
  }

  // If either merchant is generic / placeholder, they cannot be in conflict
  if (isGenericMerchant(candidateMerchant) || isGenericMerchant(evidenceMerchant)) {
    return false;
  }

  // Known brands registered in CommercePlatformRegistry
  const knownBrands = platformRegistry.getAllMerchantKeywords();
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
  const candidateTokens = candidateMerchant.split(/[^a-z0-9]+/).filter(token => token.length >= 4);
  const evidenceTokens = evidenceMerchant.split(/[^a-z0-9]+/).filter(token => token.length >= 4);
  if (candidateTokens.some(token => evidenceTokens.includes(token))) {
    return false;
  }

  // Both have distinct specific merchant names that do not match
  return true;
}

/**
 * Checks whether a transaction note is boilerplate / generic payment metadata
 * (e.g. "Transaction using Jago debit card", "Pembayaran QRIS") rather than rich itemized details.
 */
export function isGenericNote(
  note: string | undefined | null,
  merchantOrCounterParty?: string | null,
  subject?: string | null
): boolean {
  if (!note) return true;
  const trimmedNote = note.trim();
  if (!trimmedNote) return true;

  // Detailed receipt notes containing order IDs (#), bullets, or item lines are NEVER generic
  if (trimmedNote.includes('#') || trimmedNote.includes('•') || trimmedNote.includes('\n')) {
    return false;
  }

  const lowerNote = trimmedNote.toLowerCase();
  if (
    merchantOrCounterParty &&
    lowerNote === merchantOrCounterParty.trim().toLowerCase()
  ) {
    return true;
  }
  if (subject && lowerNote === subject.trim().toLowerCase()) {
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
    'debit card transaction',
    'debit card transaction via bank jago',
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
    'e-receipt',
    'grab e-receipt',
    'grab receipt',
    'gojek receipt',
    'electronic receipt',
    'struk digital',
    'struk pembayaran',
    'tanda terima',
    'tanda terima elektronik',
    'bukti pembayaran',
    'bukti transaksi',
    'bukti transfer',
  ];

  if (genericExactPhrases.includes(lowerNote)) {
    return true;
  }

  // Generic prefix / boilerplate patterns without specific product details
  const genericPrefixes = [
    'transaksi menggunakan kartu debit',
    'transaction using debit card',
    'transaction using jago debit card',
    'debit card transaction via',
    'debit card transaction',
    'transaksi kartu debit',
    'pembayaran qris di',
    'pembayaran qris',
    'pembayaran via',
    'pembayaran berhasil',
    'payment via',
    'payment using',
  ];

  for (const prefix of genericPrefixes) {
    if (lowerNote.startsWith(prefix) && lowerNote.length < prefix.length + 25) {
      return true;
    }
  }

  // Generic merchant e-receipt patterns like "[merchant] e-receipt" or "e-receipt [merchant]"
  if (
    lowerNote.endsWith('e-receipt') ||
    lowerNote.endsWith('receipt') ||
    lowerNote.startsWith('e-receipt') ||
    lowerNote.startsWith('tanda terima') ||
    lowerNote.startsWith('bukti pembayaran')
  ) {
    const strippedNote = lowerNote
      .replace(/^(e-receipt|receipt|tanda terima|bukti pembayaran)\s*/i, '')
      .replace(/\s*(e-receipt|receipt)$/i, '')
      .trim();
    if (
      !strippedNote ||
      strippedNote.split(/\s+/).length <= 2 ||
      (merchantOrCounterParty && strippedNote === merchantOrCounterParty.trim().toLowerCase())
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether an item or candidate originates from a bank or financial institution source.
 */
export function isBankSource(candidate: BankSourceCandidate): boolean {
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
  return bankKeywords.some(keyword => lowerName.includes(keyword) || lowerAccount.includes(keyword));
}

/**
 * Checks whether an item or candidate originates from a merchant payment or receipt source.
 */
export function isPaymentOrReceiptSource(
  candidate: PaymentSourceCandidate,
  platformRegistry: CommercePlatformRegistry
): boolean {
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
    platformRegistry.isCommerceMerchant(lowerName) ||
    platformRegistry.isCommerceMerchant(lowerCounter)
  );
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
  const isIncomingBank =
    incoming.sourceType === 'EMAIL_BANK' ||
    (incoming.sourceType === 'PUSH_NOTIFICATION' &&
      isBankSource({
        bankDisplayName: incoming.accountHint,
        accountNameHint: incoming.accountHint,
        evidenceSources: [incoming.sourceType],
      }));

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

/**
 * Evaluates if one source is a bank debit and the other is a merchant/payment receipt
 * whose details semantically match.
 */
export function evaluateComplementarySources(
  candidate: PendingTransactionItem,
  evidence: TransactionEvidence,
  timeDiffMs: number,
  options: ComplementaryEvaluationOptions
): ComplementaryEvaluationResult {
  const { platformRegistry, tightWindowMilliseconds } = options;

  const isCandidateBank = isBankSource(candidate);
  const isEvidenceBank =
    evidence.sourceType === 'EMAIL_BANK' ||
    (evidence.sourceType === 'PUSH_NOTIFICATION' &&
      isBankSource({
        bankDisplayName: evidence.accountHint,
        accountNameHint: evidence.accountHint,
        evidenceSources: [evidence.sourceType],
      }));

  const isCandidatePayment = isPaymentOrReceiptSource(candidate, platformRegistry);
  const isEvidencePayment =
    evidence.sourceType === 'EMAIL_PAYMENT' ||
    evidence.sourceType === 'RECEIPT' ||
    (evidence.sourceType === 'PUSH_NOTIFICATION' && !isEvidenceBank);

  const isCrossSource =
    (isCandidateBank && isEvidencePayment) || (isCandidatePayment && isEvidenceBank);

  if (!isCrossSource) {
    // Check if both are bank debits for the same transaction across channels (e.g. Push Notification + Email Bank)
    const isDualChannelBank =
      isCandidateBank &&
      isEvidenceBank &&
      (candidate.evidenceSources?.includes('PUSH_NOTIFICATION') ||
        evidence.sourceType === 'PUSH_NOTIFICATION');

    if (isDualChannelBank && timeDiffMs <= tightWindowMilliseconds) {
      return {
        isHighConfidence: true,
        reasons: [
          `Identical bank transaction across push notification and email channels within tight window (${Math.round(
            timeDiffMs / 1000
          )}s)`,
        ],
      };
    }

    // Check if both are same merchant within tight window
    const candidateMerchant = (candidate.counterParty || '').toLowerCase();
    const evidenceMerchant = (evidence.merchant || '').toLowerCase();
    if (
      candidateMerchant &&
      evidenceMerchant &&
      (candidateMerchant.includes(evidenceMerchant) || evidenceMerchant.includes(candidateMerchant)) &&
      timeDiffMs <= tightWindowMilliseconds
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
  const knownMerchants = platformRegistry.getAllMerchantKeywords();
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
  if (isBankQris && isPaymentQris && timeDiffMs <= tightWindowMilliseconds) {
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
  const isBankMerchantGeneric = isGenericMerchant(bankCounterParty);
  const isPaymentMerchantSpecific =
    Boolean(paymentMerchant) &&
    paymentMerchant.length >= 2 &&
    !isGenericMerchant(paymentMerchant);

  if (isBankMerchantGeneric && isPaymentMerchantSpecific) {
    const accountsMatch = Boolean(
      bankAccountId && paymentAccountId && bankAccountId === paymentAccountId
    );

    // Payment platform wallets (ShopeePay, GoPay, OVO, DANA) or cash/tunai
    // are compatible with authoritative bank debits
    const isPaymentAccountPlatformOrCash =
      !paymentAccountId ||
      paymentAccountId === 'acc-cash' ||
      platformRegistry.isPlatformWallet(paymentAccountName);

    // Generic card networks (Visa, Mastercard, Debit Card, etc.) mentioned in merchant receipts
    // (e.g. Grab "Visa: Rp 54500") are compatible with authoritative bank debits
    const isGenericCardNetwork =
      isGenericCardAccountOrMethod(paymentAccountName) ||
      isGenericCardAccountOrMethod(evidence.accountHint);

    const isAccountCompatible =
      !bankAccountId ||
      !paymentAccountId ||
      accountsMatch ||
      isPaymentAccountPlatformOrCash ||
      isGenericCardNetwork;

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
