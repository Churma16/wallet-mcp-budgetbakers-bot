import { CommercePlatformRegistry } from '../config/commercePlatforms.js';
import type {
  BankEmailRuleDefinition,
  GateEvaluationResult,
} from './types.js';

export const COMMON_BANK_BLACKLIST_KEYWORDS = [
  'otp',
  'kode verifikasi',
  'login',
  'perangkat baru',
  'promo',
  'diskon',
  'newsletter',
];

export const COMMON_TRANSFER_TOPUP_KEYWORDS = [
  'top up',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
  'transfer',
];

export const BANK_DEBIT_AND_GATEWAY_RULES: BankEmailRuleDefinition[] = [
  // 1. Bank Mandiri (Livin' by Mandiri)
  {
    bankKey: 'mandiri',
    displayName: 'Bank Mandiri (Livin)',
    accountNameHint: 'Mandiri',
    senderDomains: ['bankmandiri.co.id'],
    subjectKeywords: [
      'notifikasi transaksi',
      'debit rekening',
      'kredit rekening',
      'resi transaksi',
      'qris',
      'transfer',
      'livin',
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'perangkat baru',
      'login baru',
      'promo',
      'diskon',
      'penawaran khusus',
      'newsletter',
      'aktivasi',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:debet|kredit|nominal|transaksi|qris|pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Debet|Pembayaran|Transaksi)|Jumlah\s*(?:Debet|Transaksi)|Nominal)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|No\.?\s*Resi|Nomor\s*Transaksi|No\.?\s*Transaksi|RRN)(?:\s*(?:\([^\)]+\)|BI\s*Fast))?[:\s]*([A-Za-z0-9]+)/i,
      /Ref(?:erence)?\s*(?:No|ID)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'topup',
      'gopay',
      'ovo',
      'dana',
      'shopeepay',
      'linkaja',
      'jago',
      'transfer ke rekening sendiri',
    ],
  },

  // 2. Bank Jago
  {
    bankKey: 'jago',
    displayName: 'Bank Jago',
    accountNameHint: 'Jago Expense',
    senderDomains: ['jago.com'],
    subjectKeywords: [
      'uang keluar',
      'uang masuk',
      'transaksi berhasil',
      'kantong',
      'pembayaran',
      'transfer',
      'payment',
      'transaction',
      'debit card',
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'login',
      'perangkat baru',
      'promo',
      'bunga kantong',
      'newsletter',
      'being process',
      'is being process',
      'fresh new look',
      'getting a fresh new look',
    ],
    bodyRequiredPatterns: [
      /(?:uang keluar|uang masuk|berhasil|kantong|nominal|successful|amount|transaction of|debit card|pocket|payment)/i,
    ],
    amountPriorityPatterns: [
      /(?:Jumlah|Total|Nominal|Amount)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:transaction of)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:ID\s*Transaksi|No\.?\s*Referensi|Kode\s*Transaksi|Terminal\s*ID)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'topup',
      'gopay',
      'ovo',
      'dana',
      'shopeepay',
      'pindah kantong',
      'kirim uang',
    ],
  },

  // 3. Bank Central Asia (BCA)
  {
    bankKey: 'bca',
    displayName: 'BCA',
    accountNameHint: 'BCA',
    senderDomains: ['bca.co.id', 'klikbca.com'],
    subjectKeywords: [
      'transaksi',
      'debet',
      'kredit',
      'transfer',
      'qris',
      'm-bca',
      'mybca',
      'pembayaran',
      'payment',
    ],
    blacklistKeywords: COMMON_BANK_BLACKLIST_KEYWORDS,
    bodyRequiredPatterns: [
      /(?:transaksi|debet|kredit|berhasil|nominal|rekening|qris|pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Nominal|Jumlah|Total|Sebesar)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|Ref)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: COMMON_TRANSFER_TOPUP_KEYWORDS,
    ruleCategory: 'BANK',
  },

  // 4. GoPay / Gojek
  {
    bankKey: 'gopay',
    displayName: 'GoPay / Gojek',
    accountNameHint: 'GoPay',
    senderDomains: ['gopay.co.id', 'gojek.com'],
    subjectKeywords: [
      'bukti pembayaran',
      'receipt',
      'tanda terima',
      'pesanan anda telah selesai',
      'transaksi gopay',
      'pembayaran qris',
    ],
    blacklistKeywords: [
      'voucher',
      'diskon',
      'promo',
      'cashback harian',
      'goclub',
      'otp',
      'verifikasi',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total tarif|total|gopay|biaya)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Tarif|Biaya|Transaksi)|Jumlah\s*Total)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Pesanan|Order\s*ID|ID\s*Transaksi)[:\s]*([A-Za-z0-9-]+)/i,
      /(RB-[0-9A-Z-]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'isi saldo',
      'transfer bank',
      'tarik saldo',
    ],
  },

  // 5. OVO
  {
    bankKey: 'ovo',
    displayName: 'OVO',
    accountNameHint: 'OVO',
    senderDomains: ['ovo.id'],
    subjectKeywords: [
      'rincian transaksi',
      'transaksi berhasil',
      'pembayaran berhasil',
      'transfer berhasil',
      'top up berhasil',
    ],
    blacklistKeywords: [
      'promo',
      'poin ovo',
      'diskon',
      'invest',
      'asuransi',
      'otp',
      'security code',
      'voucher',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total|berhasil|ovo cash)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*Pembayaran|Total\s*Transaksi|Nominal)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|No\.?\s*Transaksi|Reference\s*No)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'isi saldo',
      'transfer ke rekening bank',
    ],
  },

  // 6. DANA
  {
    bankKey: 'dana',
    displayName: 'DANA',
    accountNameHint: 'DANA',
    senderDomains: ['dana.id'],
    subjectKeywords: [
      'pembayaran berhasil',
      'transaksi berhasil',
      'transfer berhasil',
      'kirim uang berhasil',
      'struk pembayaran',
    ],
    blacklistKeywords: [
      'dana kaget',
      'promo',
      'diskon',
      'voucher',
      'games',
      'otp',
      'pin',
      'newsletter',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total|saldo dana|berhasil)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Bayar)|Jumlah)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:ID\s*Pesanan|ID\s*Transaksi|Order\s*ID|No\.?\s*Referensi)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'isi saldo',
      'top up',
      'kirim uang ke bank',
    ],
  },

  // 7. ShopeePay
  {
    bankKey: 'shopeepay',
    displayName: 'ShopeePay',
    accountNameHint: 'ShopeePay',
    senderDomains: ['shopeepay.co.id'],
    subjectKeywords: [
      'transaksi shopeepay',
      'shopeepay berhasil',
      'isi saldo shopeepay',
      'transfer shopeepay',
      'pembayaran shopeepay',
    ],
    blacklistKeywords: [
      'flash sale',
      'gratis ongkir',
      'promo',
      'diskon',
      'koin shopee',
      'otp',
      'verifikasi',
      'login baru',
      'perangkat baru',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|shopeepay|total transaksi|rincian transaksi)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Transaksi|Isi Saldo)|Jumlah)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Transaksi|ID\s*Transaksi|No\.?\s*Referensi|Order\s*SN)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'isi saldo',
      'top up',
      'transfer ke bank',
    ],
    ruleCategory: 'PAYMENT_GATEWAY',
  },

  // 8. Flip
  {
    bankKey: 'flip',
    displayName: 'Flip',
    accountNameHint: 'Flip',
    senderDomains: ['flip.id'],
    subjectKeywords: [
      'successful transfer',
      'transaction information',
      'bukti pembayaran berhasil',
      'transfer berhasil',
      'transaksi berhasil',
      'receipt',
    ],
    blacklistKeywords: [
      'terms and conditions',
      'kebijakan privasi',
      'otp',
      'kode verifikasi',
      'promo',
      'diskon',
      'newsletter',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:transaction details|transaction id|destination|nominal|total|successful|transfer|bukti pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Transaksi|Transfer|Pembayaran)|Nominal|Amount)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:Transaction\s*ID|ID\s*Transaksi|No\.?\s*Transaksi|Ref)[:\s]*#?([A-Za-z0-9_-]+)/i,
      /#([A-Za-z0-9_-]+)/i,
    ],
    transferOrTopupKeywords: [
      'transfer',
      'kirim uang',
      'top up',
      'topup',
      'rekening',
    ],
    ruleCategory: 'PAYMENT_GATEWAY',
  },
];

/**
 * Resolves the complete active list of email rules, combining pure bank debit & gateway rules
 * with dynamic and declarative commerce platform rules from CommercePlatformRegistry.
 */
export function getAllBankEmailRules(): BankEmailRuleDefinition[] {
  return [
    ...BANK_DEBIT_AND_GATEWAY_RULES,
    ...CommercePlatformRegistry.getInstance().toBankEmailRules(),
  ];
}

/**
 * Complete list of email rules, combining pure bank debit & gateway rules
 * with declarative commerce platform rules from CommercePlatformRegistry.
 */
export const BANK_EMAIL_RULES: BankEmailRuleDefinition[] = getAllBankEmailRules();

/**
 * Extracts and normalizes the actual domain from an email sender value.
 *
 * Supports the plain addresses produced by mailparser and a conservative
 * `Display Name <address@example.com>` fallback without trusting text in the
 * display name or local part. Malformed or ambiguous sender values are rejected.
 */
export function extractSenderDomain(emailSenderAddress: string): string | undefined {
  const rawSender = emailSenderAddress.trim();
  if (!rawSender) {
    return undefined;
  }

  const hasAngleBracket = rawSender.includes('<') || rawSender.includes('>');
  let addressCandidate = rawSender;

  if (hasAngleBracket) {
    const angleAddressMatch = rawSender.match(/^[^<>]*<\s*([^<>]+)\s*>\s*$/);
    if (!angleAddressMatch?.[1]) {
      return undefined;
    }
    addressCandidate = angleAddressMatch[1];
  }

  addressCandidate = addressCandidate.trim().toLowerCase();

  // Reject ambiguous address lists or whitespace-delimited display-name fallbacks.
  if (
    !addressCandidate ||
    /[\s,;]/.test(addressCandidate) ||
    addressCandidate.startsWith('@') ||
    addressCandidate.endsWith('@')
  ) {
    return undefined;
  }

  const firstAtIndex = addressCandidate.indexOf('@');
  const lastAtIndex = addressCandidate.lastIndexOf('@');
  if (firstAtIndex <= 0 || firstAtIndex !== lastAtIndex) {
    return undefined;
  }

  const senderDomain = addressCandidate.slice(lastAtIndex + 1).replace(/\.$/, '');
  if (!senderDomain || senderDomain.length > 253 || !senderDomain.includes('.')) {
    return undefined;
  }

  const domainLabels = senderDomain.split('.');
  const isValidDomain = domainLabels.every(
    label =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
  );

  return isValidDomain ? senderDomain : undefined;
}

/**
 * Normalizes a configured allowlist domain to a clean base domain.
 */
export function normalizeAllowedSenderDomain(allowedDomain: string): string {
  return allowedDomain.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

/**
 * Returns true only for an exact configured domain or one of its real
 * subdomains. Arbitrary substring occurrences never satisfy the allowlist.
 */
export function doesSenderDomainMatchAllowedDomain(
  senderDomain: string,
  allowedDomain: string
): boolean {
  const normalizedAllowedDomain = normalizeAllowedSenderDomain(allowedDomain);
  if (!normalizedAllowedDomain) {
    return false;
  }

  return (
    senderDomain === normalizedAllowedDomain ||
    senderDomain.endsWith(`.${normalizedAllowedDomain}`)
  );
}

/**
 * Normalizes and parses Indonesian currency strings into numeric values.
 * Handles formats like: "45.000", "45.000,00", "1.500.000", "25,000.00"
 */
export function parseCurrencyAmountStringToNumber(rawAmountText: string): number {
  if (!rawAmountText) {
    return 0;
  }

  // Remove currency markers and non-numeric characters except dots and commas
  const cleanedText = rawAmountText.replace(/[^0-9.,]/g, '').trim();
  if (!cleanedText) {
    return 0;
  }

  // Case 1: Indonesian standard with cents at end, e.g. "45.000,00" or "1.500.000,50"
  if (/,\d{2}$/.test(cleanedText)) {
    const withoutThousandDots = cleanedText.replace(/\./g, '');
    const standardizedDecimal = withoutThousandDots.replace(',', '.');
    return Number.parseFloat(standardizedDecimal) || 0;
  }

  // Case 2: US standard with cents at end, e.g. "45,000.00"
  if (/\.\d{2}$/.test(cleanedText) && cleanedText.includes(',')) {
    const withoutThousandCommas = cleanedText.replace(/,/g, '');
    return Number.parseFloat(withoutThousandCommas) || 0;
  }

  // Case 3: Indonesian standard without cents, e.g. "45.000" or "1.500.000"
  if (cleanedText.includes('.')) {
    const digitsOnly = cleanedText.replace(/\./g, '');
    return Number.parseFloat(digitsOnly) || 0;
  }

  // Case 4: US standard without cents, e.g. "45,000"
  if (cleanedText.includes(',')) {
    const digitsOnly = cleanedText.replace(/,/g, '');
    return Number.parseFloat(digitsOnly) || 0;
  }

  // Case 5: Plain digits, e.g. "45000"
  return Number.parseFloat(cleanedText) || 0;
}

/**
 * Evaluates an incoming email against Gate 1: Logic & Modular Dictionary.
 * Returns passed=false with a descriptive reason if the email is not a valid transaction.
 */
export function evaluateEmailThroughGateOne(
  emailSubject: string,
  emailSenderAddress: string,
  emailBodyText: string,
  emailDate: Date,
  startupCutoffTimestamp: Date,
  processedReferenceNumberSet: Set<string>
): GateEvaluationResult {
  const sanitizedSubject = emailSubject.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const sanitizedBody = emailBodyText.replace(/[\u200B-\u200D\uFEFF]/g, '');
  const normalizedSubject = sanitizedSubject.toLowerCase().trim();
  const senderDomain = extractSenderDomain(emailSenderAddress);
  const rawCombinedContent = `${sanitizedSubject}\n${sanitizedBody}`;
  const normalizedCombinedContent = rawCombinedContent.toLowerCase();

  // 1. Check Date Filter: Ignore emails received before the startup cutoff
  if (emailDate.getTime() < startupCutoffTimestamp.getTime()) {
    return {
      passed: false,
      reason: 'EMAIL_BEFORE_STARTUP_CUTOFF',
      originalDate: emailDate,
    };
  }

  // 2. Check the parsed sender domain against the rules dictionary.
  // Exact domains and legitimate subdomains are allowed; substrings are not.
  const activeRules = getAllBankEmailRules();
  const matchedRule = senderDomain
    ? activeRules.find(ruleDefinition =>
        ruleDefinition.senderDomains.some(allowedDomain =>
          doesSenderDomainMatchAllowedDomain(senderDomain, allowedDomain)
        )
      )
    : undefined;

  if (!matchedRule) {
    return {
      passed: false,
      reason: 'UNMATCHED_SENDER_DOMAIN',
      originalDate: emailDate,
    };
  }

  // 3. Check Subject Blacklist Keywords (OTP, Promo, Security Login, etc.)
  const hasBlacklistedSubjectKeyword = matchedRule.blacklistKeywords.some(blacklistedKeyword =>
    normalizedSubject.includes(blacklistedKeyword.toLowerCase())
  );

  if (hasBlacklistedSubjectKeyword) {
    return {
      passed: false,
      matchedBankRule: matchedRule,
      reason: 'SUBJECT_BLACKLIST_KEYWORD_MATCH',
      originalDate: emailDate,
    };
  }

  // 4. Check Transaction Keywords in Subject or Body
  const hasSubjectTransactionKeyword = matchedRule.subjectKeywords.some(keyword =>
    normalizedSubject.includes(keyword.toLowerCase())
  );

  const hasBodyRequiredPattern = matchedRule.bodyRequiredPatterns.some(pattern =>
    pattern.test(normalizedCombinedContent)
  );

  if (!hasSubjectTransactionKeyword && !hasBodyRequiredPattern) {
    return {
      passed: false,
      matchedBankRule: matchedRule,
      reason: 'NO_TRANSACTION_KEYWORDS_FOUND',
      originalDate: emailDate,
    };
  }

  // 5. Extract Reference Number / Transaction ID for Anti-Duplication
  let extractedReferenceNumber: string | undefined;
  for (const referencePattern of matchedRule.referencePatterns) {
    const referenceMatch = rawCombinedContent.match(referencePattern);
    if (referenceMatch && referenceMatch[1]) {
      extractedReferenceNumber = referenceMatch[1].trim();
      break;
    }
  }

  // Check if this reference number was already processed (case-insensitive)
  if (extractedReferenceNumber) {
    const normalizedRef = extractedReferenceNumber.toUpperCase();
    const isAlreadyProcessed = Array.from(processedReferenceNumberSet).some(
      existingRef => existingRef.toUpperCase() === normalizedRef
    );

    if (isAlreadyProcessed) {
      return {
        passed: false,
        matchedBankRule: matchedRule,
        referenceNumber: extractedReferenceNumber,
        reason: 'DUPLICATE_TRANSACTION_REFERENCE_NUMBER',
        originalDate: emailDate,
      };
    }
  }

  // 6. Extract Candidate Total Amount
  let candidateAmount: number = 0;
  for (const amountPattern of matchedRule.amountPriorityPatterns) {
    const amountMatch = rawCombinedContent.match(amountPattern);
    if (amountMatch && amountMatch[1]) {
      const parsedNumericAmount = parseCurrencyAmountStringToNumber(amountMatch[1]);
      if (parsedNumericAmount > 0) {
        candidateAmount = parsedNumericAmount;
        break;
      }
    }
  }

  if (candidateAmount <= 0) {
    return {
      passed: false,
      matchedBankRule: matchedRule,
      referenceNumber: extractedReferenceNumber,
      reason: 'NO_VALID_AMOUNT_FOUND',
      originalDate: emailDate,
    };
  }

  // 7. Check for Transfer or Top-Up Candidate indicators (using word boundary check to avoid false positives like Danamon matching dana)
  const isTransferCandidate = matchedRule.transferOrTopupKeywords.some(keyword => {
    const escapedKeyword = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordBoundaryPattern = new RegExp(`(^|[^a-z0-9])${escapedKeyword}([^a-z0-9]|$)`, 'i');
    return wordBoundaryPattern.test(normalizedCombinedContent);
  });

  return {
    passed: true,
    matchedBankRule: matchedRule,
    candidateAmount,
    referenceNumber: extractedReferenceNumber,
    isTransferCandidate,
    originalDate: emailDate,
  };
}
