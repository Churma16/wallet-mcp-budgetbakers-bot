import { BANK_EMAIL_RULES, BankEmailRuleDefinition } from '../config/bankEmailRules.js';

export interface GateEvaluationResult {
  passed: boolean;
  matchedBankRule?: BankEmailRuleDefinition;
  candidateAmount?: number;
  referenceNumber?: string;
  isTransferCandidate?: boolean;
  originalDate?: Date;
  reason?: string;
}

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

  const angleAddressMatch = rawSender.match(/^.*<\s*([^<>]+)\s*>\s*$/);
  const addressCandidate = (angleAddressMatch?.[1] ?? rawSender).trim().toLowerCase();

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
  const normalizedSubject = emailSubject.toLowerCase().trim();
  const senderDomain = extractSenderDomain(emailSenderAddress);
  const rawCombinedContent = `${emailSubject}\n${emailBodyText}`;
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
  const matchedRule = senderDomain
    ? BANK_EMAIL_RULES.find(ruleDefinition =>
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

  // 7. Check for Transfer or Top-Up Candidate indicators
  const isTransferCandidate = matchedRule.transferOrTopupKeywords.some(keyword =>
    normalizedCombinedContent.includes(keyword.toLowerCase())
  );

  return {
    passed: true,
    matchedBankRule: matchedRule,
    candidateAmount,
    referenceNumber: extractedReferenceNumber,
    isTransferCandidate,
    originalDate: emailDate,
  };
}
