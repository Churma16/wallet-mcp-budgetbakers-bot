import { describe, expect, it } from 'vitest';
import {
  formatTransactionHistoryMessage,
  truncateTransactionTitle,
  formatCompactTransactionAmount,
  formatCompactTransactionDate,
  MAX_TRANSACTION_HISTORY_TITLE_LENGTH,
} from '../src/utils/humanResponseFormatter.js';
import type { TransactionHistoryPage } from '../src/services/transactionHistoryService.js';

describe('Transaction History Formatting (Issue #115)', () => {
  describe('Title Truncation (Unicode- and line-safe)', () => {
    it('does not truncate titles at or below the maximum length', () => {
      const shortTitle = 'Makan siang padang';
      expect(truncateTransactionTitle(shortTitle)).toBe(shortTitle);

      const exactTitle = 'A'.repeat(MAX_TRANSACTION_HISTORY_TITLE_LENGTH);
      expect(truncateTransactionTitle(exactTitle)).toBe(exactTitle);
    });

    it('deterministically truncates long titles at 43 graphemes with ellipsis', () => {
      const longTitle = 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN REPUBLIK INDONESIA';
      const truncated = truncateTransactionTitle(longTitle);
      expect(truncated).toBe('Pengkreditan otomatis PEMAGANGAN ANGKATAN 2...');
      expect(longTitle.startsWith('Pengkreditan')).toBe(true);
    });

    it('normalizes embedded line breaks and excess whitespace to a single line', () => {
      const multilineTitle = 'Pembayaran Toko Buku\nLantai 2\r\nBlok B';
      const singleLine = truncateTransactionTitle(multilineTitle);
      expect(singleLine).not.toContain('\n');
      expect(singleLine).not.toContain('\r');
      expect(singleLine).toBe('Pembayaran Toko Buku Lantai 2 Blok B');
    });

    it('safely handles multi-byte emoji surrogate pairs at the truncation boundary without breaking Unicode', () => {
      // 42 ASCII chars followed by a surrogate-pair emoji (🎉 = \uD83C\uDF89) and trailing text
      const boundaryEmojiTitle = `${'A'.repeat(42)}🎉 EXTRA_TEXT_THAT_SHOULD_BE_TRUNCATED`;
      const truncated = truncateTransactionTitle(boundaryEmojiTitle);

      // Must cleanly preserve the emoji rather than cutting high/low surrogates in half
      expect(truncated).toBe(`${'A'.repeat(42)}🎉...`);
      expect(truncated).not.toContain('\uFFFD'); // no replacement glyph
    });
  });

  describe('Compact Signed Amount Formatting', () => {
    it('formats negative expense with minus prefix and no spacing after currency symbol', () => {
      expect(formatCompactTransactionAmount(-20895, 'expense', 'IDR', 'id')).toBe('-Rp20.895');
      expect(formatCompactTransactionAmount(-25, 'expense', 'USD', 'en')).toBe('-$25.00');
    });

    it('formats positive income with plus prefix and no spacing after currency symbol', () => {
      expect(formatCompactTransactionAmount(5729876, 'income', 'IDR', 'id')).toBe('+Rp5.729.876');
      expect(formatCompactTransactionAmount(100.5, 'income', 'USD', 'en')).toBe('+$100.50');
    });
  });

  describe('Compact Date Formatting (Year-boundary safe)', () => {
    it('omits year when transaction is in the same year as the reference date in Asia/Jakarta', () => {
      const fixedReference = new Date('2026-06-15T12:00:00.000Z');
      // 06:52 UTC = 13:52 WIB (Asia/Jakarta)
      const txSameYear = new Date('2026-09-11T06:52:00.000Z');
      const formatted = formatCompactTransactionDate(txSameYear, 'id', fixedReference);

      expect(formatted).toBe('11 Sep 13:52');
      expect(formatted).not.toContain('2026');
    });

    it('includes year when transaction is in a different year than the reference date', () => {
      const fixedReference = new Date('2026-06-15T12:00:00.000Z');
      // 03:15 UTC = 10:15 WIB (Asia/Jakarta)
      const txPriorYear = new Date('2024-05-10T03:15:00.000Z');
      const formatted = formatCompactTransactionDate(txPriorYear, 'id', fixedReference);

      expect(formatted).toContain('2024');
      expect(formatted).toMatch(/10:15/);
    });

    it('correctly handles New Year boundary transitions in Asia/Jakarta independent of host timezone', () => {
      // 31 Dec 2026 17:30 UTC corresponds to 01 Jan 2027 00:30 WIB (Asia/Jakarta)
      const newYearRefJakarta = new Date('2026-12-31T17:30:00.000Z');

      // 01 Jan 2027 02:00 UTC = 01 Jan 2027 09:00 WIB (same year: 2027 in Jakarta)
      const txSameYear = new Date('2027-01-01T02:00:00.000Z');
      expect(formatCompactTransactionDate(txSameYear, 'id', newYearRefJakarta)).not.toContain('2027');

      // 31 Dec 2026 16:00 UTC = 31 Dec 2026 23:00 WIB (prior year: 2026 in Jakarta)
      const txPriorYear = new Date('2026-12-31T16:00:00.000Z');
      expect(formatCompactTransactionDate(txPriorYear, 'id', newYearRefJakarta)).toContain('2026');
    });
  });

  describe('Compact 3-Line Transaction History Layout', () => {
    const samplePage: TransactionHistoryPage = {
      records: [
        {
          id: 'rec-1',
          accountId: 'acc-1',
          accountName: 'Cash',
          amount: -1000,
          currency: 'IDR',
          recordDate: '2026-09-11T06:53:00.000Z',
          recordType: 'expense',
          note: 'Biaya admin tf',
          category: { id: 'cat-1', name: 'Charges, fees' },
        },
        {
          id: 'rec-2',
          accountId: 'acc-2',
          accountName: 'Gopay',
          amount: -20895,
          currency: 'IDR',
          recordDate: '2026-09-11T06:52:00.000Z',
          recordType: 'expense',
          note: 'Pembayaran ke Nodus Digital Store',
          category: { id: 'cat-2', name: 'Pengeluaran Digital' },
        },
        {
          id: 'rec-3',
          accountId: 'acc-3',
          accountName: 'Mandiri Debit Card',
          amount: 5729876,
          currency: 'IDR',
          recordDate: '2026-09-10T14:31:00.000Z',
          recordType: 'income',
          note: 'Pengkreditan otomatis PEMAGANGAN ANGKATAN 2 KEMENTERIAN KETENAGAKERJAAN',
          category: { id: 'cat-3', name: 'Wage, invoices' },
          labels: [{ id: 'lbl-1', name: 'salary' }],
        },
      ],
      total: 3741,
      limit: 10,
      offset: 0,
      page: 1,
      totalPages: 375,
      nextOffset: 10,
      hasMore: true,
      sort: 'newest',
    };

    it('renders clean 3-line layout without leading indentation and with bold amounts in Indonesian', () => {
      const output = formatTransactionHistoryMessage(samplePage, 'id');

      // Header structure
      expect(output).toMatch(/^📋 \*Riwayat Transaksi\*\nHal\. 1\/375 • 3 item/m);

      // Item 1
      expect(output).toMatch(/1\. Biaya admin tf\n\*-Rp1\.000\* • Cash\nCharges, fees • \d+ Sep \d\d:\d\d/m);

      // Item 2
      expect(output).toMatch(/2\. Pembayaran ke Nodus Digital Store\n\*-Rp20\.895\* • Gopay\nPengeluaran Digital • \d+ Sep \d\d:\d\d/m);

      // Item 3 (truncated title, bold amount, hashtags preserved)
      expect(output).toMatch(/3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5\.729\.876\* • Mandiri Debit Card\nWage, invoices • \d+ Sep \d\d:\d\d • #salary/m);

      // Exactly one blank line between items
      expect(output).toContain('\n\n1. Biaya admin tf');
      expect(output).toContain('\n\n2. Pembayaran ke Nodus Digital Store');
      expect(output).toContain('\n\n3. Pengkreditan otomatis');

      // Zero decorative per-item emojis
      const itemsOnly = output.split('\n\n').slice(1, -1).join('\n\n');
      expect(itemsOnly).not.toMatch(/[💸💰🔄🏷️🔖]/u);

      // Preserves canonical navigation hint
      expect(output).toContain('_Ketik *riwayat hal 2* untuk halaman selanjutnya._');
    });

    it('renders symmetrical 3-line layout in English', () => {
      const output = formatTransactionHistoryMessage(samplePage, 'en');

      expect(output).toMatch(/^📋 \*Transaction History\*\nPage 1\/375 • 3 items/m);
      expect(output).toMatch(/1\. Biaya admin tf\n\*-Rp1,000\* • Cash/m);
      expect(output).toMatch(/3\. Pengkreditan otomatis PEMAGANGAN ANGKATAN 2\.\.\.\n\*\+Rp5,729,876\* • Mandiri Debit Card/m);
      expect(output).toContain('_Type *history page 2* for the next page._');
    });
  });

  describe('Transfer Semantics Preservation', () => {
    it('clearly identifies transfer records without note or category as transfers', () => {
      const transferPage: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-transfer-1',
            accountId: 'acc-bca',
            accountName: 'BCA Utama',
            amount: -500000,
            currency: 'IDR',
            recordDate: '2026-09-11T06:50:00.000Z',
            recordType: 'expense',
            transfer: true,
            // note and category intentionally omitted
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
        page: 1,
        totalPages: 1,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
      };

      const outputId = formatTransactionHistoryMessage(transferPage, 'id');
      // Must not render as plain "Pengeluaran", must identify transfer
      expect(outputId).toMatch(/1\. Transfer \/ Top-Up/);
      expect(outputId).toMatch(/\*-Rp500\.000\* • BCA Utama/);
      expect(outputId).toMatch(/Transfer \/ Top-Up • \d+ Sep \d\d:\d\d/);
      expect(outputId).not.toContain('Pengeluaran');

      const outputEn = formatTransactionHistoryMessage(transferPage, 'en');
      expect(outputEn).toMatch(/1\. Transfer \/ Top-Up/);
      expect(outputEn).toMatch(/Transfer \/ Top-Up • Sep \d+ \d\d:\d\d/);
      expect(outputEn).not.toContain('Expense');
    });

    it('distinguishes transfer records with non-transfer notes using a transfer prefix', () => {
      const transferWithNote: TransactionHistoryPage = {
        records: [
          {
            id: 'rec-transfer-2',
            accountId: 'acc-cash',
            accountName: 'Dompet',
            amount: -100000,
            currency: 'IDR',
            recordDate: '2026-09-11T06:50:00.000Z',
            recordType: 'expense',
            transfer: true,
            note: 'Pindah ke tabungan darurat',
          },
        ],
        total: 1,
        limit: 10,
        offset: 0,
        page: 1,
        totalPages: 1,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
      };

      const output = formatTransactionHistoryMessage(transferWithNote, 'id');
      expect(output).toMatch(/1\. \[Transfer\] Pindah ke tabungan darurat/);
      expect(output).toMatch(/\*-Rp100\.000\* • Dompet/);
      expect(output).toMatch(/Transfer \/ Top-Up/);
    });
  });
});
