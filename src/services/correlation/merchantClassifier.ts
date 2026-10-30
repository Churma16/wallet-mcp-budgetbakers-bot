import type { CommercePlatformRegistry } from '../../config/commercePlatforms.js';

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
