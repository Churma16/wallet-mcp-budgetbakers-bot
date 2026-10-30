import { BankEmailRuleDefinition, BANK_DEBIT_AND_GATEWAY_RULES } from './bankEmailRules.js';
import { GateEvaluationResult } from '../utils/emailGateEvaluator.js';
import { PushNotificationPayload } from '../services/webhook/types.js';

export interface NotificationPackageDefinition {
  readonly packageName: string;
  readonly displayName: string;
  readonly accountNameHint: string;
  readonly bankKey: string;
  readonly category: 'BANK' | 'E_WALLET' | 'MERCHANT';
}

export const NOTIFICATION_PACKAGE_RULES: readonly NotificationPackageDefinition[] = [
  // Bank Jago
  {
    packageName: 'com.jago',
    displayName: 'Bank Jago',
    accountNameHint: 'Jago',
    bankKey: 'jago',
    category: 'BANK',
  },
  // Bank Mandiri (Livin)
  {
    packageName: 'com.bankmandiri.livin',
    displayName: 'Bank Mandiri (Livin)',
    accountNameHint: 'Mandiri',
    bankKey: 'mandiri',
    category: 'BANK',
  },
  // BCA (myBCA, BCA Mobile, BCA)
  {
    packageName: 'com.bca',
    displayName: 'BCA',
    accountNameHint: 'BCA',
    bankKey: 'bca',
    category: 'BANK',
  },
  {
    packageName: 'com.bca.mobile',
    displayName: 'BCA',
    accountNameHint: 'BCA',
    bankKey: 'bca',
    category: 'BANK',
  },
  {
    packageName: 'com.bca.mybca',
    displayName: 'BCA',
    accountNameHint: 'BCA',
    bankKey: 'bca',
    category: 'BANK',
  },
  // GoPay / Gojek
  {
    packageName: 'com.gojek.app',
    displayName: 'GoPay / Gojek',
    accountNameHint: 'GoPay',
    bankKey: 'gopay',
    category: 'E_WALLET',
  },
  // Shopee / ShopeePay
  {
    packageName: 'com.shopee.id',
    displayName: 'ShopeePay',
    accountNameHint: 'ShopeePay',
    bankKey: 'shopeepay',
    category: 'E_WALLET',
  },
  // DANA
  {
    packageName: 'id.dana',
    displayName: 'DANA',
    accountNameHint: 'DANA',
    bankKey: 'dana',
    category: 'E_WALLET',
  },
  // OVO
  {
    packageName: 'ovo.id',
    displayName: 'OVO',
    accountNameHint: 'OVO',
    bankKey: 'ovo',
    category: 'E_WALLET',
  },
  // Flip
  {
    packageName: 'id.co.flip',
    displayName: 'Flip',
    accountNameHint: 'Flip',
    bankKey: 'flip',
    category: 'BANK',
  },
  // TikTok / TikTok Shop
  {
    packageName: 'com.zhiliaoapp.musically',
    displayName: 'TikTok Shop',
    accountNameHint: 'TikTok',
    bankKey: 'tiktok',
    category: 'MERCHANT',
  },
  {
    packageName: 'com.ss.android.ugc.trill',
    displayName: 'TikTok Shop',
    accountNameHint: 'TikTok',
    bankKey: 'tiktok',
    category: 'MERCHANT',
  },
  // Grab
  {
    packageName: 'com.grabtaxi.passenger',
    displayName: 'Grab',
    accountNameHint: 'OVO',
    bankKey: 'grab',
    category: 'MERCHANT',
  },
];

const DEFAULT_BLACKLIST_KEYWORDS = [
  'otp',
  'kode verifikasi',
  'verification code',
  'login',
  'perangkat baru',
  'new device',
  'promo',
  'diskon',
  'cashback s.d',
  'voucher',
  'newsletter',
];

const TRANSACTION_KEYWORDS = [
  'transaksi',
  'berhasil',
  'pembayaran',
  'bayar',
  'transfer',
  'debet',
  'debit',
  'kredit',
  'saldo',
  'rp',
  'idr',
  'payment',
  'successful',
  'received',
  'paid',
];

/**
 * Extracts numeric amount from text strings like "Rp 15.000" or "Rp15.799,00"
 */
export function extractAmountFromText(text: string): number | undefined {
  const patterns = [
    /(?:Rp|IDR)\s*([0-9.,]+)/i,
    /(?:sebesar|sejumlah|nominal|total|amount)[:\s]*(?:Rp|IDR)?\s*([0-9.,]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const rawNumber = match[1];
      let cleaned = rawNumber.replace(/\s+/g, '');
      if (cleaned.includes('.') && cleaned.includes(',')) {
        if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) {
          cleaned = cleaned.replace(/,/g, '');
        } else {
          cleaned = cleaned.replace(/\./g, '').replace(',', '.');
        }
      } else if (cleaned.includes('.')) {
        const parts = cleaned.split('.');
        if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
          cleaned = cleaned.replace(/\./g, '');
        }
      } else if (cleaned.includes(',')) {
        const parts = cleaned.split(',');
        if (parts.length > 2 || (parts.length === 2 && parts[1].length === 3)) {
          cleaned = cleaned.replace(/,/g, '');
        } else {
          cleaned = cleaned.replace(',', '.');
        }
      }
      const parsed = Number.parseFloat(cleaned);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return undefined;
}

/**
 * Evaluates an incoming Android push notification through Gate 1.
 */
export function evaluateNotificationThroughGate(
  payload: PushNotificationPayload
): GateEvaluationResult {
  const packageName = (payload.packageName || '').trim().toLowerCase();
  const title = (payload.title || '').trim();
  const text = (payload.text || '').trim();
  const fullContent = `${title} ${text}`.toLowerCase();

  if (!packageName || (!title && !text)) {
    return {
      passed: false,
      reason: 'EMPTY_NOTIFICATION_PAYLOAD',
    };
  }

  // 1. Blacklist check
  for (const blacklist of DEFAULT_BLACKLIST_KEYWORDS) {
    if (fullContent.includes(blacklist)) {
      return {
        passed: false,
        reason: `BLACKLISTED_KEYWORD: ${blacklist}`,
      };
    }
  }

  // 2. Package matching
  const matchedPackageRule = NOTIFICATION_PACKAGE_RULES.find(
    rule => rule.packageName.toLowerCase() === packageName
  );

  // 3. Financial relevance check
  const hasFinancialKeyword = TRANSACTION_KEYWORDS.some(keyword => fullContent.includes(keyword));
  const candidateAmount = extractAmountFromText(`${title} ${text}`);

  if (!matchedPackageRule && !hasFinancialKeyword) {
    return {
      passed: false,
      reason: 'UNRECOGNIZED_NON_FINANCIAL_PACKAGE',
    };
  }

  // 4. Map or synthesize bank rule definition
  let matchedBankRule: BankEmailRuleDefinition | undefined;
  if (matchedPackageRule) {
    const existingRule = BANK_DEBIT_AND_GATEWAY_RULES.find(
      r => r.bankKey === matchedPackageRule.bankKey
    );
    if (existingRule) {
      matchedBankRule = existingRule;
    } else {
      matchedBankRule = {
        bankKey: matchedPackageRule.bankKey,
        displayName: matchedPackageRule.displayName,
        accountNameHint: matchedPackageRule.accountNameHint,
        senderDomains: [matchedPackageRule.packageName],
        subjectKeywords: TRANSACTION_KEYWORDS,
        blacklistKeywords: DEFAULT_BLACKLIST_KEYWORDS,
        bodyRequiredPatterns: [/(?:transaksi|berhasil|pembayaran|rp|idr)/i],
        amountPriorityPatterns: [/(?:Rp|IDR)\s*([\d.,]+)/i],
        referencePatterns: [/(?:No\.?\s*Ref|Ref|ID)[:\s]*([A-Za-z0-9]+)/i],
        transferOrTopupKeywords: ['top up', 'transfer'],
        ruleCategory: matchedPackageRule.category === 'MERCHANT' ? 'MERCHANT_RECEIPT' : 'BANK',
      };
    }
  }

  const originalDate = payload.timestamp ? new Date(payload.timestamp) : new Date();

  return {
    passed: true,
    matchedBankRule,
    candidateAmount,
    originalDate,
  };
}
