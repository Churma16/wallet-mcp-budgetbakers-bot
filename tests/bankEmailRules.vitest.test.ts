import { describe, expect, it } from 'vitest';
import {
  evaluateEmailThroughGateOne,
  parseCurrencyAmountStringToNumber,
} from '../src/utils/emailGateEvaluator.js';
import { detectPendingConfirmationAction } from '../src/utils/fastPathIntentDetector.js';

const NOW = new Date('2026-09-13T06:00:00.000Z');
const STARTUP_CUTOFF = new Date(NOW.getTime() - 10 * 60 * 1000);

function evaluateEmail(
  subject: string,
  sender: string,
  body: string,
  receivedAt = NOW,
  processedReferences = new Set<string>()
) {
  return evaluateEmailThroughGateOne(
    subject,
    sender,
    body,
    receivedAt,
    STARTUP_CUTOFF,
    processedReferences
  );
}

describe('bank email Gate 1 rules', () => {
  describe('currency parsing', () => {
    it.each([
      ['45.000', 45000],
      ['45.000,00', 45000],
      ['1.500.000', 1500000],
      ['Rp 120.500', 120500],
      ['25,000.00', 25000],
      ['45,000', 45000],
      ['45000', 45000],
      ['', 0],
      ['invalid', 0],
    ])('parses %j as %s', (input, expectedAmount) => {
      expect(parseCurrencyAmountStringToNumber(input)).toBe(expectedAmount);
    });
  });

  describe('real-world bank and e-wallet rules', () => {
    it('accepts a Mandiri QRIS debit notification and extracts its facts', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'noreply@bankmandiri.co.id',
        `Yth. Nasabah, transaksi berhasil pada 06 Sep 2026.
         Nomor Rekening: 1234567890
         Nomor Referensi: MANDIRI98765432
         Total Debet: Rp 45.000,00
         Keterangan: QRIS Kopi Kenangan`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('mandiri');
      expect(result.candidateAmount).toBe(45000);
      expect(result.referenceNumber).toBe('MANDIRI98765432');
    });

    it('accepts a Bank Jago outgoing-money notification and extracts its facts', () => {
      const result = evaluateEmail(
        'Uang keluar dari Kantong Utama',
        'noreply@jago.com',
        `Hai, uang sebesar Rp 150.000 telah keluar dari Kantong Utama kamu.
         Penerima: Indomaret Point
         ID Transaksi: JAGO112233
         Waktu: 06 Sep 2026`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('jago');
      expect(result.candidateAmount).toBe(150000);
      expect(result.referenceNumber).toBe('JAGO112233');
    });

    it('accepts a Bank Jago English merchant payment notification', () => {
      const result = evaluateEmail(
        'You have made a payment to Kantin Euis',
        'noreply@jago.com',
        `Thank you for trusting Jago! You have made a payment, and here are the details:
         From 507431877335
         To Kantin Euis 9360000801144353984
         Amount Rp 10.000
         Transaction Date 08 September 2026, 11:54 WIB
         Transaction Status Successful
         Acquirer Name Bank Mandiri`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('jago');
      expect(result.candidateAmount).toBe(10000);
    });

    it('accepts a Bank Jago English debit-card transaction notification', () => {
      const result = evaluateEmail(
        'You have made a transaction using your debit card',
        'noreply@jago.com',
        `Assalamu'alaikum John Doe,
         You have recently made a transaction of Rp38.889 using your Jago debit card.
         You can view the transaction history in your Pocket Details inside the Jago app.`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('jago');
      expect(result.candidateAmount).toBe(38889);
    });

    it('accepts a GoPay receipt and extracts the order reference', () => {
      const result = evaluateEmail(
        'Bukti Pembayaran Pesanan GoFood kamu',
        'receipt@gojek.com',
        `Terima kasih sudah memesan GoFood!
         No. Pesanan: RB-99887766
         Total Pembayaran: Rp 65.500
         Metode: GoPay`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('gopay');
      expect(result.candidateAmount).toBe(65500);
      expect(result.referenceNumber).toBe('RB-99887766');
    });

    it('accepts an OVO transaction notification', () => {
      const result = evaluateEmail(
        'Rincian Transaksi OVO Cash Berhasil',
        'no-reply@ovo.id',
        `Pembayaran OVO berhasil dilakukan.
         Nominal: Rp 28.000
         Merchant: Parkir Mall
         No. Referensi: OVO554433`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('ovo');
      expect(result.candidateAmount).toBe(28000);
    });

    it('accepts a DANA payment notification', () => {
      const result = evaluateEmail(
        'Pembayaran Berhasil di DANA',
        'notification@dana.id',
        `Transaksi kamu sebesar Rp 80.000 berhasil diproses.
         Merchant: Pulsa Telkomsel
         ID Pesanan: DANA778899`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('dana');
      expect(result.candidateAmount).toBe(80000);
    });

    it('accepts a ShopeePay payment notification', () => {
      const result = evaluateEmail(
        'Rincian Pesanan Shopee & Pembayaran Berhasil',
        'no-reply@shopeepay.co.id',
        `Pembayaran berhasil dengan ShopeePay.
         Total Pesanan: Rp 125.000
         ID Pesanan: 260906SP123456`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('shopeepay');
      expect(result.candidateAmount).toBe(125000);
    });
  });

  describe('security, blacklist, and edge-case filtering', () => {
    it('rejects OTP subjects', () => {
      const result = evaluateEmail(
        'Kode OTP Verifikasi Login Mandiri',
        'noreply@bankmandiri.co.id',
        'Jangan berikan kode OTP 123456 kepada siapa pun.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects promo subjects', () => {
      const result = evaluateEmail(
        'Promo Diskon Spesial ShopeePay 50%',
        'no-reply@shopeepay.co.id',
        'Dapatkan cashback koin hingga 50rb hanya hari ini!'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects unknown sender domains', () => {
      const result = evaluateEmail(
        'Notifikasi Pembayaran Tagihan',
        'billing@random-service.xyz',
        'Tagihan Anda sebesar Rp 50.000 telah terbit.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNMATCHED_SENDER_DOMAIN');
    });

    it('rejects email received before the startup cutoff', () => {
      const pastDate = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
      const result = evaluateEmail(
        'Notifikasi Transaksi Debit Rekening',
        'noreply@bankmandiri.co.id',
        'Total Debet: Rp 50.000',
        pastDate
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('EMAIL_BEFORE_STARTUP_CUTOFF');
    });

    it('rejects a duplicate transaction reference', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'noreply@bankmandiri.co.id',
        'Nomor Referensi: MANDIRI98765432 Total Debet: Rp 45.000',
        NOW,
        new Set(['MANDIRI98765432'])
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('DUPLICATE_TRANSACTION_REFERENCE_NUMBER');
    });

    it('rejects Bank Jago card processing notifications', () => {
      const result = evaluateEmail(
        'Your new Jago debit card is being process',
        'noreply@jago.com',
        'Your card request has been received and is being processed.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Bank Jago card marketing notifications', () => {
      const result = evaluateEmail(
        'Your Jago Syariah Card is getting a fresh new look!',
        'noreply@jago.com',
        'We have updated the design of our cards.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects an attacker-controlled parent domain containing an allowlisted domain', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'alert@bankmandiri.co.id.attacker-domain.com',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNMATCHED_SENDER_DOMAIN');
    });

    it('rejects an allowlisted domain appearing only in the local part', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'bankmandiri.co.id@attacker-domain.com',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNMATCHED_SENDER_DOMAIN');
    });

    it('rejects an allowlisted domain appearing only in the display name', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'bankmandiri.co.id Security <alert@attacker-domain.com>',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNMATCHED_SENDER_DOMAIN');
    });

    it('accepts a legitimate display-name wrapped bank sender', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'Livin by Mandiri <noreply@bankmandiri.co.id>',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(true);
    });

    it('accepts a legitimate allowlisted subdomain', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'alert@notify.bankmandiri.co.id',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(true);
    });

    it('rejects malformed sender addresses', () => {
      const result = evaluateEmail(
        'Notifikasi Transaksi Livin by Mandiri: Debit Rekening',
        'noreply@@bankmandiri.co.id',
        'Total Debet: Rp 50.000'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNMATCHED_SENDER_DOMAIN');
    });
  });

  describe('pending confirmation intent detection', () => {
    it.each([
      ['Ya', { actionType: 'CONFIRM', targetScope: 'LATEST' }],
      ['catat #2', { actionType: 'CONFIRM', targetScope: 2 }],
      ['ya semua', { actionType: 'CONFIRM', targetScope: 'ALL' }],
      ['Batal', { actionType: 'REJECT', targetScope: 'LATEST' }],
      ['batal 1', { actionType: 'REJECT', targetScope: 1 }],
      ['abaikan semua', { actionType: 'REJECT', targetScope: 'ALL' }],
    ] as const)('maps %j to the expected pending action', (input, expectedAction) => {
      expect(detectPendingConfirmationAction(input)).toEqual(expectedAction);
    });

    it('does not intercept a normal expense message as confirmation intent', () => {
      expect(detectPendingConfirmationAction('makan siang 35rb bca')).toBeNull();
    });
  });
});
