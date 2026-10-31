import { CommercePlatformRegistry } from './commercePlatforms.js';

export type BankEmailRuleCategory = 'BANK' | 'E_WALLET' | 'MERCHANT_RECEIPT' | 'PAYMENT_GATEWAY';

export interface BankEmailRuleDefinition {
  bankKey: string;
  displayName: string;
  accountNameHint: string;
  senderDomains: string[];
  subjectKeywords: string[];
  blacklistKeywords: string[];
  bodyRequiredPatterns: RegExp[];
  amountPriorityPatterns: RegExp[];
  referencePatterns: RegExp[];
  transferOrTopupKeywords: string[];
  ruleCategory?: BankEmailRuleCategory;
}

export const COMMON_BANK_BLACKLIST_KEYWORDS = [
  'otp',
  'kode verifikasi',
  'login',
  'perangkat baru',
  'promo',
  'diskon',
  'newsletter',
];

export const COMMON_TRANSFER_TOPUP_KEYWORDS = [
  'top up',
  'gopay',
  'ovo',
  'dana',
  'shopeepay',
  'transfer',
];

export const BANK_DEBIT_AND_GATEWAY_RULES: BankEmailRuleDefinition[] = [
  // 1. Bank Mandiri (Livin' by Mandiri)
  {
    bankKey: 'mandiri',
    displayName: 'Bank Mandiri (Livin)',
    accountNameHint: 'Mandiri',
    senderDomains: ['bankmandiri.co.id'],
    subjectKeywords: [
      'notifikasi transaksi',
      'debit rekening',
      'kredit rekening',
      'resi transaksi',
      'qris',
      'transfer',
      'livin',
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'perangkat baru',
      'login baru',
      'promo',
      'diskon',
      'penawaran khusus',
      'newsletter',
      'aktivasi',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:debet|kredit|nominal|transaksi|qris|pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Debet|Pembayaran|Transaksi)|Jumlah\s*(?:Debet|Transaksi)|Nominal)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|No\.?\s*Resi|Nomor\s*Transaksi|No\.?\s*Transaksi|RRN)(?:\s*(?:\([^\)]+\)|BI\s*Fast))?[:\s]*([A-Za-z0-9]+)/i,
      /Ref(?:erence)?\s*(?:No|ID)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'topup',
      'gopay',
      'ovo',
      'dana',
      'shopeepay',
      'linkaja',
      'jago',
      'transfer ke rekening sendiri',
    ],
  },

  // 2. Bank Jago
  {
    bankKey: 'jago',
    displayName: 'Bank Jago',
    accountNameHint: 'Jago',
    senderDomains: ['jago.com'],
    subjectKeywords: [
      'uang keluar',
      'uang masuk',
      'transaksi berhasil',
      'kantong',
      'pembayaran',
      'transfer',
      'payment',
      'transaction',
      'debit card',
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'login',
      'perangkat baru',
      'promo',
      'bunga kantong',
      'newsletter',
      'being process',
      'is being process',
      'fresh new look',
      'getting a fresh new look',
    ],
    bodyRequiredPatterns: [
      /(?:uang keluar|uang masuk|berhasil|kantong|nominal|successful|amount|transaction of|debit card|pocket|payment)/i,
    ],
    amountPriorityPatterns: [
      /(?:Jumlah|Total|Nominal|Amount)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:transaction of)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:ID\s*Transaksi|No\.?\s*Referensi|Kode\s*Transaksi|Terminal\s*ID)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'topup',
      'gopay',
      'ovo',
      'dana',
      'shopeepay',
      'pindah kantong',
      'kirim uang',
    ],
  },

  // 3. Bank Central Asia (BCA)
  {
    bankKey: 'bca',
    displayName: 'BCA',
    accountNameHint: 'BCA',
    senderDomains: ['bca.co.id', 'klikbca.com'],
    subjectKeywords: [
      'transaksi',
      'debet',
      'kredit',
      'transfer',
      'qris',
      'm-bca',
      'mybca',
      'pembayaran',
      'payment',
    ],
    blacklistKeywords: COMMON_BANK_BLACKLIST_KEYWORDS,
    bodyRequiredPatterns: [
      /(?:transaksi|debet|kredit|berhasil|nominal|rekening|qris|pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Nominal|Jumlah|Total|Sebesar)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|Ref)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: COMMON_TRANSFER_TOPUP_KEYWORDS,
    ruleCategory: 'BANK',
  },

  // 3. GoPay / Gojek
  {
    bankKey: 'gopay',
    displayName: 'GoPay / Gojek',
    accountNameHint: 'GoPay',
    senderDomains: ['gopay.co.id', 'gojek.com'],
    subjectKeywords: [
      'bukti pembayaran',
      'receipt',
      'tanda terima',
      'pesanan anda telah selesai',
      'transaksi gopay',
      'pembayaran qris',
    ],
    blacklistKeywords: [
      'voucher',
      'diskon',
      'promo',
      'cashback harian',
      'goclub',
      'otp',
      'verifikasi',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total tarif|total|gopay|biaya)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Tarif|Biaya|Transaksi)|Jumlah\s*Total)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Pesanan|Order\s*ID|ID\s*Transaksi)[:\s]*([A-Za-z0-9-]+)/i,
      /(RB-[0-9A-Z-]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'isi saldo',
      'transfer bank',
      'tarik saldo',
    ],
  },

  // 4. OVO
  {
    bankKey: 'ovo',
    displayName: 'OVO',
    accountNameHint: 'OVO',
    senderDomains: ['ovo.id'],
    subjectKeywords: [
      'rincian transaksi',
      'transaksi berhasil',
      'pembayaran berhasil',
      'transfer berhasil',
      'top up berhasil',
    ],
    blacklistKeywords: [
      'promo',
      'poin ovo',
      'diskon',
      'invest',
      'asuransi',
      'otp',
      'security code',
      'voucher',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total|berhasil|ovo cash)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*Pembayaran|Total\s*Transaksi|Nominal)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|No\.?\s*Transaksi|Reference\s*No)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'top up',
      'isi saldo',
      'transfer ke rekening bank',
    ],
  },

  // 5. DANA
  {
    bankKey: 'dana',
    displayName: 'DANA',
    accountNameHint: 'DANA',
    senderDomains: ['dana.id'],
    subjectKeywords: [
      'pembayaran berhasil',
      'transaksi berhasil',
      'transfer berhasil',
      'kirim uang berhasil',
      'struk pembayaran',
    ],
    blacklistKeywords: [
      'dana kaget',
      'promo',
      'diskon',
      'voucher',
      'games',
      'otp',
      'pin',
      'newsletter',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total|saldo dana|berhasil)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Bayar)|Jumlah)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:ID\s*Pesanan|ID\s*Transaksi|Order\s*ID|No\.?\s*Referensi)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'isi saldo',
      'top up',
      'kirim uang ke bank',
    ],
  },

  // 6. ShopeePay
  {
    bankKey: 'shopeepay',
    displayName: 'ShopeePay',
    accountNameHint: 'ShopeePay',
    senderDomains: ['shopeepay.co.id'],
    subjectKeywords: [
      'transaksi shopeepay',
      'shopeepay berhasil',
      'isi saldo shopeepay',
      'transfer shopeepay',
      'pembayaran shopeepay',
    ],
    blacklistKeywords: [
      'flash sale',
      'gratis ongkir',
      'promo',
      'diskon',
      'koin shopee',
      'otp',
      'verifikasi',
      'login baru',
      'perangkat baru',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|shopeepay|total transaksi|rincian transaksi)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Transaksi|Isi Saldo)|Jumlah)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Transaksi|ID\s*Transaksi|No\.?\s*Referensi|Order\s*SN)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'isi saldo',
      'top up',
      'transfer ke bank',
    ],
    ruleCategory: 'PAYMENT_GATEWAY',
  },

  // 7. Flip
  {
    bankKey: 'flip',
    displayName: 'Flip',
    accountNameHint: 'Flip',
    senderDomains: ['flip.id'],
    subjectKeywords: [
      'successful transfer',
      'transaction information',
      'bukti pembayaran berhasil',
      'transfer berhasil',
      'transaksi berhasil',
      'receipt',
    ],
    blacklistKeywords: [
      'terms and conditions',
      'kebijakan privasi',
      'otp',
      'kode verifikasi',
      'promo',
      'diskon',
      'newsletter',
      'keamanan',
    ],
    bodyRequiredPatterns: [
      /(?:transaction details|transaction id|destination|nominal|total|successful|transfer|bukti pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Transaksi|Transfer|Pembayaran)|Nominal|Amount)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:Transaction\s*ID|ID\s*Transaksi|No\.?\s*Transaksi|Ref)[:\s]*#?([A-Za-z0-9_-]+)/i,
      /#([A-Za-z0-9_-]+)/i,
    ],
    transferOrTopupKeywords: [
      'transfer',
      'kirim uang',
      'top up',
      'topup',
      'rekening',
    ],
    ruleCategory: 'PAYMENT_GATEWAY',
  },
];

/**
 * Resolves the complete active list of email rules, combining pure bank debit & gateway rules
 * with dynamic and declarative commerce platform rules from CommercePlatformRegistry.
 */
export function getAllBankEmailRules(): BankEmailRuleDefinition[] {
  return [
    ...BANK_DEBIT_AND_GATEWAY_RULES,
    ...CommercePlatformRegistry.getInstance().toBankEmailRules(),
  ];
}

/**
 * Complete list of email rules, combining pure bank debit & gateway rules
 * with declarative commerce platform rules from CommercePlatformRegistry.
 */
export const BANK_EMAIL_RULES: BankEmailRuleDefinition[] = getAllBankEmailRules();
