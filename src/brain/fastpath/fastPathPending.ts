import { extractHashtags } from '../parsers/hashtagParser.js';
import { KEY_NAME_REGEX, parseTagsHint, isAutoCategoryToken } from '../../wallet/records/recordEditParser.js';
import {
  PendingConfirmationIntent,
  ReconciliationIntent,
} from '../types.js';

export function detectPendingConfirmationAction(userMessageText: string): PendingConfirmationIntent | null {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedText = userMessageText.trim();
  if (!trimmedText) {
    return null;
  }

  const lowerText = trimmedText.toLowerCase();

  // 1. ALL confirmations/rejections
  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+(?:semua|all)$/i.test(lowerText)) {
    return { actionType: 'CONFIRM', targetScope: 'ALL' };
  }

  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+(?:semua|all)$/i.test(lowerText)) {
    return { actionType: 'REJECT', targetScope: 'ALL' };
  }

  // 2. Specific ticket number rejection
  const rejectSpecificMatch = lowerText.match(/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)\s+#?(\d+)$/i);
  if (rejectSpecificMatch && rejectSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(rejectSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'REJECT', targetScope: ticketNumber };
    }
  }

  // 3. Bare rejection
  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak|reject)$/i.test(lowerText)) {
    return { actionType: 'REJECT', targetScope: 'LATEST' };
  }

  // 4. Specific ticket number confirmation without note (e.g. "ya 1", "catat #2")
  const confirmSpecificMatch = lowerText.match(/^(?:ya|catat|ok|oke|y|yes|confirm|record)\s+#?(\d+)$/i);
  if (confirmSpecificMatch && confirmSpecificMatch[1]) {
    const ticketNumber = Number.parseInt(confirmSpecificMatch[1], 10);
    if (!Number.isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'CONFIRM', targetScope: ticketNumber };
    }
  }

  // 5. Bare confirmation without note (e.g. "ya", "catat", "ok")
  if (/^(?:ya|catat|ok|oke|y|yes|confirm|record)$/i.test(lowerText)) {
    return { actionType: 'CONFIRM', targetScope: 'LATEST' };
  }

  // 6. Confirmation with inline custom note and optional hashtag/category
  const confirmWithNoteMatch = trimmedText.match(
    /^(?:ya|catat|ok|oke|y|yes|confirm|record)(?:(?:\s+(?:#\s*)?|\s*#\s*)(\d+))?(?:\s*[:,\-]\s*|\s+)(.+)$/i
  );
  if (confirmWithNoteMatch) {
    const ticketStr = confirmWithNoteMatch[1];
    const rawNote = confirmWithNoteMatch[2].trim();

    if (rawNote.toLowerCase() === 'semua' || rawNote.toLowerCase() === 'all') {
      return { actionType: 'CONFIRM', targetScope: 'ALL' };
    }

    if (/^#?\d+$/.test(rawNote)) {
      const parsedNum = Number.parseInt(rawNote.replace(/^#/, ''), 10);
      if (!Number.isNaN(parsedNum) && parsedNum > 0) {
        return { actionType: 'CONFIRM', targetScope: parsedNum };
      }
    }

    const hasExplicitDelimiter = /^[:,\-]/.test(
      trimmedText.replace(/^(?:ya|catat|ok|oke|y|yes|confirm|record)(?:(?:\s+|#)\d+)?\s*/i, '')
    );
    const containsFinancialAmount = /(?:rp\.?|idr)\s*[\d.,]+|\b\d+(?:\.\d{3})+|\b\d+\s*(?:rb|k|jt|ribu|juta)\b|\b\d{4,}\b/i.test(
      rawNote
    );
    if (!hasExplicitDelimiter && containsFinancialAmount) {
      return null;
    }

    let targetScope: 'LATEST' | number = 'LATEST';
    if (ticketStr) {
      const parsedTicket = Number.parseInt(ticketStr, 10);
      if (!Number.isNaN(parsedTicket) && parsedTicket > 0) {
        targetScope = parsedTicket;
      }
    }

    let customNote: string | undefined;
    let customCategoryHint: string | undefined;
    let isAutoCategory: boolean | undefined;
    let customTags: string[] | undefined;
    let counterParty: string | undefined;
    let targetAccountHint: string | undefined;

    interface KeyToken {
      key: string;
      tokenStart: number;
      valStart: number;
    }
    const tokens: KeyToken[] = [];
    KEY_NAME_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = KEY_NAME_REGEX.exec(rawNote)) !== null) {
      tokens.push({
        key: match[1].toLowerCase(),
        tokenStart: match.index,
        valStart: match.index + match[0].length,
      });
    }

    if (tokens.length > 0) {
      // Leading text before first token (e.g. "makan siang cat:makan nafsu")
      const leadingText = rawNote.slice(0, tokens[0].tokenStart).trim();
      if (leadingText.length > 0) {
        const leadingHashtags = extractHashtags(leadingText);
        customNote = leadingHashtags.cleanedText.trim() || undefined;
        if (leadingHashtags.tags.length > 0) {
          customTags = [...leadingHashtags.tags];
        }
      }

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const valEnd = i + 1 < tokens.length ? tokens[i + 1].tokenStart : rawNote.length;
        const rawVal = rawNote.slice(token.valStart, valEnd).trim();
        if (!rawVal) continue;
        const cleanVal = rawVal.replace(/^["']+|["']+$/g, '').trim();

        switch (token.key) {
          case 'c':
          case 'cat':
          case 'kategori':
          case 'category': {
            const nextHashIndex = cleanVal.indexOf('#');
            if (nextHashIndex !== -1) {
              const catPart = cleanVal.slice(0, nextHashIndex).trim().replace(/^["']+|["']+$/g, '').trim();
              const tagPart = cleanVal.slice(nextHashIndex);
              customCategoryHint = catPart.length > 0 ? catPart : undefined;
              if (isAutoCategoryToken(catPart)) {
                isAutoCategory = true;
                customCategoryHint = 'auto';
              }
              const extracted = extractHashtags(tagPart);
              if (extracted.tags.length > 0) {
                customTags = [...(customTags || []), ...extracted.tags];
              }
            } else {
              const cleaned = cleanVal.replace(/^["']+|["']+$/g, '').trim();
              customCategoryHint = cleaned.length > 0 ? cleaned : undefined;
              if (isAutoCategoryToken(cleaned)) {
                isAutoCategory = true;
                customCategoryHint = 'auto';
              }
            }
            break;
          }

          case 't':
          case 'tag':
          case 'tags':
          case 'label':
          case 'labels': {
            const parsedTags = parseTagsHint(cleanVal);
            if (parsedTags.length > 0) {
              customTags = [...(customTags || []), ...parsedTags];
            }
            break;
          }

          case 'n':
          case 'note':
          case 'd':
          case 'des':
          case 'deskripsi':
          case 'catatan': {
            const extracted = extractHashtags(cleanVal);
            customNote = extracted.cleanedText.trim() || undefined;
            if (extracted.tags.length > 0) {
              customTags = [...(customTags || []), ...extracted.tags];
            }
            break;
          }

          case 'p':
          case 'payee':
          case 'm':
          case 'merchant': {
            counterParty = cleanVal.length > 0 ? cleanVal : undefined;
            break;
          }

          case 'rek':
          case 'acc':
          case 'rekening':
          case 'account': {
            targetAccountHint = cleanVal.length > 0 ? cleanVal : undefined;
            break;
          }
        }
      }
    } else {
      const hashtagResult = extractHashtags(rawNote);
      const cleanedNote = hashtagResult.cleanedText.trim();
      const extractedTags = hashtagResult.tags.length > 0 ? hashtagResult.tags : undefined;

      if (extractedTags && extractedTags.length > 0) {
        customTags = extractedTags;
        const rawCategoryTag = extractedTags[0];
        customCategoryHint = rawCategoryTag ? rawCategoryTag.replace(/[-_]+/g, ' ').trim() : undefined;
      }

      customNote = cleanedNote.length > 0 ? cleanedNote : undefined;
    }

    return {
      actionType: 'CONFIRM',
      targetScope,
      customNote,
      customCategoryHint,
      isAutoCategory,
      customTags,
      counterParty,
      targetAccountHint,
      rawCustomInput: rawNote,
    };
  }

  return null;
}

const LEGACY_RECORDED_RECONCILIATION_ALIASES = new Set([
  'sudah masuk',
  'already recorded',
  'already there',
  'already in wallet',
  'sudah',
  'ada',
]);
const LEGACY_ABSENT_RECONCILIATION_ALIASES = new Set([
  'belum masuk',
  'tidak ada',
  'ga ada',
  'gak ada',
  'not yet',
  'not recorded',
  'not in wallet',
  'missing',
  'not found',
  'belum',
]);

export function detectReconciliationAction(userMessageText: string): ReconciliationIntent | null {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedText = userMessageText.trim().toLowerCase();
  const canonicalMatch = trimmedText.match(
    /^(sudah\s+ada|belum\s+ada|already\s+exists?|not\s+there)(?:\s+#?(\d+))?$/i
  );
  if (canonicalMatch) {
    const actionPhrase = canonicalMatch[1];
    const actionType: ReconciliationIntent['actionType'] =
      actionPhrase === 'sudah ada' || actionPhrase.startsWith('already exist')
        ? 'CONFIRM_RECORDED'
        : 'CONFIRM_ABSENT';
    const targetTicketId = canonicalMatch[2] ? Number.parseInt(canonicalMatch[2], 10) : undefined;
    return targetTicketId !== undefined && targetTicketId <= 0
      ? null
      : { actionType, ...(targetTicketId === undefined ? {} : { targetTicketId }) };
  }

  const legacySpecificMatch = trimmedText.match(
    /^(sudah|ada|exists?|belum|confirm\s+recorded|confirm\s+absent)\s+#?(\d+)$/i
  );
  if (legacySpecificMatch) {
    const targetTicketId = Number.parseInt(legacySpecificMatch[2], 10);
    if (targetTicketId <= 0) return null;
    const phrase = legacySpecificMatch[1];
    const actionType: ReconciliationIntent['actionType'] =
      phrase === 'belum' || phrase === 'confirm absent' ? 'CONFIRM_ABSENT' : 'CONFIRM_RECORDED';
    return { actionType, targetTicketId };
  }

  if (LEGACY_RECORDED_RECONCILIATION_ALIASES.has(trimmedText)) {
    return { actionType: 'CONFIRM_RECORDED' };
  }
  if (LEGACY_ABSENT_RECONCILIATION_ALIASES.has(trimmedText)) {
    return { actionType: 'CONFIRM_ABSENT' };
  }

  return null;
}
