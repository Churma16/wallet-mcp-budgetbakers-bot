import type { ClearableRecordField } from '../types.js';

/**
 * Parsed record edit command representing user-requested modifications
 * to an existing Wallet transaction.
 */
export interface ParsedRecordEditCommand {
  readonly categoryName?: string;
  readonly isAutoCategory?: boolean;
  readonly tags?: string[];
  readonly note?: string;
  readonly amount?: number;
  readonly hasExplicitPositiveSign?: boolean;
  readonly counterParty?: string;
  readonly targetAccountHint?: string;
  readonly clearFields?: ClearableRecordField[];
  readonly hasModifications: boolean;
}

export const KEY_NAME_REGEX =
  /(?<=^|\s)(c|cat|kategori|category|t|tag|tags|label|labels|n|note|d|des|deskripsi|catatan|a|amt|amount|nominal|p|payee|m|merchant|rek|acc|rekening|account|tf|transfer):\s*/gi;

const CLEAR_VALUE_PATTERN = /^[-–—]$|^(?:none|kosong|hapus|clear|remove|delete)$/i;
const TRANSFER_UNLINK_PATTERN = /^[-–—]$|^(?:none|kosong|hapus|clear|unlink|lepas|batal|cancel)$/i;
const NATURAL_TRANSFER_UNLINK_COMMAND =
  /^(?:(?:e|edit)\s+)?(?:unlink(?:\s+transfer)?|(?:lepas|batal|hapus)\s+transfer)$/i;

function isClearToken(val: string): boolean {
  return CLEAR_VALUE_PATTERN.test(val.trim());
}

function isTransferClearToken(val: string): boolean {
  return TRANSFER_UNLINK_PATTERN.test(val.trim());
}

/**
 * Checks if a string token indicates automatic category inference based on note/context.
 * Supports patterns like "auto", "otomatis", or "c:auto(berdasarkan note)".
 */
export function isAutoCategoryToken(val: string | undefined): boolean {
  if (!val) return false;
  const clean = val.trim().toLowerCase();
  return /^(?:auto|otomatis)(?:\s*\(.*?\))?$/i.test(clean);
}

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
export function parseTagsHint(rawTags: string): string[] {
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
 * - Account move: `rek: BCA` or `acc: Mandiri`
 * - Clear field: `n: -` or `note: clear` or `t: none`
 * - Unlink transfer: `tf: -` or `unlink transfer`
 *
 * Returns null if the text does not match any recognized edit pattern.
 */
export function parseRecordEditCommand(inputText: string | undefined): ParsedRecordEditCommand | null {
  if (!inputText) return null;

  let text = inputText.trim();
  if (!text) return null;

  // Natural transfer unlink command fast-path without colons
  if (NATURAL_TRANSFER_UNLINK_COMMAND.test(text)) {
    return {
      clearFields: ['transfer'],
      hasModifications: true,
    };
  }

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
  let isAutoCategory: boolean | undefined;
  let tags: string[] | undefined;
  let note: string | undefined;
  let amount: number | undefined;
  let hasExplicitPositiveSign: boolean | undefined;
  let counterParty: string | undefined;
  let targetAccountHint: string | undefined;
  const clearFieldsSet = new Set<ClearableRecordField>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const valEnd = i + 1 < tokens.length ? tokens[i + 1].tokenStart : text.length;
    const rawVal = text.slice(token.valStart, valEnd).trim();

    if (!rawVal) continue;
    const cleanVal = rawVal.replace(/^["']+|["']+$/g, '').trim();

    switch (token.key) {
      case 'c':
      case 'cat':
      case 'kategori':
      case 'category':
        if (isClearToken(rawVal)) {
          clearFieldsSet.add('categoryId');
          categoryName = undefined;
          isAutoCategory = false;
        } else if (isAutoCategoryToken(cleanVal)) {
          isAutoCategory = true;
          categoryName = 'auto';
          clearFieldsSet.delete('categoryId');
        } else {
          categoryName = cleanVal;
          isAutoCategory = false;
          clearFieldsSet.delete('categoryId');
        }
        break;

      case 't':
      case 'tag':
      case 'tags':
      case 'label':
      case 'labels': {
        if (isClearToken(rawVal)) {
          clearFieldsSet.add('labelIds');
          tags = undefined;
        } else {
          const parsedTags = parseTagsHint(cleanVal);
          if (parsedTags.length > 0) {
            tags = parsedTags;
            clearFieldsSet.delete('labelIds');
          }
        }
        break;
      }

      case 'n':
      case 'note':
      case 'd':
      case 'des':
      case 'deskripsi':
      case 'catatan':
        if (isClearToken(rawVal)) {
          clearFieldsSet.add('note');
          note = undefined;
        } else {
          // Safeguard UTF-16 surrogate pairs during truncation
          note = Array.from(cleanVal).slice(0, 255).join('');
          clearFieldsSet.delete('note');
        }
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
        if (isClearToken(rawVal)) {
          clearFieldsSet.add('counterParty');
          counterParty = undefined;
        } else {
          counterParty = cleanVal;
          clearFieldsSet.delete('counterParty');
        }
        break;

      case 'rek':
      case 'acc':
      case 'rekening':
      case 'account':
        targetAccountHint = cleanVal;
        break;

      case 'tf':
      case 'transfer':
        if (isTransferClearToken(rawVal)) {
          clearFieldsSet.add('transfer');
        }
        break;
    }
  }

  const clearFields = clearFieldsSet.size > 0 ? Array.from(clearFieldsSet) : undefined;

  const hasModifications = Boolean(
    categoryName ||
    isAutoCategory ||
    (tags && tags.length > 0) ||
    note !== undefined ||
    amount !== undefined ||
    counterParty !== undefined ||
    targetAccountHint !== undefined ||
    (clearFields && clearFields.length > 0)
  );

  if (!hasModifications) {
    return null;
  }

  return {
    categoryName,
    isAutoCategory,
    tags,
    note,
    amount,
    hasExplicitPositiveSign,
    counterParty,
    targetAccountHint,
    clearFields,
    hasModifications,
  };
}
