/**
 * Structured result of parsing an amount string with currency awareness.
 */
export interface ParsedFinancialAmountResult {
  amount: number;
  explicitCurrencyHint?: string;
}

/**
 * Parses raw OCR/LLM currency amount strings into signed numbers and explicit currency hints.
 * Preserves decimal scale for decimal currencies (e.g. USD, EUR) while
 * respecting integer thousands separators for non-decimal currencies (e.g. IDR).
 *
 * Fails closed (returns null) on ambiguous separator patterns or invalid structures.
 */
export function parseFinancialAmount(rawInput: string): ParsedFinancialAmountResult | null {
  if (typeof rawInput !== 'string') {
    return null;
  }

  const trimmed = rawInput.trim();
  if (!trimmed) {
    return null;
  }

  // 1. Determine sign without backtracking regular expressions
  const isNegative = trimmed.startsWith('-') || (trimmed.startsWith('(') && trimmed.endsWith(')'));
  let strippedText = trimmed;
  if (trimmed.startsWith('-')) {
    strippedText = strippedText.slice(1).trim();
  } else if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    strippedText = strippedText.slice(1, -1).trim();
  }

  // 2. Identify explicit currency hints
  const isIdr = /(?:^|\s)(?:rp\.?|idr)(?:\s|$)/i.test(strippedText) ||
    /^(?:rp\.?|idr)/i.test(strippedText) ||
    /(?:rp\.?|idr)$/i.test(strippedText);

  let detectedCurrency: string | undefined = undefined;
  if (isIdr) {
    detectedCurrency = 'IDR';
  } else if (/[$]|\busd\b/i.test(strippedText)) {
    detectedCurrency = 'USD';
  } else if (/[€]|\beur\b/i.test(strippedText)) {
    detectedCurrency = 'EUR';
  } else if (/[£]|\bgbp\b/i.test(strippedText)) {
    detectedCurrency = 'GBP';
  } else if (/\bsgd\b/i.test(strippedText)) {
    detectedCurrency = 'SGD';
  } else if (/\baud\b/i.test(strippedText)) {
    detectedCurrency = 'AUD';
  } else if (/\bcad\b/i.test(strippedText)) {
    detectedCurrency = 'CAD';
  }

  const isDecimalCurrency = detectedCurrency !== undefined && detectedCurrency !== 'IDR';

  // Conflicting currency indicators fail closed
  if (isIdr && isDecimalCurrency) {
    return null;
  }

  // 3. Strip currency markers and spaces
  const withoutCurrency = strippedText
    .replace(/(?:rp\.?|idr|usd|eur|gbp|sgd|aud|cad|[$€£])/gi, '')
    .trim();

  // Must contain only digits, dots, and commas
  if (!/^[0-9.,]+$/.test(withoutCurrency)) {
    return null;
  }

  // Reject consecutive separators or trailing separators
  if (/[.,]{2}/.test(withoutCurrency) || withoutCurrency.endsWith('.') || withoutCurrency.endsWith(',')) {
    return null;
  }

  const dotCount = (withoutCurrency.match(/\./g) || []).length;
  const commaCount = (withoutCurrency.match(/,/g) || []).length;

  const buildResult = (value: number): ParsedFinancialAmountResult => ({
    amount: isNegative ? -value : value,
    ...(detectedCurrency ? { explicitCurrencyHint: detectedCurrency } : {}),
  });

  // Case A: No separators (pure integer digits)
  if (dotCount === 0 && commaCount === 0) {
    const parsedNumber = Number(withoutCurrency);
    if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
      return null;
    }
    return buildResult(parsedNumber);
  }

  // Case B: Both dot and comma present
  if (dotCount > 0 && commaCount > 0) {
    const lastDotIndex = withoutCurrency.lastIndexOf('.');
    const lastCommaIndex = withoutCurrency.lastIndexOf(',');

    if (lastDotIndex > lastCommaIndex) {
      // US/International format: commas are thousands separators, last dot is decimal separator (e.g. 1,234.50)
      if (dotCount > 1) {
        return null;
      }
      const integerSection = withoutCurrency.slice(0, lastDotIndex);
      const decimalSection = withoutCurrency.slice(lastDotIndex + 1);

      // Validate standard thousands grouping: 1-3 digits followed by groups of 3 digits
      if (!/^\d{1,3}(,\d{3})*$/.test(integerSection) || !/^\d{1,4}$/.test(decimalSection)) {
        return null;
      }

      const standardizedNumber = Number.parseFloat(withoutCurrency.replace(/,/g, ''));
      if (!Number.isFinite(standardizedNumber) || standardizedNumber === 0) {
        return null;
      }
      return buildResult(standardizedNumber);
    } else {
      // European/Indonesian format: dots are thousands separators, last comma is decimal separator (e.g. 1.234,50)
      if (commaCount > 1) {
        return null;
      }
      const integerSection = withoutCurrency.slice(0, lastCommaIndex);
      const decimalSection = withoutCurrency.slice(lastCommaIndex + 1);

      if (!/^\d{1,3}(\.\d{3})*$/.test(integerSection) || !/^\d{1,4}$/.test(decimalSection)) {
        return null;
      }

      const standardizedNumber = Number.parseFloat(
        withoutCurrency.replace(/\./g, '').replace(',', '.')
      );
      if (!Number.isFinite(standardizedNumber) || standardizedNumber === 0) {
        return null;
      }
      return buildResult(standardizedNumber);
    }
  }

  // Case C: Multiple dots, no comma (thousands separators, e.g. 1.500.000)
  if (dotCount > 1 && commaCount === 0) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(withoutCurrency)) {
      return null;
    }
    const standardizedNumber = Number(withoutCurrency.replace(/\./g, ''));
    if (!Number.isFinite(standardizedNumber) || standardizedNumber === 0) {
      return null;
    }
    return buildResult(standardizedNumber);
  }

  // Case D: Multiple commas, no dot (thousands separators, e.g. 1,500,000)
  if (commaCount > 1 && dotCount === 0) {
    if (!/^\d{1,3}(,\d{3})+$/.test(withoutCurrency)) {
      return null;
    }
    const standardizedNumber = Number(withoutCurrency.replace(/,/g, ''));
    if (!Number.isFinite(standardizedNumber) || standardizedNumber === 0) {
      return null;
    }
    return buildResult(standardizedNumber);
  }

  // Case E: Exactly ONE separator (single dot or single comma)
  const isDot = dotCount === 1;
  const [integerPart, fractionalOrThousandsPart] = withoutCurrency.split(isDot ? '.' : ',');
  const trailingDigitsCount = fractionalOrThousandsPart.length;

  if (isDot) {
    if (isIdr) {
      // In IDR, dot is thousands separator (e.g. Rp10.079, Rp15.100)
      if (trailingDigitsCount === 3 && /^\d{1,3}$/.test(integerPart)) {
        const parsedNumber = Number(`${integerPart}${fractionalOrThousandsPart}`);
        if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
          return null;
        }
        return buildResult(parsedNumber);
      }
      // Non-3-digit dots with Rp are ambiguous or invalid in IDR
      return null;
    }

    if (isDecimalCurrency) {
      // In USD/EUR/GBP, dot with 1 or 2 trailing digits is standard cents (e.g. $10.50, $10.5)
      if (trailingDigitsCount === 1 || trailingDigitsCount === 2) {
        const parsedNumber = Number.parseFloat(withoutCurrency);
        if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
          return null;
        }
        return buildResult(parsedNumber);
      }
      // Dot with 3 trailing digits under decimal currency (e.g. $10.500) is ambiguous
      return null;
    }

    // No explicit currency indicator
    // A single dot followed by 1 or 2 digits is decimal scale (thousands separators never have 1 or 2 digits)
    if (trailingDigitsCount === 1 || trailingDigitsCount === 2) {
      const parsedNumber = Number.parseFloat(withoutCurrency);
      if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
        return null;
      }
      return buildResult(parsedNumber);
    }

    // Dot followed by 3 digits with no currency (e.g. "10.079", "10.500") is ambiguous between decimal and thousands
    return null;
  } else {
    // Single comma
    if (isIdr) {
      // In IDR, comma is decimal for cents (e.g. Rp50,50)
      if (trailingDigitsCount === 1 || trailingDigitsCount === 2) {
        const parsedNumber = Number.parseFloat(`${integerPart}.${fractionalOrThousandsPart}`);
        if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
          return null;
        }
        return buildResult(parsedNumber);
      }
      return null;
    }

    if (isDecimalCurrency) {
      // In USD, comma followed by 3 digits is integer thousands (e.g. $1,234)
      if (trailingDigitsCount === 3 && /^\d{1,3}$/.test(integerPart)) {
        const parsedNumber = Number(`${integerPart}${fractionalOrThousandsPart}`);
        if (!Number.isFinite(parsedNumber) || parsedNumber === 0) {
          return null;
        }
        return buildResult(parsedNumber);
      }
      // Comma with 1 or 2 digits under USD ($10,50) is ambiguous European notation
      return null;
    }

    // Single comma without currency indicator is ambiguous
    return null;
  }
}

/**
 * Convenience wrapper returning only the numeric amount, or null if unparseable/ambiguous.
 */
export function parseFinancialAmountString(rawInput: string): number | null {
  return parseFinancialAmount(rawInput)?.amount ?? null;
}
