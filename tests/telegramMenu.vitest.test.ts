import { describe, expect, it } from 'vitest';
import {
  createTelegramBackButtonInlineKeyboard,
  createTelegramGuideInlineKeyboard,
  createTelegramMainReplyKeyboard,
  createTelegramRescanInlineKeyboard,
  getTelegramBotCommands,
  getTelegramGuideTopicContent,
} from '../src/gateway/telegramMenu.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('Telegram Menu and Keyboard Components', () => {
  describe('Bot Commands Registration', () => {
    it('returns Indonesian bot commands in usage-frequency order when language is id', () => {
      setActiveLanguage('id');
      const commands = getTelegramBotCommands('id');

      expect(commands).toEqual([
        { command: 'saldo', description: 'Saldo semua rekening' },
        { command: 'rekap', description: 'Ringkasan masuk & keluar' },
        { command: 'riwayat', description: 'Transaksi terbaru (mis. /riwayat 10)' },
        { command: 'budget', description: 'Sisa limit anggaran' },
        { command: 'antrean', description: 'Transaksi menunggu konfirmasi' },
        { command: 'rescan', description: 'Scan ulang email & notif tertinggal' },
        { command: 'reconciliation', description: 'Cocokkan transaksi vs foto mutasi' },
        { command: 'menu', description: 'Tampilkan tombol cepat & panduan' },
        { command: 'settings', description: 'Pengaturan bahasa, AI, & sistem' },
      ]);
    });

    it('returns English bot commands in usage-frequency order when language is en', () => {
      const commands = getTelegramBotCommands('en');

      expect(commands).toEqual([
        { command: 'saldo', description: 'All account balances' },
        { command: 'rekap', description: 'Income & expense summary' },
        { command: 'riwayat', description: 'Recent transactions (e.g. /riwayat 10)' },
        { command: 'budget', description: 'Remaining budget limits' },
        { command: 'antrean', description: 'Transactions awaiting confirmation' },
        { command: 'rescan', description: 'Rescan missed emails & notifs' },
        { command: 'reconciliation', description: 'Match transactions vs bank statement' },
        { command: 'menu', description: 'Show quick keyboard & guide' },
        { command: 'settings', description: 'Bot language, AI & system settings' },
      ]);
    });
  });

  describe('Main Reply Keyboard Creation', () => {
    it('creates persistent, resized 6-button (3x2) keyboard in Indonesian', () => {
      const keyboard = createTelegramMainReplyKeyboard('id');

      expect(keyboard.is_persistent).toBe(true);
      expect(keyboard.resize_keyboard).toBe(true);
      expect(keyboard.keyboard.length).toBe(3);

      // Row 1: Saldo & Rekap
      expect(keyboard.keyboard[0][0].text).toContain('Saldo');
      expect(keyboard.keyboard[0][1].text).toContain('Rekap');

      // Row 2: Budget & Riwayat
      expect(keyboard.keyboard[1][0].text).toContain('Budget');
      expect(keyboard.keyboard[1][1].text).toContain('Riwayat');

      // Row 3: Antrean & Panduan
      expect(keyboard.keyboard[2][0].text).toContain('Antrean');
      expect(keyboard.keyboard[2][1].text).toContain('Panduan');
    });

    it('creates persistent, resized 6-button (3x2) keyboard in English', () => {
      const keyboard = createTelegramMainReplyKeyboard('en');

      expect(keyboard.is_persistent).toBe(true);
      expect(keyboard.resize_keyboard).toBe(true);
      expect(keyboard.keyboard.length).toBe(3);

      expect(keyboard.keyboard[0][0].text).toContain('Balance');
      expect(keyboard.keyboard[0][1].text).toContain('Summary');
      expect(keyboard.keyboard[1][0].text).toContain('Budget');
      expect(keyboard.keyboard[1][1].text).toContain('History');
      expect(keyboard.keyboard[2][0].text).toContain('Queue');
      expect(keyboard.keyboard[2][1].text).toContain('Guide');
    });
  });

  describe('Interactive Guide Inline Keyboard Creation', () => {
    it('creates 6-topic inline keyboard ordered by user workflow', () => {
      const inlineKeyboard = createTelegramGuideInlineKeyboard('id');
      const payload = inlineKeyboard.inline_keyboard;

      expect(payload.length).toBe(3);

      // Row 1: Record Text & Scan Receipt
      expect(payload[0][0].callback_data).toBe('guide:record');
      expect(payload[0][1].callback_data).toBe('guide:receipt');

      // Row 2: Transfer & Edit/Delete
      expect(payload[1][0].callback_data).toBe('guide:transfer');
      expect(payload[1][1].callback_data).toBe('guide:edit_delete');

      // Row 3: Summary/Filter & Command List
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

  describe('Rescan Inline Keyboard Creation', () => {
    it('creates a 2-column inline keyboard with 5 duration options in Indonesian', () => {
      const keyboard = createTelegramRescanInlineKeyboard('id');
      const rows = keyboard.inline_keyboard;

      expect(rows.length).toBe(3);

      // Row 1: 1 Jam & 3 Jam
      expect(rows[0].length).toBe(2);
      expect(rows[0][0].text).toBe('1 Jam');
      expect(rows[0][0].callback_data).toBe('rescan:60');
      expect(rows[0][1].text).toBe('3 Jam');
      expect(rows[0][1].callback_data).toBe('rescan:180');

      // Row 2: 6 Jam & 12 Jam
      expect(rows[1].length).toBe(2);
      expect(rows[1][0].text).toBe('6 Jam');
      expect(rows[1][0].callback_data).toBe('rescan:360');
      expect(rows[1][1].text).toBe('12 Jam');
      expect(rows[1][1].callback_data).toBe('rescan:720');

      // Row 3: 24 Jam
      expect(rows[2].length).toBe(1);
      expect(rows[2][0].text).toBe('24 Jam');
      expect(rows[2][0].callback_data).toBe('rescan:1440');
    });

    it('creates a 2-column inline keyboard with 5 duration options in English', () => {
      const keyboard = createTelegramRescanInlineKeyboard('en');
      const rows = keyboard.inline_keyboard;

      expect(rows.length).toBe(3);

      // Row 1: 1 Hour & 3 Hours
      expect(rows[0].length).toBe(2);
      expect(rows[0][0].text).toBe('1 Hour');
      expect(rows[0][0].callback_data).toBe('rescan:60');
      expect(rows[0][1].text).toBe('3 Hours');
      expect(rows[0][1].callback_data).toBe('rescan:180');

      // Row 2: 6 Hours & 12 Hours
      expect(rows[1].length).toBe(2);
      expect(rows[1][0].text).toBe('6 Hours');
      expect(rows[1][0].callback_data).toBe('rescan:360');
      expect(rows[1][1].text).toBe('12 Hours');
      expect(rows[1][1].callback_data).toBe('rescan:720');

      // Row 3: 24 Hours
      expect(rows[2].length).toBe(1);
      expect(rows[2][0].text).toBe('24 Hours');
      expect(rows[2][0].callback_data).toBe('rescan:1440');
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
      ['fast_commands', 'Daftar Command &amp; Shortcut'],
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
      ['fast_commands', 'Command List &amp; Shortcuts'],
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
