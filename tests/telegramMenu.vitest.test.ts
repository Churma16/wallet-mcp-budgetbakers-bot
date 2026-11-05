import { describe, expect, it } from 'vitest';
import {
  createTelegramBackButtonInlineKeyboard,
  createTelegramGuideInlineKeyboard,
  createTelegramMainReplyKeyboard,
  getTelegramBotCommands,
  getTelegramGuideTopicContent,
} from '../src/gateway/telegramMenu.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('Telegram Menu and Keyboard Components', () => {
  describe('Bot Commands Registration', () => {
    it('returns Indonesian bot commands when language is id', () => {
      setActiveLanguage('id');
      const commands = getTelegramBotCommands('id');

      expect(commands).toEqual([
        { command: 'saldo', description: 'Cek saldo seluruh rekening' },
        { command: 'budget', description: 'Cek limit dan sisa anggaran' },
        { command: 'riwayat', description: 'Cek transaksi terakhir' },
        { command: 'rekap', description: 'Cek ringkasan pengeluaran bulan ini' },
        { command: 'menu', description: 'Buka menu utama dan panduan' },
        { command: 'settings', description: 'Buka menu pengaturan bot' },
        { command: 'rescan', description: 'Tarik ulang & selaraskan email & notifikasi (misal: /rescan 60)' },
      ]);
    });

    it('returns English bot commands when language is en', () => {
      const commands = getTelegramBotCommands('en');

      expect(commands).toEqual([
        { command: 'saldo', description: 'Check all account balances' },
        { command: 'budget', description: 'Check budget limits and remaining balance' },
        { command: 'riwayat', description: 'Check recent transaction history' },
        { command: 'rekap', description: 'Check this month expense summary' },
        { command: 'menu', description: 'Open main menu and guide' },
        { command: 'settings', description: 'Open bot settings menu' },
        { command: 'rescan', description: 'Rescan and reconcile inbound emails & notifications (e.g. /rescan 60)' },
      ]);
    });
  });

  describe('Main Reply Keyboard Creation', () => {
    it('creates persistent, resized 4-button keyboard in Indonesian', () => {
      const keyboard = createTelegramMainReplyKeyboard('id');

      expect(keyboard.is_persistent).toBe(true);
      expect(keyboard.resize_keyboard).toBe(true);
      expect(keyboard.keyboard.length).toBe(2);

      // Row 1: Saldo & Budget
      expect(keyboard.keyboard[0][0].text).toContain('Cek Saldo');
      expect(keyboard.keyboard[0][1].text).toContain('Cek Budget');

      // Row 2: Riwayat & Panduan
      expect(keyboard.keyboard[1][0].text).toContain('Riwayat');
      expect(keyboard.keyboard[1][1].text).toContain('Panduan');
    });

    it('creates persistent, resized 4-button keyboard in English', () => {
      const keyboard = createTelegramMainReplyKeyboard('en');

      expect(keyboard.is_persistent).toBe(true);
      expect(keyboard.resize_keyboard).toBe(true);
      expect(keyboard.keyboard.length).toBe(2);

      expect(keyboard.keyboard[0][0].text).toContain('Check Balance');
      expect(keyboard.keyboard[0][1].text).toContain('Check Budget');
      expect(keyboard.keyboard[1][0].text).toContain('History');
      expect(keyboard.keyboard[1][1].text).toContain('Guide');
    });
  });

  describe('Interactive Guide Inline Keyboard Creation', () => {
    it('creates 6-topic inline keyboard with exact callback_data mappings', () => {
      const inlineKeyboard = createTelegramGuideInlineKeyboard('id');
      const payload = inlineKeyboard.inline_keyboard;

      expect(payload.length).toBe(3);

      // Row 1: Catat & Transfer
      expect(payload[0][0].callback_data).toBe('guide:record');
      expect(payload[0][1].callback_data).toBe('guide:transfer');

      // Row 2: Edit & Hapus & Foto Struk
      expect(payload[1][0].callback_data).toBe('guide:edit_delete');
      expect(payload[1][1].callback_data).toBe('guide:receipt');

      // Row 3: Rekap & Filter & Perintah Cepat
      expect(payload[2][0].callback_data).toBe('guide:summary_filter');
      expect(payload[2][1].callback_data).toBe('guide:fast_commands');
    });

    it('creates back button inline keyboard pointing to guide:home', () => {
      const backKeyboard = createTelegramBackButtonInlineKeyboard('id');
      const payload = backKeyboard.inline_keyboard;

      expect(payload.length).toBe(1);
      expect(payload[0][0].callback_data).toBe('guide:home');
    });
  });

  describe('Guide Topic Content Resolution', () => {
    it.each([
      ['home', 'Panduan Penggunaan Wallet Bot'],
      ['record', 'Catat Pengeluaran &amp; Pemasukan'],
      ['transfer', 'Catat Transfer Antar Rekening'],
      ['edit_delete', 'Edit &amp; Hapus Transaksi (Via Reply)'],
      ['receipt', 'Kirim Foto Struk Belanja (Vision)'],
      ['summary_filter', 'Rekap &amp; Filter Riwayat'],
      ['fast_commands', 'Perintah Cepat'],
    ])('resolves valid Indonesian content for topic "%s"', (topic, expectedKeyword) => {
      const content = getTelegramGuideTopicContent(topic, 'id');
      expect(content).not.toBeNull();
      expect(content!.text).toContain(expectedKeyword);
      expect(content!.replyMarkup).toBeDefined();
    });

    it.each([
      ['home', 'Wallet Bot User Guide'],
      ['record', 'Record Expenses &amp; Income'],
      ['transfer', 'Record Inter-Account Transfers'],
      ['edit_delete', 'Edit &amp; Delete Transactions (Via Reply)'],
      ['receipt', 'Send Receipt Photo (Vision)'],
      ['summary_filter', 'Summary &amp; History Queries'],
      ['fast_commands', 'Quick Commands'],
    ])('resolves valid English content for topic "%s"', (topic, expectedKeyword) => {
      const content = getTelegramGuideTopicContent(topic, 'en');
      expect(content).not.toBeNull();
      expect(content!.text).toContain(expectedKeyword);
      expect(content!.replyMarkup).toBeDefined();
    });

    it('returns null for unknown guide topics', () => {
      expect(getTelegramGuideTopicContent('non_existent_topic')).toBeNull();
      expect(getTelegramGuideTopicContent('')).toBeNull();
    });
  });
});
