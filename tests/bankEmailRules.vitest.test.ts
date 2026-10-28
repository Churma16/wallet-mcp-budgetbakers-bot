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

    it('accepts a Shopee e-commerce order confirmation as MERCHANT_RECEIPT', () => {
      const result = evaluateEmail(
        'Pembayaranmu Berhasil Dikonfirmasi',
        'info@mail.shopee.co.id',
        `Hai fathanmf_, Pembayaran untuk pesanan #261015PF5NYVHP telah terkonfirmasi.
         RINCIAN PEMBAYARAN
         Metode Pembayaran: Kartu Kredit/Debit
         Tanggal Pembayaran: 15 Okt 2026 21:06:26
         Total Dibayarkan: Rp 47.664`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('shopee');
      expect(result.matchedBankRule?.ruleCategory).toBe('MERCHANT_RECEIPT');
      expect(result.candidateAmount).toBe(47664);
      expect(result.referenceNumber).toBe('261015PF5NYVHP');
    });

    it('accepts a Flip transfer receipt and extracts amount and reference ID', () => {
      const result = evaluateEmail(
        'Successful transfer to FATHAN MUHAMMAD FAQIH. Here is the receipt.',
        'no-reply@flip.id',
        `Hello, Fathan Muhammad Faqih.
         Yay, your transaction has been successfully processed. Here are the transaction details:
         Transaction ID: #ST2610011255362009CNJD
         Destination Name: FATHAN MUHAMMAD FAQIH
         Destination Bank: Bank Jago Syariah
         Amount: Rp2.000.000`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('flip');
      expect(result.candidateAmount).toBe(2000000);
      expect(result.referenceNumber).toBe('ST2610011255362009CNJD');
      expect(result.isTransferCandidate).toBe(true);
    });

    it('accepts a Grab ride e-receipt and extracts amount and booking ID', () => {
      const result = evaluateEmail(
        'Your Grab E-Receipt',
        'no-reply@grab.com',
        `Grab E-Receipt
         Booking ID: A-9UQLPJWGW8CCAV
         Layanan: GrabBike
         Total Tarif: Rp70.100`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('grab');
      expect(result.candidateAmount).toBe(70100);
      expect(result.referenceNumber).toBe('A-9UQLPJWGW8CCAV');
    });

    it('accepts a Blibli offline store QRIS receipt and extracts amount and order ID', () => {
      const result = evaluateEmail(
        'Pembayaran QRIS Anda Telah Kami Terima - Offline Store - Bakwan Sayur [1pcs]',
        'transaction@blibli.com',
        `Halo, Fathan Muhammad Faqih!
         Terima kasih telah melakukan pembayaran dengan QRIS.
         No. Pesanan: 12198693563
         Offline Store - Bakwan Sayur [1pcs] (Jumlah: 2) @ Rp 2.600
         Offline Store - NASI UDUK + TELUR (Jumlah: 1) @ Rp 11.500
         Total Pembayaran: Rp 16.700`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('blibli');
      expect(result.candidateAmount).toBe(16700);
      expect(result.referenceNumber).toBe('12198693563');
      expect(result.matchedBankRule?.ruleCategory).toBe('MERCHANT_RECEIPT');
    });

    it('accepts an Alfagift order payment receipt and extracts its facts', () => {
      const result = evaluateEmail(
        'Pembayaran Pesanan (#O-261028-AGVGLZH) Diterima',
        'noreply@alfagift.id',
        `Pembayaran pesanan O-261028-AGVGLZH sebesar Rp 26.200 sudah kami terima.
         PEMBAYARAN DITERIMA
         Hai Fathan,
         Pembayaran atas pesanan Anda sudah kami terima. Terima kasih telah berbelanja di Alfagift.
         Nomor Pesanan       O-261028-AGVGLZH
         Total Pembayaran    Rp 26.200
         Metode Pembayaran   QRIS
         Waktu Pembayaran    28 October 2026 15:19 WIB
         Nomor Referensi     T-261028-AGXYFBW
         NAMA PRODUK                                              HARGA       QTY   SUBTOTAL
         Promag Obat Maag & Kembung Mint Segar 10 Tablet Kunyah   Rp 11.600   1     Rp 11.600
         Entrostop Obat Diare 10 Tablet                           Rp 11.700   1     Rp 11.700
         Cielo Minuman Soda Rasa Leci 400 ml                      Rp 6.300    1     Rp 6.300
            Subtotal Belanja:        Rp 29.600
            Diskon:                  Rp 3.400
            Voucher:                 Rp 0
            Ongkos Kirim:            Rp 10.000 Rp 0
            Total Pembayaran:        Rp 26.200`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('alfagift');
      expect(result.candidateAmount).toBe(26200);
      expect(result.referenceNumber).toBe('O-261028-AGVGLZH');
      expect(result.matchedBankRule?.ruleCategory).toBe('MERCHANT_RECEIPT');
    });

    it('accepts a Bank Jago QRIS payment with Terminal ID and Danamon acquirer without false transfer flag', () => {
      const result = evaluateEmail(
        'You have made a payment to KOALASTORE\u200B.DIGI💸',
        'noreply@jago.com',
        `Assalamu'alaikum FATHAN MUHAMMAD FAQIH,
         Thank you for trusting Jago! You have made a payment, and here are the details:
         From: 5074****7335
         To: KOALASTORE .DIGI
         Amount: Rp 13.637
         Transaction Date: 20 October 2026, 13:34 WIB
         Transaction Status: Successful
         Acquirer Name: Bank Danamon
         Terminal ID: 452696984`
      );

      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.bankKey).toBe('jago');
      expect(result.candidateAmount).toBe(13637);
      expect(result.referenceNumber).toBe('452696984');
      // "Bank Danamon" must not falsely trigger "dana" transfer/topup keyword
      expect(result.isTransferCandidate).toBe(false);
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

    it('rejects Flip terms and conditions update emails', () => {
      const result = evaluateEmail(
        'We’re updating our Terms and Conditions',
        'hello@flip.id',
        'Please review our updated terms and conditions.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Grab promo discount emails', () => {
      const result = evaluateEmail(
        'Diskon Spesial Perjalanan GrabBike',
        'no-reply@grab.com',
        'Gunakan voucher diskon spesial ini sekarang.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Blibli flash sale promo emails', () => {
      const result = evaluateEmail(
        'Flash Sale Promo Diskon Kilat Blibli',
        'newsletter@blibli.com',
        'Dapatkan diskon heboh hingga 80% hanya hari ini.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Alfagift awaiting payment notification emails', () => {
      const result = evaluateEmail(
        'Menunggu Pembayaran QRIS Untuk Pesanan di Alfagift (#O-261028-AGVGLZH)',
        'noreply@alfagift.id',
        'Selesaikan pembayaran pesanan Anda.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Alfagift cart reminder emails', () => {
      const result = evaluateEmail(
        'Keranjang-mu sudah kami jaga, Sekarang tugas kamu yuk untuk selesain',
        'no-reply@e.alfagift.id',
        'Yuk selesaikan belanjaanmu sekarang.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Alfagift delivery completion emails', () => {
      const result = evaluateEmail(
        'Pengiriman Pesanan (# S-261026-AGFHWGT) Telah Selesai',
        'noreply@alfagift.id',
        'Pesanan Anda telah selesai dikirim oleh kurir.'
      );

      expect(result.passed).toBe(false);
      expect(result.reason).toBe('SUBJECT_BLACKLIST_KEYWORD_MATCH');
    });

    it('rejects Alfagift product recommendation and promo blast emails', () => {
      const result = evaluateEmail(
        'Alfagift punya rekomendasi produk yang cocok untuk kamu! Cek Sekarang!!',
        'no-reply@e.alfagift.id',
        'Berdasarkan produk yang pernah kamu beli, kami menemukan produk yang mungkin cocok.'
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
