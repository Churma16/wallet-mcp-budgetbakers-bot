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
        packageName: 'com.jago',
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
        packageName: 'com.jago',
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
