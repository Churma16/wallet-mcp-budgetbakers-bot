/**
 * Smart casing and normalization utility for transaction descriptions, notes, and counterParty strings.
 *
 * Implements intelligent Title Case formatting with:
 * - Full uppercase retention for transit, financial, tech, and public acronyms (e.g. MRT, KRL, BCA, QRIS, PLN).
 * - Indonesian and English minor words (prepositions/conjunctions) kept lowercase (e.g. "di", "ke", "dari", "dan", "untuk").
 * - Route connector normalization ("to" -> "ke", "->" -> "ke") for transit trips.
 * - Transit abbreviation expansion (e.g. "tj priuk" / "tj priok" -> "Tanjung Priok").
 * - Canonical brand casing (e.g. "GoPay", "ShopeePay", "GrabFood", "Indomaret", "McDonald's").
 * - Multiplier / quantity prefix preservation (e.g. "2x Nasi Goreng").
 * - Account hint / payment token decontamination from notes.
 */

/** Known uppercase transit, financial, utility, and tech acronyms */
const KNOWN_UPPERCASE_ACRONYMS = new Set<string>([
  // Transit
  'MRT',
  'KRL',
  'LRT',
  'KAI',
  'TJ',
  'DAMRI',
  'APMS',
  'HI',
  // Banking / Fintech / Payments
  'BCA',
  'BRI',
  'BNI',
  'BSI',
  'CIMB',
  'BTPN',
  'QRIS',
  'ATM',
  'EDC',
  'PPOB',
  'VA',
  'PAN',
  // Utilities & Public Services
  'PLN',
  'PDAM',
  'BPJS',
  'PBB',
  'SIM',
  'STNK',
  'KTP',
  'NPWP',
  'SPBU',
  'BBM',
  'RSUD',
  // Food / Retail / Tech
  'KFC',
  'A&W',
  'XXI',
  'CGV',
  'SMS',
  'POS',
  'AI',
  'VPS',
  'API',
  'SEO',
  'PWA',
]);

/** Prepositions and conjunctions that remain lowercase when not the leading word */
const MINOR_WORDS = new Set<string>([
  // Indonesian
  'di',
  'ke',
  'dari',
  'dan',
  'untuk',
  'pada',
  'yang',
  'atau',
  'oleh',
  'dengan',
  'buat',
  // English
  'in',
  'at',
  'on',
  'by',
  'for',
  'from',
  'of',
  'with',
  'and',
  'or',
  'the',
  'a',
  'an',
]);

/** Canonical brand name mapping (case-insensitive lookup -> canonical format) */
const CANONICAL_BRAND_CASING = new Map<string, string>([
  ['gopay', 'GoPay'],
  ['shopeepay', 'ShopeePay'],
  ['grabfood', 'GrabFood'],
  ['gofood', 'GoFood'],
  ['shopeefood', 'ShopeeFood'],
  ['grabbike', 'GrabBike'],
  ['goride', 'GoRide'],
  ['grabcar', 'GrabCar'],
  ['gocar', 'GoCar'],
  ['tokopedia', 'Tokopedia'],
  ['indomaret', 'Indomaret'],
  ['alfamart', 'Alfamart'],
  ['alfagift', 'Alfagift'],
  ['blibli', 'Blibli'],
  ['starbucks', 'Starbucks'],
  ['chatime', 'Chatime'],
  ['mcd', 'McD'],
  ['mcdonalds', "McDonald's"],
  ["mcdonald's", "McDonald's"],
  ['deli2go', 'Deli2go'],
]);

export interface NormalizeTransactionTextOptions {
  /** Account hint captured by AI intent (e.g. "Tapcash", "BNI Tapcash", "Jago") */
  accountHint?: string;
  /** Resolved canonical account name from Wallet (e.g. "BNI Tapcash", "Cash") */
  accountName?: string;
}

/**
 * Normalizes single words within a title-cased sentence.
 */
function normalizeWordToken(rawWord: string, isLeadingWord: boolean): string {
  // Separate leading or trailing punctuation (e.g. "(KRL)", "BCA:", "#tag")
  const match = rawWord.match(/^([^a-zA-Z0-9]*)(.*?)([^a-zA-Z0-9]*)$/);
  if (!match) {
    return rawWord;
  }

  const [, leadingPunct, coreToken, trailingPunct] = match;
  if (!coreToken) {
    return rawWord;
  }

  const lowerCore = coreToken.toLowerCase();

  // 1. Check exact brand override
  if (CANONICAL_BRAND_CASING.has(lowerCore)) {
    return `${leadingPunct}${CANONICAL_BRAND_CASING.get(lowerCore)}${trailingPunct}`;
  }

  // 2. Check uppercase acronym
  if (KNOWN_UPPERCASE_ACRONYMS.has(coreToken.toUpperCase())) {
    return `${leadingPunct}${coreToken.toUpperCase()}${trailingPunct}`;
  }

  // 3. Multiplier / Quantity format (e.g. "2x", "1x", "10x")
  if (/^\d+x$/i.test(coreToken)) {
    return `${leadingPunct}${coreToken.toLowerCase()}${trailingPunct}`;
  }

  // 4. Minor words / Prepositions (remain lowercase unless leading word)
  if (MINOR_WORDS.has(lowerCore)) {
    if (isLeadingWord) {
      return `${leadingPunct}${lowerCore.charAt(0).toUpperCase()}${lowerCore.slice(1)}${trailingPunct}`;
    }
    return `${leadingPunct}${lowerCore}${trailingPunct}`;
  }

  // 5. Preserving existing mixed-case tokens (e.g. "iPhone", "d'BestO", "WiFi")
  const hasInternalUppercase = /[a-z][A-Z]/.test(coreToken);
  const hasApostropheCase = /^[a-z]'[A-Z]/i.test(coreToken);
  if (hasInternalUppercase || hasApostropheCase) {
    return `${leadingPunct}${coreToken}${trailingPunct}`;
  }

  // 6. Default Title Casing
  const capitalizedCore = lowerCore.charAt(0).toUpperCase() + lowerCore.slice(1);
  return `${leadingPunct}${capitalizedCore}${trailingPunct}`;
}

/**
 * Pre-processes text to standardize transit routes and connectors.
 */
function standardizeRouteConnectors(text: string): string {
  let processed = text;

  // Normalize " -> " or " --> " to " ke "
  processed = processed.replace(/\s*--?>\s*/g, ' ke ');

  // Normalize route connector " to " between words into " ke "
  processed = processed.replace(/(?<=\S)\s+to\s+(?=\S)/gi, ' ke ');

  // Normalize transit abbreviations for Tanjung Priok
  processed = processed.replace(/\btj\.?\s+priuk\b/gi, 'Tanjung Priok');
  processed = processed.replace(/\btj\.?\s+priok\b/gi, 'Tanjung Priok');

  return processed;
}

/**
 * Strips redundant payment account or payment-channel words from the end of a note.
 */
function stripRedundantAccountLeak(text: string, options?: NormalizeTransactionTextOptions): string {
  const accountWords: string[] = [];

  const addCandidates = (name?: string) => {
    if (!name) return;
    const tokens = name.toLowerCase().split(/[\s_-]+/).filter(t => t.length > 2);
    accountWords.push(...tokens);
  };

  addCandidates(options?.accountHint);
  addCandidates(options?.accountName);

  // Common payment channel leak tokens
  accountWords.push('tapcash');

  const uniqueLeakWords = Array.from(new Set(accountWords));
  if (uniqueLeakWords.length === 0) {
    return text;
  }

  let cleaned = text.trim();
  for (const leakWord of uniqueLeakWords) {
    const trailingRegex = new RegExp(`\\s+${leakWord}\\s*$`, 'i');
    // Only strip if there is still preceding content
    if (trailingRegex.test(cleaned) && cleaned.replace(trailingRegex, '').trim().length > 0) {
      cleaned = cleaned.replace(trailingRegex, '').trim();
    }
  }

  return cleaned;
}

/**
 * Formats arbitrary text into clean, contextual Title Case.
 */
export function formatSmartTitleCase(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }

  // If the text is screaming ALL-CAPS (and not a single acronym), downcase it first
  const isScreamingAllCaps =
    trimmed === trimmed.toUpperCase() &&
    /[A-Z]/.test(trimmed) &&
    !KNOWN_UPPERCASE_ACRONYMS.has(trimmed) &&
    trimmed.length > 4;

  const workingText = isScreamingAllCaps ? trimmed.toLowerCase() : trimmed;

  // Split by whitespace while preserving punctuation
  const rawTokens = workingText.split(/(\s+)/);

  let wordIndex = 0;
  let wordAfterDelimiter = true;

  const resultTokens = rawTokens.map(token => {
    if (/^\s+$/.test(token)) {
      return token;
    }

    const isLeading = wordIndex === 0 || wordAfterDelimiter;
    const normalized = normalizeWordToken(token, isLeading);

    wordAfterDelimiter = /[:\-\/]\s*$/.test(token);
    wordIndex++;

    return normalized;
  });

  return resultTokens.join('');
}

/**
 * Main public entrypoint for sanitizing and smart-casing transaction descriptions and notes.
 *
 * @param text The raw transaction note or description text.
 * @param options Optional account hints to prevent account token leaking into description.
 * @returns Beautifully normalized Title-cased transaction text, or undefined if empty.
 */
export function normalizeTransactionText(
  text: string | undefined | null,
  options?: NormalizeTransactionTextOptions
): string | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }

  let processed = text.trim();
  if (processed.length === 0) {
    return undefined;
  }

  // 1. Strip redundant account/channel leaks from note
  processed = stripRedundantAccountLeak(processed, options);

  // 2. Standardize route connectors
  processed = standardizeRouteConnectors(processed);

  // 3. Apply smart Title Casing with acronym and brand awareness
  const formatted = formatSmartTitleCase(processed);

  return formatted.length > 0 ? formatted : undefined;
}
