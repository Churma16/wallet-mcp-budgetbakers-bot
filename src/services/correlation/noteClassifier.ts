/**
 * Checks whether a transaction note is boilerplate / generic payment metadata
 * (e.g. "Transaction using Jago debit card", "Pembayaran QRIS") rather than rich itemized details.
 */
export function isGenericNote(
  note: string | undefined | null,
  merchantOrCounterParty?: string | null,
  subject?: string | null
): boolean {
  if (!note) return true;
  const trimmedNote = note.trim();
  if (!trimmedNote) return true;

  // Detailed receipt notes containing order IDs (#), bullets, or item lines are NEVER generic
  if (trimmedNote.includes('#') || trimmedNote.includes('•') || trimmedNote.includes('\n')) {
    return false;
  }

  const lowerNote = trimmedNote.toLowerCase();
  if (
    merchantOrCounterParty &&
    lowerNote === merchantOrCounterParty.trim().toLowerCase()
  ) {
    return true;
  }
  if (subject && lowerNote === subject.trim().toLowerCase()) {
    return true;
  }

  const genericExactPhrases = [
    'unknown',
    'pembayaran',
    'pembayaran qris',
    'pembayaran berhasil',
    'pembayaran merchant',
    'transaksi',
    'transaksi berhasil',
    'transaksi domestik',
    'transaksi merchant',
    'transaksi menggunakan kartu debit',
    'transaksi menggunakan kartu debit jago',
    'transaction using debit card',
    'transaction using jago debit card',
    'debit card transaction',
    'debit card transaction via bank jago',
    'kartu debit',
    'debit card',
    'debit',
    'pos/edc',
    'pos debit',
    'edc/pos',
    'edc',
    'qris',
    'transfer',
    'transfer dana',
    'transfer masuk',
    'transfer keluar',
    'e-receipt',
    'grab e-receipt',
    'grab receipt',
    'gojek receipt',
    'electronic receipt',
    'struk digital',
    'struk pembayaran',
    'tanda terima',
    'tanda terima elektronik',
    'bukti pembayaran',
    'bukti transaksi',
    'bukti transfer',
  ];

  if (genericExactPhrases.includes(lowerNote)) {
    return true;
  }

  // Generic prefix / boilerplate patterns without specific product details
  const genericPrefixes = [
    'transaksi menggunakan kartu debit',
    'transaction using debit card',
    'transaction using jago debit card',
    'debit card transaction via',
    'debit card transaction',
    'transaksi kartu debit',
    'pembayaran qris di',
    'pembayaran qris',
    'pembayaran via',
    'pembayaran berhasil',
    'payment via',
    'payment using',
  ];

  for (const prefix of genericPrefixes) {
    if (lowerNote.startsWith(prefix) && lowerNote.length < prefix.length + 25) {
      return true;
    }
  }

  // Generic merchant e-receipt patterns like "[merchant] e-receipt" or "e-receipt [merchant]"
  if (
    lowerNote.endsWith('e-receipt') ||
    lowerNote.endsWith('receipt') ||
    lowerNote.startsWith('e-receipt') ||
    lowerNote.startsWith('tanda terima') ||
    lowerNote.startsWith('bukti pembayaran')
  ) {
    const strippedNote = lowerNote
      .replace(/^(e-receipt|receipt|tanda terima|bukti pembayaran)\s*/i, '')
      .replace(/\s*(e-receipt|receipt)$/i, '')
      .trim();
    if (
      !strippedNote ||
      strippedNote.split(/\s+/).length <= 2 ||
      (merchantOrCounterParty && strippedNote === merchantOrCounterParty.trim().toLowerCase())
    ) {
      return true;
    }
  }

  return false;
}
