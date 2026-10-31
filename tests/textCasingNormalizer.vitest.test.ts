import { describe, expect, it } from 'vitest';
import {
  normalizeTransactionText,
  formatSmartTitleCase,
} from '../src/lib/textCasing.js';
import { validateAndSanitizeFinancialRecords } from '../src/wallet/recordValidator.js';
import {
  buildCompactSystemInstruction,
} from '../src/brain/index.js';
import { CreateRecordInputPayload, WalletAccountItem } from '../src/types/walletTypes.js';

describe('textCasingNormalizer unit tests', () => {
  it('formats transit routes with uppercase transit acronyms and "ke" preposition', () => {
    expect(normalizeTransactionText('mrt sudirman to dukuh atas')).toBe('MRT Sudirman ke Dukuh Atas');
    expect(normalizeTransactionText('krl manggarai -> bogor')).toBe('KRL Manggarai ke Bogor');
    expect(normalizeTransactionText('lrt dukuh atas to harjamukti')).toBe('LRT Dukuh Atas ke Harjamukti');
    expect(normalizeTransactionText('mrt bundaran hi ke lebak bulus')).toBe('MRT Bundaran HI ke Lebak Bulus');
  });

  it('expands transit abbreviations for Tanjung Priok', () => {
    expect(normalizeTransactionText('krl dukuh atas to tj priuk')).toBe('KRL Dukuh Atas ke Tanjung Priok');
    expect(normalizeTransactionText('krl stasiun kota to tj. priok')).toBe('KRL Stasiun Kota ke Tanjung Priok');
  });

  it('preserves uppercase for financial, utility, tech, and retail acronyms', () => {
    expect(normalizeTransactionText('token pln')).toBe('Token PLN');
    expect(normalizeTransactionText('pembayaran pdam')).toBe('Pembayaran PDAM');
    expect(normalizeTransactionText('iuran bpjs kesehatan')).toBe('Iuran BPJS Kesehatan');
    expect(normalizeTransactionText('pembayaran qris di kopi kenangan')).toBe('Pembayaran QRIS di Kopi Kenangan');
    expect(normalizeTransactionText('beli vps untuk ai api')).toBe('Beli VPS untuk AI API');
    expect(normalizeTransactionText('nonton film di xxi')).toBe('Nonton Film di XXI');
    expect(normalizeTransactionText('makan paket kfc')).toBe('Makan Paket KFC');
    expect(normalizeTransactionText('isi bensin di spbu pertamina')).toBe('Isi Bensin di SPBU Pertamina');
  });

  it('keeps prepositions and conjunctions lowercase when not the leading word', () => {
    expect(normalizeTransactionText('makan soto betawi di warung padang')).toBe(
      'Makan Soto Betawi di Warung Padang'
    );
    expect(normalizeTransactionText('kopi dan kue untuk rapat')).toBe('Kopi dan Kue untuk Rapat');
    expect(normalizeTransactionText('lunch with client in jakarta')).toBe('Lunch with Client in Jakarta');
  });

  it('capitalizes prepositions when they are the leading word', () => {
    expect(normalizeTransactionText('di jalan sudirman')).toBe('Di Jalan Sudirman');
    expect(normalizeTransactionText('untuk keluarga')).toBe('Untuk Keluarga');
    expect(normalizeTransactionText('ke stasiun')).toBe('Ke Stasiun');
  });

  it('enforces canonical brand casing', () => {
    expect(normalizeTransactionText('top up gopay')).toBe('Top Up GoPay');
    expect(normalizeTransactionText('transfer shopeepay')).toBe('Transfer ShopeePay');
    expect(normalizeTransactionText('pesan grabfood')).toBe('Pesan GrabFood');
    expect(normalizeTransactionText('order gofood mart')).toBe('Order GoFood Mart');
    expect(normalizeTransactionText('beli buku di tokopedia')).toBe('Beli Buku di Tokopedia');
    expect(normalizeTransactionText('belanja di indomaret point')).toBe('Belanja di Indomaret Point');
    expect(normalizeTransactionText('mcd sudirman')).toBe('McD Sudirman');
    expect(normalizeTransactionText("mcdonald's sarinah")).toBe("McDonald's Sarinah");
  });

  it('preserves multiplier / quantity syntax in lowercase x', () => {
    expect(normalizeTransactionText('2x nasi goreng, 1x es teh manis')).toBe(
      '2x Nasi Goreng, 1x Es Teh Manis'
    );
    expect(normalizeTransactionText('10x gorengan')).toBe('10x Gorengan');
  });

  it('preserves existing mixed-case or camelCase identifiers', () => {
    expect(normalizeTransactionText('beli casing iPhone 15')).toBe('Beli Casing iPhone 15');
    expect(normalizeTransactionText('WiFi router baru')).toBe('WiFi Router Baru');
    expect(normalizeTransactionText('ayam d\'BestO')).toBe('Ayam d\'BestO');
  });

  it('downcases screaming ALL-CAPS input before applying smart title casing', () => {
    expect(normalizeTransactionText('PEMBAYARAN QRIS DI INDOMARET')).toBe(
      'Pembayaran QRIS di Indomaret'
    );
    expect(normalizeTransactionText('TAGIHAN PLN PRABAYAR')).toBe('Tagihan PLN Prabayar');
  });

  it('strips redundant trailing account tokens from transaction notes', () => {
    expect(
      normalizeTransactionText('krl dukuh atas to tj priuk tapcash', {
        accountHint: 'BNI Tapcash',
        accountName: 'BNI Tapcash',
      })
    ).toBe('KRL Dukuh Atas ke Tanjung Priok');

    expect(
      normalizeTransactionText('makan soto betawi bca', {
        accountHint: 'BCA',
        accountName: 'BCA Personal',
      })
    ).toBe('Makan Soto Betawi');

    expect(
      normalizeTransactionText('kopi kenangan cash', {
        accountHint: 'cash',
        accountName: 'Cash',
      })
    ).toBe('Kopi Kenangan');
  });

  it('returns undefined for empty, null, or whitespace-only strings', () => {
    expect(normalizeTransactionText('')).toBeUndefined();
    expect(normalizeTransactionText('   ')).toBeUndefined();
    expect(normalizeTransactionText(null)).toBeUndefined();
    expect(normalizeTransactionText(undefined)).toBeUndefined();
  });
});

describe('recordValidator casing integration', () => {
  const mockAccounts: WalletAccountItem[] = [
    { id: 'acc-tapcash', name: 'BNI Tapcash' },
    { id: 'acc-bca', name: 'BCA Personal' },
  ];

  it('normalizes note and counterParty upon record validation', () => {
    const rawRecord: CreateRecordInputPayload = {
      accountId: 'acc-tapcash',
      accountHint: 'BNI Tapcash',
      amount: -3000,
      recordDate: '2026-10-30T10:00:00Z',
      note: '3k mrt sudirman to dukuh atas tapcash',
      counterParty: 'mrt jakarta',
    };

    const result = validateAndSanitizeFinancialRecords([rawRecord], mockAccounts, []);
    expect(result.isValid).toBe(true);
    expect(result.sanitizedRecords[0].note).toBe('3k MRT Sudirman ke Dukuh Atas');
    expect(result.sanitizedRecords[0].counterParty).toBe('MRT Jakarta');
  });
});

describe('aiPromptBuilder text prompt casing rules', () => {
  it('includes NOTE & COUNTERPARTY SMART CASING instructions in buildCompactSystemInstruction', () => {
    const prompt = buildCompactSystemInstruction([], [], '2026-10-30');
    expect(prompt).toContain('NOTE & COUNTERPARTY SMART CASING');
    expect(prompt).toContain('Title Case');
    expect(prompt).toContain('MRT, KRL, LRT, KAI, BCA');
    expect(prompt).toContain('Indonesian preposition "ke"');
    expect(prompt).toContain('Exclude the payment account');
  });
});
