import type { CommercePlatformRegistry } from '../../config/commercePlatforms.js';

export interface BankSourceCandidate {
  evidenceSources?: string[];
  bankDisplayName?: string | null;
  accountNameHint?: string | null;
}

export interface PaymentSourceCandidate {
  evidenceSources?: string[];
  bankDisplayName?: string | null;
  counterParty?: string | null;
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
