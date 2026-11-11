/**
 * Pure predicate and normalization functions for financial entities,
 * payment notes, account strings, and categories.
 */

/**
 * Checks whether a merchant or counterparty name is generic or placeholder (e.g. "Unknown", "Kartu Debit").
 */
export function isGenericMerchant(merchant: string | undefined | null): boolean {
  if (!merchant) return true;
  const lowerMerchant = merchant.trim().toLowerCase();
  if (!lowerMerchant || lowerMerchant === 'unknown') return true;

  // Special case: legitimate registered couriers and merchants
  if (lowerMerchant.includes('pos indonesia')) {
    return false;
  }

  // Exact phrase checks
  const exactPhrases = [
    'kartu debit',
    'debit card',
    'pembayaran qris',
    'edc/pos',
    'pos debit',
    'transaksi domestik',
  ];
  if (exactPhrases.some(phrase => lowerMerchant.includes(phrase))) {
    return true;
  }

  // Word-token boundary checks for identifiers
  const words = lowerMerchant.split(/[^a-z0-9]+/);
  const genericWords = new Set([
    'unknown',
    'debit',
    'card',
    'kartu',
    'qris',
    'edc',
    'pos',
    'payment',
    'pembayaran',
    'bank',
    'transfer',
    'transaksi',
    'merchant',
    'mandiri',
    'jago',
    'bca',
    'bni',
    'bri',
    'cimb',
    'dana',
    'gopay',
    'ovo',
    'shopeepay',
    'flip',
  ]);

  return words.some(word => genericWords.has(word));
}

/**
 * Checks whether an account hint, payment method, or account name refers to a generic card network
 * (e.g. "Visa", "Mastercard", "Debit Card", "Kartu Debit").
 */
export function isGenericCardAccountOrMethod(text?: string | null): boolean {
  if (!text) return false;
  const lowerText = text.toLowerCase().trim();
  const genericCardTokens = [
    'visa',
    'mastercard',
    'jcb',
    'amex',
    'american express',
    'debit card',
    'credit card',
    'kartu debit',
    'kartu kredit',
  ];
  return genericCardTokens.some(token => {
    const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escapedToken}([^a-z0-9]|$)`, 'i').test(lowerText);
  });
}

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

  // Detailed receipt notes containing order IDs (#) or multi-line items (\n) are NEVER generic
  if (trimmedNote.includes('#') || trimmedNote.includes('\n')) {
    return false;
  }

  // Bullet point check: if it contains bullets and has bank debit keywords without item quantities,
  // it is boilerplate financial text (e.g. "Debit card payment • Debit card transaction of Rp51.612 using Jago debit card").
  if (trimmedNote.includes('•')) {
    const isItemizedList = /(?:\d+x\s|[0-9]+(?:\.[0-9]{3})*,\s*|qty|item|pcs)/i.test(trimmedNote);
    const hasBankDebitKeyword = /(?:debit card|kartu debit|pembayaran qris|transaksi|jago debit card|mandiri debit)/i.test(trimmedNote);
    if (isItemizedList && !hasBankDebitKeyword) {
      return false;
    }
    if (hasBankDebitKeyword) {
      return true;
    }
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

/**
 * Evaluates whether a category name represents a generic or unclassified placeholder
 * (e.g. "Unknown expense", "Belanja", "General", "Lain-lain").
 */
export function isGenericCategory(categoryName: string | undefined | null): boolean {
  if (!categoryName) return true;
  const lower = categoryName.trim().toLowerCase();
  if (!lower || lower === 'unknown') return true;

  const exactGenerics = [
    'belanja',
    'shopping',
    'pengeluaran',
    'expense',
    'expenses',
    'financial expenses',
    'financial expense',
    'biaya keuangan',
    'transaksi',
    'transaction',
  ];
  if (exactGenerics.includes(lower)) return true;

  const prefixOrContains = [
    'unknown',
    'uncategorized',
    'umum',
    'general',
    'lain-lain',
    'lain nya',
    'lainnya',
    'other',
    'others',
  ];

  return prefixOrContains.some(token => lower.includes(token));
}

/**
 * Detects whether a merchant or counterparty represents an online commerce platform,
 * web domain, or payment gateway aggregator (e.g. "SHOPEE.CO.ID", "BLIBLI.COM", "MIDTRANS*", "QRIS_NOBU").
 */
export function isOnlinePlatformOrGateway(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.trim().toLowerCase();
  if (!lower) return false;

  // 1. Web TLD pattern: e.g. .co.id, .com, .id, .net, .org, .app, .io
  if (/\b[a-z0-9_-]+\.(?:co\.id|com|id|net|org|app|io)\b/i.test(lower)) {
    return true;
  }

  // 2. Gateway / Aggregator keywords, prefixes or delimiters (e.g. PG_, QRIS_, MIDTRANS*, DOKU*, XENDIT*)
  const gatewayTokens = new Set([
    'pg',
    'qris',
    'payment',
    'pembayaran',
    'midtrans',
    'xendit',
    'doku',
    'espay',
    'faspay',
    'airpay',
    'shopeepay',
    'shopee',
    'tokopedia',
    'blibli',
    'grab',
    'gojek',
    'tiktok',
    'lazada',
    'bukalapak',
    'gopay',
    'ovo',
    'dana',
  ]);
  const words = lower.split(/[^a-z0-9]+/);
  if (words.some(word => gatewayTokens.has(word))) {
    return true;
  }
  if (lower.includes('*')) {
    return true;
  }

  return false;
}

