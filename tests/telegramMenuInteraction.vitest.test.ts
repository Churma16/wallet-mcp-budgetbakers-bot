import { Context } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';

describe('Telegram Menu and Interactive Guide Gateway Integration', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';

  describe('sendTextMessage with isHelpMenu', () => {
    it('dispatches main reply keyboard followed by guide overview inline keyboard', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 101 });

      (adapter as any).botInstance = {
        api: {
          sendMessage: mockSendMessage,
        },
      };

      const receipt = await adapter.sendTextMessage('12345', 'Halo! Selamat datang di bot.', {
        isHelpMenu: true,
      });

      expect(receipt.messageId).toBe('101');
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      // Call 1: Welcome guidance + persistent reply keyboard
      const [chatId1, text1, options1] = mockSendMessage.mock.calls[0];
      expect(chatId1).toBe('12345');
      expect(text1).toContain('Halo! Selamat datang di bot.');
      expect(options1.reply_markup).toBeDefined();
      expect(options1.reply_markup.is_persistent).toBe(true);
      expect(options1.reply_markup.resize_keyboard).toBe(true);

      // Call 2: Guide overview + inline keyboard
      const [chatId2, text2, options2] = mockSendMessage.mock.calls[1];
      expect(chatId2).toBe('12345');
      expect(text2).toContain('Panduan Penggunaan Wallet Bot');
      expect(options2.reply_markup).toBeDefined();
      expect(options2.reply_markup.inline_keyboard.length).toBe(3);
    });

    it('falls back to plain text with reply keyboard if HTML parsing fails on help menu', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockSendMessage = vi
        .fn()
        .mockRejectedValueOnce(new Error('HTML parse error'))
        .mockResolvedValueOnce({ message_id: 102 });

      (adapter as any).botInstance = {
        api: {
          sendMessage: mockSendMessage,
        },
      };

      const receipt = await adapter.sendTextMessage('12345', 'Broken <unclosed> tag', {
        isHelpMenu: true,
      });

      expect(receipt.messageId).toBe('102');
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      // Second call was the plain text fallback with reply keyboard attached
      const [chatId, text, options] = mockSendMessage.mock.calls[1];
      expect(chatId).toBe('12345');
      expect(text).toBe('Broken <unclosed> tag');
      expect(options.reply_markup.is_persistent).toBe(true);
    });
  });

  describe('Interactive Callback Query Handlers', () => {
    it('updates message text and answers callback query when valid guide topic is clicked', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      expect(handlers['callback_query:data']).toBeDefined();

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'guide:record',
        },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [editedText, editOptions] = mockEditMessageText.mock.calls[0];
      expect(editedText).toContain('Catat Pengeluaran');
      expect(editOptions.reply_markup).toBeDefined();
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('navigates back to home overview when guide:home is clicked', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'guide:home',
        },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [editedText] = mockEditMessageText.mock.calls[0];
      expect(editedText).toContain('Panduan Penggunaan Wallet Bot');
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('answers callback query without editing when callback data is empty', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: '',
        },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockEditMessageText).not.toHaveBeenCalled();
      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
    });

    it('handles rescan duration callback query, edits message, and dispatches synthetic message', async () => {
      const mockUserMessageReceived = vi.fn().mockResolvedValue(undefined);
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, mockUserMessageReceived);
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      expect(handlers['callback_query:data']).toBeDefined();

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'rescan:180',
        },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockEditMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Rescan'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
      expect(mockUserMessageReceived).toHaveBeenCalledWith({
        channel: 'telegram',
        messageType: 'text',
        chatIdentifier: '123456789',
        senderIdentifier: '123456789',
        textPayload: '/rescan 180m',
      });
    });

    it('handles delete:confirm callback query, edits message, and dispatches /delete_confirm message', async () => {
      const mockUserMessageReceived = vi.fn().mockResolvedValue(undefined);
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, mockUserMessageReceived);
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      expect(handlers['callback_query:data']).toBeDefined();

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'delete:confirm:msg-999',
        },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockEditMessageText).toHaveBeenCalledWith(
        expect.stringContaining('Menghapus transaksi'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
      expect(mockUserMessageReceived).toHaveBeenCalledWith({
        channel: 'telegram',
        messageType: 'text',
        chatIdentifier: '123456789',
        senderIdentifier: '123456789',
        textPayload: '/delete_confirm msg-999',
      });
    });

    it('handles delete:cancel callback query, edits message with cancelled notice, and answers query', async () => {
      const mockUserMessageReceived = vi.fn().mockResolvedValue(undefined);
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, mockUserMessageReceived);
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      expect(handlers['callback_query:data']).toBeDefined();

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      const mockContext = {
        callbackQuery: {
          data: 'delete:cancel:msg-999',
        },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await handlers['callback_query:data'](mockContext);

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockEditMessageText).toHaveBeenCalledWith(
        expect.stringContaining('dibatalkan'),
        expect.objectContaining({ parse_mode: 'HTML' })
      );
      expect(mockUserMessageReceived).not.toHaveBeenCalled();
    });
  });

  describe('Security Guardrails on Callback Queries', () => {
    it('answers alert and blocks unauthorized callback query attempts', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn());
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});
      let nextCalled = false;

      const unauthorizedContext: Partial<Context> = {
        from: { id: 999999999, is_bot: false, first_name: 'Attacker' },
        callbackQuery: {
          id: 'cb_123',
          from: { id: 999999999, is_bot: false, first_name: 'Attacker' },
          chat_instance: 'inst_1',
          data: 'guide:record',
        } as any,
        answerCallbackQuery: mockAnswerCallbackQuery,
      };

      await adapter.handleInboundMiddleware(unauthorizedContext as Context, async () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(false);
      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith({
        text: 'Akses ditolak / Unauthorized',
        show_alert: true,
      });
    });
  });
});
