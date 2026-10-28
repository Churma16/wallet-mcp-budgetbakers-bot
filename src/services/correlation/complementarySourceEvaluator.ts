import type { PendingTransactionItem } from '../pendingTransactionService.js';
import type { TransactionEvidence } from '../../types/transactionCorrelationTypes.js';
import type { CommercePlatformRegistry } from '../../config/commercePlatforms.js';
import { isGenericMerchant, isGenericCardAccountOrMethod } from './merchantClassifier.js';
import { isBankSource, isPaymentOrReceiptSource } from './transactionSourceClassifier.js';

export interface ComplementaryEvaluationOptions {
  platformRegistry: CommercePlatformRegistry;
  tightWindowMilliseconds: number;
}

export interface ComplementaryEvaluationResult {
  isHighConfidence: boolean;
  reasons: string[];
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
  const isEvidenceBank = evidence.sourceType === 'EMAIL_BANK';

  const isCandidatePayment = isPaymentOrReceiptSource(candidate, platformRegistry);
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
