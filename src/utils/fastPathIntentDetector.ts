export type FastPathAction = 'CHECK_BALANCE' | 'CHECK_BUDGET' | 'HELP_MENU' | null;

/**
 * Fast-path deterministic classifier that intercepts common repetitive commands
 * (e.g. balance check, budget check, help menu) directly in code to save 100% of Gemini AI tokens.
 */
export function detectFastPathAction(userMessageText: string): FastPathAction {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedLowerText = userMessageText.toLowerCase().trim();

  // If the message contains numeric digits or common price indicators (e.g. 50k, 25rb, 10000),
  // it is almost certainly a transaction recording (e.g. "tambah saldo 50rb" or "beli bensin 25k").
  // Do NOT intercept as fast-path to prevent suppressing transaction recordings.
  const hasNumericOrPricePattern = /\d|(?:^|\s)(?:rb|k|jt|ribu|juta)(?:$|\s)/i.test(trimmedLowerText);
  if (hasNumericOrPricePattern) {
    return null;
  }

  // 1. Balance Checks (e.g. "saldo", "cek saldo", "lihat saldo", "info saldo", "balance", "rekening")
  const balancePattern = /^(?:cek|lihat|info|total)?\s*(?:saldo|balance|rekening|total\s+saldo)(?:\s+(?:saya|rekening))?$/i;
  if (balancePattern.test(trimmedLowerText)) {
    return 'CHECK_BALANCE';
  }

  // 2. Budget Checks (e.g. "budget", "cek budget", "lihat budget", "anggaran", "sisa budget")
  const budgetPattern = /^(?:cek|lihat|info|status)?\s*(?:budget|anggaran|sisa\s+budget|status\s+budget|status\s+anggaran)(?:\s+(?:saya|aktif))?$/i;
  if (budgetPattern.test(trimmedLowerText)) {
    return 'CHECK_BUDGET';
  }

  // 3. Help / Greetings / Menu (e.g. "halo", "hi", "menu", "bantuan", "help", "ping", "p")
  const helpPattern = /^(?:halo|hello|hi|hai|menu|help|bantuan|ping|p|panduan|mulai|start)$/i;
  if (helpPattern.test(trimmedLowerText)) {
    return 'HELP_MENU';
  }

  return null;
}

export interface PendingConfirmationIntent {
  actionType: 'CONFIRM' | 'REJECT';
  targetScope: 'LATEST' | 'ALL' | number;
}

/**
 * Detects WhatsApp confirmation/cancellation replies for pending transaction tickets.
 * Handles "ya", "catat", "ya 1", "ya semua", "batal", "batal 2", "batal semua", etc.
 */
export function detectPendingConfirmationAction(userMessageText: string): PendingConfirmationIntent | null {
  if (!userMessageText || typeof userMessageText !== 'string') {
    return null;
  }

  const trimmedText = userMessageText.toLowerCase().trim();

  // 1. Confirm All (e.g. "ya semua", "catat semua", "ok semua", "y all")
  if (/^(?:ya|catat|ok|oke|y|yes|confirm)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'ALL' };
  }

  // 2. Reject All (e.g. "batal semua", "abaikan semua", "cancel all")
  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak)\s+(?:semua|all)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'ALL' };
  }

  // 3. Confirm Specific Ticket (e.g. "ya 1", "catat #2", "ok 3", "y 1")
  const confirmSpecificMatch = trimmedText.match(/^(?:ya|catat|ok|oke|y|yes|confirm)\s+#?(\d+)$/i);
  if (confirmSpecificMatch && confirmSpecificMatch[1]) {
    const ticketNumber = parseInt(confirmSpecificMatch[1], 10);
    if (!isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'CONFIRM', targetScope: ticketNumber };
    }
  }

  // 4. Reject Specific Ticket (e.g. "batal 1", "abaikan #2", "cancel 3")
  const rejectSpecificMatch = trimmedText.match(/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak)\s+#?(\d+)$/i);
  if (rejectSpecificMatch && rejectSpecificMatch[1]) {
    const ticketNumber = parseInt(rejectSpecificMatch[1], 10);
    if (!isNaN(ticketNumber) && ticketNumber > 0) {
      return { actionType: 'REJECT', targetScope: ticketNumber };
    }
  }

  // 5. Confirm Latest Single (e.g. "ya", "catat", "ok", "oke", "y", "yes", "confirm")
  if (/^(?:ya|catat|ok|oke|y|yes|confirm)$/i.test(trimmedText)) {
    return { actionType: 'CONFIRM', targetScope: 'LATEST' };
  }

  // 6. Reject Latest Single (e.g. "batal", "abaikan", "gak", "ga", "gajadi", "cancel", "tolak")
  if (/^(?:batal|abaikan|gak|ga|gajadi|cancel|tolak)$/i.test(trimmedText)) {
    return { actionType: 'REJECT', targetScope: 'LATEST' };
  }

  return null;
}

