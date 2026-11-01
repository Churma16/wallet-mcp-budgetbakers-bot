import { describe, it, expect } from 'vitest';
import { parseRecordEditCommand } from '../src/wallet/records/recordEditParser.js';

describe('recordEditParser', () => {
  describe('Explicit Prefix Parsing (`e` and `edit`)', () => {
    it('parses multi-key edit command prefixed with `e`', () => {
      const parsed = parseRecordEditCommand('e c: Makan t: #jajan n: Kopi susu a: -25000');
      expect(parsed).not.toBeNull();
      expect(parsed?.categoryName).toBe('Makan');
      expect(parsed?.tags).toEqual(['jajan']);
      expect(parsed?.note).toBe('Kopi susu');
      expect(parsed?.amount).toBe(-25000);
      expect(parsed?.hasModifications).toBe(true);
    });

    it('parses edit command prefixed with `edit` case-insensitively', () => {
      const parsed = parseRecordEditCommand('EDIT cat: Makanan tag: #kantor, #makan note: Makan siang tim');
      expect(parsed).not.toBeNull();
      expect(parsed?.categoryName).toBe('Makanan');
      expect(parsed?.tags).toEqual(['kantor', 'makan']);
      expect(parsed?.note).toBe('Makan siang tim');
      expect(parsed?.hasModifications).toBe(true);
    });
  });

  describe('Direct Parsing Without Prefix (Shorthand & Full Names)', () => {
    it('parses shorthand keys directly without `e` prefix', () => {
      const parsed = parseRecordEditCommand('c: Transport t: #bensin n: Pertamax');
      expect(parsed).not.toBeNull();
      expect(parsed?.categoryName).toBe('Transport');
      expect(parsed?.tags).toEqual(['bensin']);
      expect(parsed?.note).toBe('Pertamax');
    });

    it('parses single field update: category only', () => {
      const parsed = parseRecordEditCommand('c: Makanan Ringan');
      expect(parsed).not.toBeNull();
      expect(parsed?.categoryName).toBe('Makanan Ringan');
      expect(parsed?.tags).toBeUndefined();
      expect(parsed?.note).toBeUndefined();
    });

    it('parses single field update: note only (using d:, des:, or note:)', () => {
      const parsed1 = parseRecordEditCommand('n: Kopi Kenangan');
      expect(parsed1?.note).toBe('Kopi Kenangan');

      const parsed2 = parseRecordEditCommand('d: Es Kopi Susu');
      expect(parsed2?.note).toBe('Es Kopi Susu');

      const parsed3 = parseRecordEditCommand('des: Catatan transaksi baru');
      expect(parsed3?.note).toBe('Catatan transaksi baru');
    });

    it('parses single field update: tags only', () => {
      const parsed = parseRecordEditCommand('t: #jajan #kopi #liburan');
      expect(parsed).not.toBeNull();
      expect(parsed?.tags).toEqual(['jajan', 'kopi', 'liburan']);
    });
  });

  describe('Indonesian & Alternate Shorthand Aliases', () => {
    it('supports Indonesian key aliases like kategori:, catatan:, label:', () => {
      const parsed = parseRecordEditCommand('kategori: Belanja Bulanan catatan: Sabun dan pasta gigi label: #rumah, #bulanan');
      expect(parsed).not.toBeNull();
      expect(parsed?.categoryName).toBe('Belanja Bulanan');
      expect(parsed?.note).toBe('Sabun dan pasta gigi');
      expect(parsed?.tags).toEqual(['rumah', 'bulanan']);
    });

    it('supports merchant / payee keys: p:, payee:, m:, merchant:', () => {
      const parsed1 = parseRecordEditCommand('m: Starbucks c: Minuman');
      expect(parsed1?.counterParty).toBe('Starbucks');
      expect(parsed1?.categoryName).toBe('Minuman');

      const parsed2 = parseRecordEditCommand('payee: Tokopedia a: 150000');
      expect(parsed2?.counterParty).toBe('Tokopedia');
      expect(parsed2?.amount).toBe(150000);
    });
  });

  describe('Amount Parsing Formats & Currency Prefixes', () => {
    it('parses numeric amounts with positive/negative signs', () => {
      expect(parseRecordEditCommand('a: 45000')?.amount).toBe(45000);
      expect(parseRecordEditCommand('a: 45000')?.hasExplicitPositiveSign).toBe(false);

      expect(parseRecordEditCommand('a: -45000')?.amount).toBe(-45000);
      expect(parseRecordEditCommand('a: -45000')?.hasExplicitPositiveSign).toBe(false);

      expect(parseRecordEditCommand('a: +30000')?.amount).toBe(30000);
      expect(parseRecordEditCommand('a: +30000')?.hasExplicitPositiveSign).toBe(true);
    });

    it('parses shorthand amount suffixes (k, rb, jt)', () => {
      expect(parseRecordEditCommand('a: 25k')?.amount).toBe(25000);
      expect(parseRecordEditCommand('amt: -50rb')?.amount).toBe(-50000);
      expect(parseRecordEditCommand('nominal: 1.5jt')?.amount).toBe(1500000);
    });

    it('parses amounts with thousands separators', () => {
      expect(parseRecordEditCommand('amount: 150.000')?.amount).toBe(150000);
      expect(parseRecordEditCommand('amount: 1,500,000')?.amount).toBe(1500000);
    });

    it('parses amounts with Indonesian currency markers (Rp, IDR)', () => {
      expect(parseRecordEditCommand('a: Rp 50.000')?.amount).toBe(50000);
      expect(parseRecordEditCommand('a: rp 50k')?.amount).toBe(50000);
      expect(parseRecordEditCommand('a: -Rp 25.000')?.amount).toBe(-25000);
      expect(parseRecordEditCommand('a: Rp -25.000')?.amount).toBe(-25000);
      expect(parseRecordEditCommand('a: +IDR 100.000')?.amount).toBe(100000);
      expect(parseRecordEditCommand('a: +IDR 100.000')?.hasExplicitPositiveSign).toBe(true);
      expect(parseRecordEditCommand('nominal: Rp25.000')?.amount).toBe(25000);
    });
  });

  describe('Non-Matching and Guardrail Tests', () => {
    it('returns null for empty, whitespace, or undefined input', () => {
      expect(parseRecordEditCommand('')).toBeNull();
      expect(parseRecordEditCommand('   ')).toBeNull();
      expect(parseRecordEditCommand(undefined)).toBeNull();
    });

    it('returns null for normal conversational messages without edit keys', () => {
      expect(parseRecordEditCommand('makan siang 50rb di warteg')).toBeNull();
      expect(parseRecordEditCommand('halo bot terima kasih')).toBeNull();
      expect(parseRecordEditCommand('batal')).toBeNull();
      expect(parseRecordEditCommand('ya')).toBeNull();
    });

    it('returns null for conversational text containing colons mid-sentence without explicit prefix', () => {
      expect(parseRecordEditCommand('Halo min tolong note: transaksi kemarin')).toBeNull();
      expect(parseRecordEditCommand('Terima kasih c: sudah dibantu')).toBeNull();
      expect(parseRecordEditCommand('Bukti bayar ke p: 0812345678')).toBeNull();
    });

    it('truncates note exceeding 255 characters without corrupting surrogate pairs', () => {
      const longNote = '🍕'.repeat(300);
      const parsed = parseRecordEditCommand(`n: ${longNote}`);
      expect(parsed?.note).toBeDefined();
      expect(Array.from(parsed!.note!)).toHaveLength(255);
    });
  });
});
