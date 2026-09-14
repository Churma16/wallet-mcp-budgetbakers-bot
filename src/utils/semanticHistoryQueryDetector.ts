/**
 * Identifies history-like text that was not confidently handled by the fast path.
 * This is deliberately only a routing gate: semantic interpretation belongs to the model.
 */
export function isSemanticHistoryQueryCandidate(userMessageText: string): boolean {
  const text = userMessageText.trim().toLowerCase();
  if (!text) return false;

  const hasAmount = /\d+\s*(?:k|rb|jt|ribu|juta)\b|(?:rp|idr)\.?\s*\d+|\d+\s*(?:rp|idr)\b/i.test(text);
  const startsWithMutation = /^(?:beli|bayar|catat|tambahkan|tambah|masukkan|record|add|transfer|top\s*up|topup)\b/i.test(text);
  if (hasAmount || startsWithMutation) return false;

  const explicitHistory = /\b(?:riwayat|history|transactions?|transaksi)\b/i.test(text);
  const queryVerb = /^(?:show|view|find|search|list|cari|lihat|tampilkan|cek)\b/i.test(text);
  const financialRecords = /\b(?:spending|expenses?|income|earnings?|pengeluaran|pemasukan)\b/i.test(text);
  const historyQualifier = /\b(?:older|oldest|newest|recent|last|before|after|around|early|late|terlama|terbaru|sebelum|sesudah|sekitar|awal|akhir|minggu|month|bulan|week)\b/i.test(text);

  return explicitHistory || (queryVerb && financialRecords && historyQualifier);
}
