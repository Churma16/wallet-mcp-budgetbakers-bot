/**
 * Applies structural safety exclusions before read-only semantic interpretation.
 * It intentionally does not infer history meaning from words or phrases; the model
 * decides whether an otherwise-unmatched message is a history request.
 */
export function isSemanticHistoryQueryCandidate(userMessageText: string): boolean {
  const text = userMessageText.trim().toLowerCase();
  if (!text) return false;

  const hasAmount = /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b/i.test(text);
  const startsWithMutation = /^(?:beli|bayar|catat|tambahkan|tambah|masukkan|record|add|transfer|top\s*up|topup)\b/i.test(text);
  return !hasAmount && !startsWithMutation;
}
