import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTelegramSettingsMenuContent,
  createSettingsMainInlineKeyboard,
  createCategoryInlineKeyboard,
  createAutoRecordInlineKeyboard,
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
    it('renders Main Hub (home) with active status summary and logically grouped 4-row menu', () => {
      const content = getTelegramSettingsMenuContent('home', 'id', settingsManager);

      expect(content.text).toContain('Pengaturan Bot');
      expect(content.text).toContain('Status Konfigurasi Aktif:');
      expect(content.text).toContain('Mode Kategori:');
      expect(content.text).toContain('Auto-Catat:');
      expect(content.text).toContain('Model AI:');
      expect(content.text).toContain('Bahasa Respon:');
      expect(content.text).toContain('Mata Uang Default:');
      expect(content.text).toContain('Zona Waktu:');
      expect(content.text).toContain('Timeout Respon AI:');
      expect(content.text).toContain('Jeda Kirim Pesan:');
      expect(content.text).toContain('Retensi Log:');
      expect(content.text).toContain('Debug Log:');

      const markup = content.replyMarkup.inline_keyboard;
      expect(markup.length).toBe(4);
      expect(markup[0][0].callback_data).toBe('settings:page:category');
      expect(markup[0][1].callback_data).toBe('settings:page:auto_record');
      expect(markup[1][0].callback_data).toBe('settings:page:language');
      expect(markup[1][1].callback_data).toBe('settings:page:currency');
      expect(markup[2][0].callback_data).toBe('settings:page:ai_model');
      expect(markup[2][1].callback_data).toBe('settings:page:advanced');
      expect(markup[3][0].callback_data).toBe('settings:action:close');
    });

    it('renders Category sub-menu with one-line function overview and checkmark on active option', () => {
      const content = getTelegramSettingsMenuContent('category', 'id', settingsManager);

      expect(content.text).toContain('Fungsi: Menentukan apakah bot meminta konfirmasi saat kategori ambigu atau memilih otomatis.');

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

    it('renders Auto-Record sub-menu with clear function overview and active checkmark', () => {
      const content = getTelegramSettingsMenuContent('auto_record', 'id', settingsManager);

      expect(content.text).toContain('Pencatatan Otomatis');
      expect(content.text).toContain('Fungsi:');

      const buttons = content.replyMarkup.inline_keyboard;
      // Default is false -> 'off' is active
      expect(buttons[0][0].text).not.toContain('✅');
      expect(buttons[0][0].callback_data).toBe('settings:set:auto_record:on');
      expect(buttons[1][0].text).toContain('✅');
      expect(buttons[1][0].callback_data).toBe('settings:set:auto_record:off');
      expect(buttons[2][0].callback_data).toBe('settings:home');

      const enabledKb = createAutoRecordInlineKeyboard(true, 'id').inline_keyboard;
      expect(enabledKb[0][0].text).toContain('✅');
      expect(enabledKb[1][0].text).not.toContain('✅');
    });

    it('renders AI Model sub-menu with one-line function overview and model choices', () => {
      const content = getTelegramSettingsMenuContent('ai_model', 'id', settingsManager);

      expect(content.text).toContain('Fungsi: Memilih model LLM utama untuk mengekstrak transaksi, struk, dan klasifikasi.');

      const buttons = content.replyMarkup.inline_keyboard;
      // Default model is gemini-3.5-flash-lite
      expect(buttons[0][0].text).toContain('✅');
      expect(buttons[0][0].text).toContain('Gemini 3.5 Flash Lite');
      expect(buttons[0][0].callback_data).toBe('settings:set:ai_model:gemini-3.5-flash-lite');

      expect(buttons[1][0].text).not.toContain('✅');
      expect(buttons[1][0].text).toContain('Gemini 3.8 Flash');
      expect(buttons[1][0].callback_data).toBe('settings:set:ai_model:gemini-3.8-flash');

      expect(buttons[2][0].text).toContain('Fallback Otomatis: ON');
      expect(buttons[2][0].callback_data).toBe('settings:toggle:ai_fallback');
    });

    it('renders Language sub-menu with one-line function overview in English when requested', () => {
      const content = getTelegramSettingsMenuContent('language', 'en', settingsManager);

      expect(content.text).toContain('Function: Configures the language for bot replies, reports, and transaction confirmations.');
      expect(content.text).toContain('Response Language:');

      const buttons = content.replyMarkup.inline_keyboard;
      expect(buttons[0][0].text).toContain('Bahasa Indonesia');
      expect(buttons[0][0].callback_data).toBe('settings:set:language:id');
      expect(buttons[1][0].text).toContain('English');
      expect(buttons[1][0].callback_data).toBe('settings:set:language:en');
    });

    it('renders Currency sub-menu with expanded presets and custom active value fallback', () => {
      const content = getTelegramSettingsMenuContent('currency', 'id', settingsManager);

      expect(content.text).toContain('Fungsi: Menentukan mata uang dasar saat nominal dicatat tanpa simbol mata uang.');
      expect(content.text).toContain('/settings currency THB');

      const buttons = content.replyMarkup.inline_keyboard;
      expect(buttons[0].map(b => b.callback_data)).toEqual([
        'settings:set:currency:IDR',
        'settings:set:currency:USD',
        'settings:set:currency:SGD',
        'settings:set:currency:MYR',
      ]);
      expect(buttons[1].map(b => b.callback_data)).toEqual([
        'settings:set:currency:EUR',
        'settings:set:currency:JPY',
        'settings:set:currency:GBP',
        'settings:set:currency:AUD',
      ]);
      expect(buttons[0][0].text).toContain('✅ IDR');
      expect(buttons[2][0].callback_data).toBe('settings:home');

      const customCurrKb = createCurrencyInlineKeyboard('THB', 'id').inline_keyboard;
      expect(customCurrKb[2][0].text).toBe('✅ THB');
      expect(customCurrKb[2][0].callback_data).toBe('settings:set:currency:THB');
      expect(customCurrKb[3][0].callback_data).toBe('settings:home');
    });

    it('renders Advanced settings hub with active technical summary and paired 2-column controls', () => {
      const advanced = getTelegramSettingsMenuContent('advanced', 'id', settingsManager);
      expect(advanced.text).toContain('Fungsi: Konfigurasi zona waktu, sinkronisasi email, performa AI, dan log sistem.');
      expect(advanced.text).toContain('Zona Waktu:');
      expect(advanced.text).toContain('Debug Log:');

      const advButtons = advanced.replyMarkup.inline_keyboard;
      expect(advButtons.length).toBe(5);
      expect(advButtons[0][0].callback_data).toBe('settings:page:timezone');
      expect(advButtons[0][1].callback_data).toBe('settings:page:email_lookback');
      expect(advButtons[1][0].callback_data).toBe('settings:page:ai_timeout');
      expect(advButtons[1][1].callback_data).toBe('settings:page:queue_interval');
      expect(advButtons[2][0].callback_data).toBe('settings:page:log_retention');
      expect(advButtons[2][1].callback_data).toBe('settings:toggle:debug');
      expect(advButtons[3][0].callback_data).toBe('settings:page:reset_confirm');
      expect(advButtons[4][0].callback_data).toBe('settings:home');

      const tz = getTelegramSettingsMenuContent('timezone', 'id', settingsManager);
      expect(tz.text).toContain('Fungsi: Mengatur zona waktu operasional untuk pencatatan tanggal transaksi.');
      expect(tz.text).toContain('/settings timezone Europe/London');
      expect(tz.replyMarkup.inline_keyboard[0][0].text).toContain('✅ WIB');

      const customTzKb = createTimezoneInlineKeyboard('Europe/London', 'id').inline_keyboard;
      expect(customTzKb[3][0].text).toBe('✅ Europe/London');
      expect(customTzKb[3][0].callback_data).toBe('settings:set:timezone:Europe/London');

      const timeout = getTelegramSettingsMenuContent('ai_timeout', 'id', settingsManager);
      expect(timeout.text).toContain('Fungsi: Batas maksimal durasi tunggu respon AI sebelum beralih ke model cadangan.');
      expect(timeout.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 20s');

      const email = getTelegramSettingsMenuContent('email_lookback', 'id', settingsManager);
      expect(email.text).toContain('Fungsi: Rentang waktu penarikan email transaksi masuk dari server IMAP.');
      expect(email.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 10m');

      const queue = getTelegramSettingsMenuContent('queue_interval', 'id', settingsManager);
      expect(queue.text).toContain('Fungsi: Jeda waktu throttling pengiriman pesan keluar untuk mencegah rate limit.');
      expect(queue.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 1000ms');

      const logs = getTelegramSettingsMenuContent('log_retention', 'id', settingsManager);
      expect(logs.text).toContain('Fungsi: Durasi penyimpanan file log aplikasi sebelum dibersihkan otomatis.');
      expect(logs.replyMarkup.inline_keyboard[0][1].text).toContain('✅ 7d');

      const resetConfirm = getTelegramSettingsMenuContent('reset_confirm', 'id', settingsManager);
      expect(resetConfirm.text).toContain('Fungsi: Mengembalikan seluruh konfigurasi runtime ke pengaturan awal (.env / default).');
    });

    it('renders full English summary without leftover Indonesian labels when language is en', () => {
      const homeEn = getTelegramSettingsMenuContent('home', 'en', settingsManager);
      expect(homeEn.text).toContain('Bot Settings');
      expect(homeEn.text).toContain('Category Mode:');
      expect(homeEn.text).toContain('Auto-Record:');
      expect(homeEn.text).not.toContain('Mode Kategori');
      expect(homeEn.text).not.toContain('hari');

      const advEn = getTelegramSettingsMenuContent('advanced', 'en', settingsManager);
      expect(advEn.text).toContain('Advanced Settings');
      expect(advEn.text).toContain('Select an option below');
      expect(advEn.text).not.toContain('Pilih opsi lanjutan');
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

    it('toggles autoRecordEnriched when settings:toggle:auto_record_enriched is received', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      const mockEditMessageText = vi.fn().mockResolvedValue({});

      const initialVal = RuntimeSettingsManager.getInstance().getSetting('autoRecordEnriched');
      expect(initialVal).toBe(false);

      const mockContext: any = {
        from: { id: Number(allowedUserId) },
        callbackQuery: { data: 'settings:toggle:auto_record_enriched' },
        answerCallbackQuery: mockAnswerCallbackQuery,
        editMessageText: mockEditMessageText,
      };

      await adapter.handleSettingsCallbackQuery(mockContext, 'settings:toggle:auto_record_enriched');

      const toggledVal = RuntimeSettingsManager.getInstance().getSetting('autoRecordEnriched');
      expect(toggledVal).toBe(true);
    });

    it('toggles debug logging and remains on Advanced settings page', async () => {
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

      const [editedText, editOptions] = mockEditMessageText.mock.calls[0];
      expect(editedText).toContain('Pengaturan Lanjutan');
      expect(editOptions.reply_markup.inline_keyboard[2][1].text).toContain('Debug Log: ON');
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

    it('registers /settings and /pengaturan command in setupBotHandlers and handles text commands', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const registeredCommands: Record<string, any> = {};
      const registeredListeners: Record<string, any> = {};

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
        on: vi.fn((evt: string, handler: any) => {
          registeredListeners[evt] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);

      expect(registeredCommands['settings']).toBeDefined();
      expect(registeredCommands['pengaturan']).toBeDefined();

      // Test bot.command invocation
      const mockReply = vi.fn().mockResolvedValue({});
      await registeredCommands['settings']({ reply: mockReply });
      expect(mockReply).toHaveBeenCalledTimes(1);
      expect(mockReply.mock.calls[0][0]).toContain('Pengaturan Bot');

      // Test message:text listener for /settings, settings, /pengaturan, pengaturan
      const textHandler = registeredListeners['message:text'];
      expect(textHandler).toBeDefined();

      for (const cmdText of ['/settings', 'settings', '/pengaturan', 'pengaturan']) {
        const textReply = vi.fn().mockResolvedValue({});
        await textHandler({
          message: { text: cmdText },
          chat: { id: 12345 },
          from: { id: Number(allowedUserId) },
          reply: textReply,
        });
        expect(textReply).toHaveBeenCalledTimes(1);
        expect(textReply.mock.calls[0][0]).toContain('Pengaturan Bot');
      }
    });

    it('handles all sub-setting update callbacks in handleSettingsCallbackQuery', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const manager = RuntimeSettingsManager.getInstance();

      const testCases = [
        { callback: 'settings:set:auto_record:on', check: () => expect(manager.getSetting('autoRecordEnriched')).toBe(true) },
        { callback: 'settings:set:auto_record:off', check: () => expect(manager.getSetting('autoRecordEnriched')).toBe(false) },
        { callback: 'settings:set:ai_model:gemini-3.8-flash', check: () => expect(manager.getSetting('aiModel')).toBe('gemini-3.8-flash') },
        { callback: 'settings:set:language:en', check: () => expect(manager.getSetting('appLanguage')).toBe('en') },
        { callback: 'settings:set:currency:USD', check: () => expect(manager.getSetting('defaultCurrency')).toBe('USD') },
        { callback: 'settings:set:timezone:WITA', check: () => expect(manager.getSetting('appTimezone')).toBe('Asia/Makassar') },
        { callback: 'settings:set:timezone:Asia/Tokyo', check: () => expect(manager.getSetting('appTimezone')).toBe('Asia/Tokyo') },
        { callback: 'settings:set:ai_timeout:45', check: () => expect(manager.getSetting('aiRequestTimeoutSeconds')).toBe(45) },
        { callback: 'settings:set:email_lookback:30', check: () => expect(manager.getSetting('emailLookbackMinutes')).toBe(30) },
        { callback: 'settings:set:queue_interval:3000', check: () => expect(manager.getSetting('whatsappMessageQueueIntervalMs')).toBe(3000) },
        { callback: 'settings:set:log_retention:30', check: () => expect(manager.getSetting('logRetentionDays')).toBe(30) },
        { callback: 'settings:home', check: () => {} },
      ];

      for (const tc of testCases) {
        const mockEdit = vi.fn().mockResolvedValue({});
        const mockAnswer = vi.fn().mockResolvedValue({});
        const ctx: any = {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: tc.callback },
          answerCallbackQuery: mockAnswer,
          editMessageText: mockEdit,
        };

        await adapter.handleSettingsCallbackQuery(ctx, tc.callback);
        expect(mockEdit).toHaveBeenCalled();
        expect(mockAnswer).toHaveBeenCalled();
        tc.check();
      }
    });

    it('toggles AI fallback chain on and off', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const manager = RuntimeSettingsManager.getInstance();

      // First toggle: currently has fallbacks, so toggles to empty
      const mockEdit1 = vi.fn().mockResolvedValue({});
      const mockAnswer1 = vi.fn().mockResolvedValue({});
      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:toggle:ai_fallback' },
          answerCallbackQuery: mockAnswer1,
          editMessageText: mockEdit1,
        } as any,
        'settings:toggle:ai_fallback'
      );
      expect(manager.getSetting('aiFallbackModels')).toEqual([]);

      // Second toggle: empty, so restores default fallbacks
      const mockEdit2 = vi.fn().mockResolvedValue({});
      const mockAnswer2 = vi.fn().mockResolvedValue({});
      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:toggle:ai_fallback' },
          answerCallbackQuery: mockAnswer2,
          editMessageText: mockEdit2,
        } as any,
        'settings:toggle:ai_fallback'
      );
      expect(manager.getSetting('aiFallbackModels')).toEqual(['gemini-3.6-flash', 'gemini-3.8-flash']);
    });

    it('falls back to editing message if deleteMessage fails on close', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockDelete = vi.fn().mockRejectedValue(new Error('Cannot delete'));
      const mockEdit = vi.fn().mockResolvedValue({});
      const mockAnswer = vi.fn().mockResolvedValue({});

      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:action:close' },
          deleteMessage: mockDelete,
          editMessageText: mockEdit,
          answerCallbackQuery: mockAnswer,
        } as any,
        'settings:action:close'
      );

      expect(mockDelete).toHaveBeenCalled();
      expect(mockEdit).toHaveBeenCalledWith(
        expect.stringContaining('ditutup'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
    });

    it('catches and answers callback query if an internal error occurs', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockAnswer = vi.fn().mockResolvedValue({});
      vi.spyOn(RuntimeSettingsManager.getInstance(), 'getSettings').mockImplementationOnce(() => {
        throw new Error('Fatal storage bug');
      });

      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:home' },
          editMessageText: vi.fn(),
          answerCallbackQuery: mockAnswer,
        } as any,
        'settings:home'
      );

      expect(mockAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Error') })
      );
    });

    it('renders all options with checkmarks when non-default values are active', () => {
      const customSettings = {
        categoryResolutionMode: 'auto' as const,
        aiModel: 'gemini-3.8-flash',
        aiFallbackModels: [],
        appLanguage: 'en' as const,
        defaultCurrency: 'EUR',
        appTimezone: 'UTC',
        aiRequestTimeoutSeconds: 45,
        emailLookbackMinutes: 30,
        whatsappMessageQueueIntervalMs: 3000,
        logRetentionDays: 30,
        debugLoggingEnabled: true,
      };

      const langKb = createLanguageInlineKeyboard('en', 'en');
      expect(langKb.inline_keyboard[1][0].text).toContain('✅');

      const currKb = createCurrencyInlineKeyboard('EUR', 'id');
      expect(currKb.inline_keyboard[1][0].text).toContain('✅ EUR');

      const tzKb = createTimezoneInlineKeyboard('UTC', 'id');
      expect(tzKb.inline_keyboard[2][1].text).toContain('✅ UTC');

      const timeoutKb = createAiTimeoutInlineKeyboard(45, 'id');
      expect(timeoutKb.inline_keyboard[1][1].text).toContain('✅ 45s');

      const emailKb = createEmailLookbackInlineKeyboard(30, 'id');
      expect(emailKb.inline_keyboard[1][0].text).toContain('✅ 30m');

      const queueKb = createQueueIntervalInlineKeyboard(3000, 'id');
      expect(queueKb.inline_keyboard[1][1].text).toContain('✅ 3000ms');

      const logKb = createLogRetentionInlineKeyboard(30, 'id');
      expect(logKb.inline_keyboard[1][1].text).toContain('✅ 30d');

      const fallbackHome = getTelegramSettingsMenuContent('unknown_page' as any, 'id', settingsManager);
      expect(fallbackHome.text).toContain('Pengaturan Bot');
    });

    it('supports /settings timezone and /settings currency command arguments with validation', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const registeredCommands: Record<string, any> = {};
      const registeredListeners: Record<string, any> = {};

      const mockBot: any = {
        use: vi.fn(),
        command: vi.fn((cmd: string | string[], handler: any) => {
          for (const c of Array.isArray(cmd) ? cmd : [cmd]) {
            registeredCommands[c] = handler;
          }
        }),
        on: vi.fn((evt: string, handler: any) => {
          registeredListeners[evt] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      const manager = RuntimeSettingsManager.getInstance();

      const validTzReply = vi.fn().mockResolvedValue({});
      await registeredCommands['settings']({ match: 'timezone Europe/London', reply: validTzReply });
      expect(manager.getSetting('appTimezone')).toBe('Europe/London');
      expect(validTzReply.mock.calls[0][0]).toContain('Europe/London');

      const invalidTzReply = vi.fn().mockResolvedValue({});
      await registeredCommands['settings']({ match: 'timezone Mars/Olympus', reply: invalidTzReply });
      expect(manager.getSetting('appTimezone')).toBe('Europe/London');
      expect(invalidTzReply.mock.calls[0][0]).toContain('tidak valid');

      const validCurrReply = vi.fn().mockResolvedValue({});
      await registeredListeners['message:text']({
        message: { text: '/settings currency thb' },
        chat: { id: 12345 },
        from: { id: Number(allowedUserId) },
        reply: validCurrReply,
      });
      expect(manager.getSetting('defaultCurrency')).toBe('THB');
      expect(validCurrReply.mock.calls[0][0]).toContain('THB');

      const invalidCurrReply = vi.fn().mockResolvedValue({});
      await registeredListeners['message:text']({
        message: { text: '/settings currency 123' },
        chat: { id: 12345 },
        from: { id: Number(allowedUserId) },
        reply: invalidCurrReply,
      });
      expect(manager.getSetting('defaultCurrency')).toBe('THB');
      expect(invalidCurrReply.mock.calls[0][0]).toContain('tidak valid');
    });

    it('refreshes Telegram bot commands via setMyCommands when language changes or resets', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockSetMyCommands = vi.fn().mockResolvedValue(true);
      (adapter as any).botInstance = {
        api: {
          setMyCommands: mockSetMyCommands,
        },
      };

      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:set:language:en' },
          answerCallbackQuery: vi.fn().mockResolvedValue({}),
          editMessageText: vi.fn().mockResolvedValue({}),
        } as any,
        'settings:set:language:en'
      );

      expect(mockSetMyCommands).toHaveBeenCalledTimes(1);
      expect(mockSetMyCommands.mock.calls[0][0][0]).toEqual({
        command: 'saldo',
        description: 'All account balances',
      });

      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:action:reset' },
          answerCallbackQuery: vi.fn().mockResolvedValue({}),
          editMessageText: vi.fn().mockResolvedValue({}),
        } as any,
        'settings:action:reset'
      );

      expect(mockSetMyCommands).toHaveBeenCalledTimes(2);
      expect(mockSetMyCommands.mock.calls[1][0][0]).toEqual({
        command: 'saldo',
        description: 'Saldo semua rekening',
      });
    });

    it('logs a warning without failing when setMyCommands rejects on language switch', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, allowedUserId, vi.fn());
      const mockSetMyCommands = vi.fn().mockRejectedValue(new Error('Telegram API rate limit'));
      (adapter as any).botInstance = {
        api: {
          setMyCommands: mockSetMyCommands,
        },
      };

      await adapter.handleSettingsCallbackQuery(
        {
          from: { id: Number(allowedUserId) },
          callbackQuery: { data: 'settings:set:language:en' },
          answerCallbackQuery: vi.fn().mockResolvedValue({}),
          editMessageText: vi.fn().mockResolvedValue({}),
        } as any,
        'settings:set:language:en'
      );

      // Flush microtask queue so the non-blocking Promise.resolve(...).catch(...) runs
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSetMyCommands).toHaveBeenCalledTimes(1);
    });
  });
});
