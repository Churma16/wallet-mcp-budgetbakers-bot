import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTelegramSettingsMenuContent,
  createSettingsMainInlineKeyboard,
  createCategoryInlineKeyboard,
  createAiModelInlineKeyboard,
  createLanguageInlineKeyboard,
  createCurrencyInlineKeyboard,
  createAdvancedInlineKeyboard,
  createTimezoneInlineKeyboard,
  createAiTimeoutInlineKeyboard,
  createEmailLookbackInlineKeyboard,
  createQueueIntervalInlineKeyboard,
  createLogRetentionInlineKeyboard,
  createResetConfirmInlineKeyboard,
} from '../src/gateway/telegramSettingsMenu.js';
import { RuntimeSettingsManager } from '../src/config/runtimeSettingsManager.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { setActiveLanguage } from '../src/i18n/index.js';

describe('Telegram Settings Menu and Callback Gateway Integration', () => {
  let tempDirectory: string;
  let testSettingsFilePath: string;
  let settingsManager: RuntimeSettingsManager;
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const allowedUserId = '123456789';

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-mcp-settings-menu-test-'));
    testSettingsFilePath = path.join(tempDirectory, 'app-settings.json');
    RuntimeSettingsManager.resetInstance();
    settingsManager = new RuntimeSettingsManager(testSettingsFilePath);
    setActiveLanguage('id');
  });

  afterEach(() => {
    RuntimeSettingsManager.resetInstance();
    try {
      if (fs.existsSync(tempDirectory)) {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup
    }
  });

  describe('Menu Content and One-Line Function Overview Resolution', () => {
    it('renders Main Hub (home) with active status summary and main categories', () => {
      const content = getTelegramSettingsMenuContent('home', 'id', settingsManager);

      expect(content.text).toContain('Pengaturan Bot');
      expect(content.text).toContain('Status Konfigurasi Aktif:');
      expect(content.text).toContain('Mode Kategori:');
      expect(content.text).toContain('Model AI:');
      expect(content.text).toContain('Bahasa Respon:');
      expect(content.text).toContain('Mata Uang Default:');
      expect(content.text).toContain('Zona Waktu:');
      expect(content.text).toContain('AI Timeout:');
      expect(content.text).toContain('Antrean Pesan:');
      expect(content.text).toContain('Retensi Log:');
      expect(content.text).toContain('Debug Logging:');

      const markup = content.replyMarkup.inline_keyboard;
      expect(markup.length).toBe(5);
      expect(markup[0][0].callback_data).toBe('settings:page:category');
      expect(markup[0][1].callback_data).toBe('settings:page:ai_model');
      expect(markup[1][0].callback_data).toBe('settings:page:language');
      expect(markup[1][1].callback_data).toBe('settings:page:currency');
      expect(markup[2][0].callback_data).toBe('settings:page:advanced');
      expect(markup[3][0].callback_data).toBe('settings:toggle:debug');
      expect(markup[4][0].callback_data).toBe('settings:action:close');
    });

    it('renders Category sub-menu with one-line function overview and checkmark on active option', () => {
      const content = getTelegramSettingsMenuContent('category', 'id', settingsManager);

      expect(content.text).toContain('[INFO] Fungsi: Menentukan apakah bot meminta konfirmasi saat kategori ambigu atau memilih otomatis.');

      const buttons = content.replyMarkup.inline_keyboard;
      // Option 1: 'ask' (active by default)
      expect(buttons[0][0].text).toContain('✅');
      expect(buttons[0][0].text).toContain('Tanya jika ragu');
      expect(buttons[0][0].callback_data).toBe('settings:set:category:ask');

      // Option 2: 'auto'
      expect(buttons[1][0].text).not.toContain('✅');
      expect(buttons[1][0].text).toContain('Otomatis pilih terbaik');
      expect(buttons[1][0].callback_data).toBe('settings:set:category:auto');

      // Back button
      expect(buttons[2][0].callback_data).toBe('settings:home');
    });

    it('renders AI Model sub-menu with one-line function overview and model choices', () => {
      const content = getTelegramSettingsMenuContent('ai_model', 'id', settingsManager);

      expect(content.text).toContain('[INFO] Fungsi: Memilih model LLM utama untuk mengekstrak transaksi, struk, dan klasifikasi.');

      const buttons = content.replyMarkup.inline_keyboard;
      // Default model is gemini-3.5-flash-lite
      expect(buttons[0][0].text).toContain('✅');
      expect(buttons[0][0].text).toContain('Gemini 3.5 Flash Lite');
      expect(buttons[0][0].callback_data).toBe('settings:set:ai_model:gemini-3.5-flash-lite');

      expect(buttons[1][0].text).not.toContain('✅');
      expect(buttons[1][0].text).toContain('Gemini 3.8 Flash');
      expect(buttons[1][0].callback_data).toBe('settings:set:ai_model:gemini-3.8-flash');

      expect(buttons[2][0].text).toContain('Rantai Cadangan');
      expect(buttons[2][0].callback_data).toBe('settings:toggle:ai_fallback');
    });

    it('renders Language sub-menu with one-line function overview in English when requested', () => {
      const content = getTelegramSettingsMenuContent('language', 'en', settingsManager);

      expect(content.text).toContain('[INFO] Function: Configures the language for bot replies, reports, and transaction confirmations.');

      const buttons = content.replyMarkup.inline_keyboard;
      expect(buttons[0][0].text).toContain('Bahasa Indonesia');
      expect(buttons[0][0].callback_data).toBe('settings:set:language:id');
      expect(buttons[1][0].text).toContain('English');
      expect(buttons[1][0].callback_data).toBe('settings:set:language:en');
    });

    it('renders Currency sub-menu with one-line function overview and supported currency buttons', () => {
      const content = getTelegramSettingsMenuContent('currency', 'id', settingsManager);

      expect(content.text).toContain('[INFO] Fungsi: Menentukan mata uang dasar saat nominal dicatat tanpa simbol mata uang.');

      const buttons = content.replyMarkup.inline_keyboard;
      expect(buttons[0][0].text).toContain('✅ IDR');
      expect(buttons[0][0].callback_data).toBe('settings:set:currency:IDR');
      expect(buttons[0][1].text).toBe('USD');
      expect(buttons[0][1].callback_data).toBe('settings:set:currency:USD');
      expect(buttons[1][0].text).toBe('SGD');
      expect(buttons[1][0].callback_data).toBe('settings:set:currency:SGD');
      expect(buttons[1][1].text).toBe('EUR');
      expect(buttons[1][1].callback_data).toBe('settings:set:currency:EUR');
    });

    it('renders Advanced settings hub and each of its sub-pages with function overviews', () => {
      const advanced = getTelegramSettingsMenuContent('advanced', 'id', settingsManager);
      expect(advanced.text).toContain('[INFO] Fungsi: Konfigurasi performa, antrean, retensi log, dan sinkronisasi sistem.');

      const tz = getTelegramSettingsMenuContent('timezone', 'id', settingsManager);
      expect(tz.text).toContain('[INFO] Fungsi: Mengatur zona waktu operasional untuk pencatatan tanggal transaksi.');
      expect(tz.replyMarkup.inline_keyboard[0][0].text).toContain('✅ WIB');

      const timeout = getTelegramSettingsMenuContent('ai_timeout', 'id', settingsManager);
      expect(timeout.text).toContain('[INFO] Fungsi: Batas maksimal durasi tunggu respon AI sebelum beralih ke model cadangan.');
      expect(timeout.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 20s');

      const email = getTelegramSettingsMenuContent('email_lookback', 'id', settingsManager);
      expect(email.text).toContain('[INFO] Fungsi: Rentang waktu penarikan email transaksi masuk dari server IMAP.');
      expect(email.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 10m');

      const queue = getTelegramSettingsMenuContent('queue_interval', 'id', settingsManager);
      expect(queue.text).toContain('[INFO] Fungsi: Jeda waktu throttling pengiriman pesan keluar untuk mencegah rate limit.');
      expect(queue.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 1000ms');

      const logs = getTelegramSettingsMenuContent('log_retention', 'id', settingsManager);
      expect(logs.text).toContain('[INFO] Fungsi: Durasi penyimpanan file log aplikasi sebelum dibersihkan otomatis.');
      expect(logs.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 7d');

      const resetConfirm = getTelegramSettingsMenuContent('reset_confirm', 'id', settingsManager);
      expect(resetConfirm.text).toContain('[INFO] Fungsi: Mengembalikan seluruh konfigurasi runtime ke pengaturan awal (.env / default).');
    });
  });

  describe('Telegram Gateway Callback Query Integration and Fail-Closed Authorization', () => {
    it('rejects unauthorized users fail-closed when settings callback is received', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const mockContext: any = {
        from: { id: 987654321, username: 'unauthorized_attacker' },
        callbackQuery: { data: 'settings:set:category:auto' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:set:category:auto');

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Unauthorized'), show_alert: true })
      );
      expect(mockEditMessageText).not.toHaveBeenCalled();
      expect(settingsManager.getSetting('categoryResolutionMode')).toBe('ask');
    });

    it('allows authorized bot owner to navigate pages and updates message text in-place', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:page:category' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:page:category');

      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [text, options] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('Mode Resolusi Kategori');
      expect(options.parse_mode).toBe('HTML');
      expect(options.reply_markup).toBeDefined();
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('updates runtime settings when authorized user clicks setting option', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:set:category:auto' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:set:category:auto');

      const currentMode = RuntimeSettingsManager.getInstance().getSetting('categoryResolutionMode');
      expect(currentMode).toBe('auto');

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('berhasil') })
      );
      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [, options] = mockEditMessageText.mock.calls[0];
      // Check that the updated markup now displays the checkmark on 'auto'
      const buttons = options.reply_markup.inline_keyboard;
      expect(buttons[1][0].text).toContain('✅');
      expect(buttons[1][0].text).toContain('Otomatis');
    });

    it('toggles debug logging when settings:toggle:debug is received', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const initialDebug = RuntimeSettingsManager.getInstance().getSetting('debugLoggingEnabled');
      expect(initialDebug).toBe(false);

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:toggle:debug' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:toggle:debug');

      const toggledDebug = RuntimeSettingsManager.getInstance().getSetting('debugLoggingEnabled');
      expect(toggledDebug).toBe(true);
      expect(process.env.DEBUG_FINANCIAL_PAYLOADS).toBe('true');
    });

    it('resets settings to defaults when settings:action:reset is received', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const manager = RuntimeSettingsManager.getInstance();
      await manager.updateSetting('defaultCurrency', 'USD');
      expect(manager.getSetting('defaultCurrency')).toBe('USD');

      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:action:reset' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:action:reset');

      expect(manager.getSetting('defaultCurrency')).toBe('IDR');
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('default') })
      );
    });

    it('handles settings:action:close by deleting or replacing menu message', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockDeleteMessage = vi.fn().mockResolvedValue(true);
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:action:close' },
        deleteMessage: mockDeleteMessage,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:action:close');

      expect(mockDeleteMessage).toHaveBeenCalledTimes(1);
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('handles Telegram "message is not modified" error gracefully without throwing', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message'));

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:page:category' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await expect(
        adapter.handleSettingsCallbackQuery(mockContext, 'settings:page:category')
      ).resolves.not.toThrow();

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('registers /settings and /pengaturan command in setupBotHandlers', () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const registeredCommands: Record<string, any> = {};

      const mockBot: any = {
        use: vi.fn(),
        command: vi.fn((cmd: string | string[], handler: any) => {
          if (Array.isArray(cmd)) {
            for (const c of cmd) {
              registeredCommands[c] = handler;
            }
          } else {
            registeredCommands[cmd] = handler;
          }
        }),
        on: vi.fn(),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);

      expect(registeredCommands['settings']).toBeDefined();
      expect(registeredCommands['pengaturan']).toBeDefined();
    });
  });
});
