import { describe, expect, it } from 'vitest';
import {
  evaluateNotificationThroughGate,
  extractAmountFromText,
} from '../src/config/notificationRules.js';

describe('notificationRules', () => {
  describe('extractAmountFromText', () => {
    it('extracts amount from standard Indonesian currency formats', () => {
      expect(extractAmountFromText('Pembayaran sebesar Rp 15.000 berhasil')).toBe(15000);
      expect(extractAmountFromText('Transaksi Rp15.799 di Indomaret')).toBe(15799);
      expect(extractAmountFromText('Total: Rp 1.250.000 telah didebet')).toBe(1250000);
      expect(extractAmountFromText('IDR 50.000,00 transferred')).toBe(50000);
    });

    it('returns undefined when no amount pattern is found', () => {
      expect(extractAmountFromText('Selamat datang di aplikasi kami')).toBeUndefined();
    });
  });

  describe('evaluateNotificationThroughGate', () => {
    it('rejects empty payloads', () => {
      const result = evaluateNotificationThroughGate({
        packageName: '',
        title: '',
        text: '',
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('EMPTY_NOTIFICATION_PAYLOAD');
    });

    it('rejects blacklisted keywords like OTP and promo', () => {
      const resultOtp = evaluateNotificationThroughGate({
        packageName: 'com.jago.digitalbanking',
        title: 'Kode OTP Rahasia',
        text: 'Jangan bagikan kode verifikasi 123456 kepada siapapun',
      });
      expect(resultOtp.passed).toBe(false);
      expect(resultOtp.reason).toContain('BLACKLISTED_KEYWORD');

      const resultPromo = evaluateNotificationThroughGate({
        packageName: 'com.gojek.app',
        title: 'Promo Spesial Weekend!',
        text: 'Dapatkan diskon hingga 50% di resto favoritmu',
      });
      expect(resultPromo.passed).toBe(false);
      expect(resultPromo.reason).toContain('BLACKLISTED_KEYWORD');
    });

    it('accepts and correctly maps Bank Jago notification', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.jago.digitalbanking',
        title: 'Transaksi Berhasil',
        text: 'Pembayaran Rp 15.799 menggunakan Kartu Debit Jago di Tabucci Snack berhasil',
        timestamp: 1730335000000,
      });
      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.displayName).toBe('Bank Jago');
      expect(result.candidateAmount).toBe(15799);
      expect(result.originalDate?.getTime()).toBe(1730335000000);
    });

    it('accepts and correctly maps BCA notification', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.bca',
        title: 'm-BCA: Transaksi Berhasil',
        text: 'Debit rekening 123456 sebesar Rp 50.000 untuk QRIS Kopi Kenangan',
      });
      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.displayName).toBe('BCA');
      expect(result.candidateAmount).toBe(50000);
    });

    it('accepts and correctly maps Toco push notification', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'id.toco',
        title: 'Pesanan Berhasil',
        text: 'Pembayaran sebesar Rp 150.000 telah berhasil diterima',
      });
      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.displayName).toBe('Toco');
      expect(result.candidateAmount).toBe(150000);
    });

    it('accepts and correctly maps TikTok Shop notification', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.zhiliaoapp.musically',
        title: 'Pesanan Berhasil',
        text: 'Pembayaran pesanan Rp 89.000 di TikTok Shop telah dikonfirmasi',
      });
      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.displayName).toBe('TikTok Shop');
      expect(result.candidateAmount).toBe(89000);
    });

    it('accepts and correctly maps Bank Jago digitalBanking package and lowercase variant', () => {
      const resultPascalCase = evaluateNotificationThroughGate({
        packageName: 'com.jago.digitalBanking',
        title: 'Transaksi Berhasil',
        text: 'Pembayaran Rp 15.799 menggunakan Kartu Debit Jago berhasil',
      });
      expect(resultPascalCase.passed).toBe(true);
      expect(resultPascalCase.matchedBankRule?.displayName).toBe('Bank Jago');
      expect(resultPascalCase.candidateAmount).toBe(15799);

      const resultLowercase = evaluateNotificationThroughGate({
        packageName: 'com.jago.digitalbanking',
        title: 'Transaksi Berhasil',
        text: 'Pembayaran Rp 15.799 menggunakan Kartu Debit Jago berhasil',
      });
      expect(resultLowercase.passed).toBe(true);
      expect(resultLowercase.matchedBankRule?.displayName).toBe('Bank Jago');
      expect(resultLowercase.candidateAmount).toBe(15799);
    });

    it('accepts and correctly maps verified package IDs for Mandiri, myBCA, wondr, Jenius, Flip, and ShopeePay', () => {
      const packageTestCases = [
        { packageName: 'id.bmri.livin', title: 'Transaksi Sukses', text: 'Transfer Rp 100.000 berhasil', expectedBank: 'Bank Mandiri (Livin)', expectedAmount: 100000 },
        { packageName: 'id.co.bankmandiri', title: 'Transaksi Sukses', text: 'Debit rekening Rp 200.000', expectedBank: 'Bank Mandiri (Livin)', expectedAmount: 200000 },
        { packageName: 'com.bca.mybca.omni.android', title: 'myBCA Transaksi', text: 'Pembayaran QRIS Rp 45.000 berhasil', expectedBank: 'BCA', expectedAmount: 45000 },
        { packageName: 'id.bni.wondr', title: 'wondr by BNI', text: 'Transfer dana Rp 350.000 berhasil', expectedBank: 'wondr by BNI', expectedAmount: 350000 },
        { packageName: 'id.co.bni.tapcashgo', title: 'TapCash Update', text: 'Top up saldo Rp 50.000 berhasil', expectedBank: 'BNI TapCash Go', expectedAmount: 50000 },
        { packageName: 'com.btpn.jenius.dc', title: 'Uang Keluar', text: 'Pembayaran Rp 75.000 di merchant berhasil', expectedBank: 'Jenius', expectedAmount: 75000 },
        { packageName: 'id.flip', title: 'Flip Transaksi Berhasil', text: 'Transfer Rp 150.000 telah terkirim', expectedBank: 'Flip', expectedAmount: 150000 },
        { packageName: 'com.shopeepay.id', title: 'ShopeePay Berhasil', text: 'Pembayaran Rp 30.000 di toko offline', expectedBank: 'ShopeePay', expectedAmount: 30000 },
      ];

      for (const testCase of packageTestCases) {
        const evaluation = evaluateNotificationThroughGate({
          packageName: testCase.packageName,
          title: testCase.title,
          text: testCase.text,
        });
        expect(evaluation.passed).toBe(true);
        expect(evaluation.matchedBankRule?.displayName).toBe(testCase.expectedBank);
        expect(evaluation.candidateAmount).toBe(testCase.expectedAmount);
      }
    });

    it('accepts and correctly maps Tokopedia payment notification', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.tokopedia.tkpd',
        title: 'Pembayaran Berhasil',
        text: 'Pembayaran untuk pesanan batagor sebesar Rp 50.000 telah diverifikasi',
      });
      expect(result.passed).toBe(true);
      expect(result.matchedBankRule?.displayName).toBe('Tokopedia');
      expect(result.candidateAmount).toBe(50000);
    });

    it('rejects shipping status and chatter from recognized apps with NO_FINANCIAL_OR_TRANSACTION_INDICATOR', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.tokopedia.tkpd',
        title: 'Pesanan Sedang Dikirim',
        text: 'Kurir Anteraja sedang menuju ke alamat pengiriman Anda',
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('NO_FINANCIAL_OR_TRANSACTION_INDICATOR');
    });

    it('rejects unrecognized non-financial apps without transaction keywords', () => {
      const result = evaluateNotificationThroughGate({
        packageName: 'com.spotify.music',
        title: 'Now Playing',
        text: 'Song title by Artist',
      });
      expect(result.passed).toBe(false);
      expect(result.reason).toBe('UNRECOGNIZED_NON_FINANCIAL_PACKAGE');
    });
  });
});
