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
}

export const BANK_EMAIL_RULES: BankEmailRuleDefinition[] = [
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
      /(?:Total\s*(?:Debet|Pembayaran|Transaksi)|Jumlah\s*(?:Debet|Transaksi)|Nominal)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|No\.?\s*Resi|Nomor\s*Transaksi|No\.?\s*Transaksi|RRN)[:\s]*([A-Za-z0-9]+)/i,
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
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'login',
      'perangkat baru',
      'promo',
      'bunga kantong',
      'newsletter',
    ],
    bodyRequiredPatterns: [
      /(?:uang keluar|uang masuk|berhasil|kantong|nominal)/i,
    ],
    amountPriorityPatterns: [
      /(?:Jumlah|Total|Nominal)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:ID\s*Transaksi|No\.?\s*Referensi|Kode\s*Transaksi)[:\s]*([A-Za-z0-9]+)/i,
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
      /(?:Total\s*(?:Pembayaran|Tarif|Biaya|Transaksi)|Jumlah\s*Total)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
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
      /(?:Total\s*Pembayaran|Total\s*Transaksi|Nominal)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
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
      /(?:Total\s*(?:Pembayaran|Bayar)|Jumlah)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
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
    senderDomains: ['shopeepay.co.id', 'shopee.co.id'],
    subjectKeywords: [
      'rincian pesanan',
      'pembayaran berhasil',
      'transaksi shopeepay',
      'shopeepay berhasil',
      'pesanan selesai',
    ],
    blacklistKeywords: [
      'flash sale',
      'gratis ongkir',
      'promo',
      'diskon',
      'koin shopee',
      'otp',
      'verifikasi',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|shopeepay|total pesanan|rincian)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Pembayaran|Pesanan|Belanja)|Jumlah)[:\s]*(?:Rp|IDR)?\s*([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Pesanan|ID\s*Pesanan|Order\s*SN|No\.?\s*Transaksi)[:\s]*([A-Za-z0-9]+)/i,
    ],
    transferOrTopupKeywords: [
      'isi saldo',
      'top up',
      'transfer ke bank',
    ],
  },
];
