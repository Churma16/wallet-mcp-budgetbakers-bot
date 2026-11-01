/**
 * Parsed record edit command representing user-requested modifications
 * to an existing Wallet transaction.
 */
export interface ParsedRecordEditCommand {
  readonly categoryName?: string;
  readonly tags?: string[];
  readonly note?: string;
  readonly amount?: number;
  readonly counterParty?: string;
  readonly hasModifications: boolean;
}

const EDIT_KEY_PATTERN = /(?:^|\s+)(c|cat|kategori|t|tag|tags|label|labels|n|note|d|des|deskripsi|catatan|a|amt|amount|nominal|p|payee|m|merchant):\s*([^]*?)(?=(?:\s+(?:c|cat|kategori|t|tag|tags|label|labels|n|note|d|des|deskripsi|catatan|a|amt|amount|nominal|p|payee|m|merchant):)|$)/gi;

/**
 * Normalizes an amount string, supporting formats like 25000, -25000, 25.000, or 25k.
 */
function parseAmountHint(rawAmount: string): number | undefined {
  const trimmed = rawAmount.trim();
  if (!trimmed) return undefined;

  let sign = 1;
  let cleaned = trimmed;
  if (cleaned.startsWith('-')) {
    sign = -1;
    cleaned = cleaned.slice(1).trim();
  } else if (cleaned.startsWith('+')) {
    cleaned = cleaned.slice(1).trim();
  }

  // Handle shorthand suffix like 25k or 25rb
  let multiplier = 1;
  if (/k$/i.test(cleaned)) {
    multiplier = 1000;
    cleaned = cleaned.replace(/k$/i, '').trim();
  } else if (/rb$/i.test(cleaned)) {
    multiplier = 1000;
    cleaned = cleaned.replace(/rb$/i, '').trim();
  } else if (/jt$/i.test(cleaned) || /m$/i.test(cleaned)) {
    multiplier = 1000000;
    cleaned = cleaned.replace(/(?:jt|m)$/i, '').trim();
  }

  // Remove thousands separators (.) or (,)
  cleaned = cleaned.replace(/[.,](?=\d{3})/g, '');
  cleaned = cleaned.replace(/,/g, '.');

  const parsed = Number.parseFloat(cleaned);
  if (Number.isNaN(parsed)) return undefined;

  return sign * parsed * multiplier;
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

  const matches = Array.from(text.matchAll(EDIT_KEY_PATTERN));
  if (matches.length === 0) {
    return null;
  }

  let categoryName: string | undefined;
  let tags: string[] | undefined;
  let note: string | undefined;
  let amount: number | undefined;
  let counterParty: string | undefined;

  for (const match of matches) {
    const rawKey = match[1].toLowerCase();
    const rawVal = match[2]?.trim();
    if (!rawVal) continue;

    switch (rawKey) {
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
        note = rawVal.slice(0, 255);
        break;

      case 'a':
      case 'amt':
      case 'amount':
      case 'nominal':
        amount = parseAmountHint(rawVal);
        break;

      case 'p':
      case 'payee':
      case 'm':
      case 'merchant':
        counterParty = rawVal.slice(0, 255);
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
    counterParty,
    hasModifications: true,
  };
}
