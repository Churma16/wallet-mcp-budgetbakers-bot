import type { BankEmailRuleDefinition } from './bankEmailRules.js';

export interface CommercePlatformDefinition {
  /** Unique identifier for the platform (e.g. 'grab', 'shopee', 'blibli', 'tokopedia') */
  readonly id: string;
  /** Human-readable display name */
  readonly displayName: string;
  /** Default category for this commerce platform (e.g. 'Ojol', 'Shopping') */
  readonly defaultCategory: string;
  /** Default account name hint if not specified (e.g. 'Cash', 'Grab') */
  readonly defaultAccountHint: string;
  /** Allowed sender domains (e.g. ['grab.com'], ['shopee.co.id']) */
  readonly senderDomains: string[];
  /** Transaction-indicating subject keywords */
  readonly subjectKeywords: string[];
  /** Non-transaction blacklist keywords (OTP, promos, etc.) */
  readonly blacklistKeywords: string[];
  /** Patterns required to be present in email body */
  readonly bodyRequiredPatterns: RegExp[];
  /** Priority regex patterns to extract amount */
  readonly amountPriorityPatterns: RegExp[];
  /** Regex patterns to extract reference / order number */
  readonly referencePatterns: RegExp[];
  /** Platform-specific wallet or platform account names (e.g. ['ShopeePay', 'SPayLater'], ['OVO', 'GrabPay']) */
  readonly platformWallets: string[];
  /** Merchant keywords / brand tokens that appear in counterparty or descriptions */
  readonly merchantKeywords: string[];
  /** Keywords indicating top up or transfer */
  readonly transferOrTopupKeywords?: string[];
}

export const DEFAULT_COMMERCE_PLATFORMS: CommercePlatformDefinition[] = [
  // 1. Grab
  {
    id: 'grab',
    displayName: 'Grab',
    defaultCategory: 'Ojol',
    defaultAccountHint: 'Grab',
    senderDomains: ['grab.com'],
    subjectKeywords: [
      'your grab e-receipt',
      'e-receipt',
      'tanda terima',
      'tagihan',
      'paket grabunlimited',
      'perjalanan',
    ],
    blacklistKeywords: [
      'promo',
      'diskon',
      'voucher',
      'penawaran',
      'paket hemat',
      'newsletter',
      'otp',
      'verifikasi',
      'login baru',
    ],
    bodyRequiredPatterns: [
      /(?:total|tarif|pembayaran|biaya|fare|grabbike|grabcar|grabfood|grabmart|booking id)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Tarif|Biaya|Pembayaran|Fare)|Jumlah\s*Total)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:Booking\s*ID|Order\s*ID|ID\s*Pemesanan)[:\s]*([A-Za-z0-9-]+)/i,
      /(A-[A-Z0-9]+)/i,
    ],
    platformWallets: ['grab', 'ovo', 'grabpay'],
    merchantKeywords: ['grab', 'grabbike', 'grabcar', 'grabfood', 'grabmart'],
    transferOrTopupKeywords: ['top up', 'isi saldo', 'ovo'],
  },

  // 2. Blibli
  {
    id: 'blibli',
    displayName: 'Blibli',
    defaultCategory: 'Shopping',
    defaultAccountHint: 'Cash',
    senderDomains: ['blibli.com'],
    subjectKeywords: [
      'pembayaran qris anda telah kami terima',
      'pembayaran berhasil',
      'pesanan anda telah dibayar',
      'pesanan',
      'blibli',
      'qris',
      'offline store',
      'e-receipt',
      'struk pembayaran',
    ],
    blacklistKeywords: [
      'otp',
      'kode verifikasi',
      'promo',
      'diskon',
      'newsletter',
      'flash sale',
      'pengingat pembayaran',
      'menunggu pembayaran',
    ],
    bodyRequiredPatterns: [
      /(?:pembayaran\s*(?:qris\s*)?(?:anda\s*)?telah\s*kami\s*terima|terima\s*kasih\s*telah\s*melakukan\s*pembayaran|offline\s*store|total\s*pembayaran|detail\s*pesanan|produk)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*Pembayaran|Total\s*Belanja|Total\s*Tagihan|Total)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Pesanan|Nomor\s*Pesanan|Order\s*ID|Order\s*Number)[:\s]*([A-Za-z0-9_-]+)/i,
      /(?:No\.?\s*Referensi|Nomor\s*Referensi|No\.?\s*Transaksi|Nomor\s*Transaksi|RRN)[:\s]*([A-Za-z0-9]+)/i,
    ],
    platformWallets: ['blibli', 'blibli tiket points'],
    merchantKeywords: ['blibli', 'blibli.com', 'blibli offline store'],
  },

  // 3. Shopee
  {
    id: 'shopee',
    displayName: 'Shopee',
    defaultCategory: 'Shopping',
    defaultAccountHint: 'Cash',
    senderDomains: ['shopee.co.id'],
    subjectKeywords: [
      'pembayaranmu berhasil dikonfirmasi',
      'pembayaran berhasil',
      'rincian pesanan',
      'pesanan selesai',
      'pesanan anda telah',
      'pesanan',
      'tagihan',
      'e-receipt',
    ],
    blacklistKeywords: [
      'flash sale',
      'gratis ongkir',
      'promo',
      'diskon',
      'koin shopee',
      'otp',
      'verifikasi',
      'telah dikirim',
      'sedang dikirim',
      'pengiriman',
      'dikirim',
      'pesanan dibatalkan',
    ],
    bodyRequiredPatterns: [
      /(?:total pembayaran|total dibayarkan|total pesanan|rincian pesanan|rincian pembayaran|metode pembayaran)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*(?:Dibayarkan|Pembayaran|Pesanan|Belanja)|Jumlah\s*Total)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:No\.?\s*Pesanan|ID\s*Pesanan|Order\s*SN|No\.?\s*Transaksi)[:\s]*#?([A-Za-z0-9]+)/i,
      /#([0-9]{6}[A-Z0-9]+)/i,
    ],
    platformWallets: ['shopee', 'shopeepay', 'spaylater'],
    merchantKeywords: ['shopee', 'shopeepay'],
  },

  // 4. Alfagift
  {
    id: 'alfagift',
    displayName: 'Alfagift',
    defaultCategory: 'Groceries',
    defaultAccountHint: 'Cash',
    senderDomains: ['alfagift.id', 'alfamart.co.id'],
    subjectKeywords: [
      'pembayaran pesanan',
      'pembayaran diterima',
      'pesanan di alfagift',
      'e-receipt',
      'struk pembayaran',
    ],
    blacklistKeywords: [
      'menunggu pembayaran',
      'keranjang',
      'pengiriman pesanan',
      'telah selesai',
      'verifikasi',
      'create pin',
      'otp',
      'promo',
      'diskon',
      'cashback',
      'voucher',
      'a-poin',
      'rekomendasi',
      'selamat datang',
      'ulang tahun',
      'birthday',
      'balasan untuk komentar',
    ],
    bodyRequiredPatterns: [
      /(?:pembayaran\s*(?:atas\s*)?pesanan\s*(?:anda\s*)?(?:sudah\s*kami\s*terima|diterima)|total\s*pembayaran|nomor\s*pesanan|detail\s*pesanan)/i,
    ],
    amountPriorityPatterns: [
      /(?:Total\s*Pembayaran|Total\s*Belanja|Total\s*Tagihan|Total|sebesar)[:\s]{0,30}(?:Rp|IDR)?[\s]{0,30}([\d.,]+)/i,
      /(?:Rp|IDR)\s*([\d.,]+)/i,
    ],
    referencePatterns: [
      /(?:Nomor\s*Pesanan|No\.?\s*Pesanan|Order\s*ID)[:\s]*#?([A-Za-z0-9_-]+)/i,
      /(?:Nomor\s*Referensi|No\.?\s*Referensi|Nomor\s*Transaksi|No\.?\s*Transaksi)[:\s]*([A-Za-z0-9_-]+)/i,
      /(?:#|\()([OTS]-[0-9]{6}-[A-Z0-9]+)/i,
      /([OTS]-[0-9]{6}-[A-Z0-9]+)/i,
    ],
    platformWallets: ['alfagift', 'a-poin', 'aladin'],
    merchantKeywords: ['alfagift', 'alfamart', 'sumber alfaria trijaya'],
  },
];

export class CommercePlatformRegistry {
  private static instance: CommercePlatformRegistry;
  private readonly platforms = new Map<string, CommercePlatformDefinition>();

  constructor(definitions: CommercePlatformDefinition[] = DEFAULT_COMMERCE_PLATFORMS) {
    for (const def of definitions) {
      this.register(def);
    }
  }

  public static getInstance(): CommercePlatformRegistry {
    if (!CommercePlatformRegistry.instance) {
      CommercePlatformRegistry.instance = new CommercePlatformRegistry();
    }
    return CommercePlatformRegistry.instance;
  }

  public static resetInstance(): void {
    CommercePlatformRegistry.instance = new CommercePlatformRegistry();
  }

  public register(platform: CommercePlatformDefinition): void {
    this.platforms.set(platform.id.toLowerCase(), platform);
  }

  public unregister(platformId: string): void {
    this.platforms.delete(platformId.toLowerCase());
  }

  public getAll(): CommercePlatformDefinition[] {
    return Array.from(this.platforms.values());
  }

  public getById(id: string): CommercePlatformDefinition | undefined {
    return this.platforms.get(id.toLowerCase());
  }

  /**
   * Checks whether an account hint matches a known platform wallet or platform payment instrument.
   * e.g. "ShopeePay", "SPayLater", "GoPay", "OVO", "Grab", "Cash", "Tunai", "DANA", "LinkAja".
   */
  public isPlatformWallet(accountName: string | undefined | null): boolean {
    if (!accountName) return false;
    const lower = accountName.toLowerCase().trim();
    if (!lower) return false;

    // Universal cash and platform e-wallet identifiers
    const universalPlatformKeywords = ['cash', 'tunai', 'gopay', 'ovo', 'dana', 'linkaja'];
    if (universalPlatformKeywords.some(keyword => lower.includes(keyword))) {
      return true;
    }

    // Registered platform wallets & brands
    return Array.from(this.platforms.values()).some(p =>
      p.platformWallets.some(wallet => lower.includes(wallet.toLowerCase())) ||
      lower.includes(p.id) ||
      lower.includes(p.displayName.toLowerCase())
    );
  }

  /**
   * Checks whether a merchant or counterparty name corresponds to a registered commerce platform.
   * e.g. "Grab", "GrabFood", "Shopee", "Blibli", "Alfamart".
   */
  public isCommerceMerchant(merchantName: string | undefined | null): boolean {
    if (!merchantName) return false;
    const lower = merchantName.toLowerCase().trim();
    if (!lower) return false;

    // Common retail merchants
    const retailKeywords = ['alfamart', 'alfagift', 'indomaret', 'flip'];
    if (retailKeywords.some(k => lower.includes(k))) {
      return true;
    }

    return Array.from(this.platforms.values()).some(p =>
      lower.includes(p.id) ||
      lower.includes(p.displayName.toLowerCase()) ||
      p.merchantKeywords.some(keyword => lower.includes(keyword.toLowerCase()))
    );
  }

  /**
   * Returns all known merchant keywords across all registered commerce platforms.
   */
  public getAllMerchantKeywords(): string[] {
    const keywords = new Set<string>(['alfamart', 'alfagift', 'indomaret', 'flip']);
    for (const p of this.platforms.values()) {
      keywords.add(p.id);
      keywords.add(p.displayName.toLowerCase());
      for (const k of p.merchantKeywords) {
        keywords.add(k.toLowerCase());
      }
    }
    return Array.from(keywords);
  }

  /**
   * Translates registered commerce platforms into BankEmailRuleDefinition objects
   * for seamless integration with EmailGateEvaluator.
   */
  public toBankEmailRules(): BankEmailRuleDefinition[] {
    return Array.from(this.platforms.values()).map(p => ({
      bankKey: p.id,
      displayName: p.displayName,
      accountNameHint: p.defaultAccountHint,
      senderDomains: p.senderDomains,
      subjectKeywords: p.subjectKeywords,
      blacklistKeywords: p.blacklistKeywords,
      bodyRequiredPatterns: p.bodyRequiredPatterns,
      amountPriorityPatterns: p.amountPriorityPatterns,
      referencePatterns: p.referencePatterns,
      transferOrTopupKeywords: p.transferOrTopupKeywords || [],
      ruleCategory: 'MERCHANT_RECEIPT' as const,
    }));
  }
}
