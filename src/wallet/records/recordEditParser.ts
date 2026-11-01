/**
 * Parsed record edit command representing user-requested modifications
 * to an existing Wallet transaction.
 */
export interface ParsedRecordEditCommand {
  readonly categoryName?: string;
  readonly tags?: string[];
  readonly note?: string;
  readonly amount?: number;
  readonly hasExplicitPositiveSign?: boolean;
  readonly counterParty?: string;
  readonly hasModifications: boolean;
}

const KEY_NAME_REGEX = /(?:^|\s+)(c|cat|kategori|t|tag|tags|label|labels|n|note|d|des|deskripsi|catatan|a|amt|amount|nominal|p|payee|m|merchant):\s*/gi;

/**
 * Normalizes an amount string, supporting formats like 25000, -25000, 25.000, Rp 25k, or -Rp 50rb.
 */
function parseAmountHint(rawAmount: string): { amount: number; hasExplicitPositiveSign: boolean } | undefined {
  const trimmed = rawAmount.trim();
  if (!trimmed) return undefined;

  let sign = 1;
  let hasExplicitPositiveSign = false;

  // Strip currency prefixes before sign (e.g. "Rp-50000" or "Rp 50000")
  let cleaned = trimmed.replace(/^(?:rp|idr)\.?\s*/i, '').trim();

  if (cleaned.startsWith('-')) {
    sign = -1;
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith('+')) {
    hasExplicitPositiveSign = true;
    cleaned = cleaned.slice(1).trim();
  }

  // Also strip currency prefixes after sign (e.g. "-Rp 50000")
  cleaned = cleaned.replace(/^(?:rp|idr)\.?\s*/i, '').trim();

  // Handle shorthand suffix like 25k or 25rb
  let multiplier = 1;
  if (/k$/i.test(cleaned)) {
    multiplier = 1000;
    cleaned = cleaned.replace(/k$/i, '').trim();
  } else if (/rb$/i.test(cleaned)) {
    multiplier = 1000;
    cleaned = cleaned.replace(/rb$/i, '').trim();
  } else if (/(?:jt|m)$/i.test(cleaned)) {
    multiplier = 1000000;
    cleaned = cleaned.replace(/(?:jt|m)$/i, '').trim();
  }

  // Remove thousands separators (.) or (,)
  cleaned = cleaned.replace(/[.,](?=\d{3})/g, '');
  cleaned = cleaned.replace(/,/g, '.');

  const parsed = Number.parseFloat(cleaned);
  if (Number.isNaN(parsed)) return undefined;

  return {
    amount: sign * parsed * multiplier,
    hasExplicitPositiveSign,
  };
}

/**
 * Normalizes tags/labels input from user, splitting comma-separated or space-separated tags
 * and stripping leading '#' symbols.
 */
function parseTagsHint(rawTags: string): string[] {
  const parts = rawTags.includes(',')
    ? rawTags.split(',')
    : rawTags.split(/\s+/);

  const tags: string[] = [];
  for (const part of parts) {
    const cleaned = part.trim().replace(/^#/, '').trim();
    if (cleaned.length > 0 && !tags.includes(cleaned)) {
      tags.push(cleaned);
    }
  }
  return tags;
}

interface KeyToken {
  key: string;
  tokenStart: number;
  valStart: number;
}

/**
 * Parses user edit commands formatted as shorthand key-values.
 *
 * Supported formats:
 * - With prefix: `e c: Makan t: #jajan n: Kopi`
 * - With prefix: `edit cat: Makanan tag: #jajan note: Kopi`
 * - Directly without prefix: `c: Makan t: #jajan n: Kopi`
 * - Partial: `c: Transport` or `n: Kopi Kenangan`
 *
 * Returns null if the text does not match any recognized edit pattern.
 */
export function parseRecordEditCommand(inputText: string | undefined): ParsedRecordEditCommand | null {
  if (!inputText) return null;

  let text = inputText.trim();
  if (!text) return null;

  // Strip leading 'e ' or 'edit ' prefix if present
  const explicitPrefixPattern = /^(?:e|edit)\s+/i;
  const hasExplicitPrefix = explicitPrefixPattern.test(text);
  if (hasExplicitPrefix) {
    text = text.replace(explicitPrefixPattern, '').trim();
  }

  // Linear scan for key tokens without backtracking
  const tokens: KeyToken[] = [];
  KEY_NAME_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = KEY_NAME_REGEX.exec(text)) !== null) {
    tokens.push({
      key: match[1].toLowerCase(),
      tokenStart: match.index,
      valStart: match.index + match[0].length,
    });
  }

  if (tokens.length === 0) {
    return null;
  }

  // Shorthand commands without explicit 'e'/'edit' prefix MUST start at index 0
  // to avoid hijacking ordinary conversational replies containing colons (e.g. smileys "c:" or "note: ...")
  if (!hasExplicitPrefix && tokens[0].tokenStart !== 0) {
    return null;
  }

  let categoryName: string | undefined;
  let tags: string[] | undefined;
  let note: string | undefined;
  let amount: number | undefined;
  let hasExplicitPositiveSign: boolean | undefined;
  let counterParty: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const valEnd = i + 1 < tokens.length ? tokens[i + 1].tokenStart : text.length;
    const rawVal = text.slice(token.valStart, valEnd).trim();

    if (!rawVal) continue;

    switch (token.key) {
      case 'c':
      case 'cat':
      case 'kategori':
        categoryName = rawVal;
        break;

      case 't':
      case 'tag':
      case 'tags':
      case 'label':
      case 'labels': {
        const parsedTags = parseTagsHint(rawVal);
        if (parsedTags.length > 0) {
          tags = parsedTags;
        }
        break;
      }

      case 'n':
      case 'note':
      case 'd':
      case 'des':
      case 'deskripsi':
      case 'catatan':
        // Safeguard UTF-16 surrogate pairs during truncation
        note = Array.from(rawVal).slice(0, 255).join('');
        break;

      case 'a':
      case 'amt':
      case 'amount':
      case 'nominal': {
        const parsedAmount = parseAmountHint(rawVal);
        if (parsedAmount !== undefined) {
          amount = parsedAmount.amount;
          hasExplicitPositiveSign = parsedAmount.hasExplicitPositiveSign;
        }
        break;
      }

      case 'p':
      case 'payee':
      case 'm':
      case 'merchant':
        counterParty = rawVal;
        break;
    }
  }

  const hasModifications = Boolean(
    categoryName ||
    (tags && tags.length > 0) ||
    note !== undefined ||
    amount !== undefined ||
    counterParty !== undefined
  );

  if (!hasModifications) {
    return null;
  }

  return {
    categoryName,
    tags,
    note,
    amount,
    hasExplicitPositiveSign,
    counterParty,
    hasModifications,
  };
}
