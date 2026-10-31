import { extractHashtags } from '../parsers/hashtagParser.js';
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

    let customCategoryHint: string | undefined;
    let textToParseForTagsAndNote = rawNote;

    const categoryTriggerMatch = rawNote.match(/(?:^|\s)(cat|kategori|category):\s*/i);
    if (categoryTriggerMatch && categoryTriggerMatch.index !== undefined) {
      const prefixMatchIndex = categoryTriggerMatch.index;
      const actualPrefixIndex = categoryTriggerMatch[0].startsWith(' ') || categoryTriggerMatch[0].startsWith('\t')
        ? prefixMatchIndex + 1
        : prefixMatchIndex;
      const contentStartIndex = actualPrefixIndex + categoryTriggerMatch[0].trimStart().length;

      const nextHashIndex = rawNote.indexOf('#', contentStartIndex);
      const rawCategorySnippet = nextHashIndex !== -1
        ? rawNote.slice(contentStartIndex, nextHashIndex)
        : rawNote.slice(contentStartIndex);

      const cleanedCategorySnippet = rawCategorySnippet
        .trim()
        .replace(/^["']+|["']+$/g, '')
        .trim();

      if (cleanedCategorySnippet.length > 0) {
        customCategoryHint = cleanedCategorySnippet;
      }

      const textBeforeCat = rawNote.slice(0, actualPrefixIndex);
      const textAfterCat = nextHashIndex !== -1 ? rawNote.slice(nextHashIndex) : '';
      textToParseForTagsAndNote = `${textBeforeCat} ${textAfterCat}`.trim();
    }

    const hashtagResult = extractHashtags(textToParseForTagsAndNote);
    const cleanedNote = hashtagResult.cleanedText.trim();
    const customTags = hashtagResult.tags.length > 0 ? hashtagResult.tags : undefined;

    if (!customCategoryHint) {
      const rawCategoryTag = customTags ? customTags[0] : undefined;
      customCategoryHint = rawCategoryTag ? rawCategoryTag.replace(/[-_]+/g, ' ').trim() : undefined;
    }

    const customNote = cleanedNote.length > 0 ? cleanedNote : undefined;

    return {
      actionType: 'CONFIRM',
      targetScope,
      customNote,
      customCategoryHint,
      customTags,
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
