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
