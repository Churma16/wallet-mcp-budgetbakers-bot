import { describe, expect, it } from 'vitest';
import {
  detectFastPathAction,
  normalizeFastPathInput,
} from '../src/brain/fastpath/fastPath.js';
import { FINANCIAL_ACTION_TYPES } from '../src/brain/constants.js';

describe('Fast-Path Deterministic Command & Button Resolution', () => {
  describe('Input Normalization', () => {
    it('strips leading slash and exclamation marks', () => {
      expect(normalizeFastPathInput('/saldo')).toBe('saldo');
      expect(normalizeFastPathInput('!budget')).toBe('budget');
      expect(normalizeFastPathInput('/start')).toBe('start');
    });

    it('strips leading emojis and UI symbols from button texts', () => {
      expect(normalizeFastPathInput('\u{1F4B0} Cek Saldo')).toBe('Cek Saldo');
      expect(normalizeFastPathInput('\u{1F4CA} Cek Budget')).toBe('Cek Budget');
      expect(normalizeFastPathInput('\u{1F4DC} Riwayat')).toBe('Riwayat');
      expect(normalizeFastPathInput('\u{2753} Panduan')).toBe('Panduan');
    });

    it('handles empty and whitespace-only inputs gracefully', () => {
      expect(normalizeFastPathInput('')).toBe('');
      expect(normalizeFastPathInput('   ')).toBe('');
    });
  });

  describe('O(1) Slash Commands Resolution', () => {
    it('resolves balance check for /saldo and /balance including @botname suffix', () => {
      expect(detectFastPathAction('/saldo')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
      expect(detectFastPathAction('/saldo@my_wallet_bot')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
      expect(detectFastPathAction('/balance')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
      expect(detectFastPathAction('/SALDO')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
    });

    it('resolves budget check for /budget and /anggaran', () => {
      expect(detectFastPathAction('/budget')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BUDGET);
      expect(detectFastPathAction('/anggaran')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BUDGET);
      expect(detectFastPathAction('/BUDGET')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BUDGET);
    });

    it('resolves transaction history for /riwayat and /history with optional limit parameter', () => {
      expect(detectFastPathAction('/riwayat')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest' },
      });
      expect(detectFastPathAction('/history')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest' },
      });
      expect(detectFastPathAction('/riwayat 10')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest', limit: 10 },
      });
      expect(detectFastPathAction('/history 5')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest', limit: 5 },
      });
    });

    it('resolves transaction summary for /rekap and /summary', () => {
      const rekapAction = detectFastPathAction('/rekap');
      expect(rekapAction).not.toBeNull();
      expect(typeof rekapAction === 'object' && rekapAction !== null && 'type' in rekapAction && rekapAction.type).toBe(
        FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY
      );

      const summaryAction = detectFastPathAction('/summary');
      expect(summaryAction).not.toBeNull();
      expect(typeof summaryAction === 'object' && summaryAction !== null && 'type' in summaryAction && summaryAction.type).toBe(
        FINANCIAL_ACTION_TYPES.TRANSACTION_SUMMARY
      );
    });

    it('resolves help menu for /menu, /start, /help, /panduan, and /guide', () => {
      expect(detectFastPathAction('/menu')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
      expect(detectFastPathAction('/start')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
      expect(detectFastPathAction('/help')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
      expect(detectFastPathAction('/panduan')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
      expect(detectFastPathAction('/guide')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
    });

    it('resolves queue check for /queue, /antrean, /antrian, and /pending', () => {
      expect(detectFastPathAction('/queue')).toBe(FINANCIAL_ACTION_TYPES.CHECK_QUEUE);
      expect(detectFastPathAction('/antrean')).toBe(FINANCIAL_ACTION_TYPES.CHECK_QUEUE);
      expect(detectFastPathAction('/antrian')).toBe(FINANCIAL_ACTION_TYPES.CHECK_QUEUE);
      expect(detectFastPathAction('/pending')).toBe(FINANCIAL_ACTION_TYPES.CHECK_QUEUE);
    });
  });

  describe('O(1) Button Label Exact Matches', () => {
    it('resolves exact Indonesian reply keyboard buttons', () => {
      expect(detectFastPathAction('\u{1F4B0} Cek Saldo')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
      expect(detectFastPathAction('\u{1F4CA} Cek Budget')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BUDGET);
      expect(detectFastPathAction('\u{1F4DC} Riwayat')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest' },
      });
      expect(detectFastPathAction('\u{2753} Panduan')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
    });

    it('resolves exact English reply keyboard buttons', () => {
      expect(detectFastPathAction('\u{1F4B0} Check Balance')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BALANCE);
      expect(detectFastPathAction('\u{1F4CA} Check Budget')).toBe(FINANCIAL_ACTION_TYPES.CHECK_BUDGET);
      expect(detectFastPathAction('\u{1F4DC} History')).toEqual({
        type: FINANCIAL_ACTION_TYPES.TRANSACTION_HISTORY,
        options: { sort: 'newest' },
      });
      expect(detectFastPathAction('\u{2753} Guide')).toBe(FINANCIAL_ACTION_TYPES.HELP_MENU);
    });
  });

  describe('Natural Language vs Financial Record Disambiguation', () => {
    it('returns null for actual expense recording messages to defer to AI brain', () => {
      expect(detectFastPathAction('Makan siang 35k BCA')).toBeNull();
      expect(detectFastPathAction('Beli bensin 50rb Cash')).toBeNull();
      expect(detectFastPathAction('Gaji masuk 10jt ke Mandiri')).toBeNull();
      expect(detectFastPathAction('Transfer 200rb BCA ke Gopay')).toBeNull();
    });
  });
});
