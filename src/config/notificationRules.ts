import { BankEmailRuleDefinition, BANK_DEBIT_AND_GATEWAY_RULES } from '../email/index.js';
import { GateEvaluationResult } from '../email/index.js';
import { PushNotificationPayload } from '../services/webhook/types.js';

export interface NotificationPackageDefinition {
  readonly packageName: string;
  readonly displayName: string;
  readonly accountNameHint: string;
  readonly bankKey: string;
  readonly category: 'BANK' | 'E_WALLET' | 'MERCHANT';
}

type PackageRuleTuple = [
  packageName: string,
  displayName: string,
  accountNameHint: string,
  bankKey: string,
  category: 'BANK' | 'E_WALLET' | 'MERCHANT'
];

const RAW_PACKAGE_RULES: readonly PackageRuleTuple[] = [
  ['com.jago', 'Bank Jago', 'Jago', 'jago', 'BANK'],
  ['com.bankmandiri.livin', 'Bank Mandiri (Livin)', 'Mandiri', 'mandiri', 'BANK'],
  ['com.bca', 'BCA', 'BCA', 'bca', 'BANK'],
  ['com.bca.mobile', 'BCA', 'BCA', 'bca', 'BANK'],
  ['com.bca.mybca', 'BCA', 'BCA', 'bca', 'BANK'],
  ['com.gojek.app', 'GoPay / Gojek', 'GoPay', 'gopay', 'E_WALLET'],
  ['com.shopee.id', 'ShopeePay', 'ShopeePay', 'shopeepay', 'E_WALLET'],
  ['id.dana', 'DANA', 'DANA', 'dana', 'E_WALLET'],
  ['ovo.id', 'OVO', 'OVO', 'ovo', 'E_WALLET'],
  ['id.co.flip', 'Flip', 'Flip', 'flip', 'BANK'],
  ['com.zhiliaoapp.musically', 'TikTok Shop', 'TikTok', 'tiktok', 'MERCHANT'],
  ['com.ss.android.ugc.trill', 'TikTok Shop', 'TikTok', 'tiktok', 'MERCHANT'],
  ['com.grabtaxi.passenger', 'Grab', 'OVO', 'grab', 'MERCHANT'],
];

export const NOTIFICATION_PACKAGE_RULES: readonly NotificationPackageDefinition[] =
  RAW_PACKAGE_RULES.map(([packageName, displayName, accountNameHint, bankKey, category]) => ({
    packageName,
    displayName,
    accountNameHint,
    bankKey,
    category,
  }));

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
    /(?:sebesar|sejumlah|nominal|total|amount)[:\s]+(?:(?:Rp|IDR)\s*)?([0-9.,]+)/i,
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
