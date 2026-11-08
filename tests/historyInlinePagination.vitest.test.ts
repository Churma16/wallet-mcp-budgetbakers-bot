import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildHistoryPaginationInlineKeyboard,
  handleHistoryPagination,
  historySessionStore,
  HistorySessionStore,
} from '../src/core/history/index.js';
import { formatTransactionHistoryMessage } from '../src/wallet/formatters/humanResponseFormatter.js';
import { FinancialActionExecutor } from '../src/core/executor.js';
import type { TransactionHistoryPage, TransactionHistoryService } from '../wallet/index.js';
import type { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';

describe('Transaction History Inline Pagination', () => {
  beforeEach(() => {
    historySessionStore.clear();
  });

  describe('buildHistoryPaginationInlineKeyboard', () => {
    it('returns undefined if totalPages is 1 or less', () => {
      expect(buildHistoryPaginationInlineKeyboard('sess123', 1, 1)).toBeUndefined();
      expect(buildHistoryPaginationInlineKeyboard('sess123', 1, 0)).toBeUndefined();
    });

    it('builds [ 1/5 ] [ Next ➡️ ] for page 1 (Option A)', () => {
      const markup = buildHistoryPaginationInlineKeyboard('sess123', 1, 5);
      expect(markup).toBeDefined();
      expect(markup?.inline_keyboard).toHaveLength(1);
      const row = markup!.inline_keyboard[0];
      expect(row).toHaveLength(2);

      expect(row[0]).toEqual({ text: '1/5', callback_data: 'hist:noop' });
      expect(row[1]).toEqual({ text: 'Next ➡️', callback_data: 'hist:sess123:2' });
    });

    it('builds [ ⬅️ Prev ] [ 3/5 ] [ Next ➡️ ] for middle page', () => {
      const markup = buildHistoryPaginationInlineKeyboard('sess123', 3, 5);
      expect(markup).toBeDefined();
      expect(markup?.inline_keyboard).toHaveLength(1);
      const row = markup!.inline_keyboard[0];
      expect(row).toHaveLength(3);

      expect(row[0]).toEqual({ text: '⬅️ Prev', callback_data: 'hist:sess123:2' });
      expect(row[1]).toEqual({ text: '3/5', callback_data: 'hist:noop' });
      expect(row[2]).toEqual({ text: 'Next ➡️', callback_data: 'hist:sess123:4' });
    });

    it('builds [ ⬅️ Prev ] [ 5/5 ] for last page', () => {
      const markup = buildHistoryPaginationInlineKeyboard('sess123', 5, 5);
      expect(markup).toBeDefined();
      expect(markup?.inline_keyboard).toHaveLength(1);
      const row = markup!.inline_keyboard[0];
      expect(row).toHaveLength(2);

      expect(row[0]).toEqual({ text: '⬅️ Prev', callback_data: 'hist:sess123:4' });
      expect(row[1]).toEqual({ text: '5/5', callback_data: 'hist:noop' });
    });

    it('clamps requested page within bounds', () => {
      const markupBelow = buildHistoryPaginationInlineKeyboard('sess123', 0, 5);
      expect(markupBelow?.inline_keyboard[0][0]).toEqual({ text: '1/5', callback_data: 'hist:noop' });

      const markupAbove = buildHistoryPaginationInlineKeyboard('sess123', 10, 5);
      expect(markupAbove?.inline_keyboard[0][1]).toEqual({ text: '5/5', callback_data: 'hist:noop' });
    });
  });

  describe('HistorySessionStore', () => {
    it('creates and retrieves a session', () => {
      const store = new HistorySessionStore(60000);
      const sessionId = store.createSession('chat-123', { limit: 10 }, 5);
      expect(sessionId).toMatch(/^[0-9a-f]{8}$/);

      const session = store.getSession(sessionId);
      expect(session).toBeDefined();
      expect(session?.chatId).toBe('chat-123');
      expect(session?.totalPages).toBe(5);
      expect(session?.queryOptions).toEqual({ limit: 10 });
    });

    it('prunes expired sessions', () => {
      const store = new HistorySessionStore(-1000); // already expired
      const sessionId = store.createSession('chat-123', {}, 5);

      const retrieved = store.getSession(sessionId);
      expect(retrieved).toBeUndefined();
    });

    it('deletes session explicitly', () => {
      const store = new HistorySessionStore(60000);
      const sessionId = store.createSession('chat-123', {}, 5);
      store.deleteSession(sessionId);
      expect(store.getSession(sessionId)).toBeUndefined();
    });
  });

  describe('formatTransactionHistoryMessage with omitNavigationHint', () => {
    const mockPageWithMore: TransactionHistoryPage = {
      records: [
        {
          id: 'rec-1',
          amount: -50000,
          currency: 'IDR',
          recordType: 'expense',
          recordDate: '2026-11-08T10:00:00Z',
          category: { id: 'cat-1', name: 'Makan' },
          note: 'Makan siang',
        },
      ],
      total: 100,
      limit: 10,
      offset: 0,
      page: 1,
      totalPages: 10,
      hasMore: true,
      nextOffset: 10,
      sort: 'newest',
    };

    it('includes navigation hint by default (backwards compatible)', () => {
      const output = formatTransactionHistoryMessage(mockPageWithMore, 'id');
      expect(output).toContain('_Ketik *riwayat hal 2* untuk halaman selanjutnya._');
    });

    it('omits navigation hint when omitNavigationHint is true', () => {
      const output = formatTransactionHistoryMessage(mockPageWithMore, {
        languageCode: 'id',
        omitNavigationHint: true,
      });
      expect(output).not.toContain('_Ketik *riwayat hal 2* untuk halaman selanjutnya._');
      expect(output).toContain('Hal. 1/10');
      expect(output).toContain('Makan siang');
    });

    it('omits navigation hint for English when omitNavigationHint is true', () => {
      const output = formatTransactionHistoryMessage(mockPageWithMore, {
        languageCode: 'en',
        omitNavigationHint: true,
      });
      expect(output).not.toContain('Type *history page 2*');
      expect(output).toContain('Page 1/10');
    });
  });

  describe('handleHistoryPagination', () => {
    it('returns null on invalid callback data or noop', async () => {
      expect(await handleHistoryPagination('recon:noop')).toBeNull();
      expect(await handleHistoryPagination('hist:noop')).toBeNull();
      expect(await handleHistoryPagination('hist:sess:noop')).toBeNull();
      expect(await handleHistoryPagination('hist:invalid')).toBeNull();
    });

    it('returns null if session is missing or expired', async () => {
      const mockHistoryService = {
        getTransactionHistory: vi.fn(),
      } as unknown as TransactionHistoryService;

      const result = await handleHistoryPagination('hist:deadbeef:2', mockHistoryService);
      expect(result).toBeNull();
    });

    it('fetches requested page and returns formatted text without hint and updated keyboard', async () => {
      const sessionId = historySessionStore.createSession('chat-1', { limit: 10 }, 5);

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [
            {
              id: 'rec-2',
              amount: -25000,
              currency: 'IDR',
              recordType: 'expense',
              recordDate: '2026-11-08T11:00:00Z',
              category: { id: 'cat-1', name: 'Snacks' },
              note: 'Kopi',
            },
          ],
          total: 50,
          limit: 10,
          offset: 10,
          page: 2,
          totalPages: 5,
          hasMore: true,
          nextOffset: 20,
          sort: 'newest',
        }),
      } as unknown as TransactionHistoryService;

      const result = await handleHistoryPagination(`hist:${sessionId}:2`, mockHistoryService, 'id');
      expect(result).toBeDefined();
      expect(result?.text).toContain('Hal. 2/5');
      expect(result?.text).toContain('Kopi');
      expect(result?.text).not.toContain('_Ketik *riwayat hal 3* untuk halaman selanjutnya._');

      expect(mockHistoryService.getTransactionHistory).toHaveBeenCalledWith(
        expect.objectContaining({ page: 2, limit: 10 })
      );

      expect(result?.replyMarkup?.inline_keyboard).toBeDefined();
      const row = result!.replyMarkup!.inline_keyboard[0];
      expect(row[0]).toEqual({ text: '⬅️ Prev', callback_data: `hist:${sessionId}:1` });
      expect(row[1]).toEqual({ text: '2/5', callback_data: 'hist:noop' });
      expect(row[2]).toEqual({ text: 'Next ➡️', callback_data: `hist:${sessionId}:3` });
    });
  });

  describe('FinancialActionExecutor.executeTransactionHistory integration', () => {
    it('attaches inline keyboard and omits navigation hint on Telegram', async () => {
      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [
            {
              id: 'rec-1',
              amount: -15000,
              currency: 'IDR',
              recordType: 'expense',
              recordDate: '2026-11-08T09:00:00Z',
              category: { id: 'cat-1', name: 'Transport' },
              note: 'Ojol',
            },
          ],
          total: 3950,
          limit: 10,
          offset: 0,
          page: 1,
          totalPages: 395,
          hasMore: true,
          nextOffset: 10,
          sort: 'newest',
        }),
      };

      const executor = new FinancialActionExecutor(
        {} as any,
        {} as any,
        mockGateway as any,
        mockHistoryService as any
      );

      const telegramEvent: IncomingUserMessageEvent = {
        channel: 'telegram',
        senderIdentifier: 'user-1',
        chatIdentifier: 'chat-100',
        messageType: 'text',
        textPayload: '/riwayat',
      };

      await executor.executeTransactionHistory(telegramEvent, { limit: 10 });

      expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
      const [channel, chatId, messageText, options] = mockGateway.sendMessage.mock.calls[0];

      expect(channel).toBe('telegram');
      expect(chatId).toBe('chat-100');
      expect(messageText).not.toContain('Ketik riwayat hal 2');
      expect(messageText).toContain('Hal. 1/395');

      expect(options).toBeDefined();
      expect(options.replyMarkup).toBeDefined();
      const keyboard = options.replyMarkup.inline_keyboard[0];
      expect(keyboard[0]).toEqual({ text: '1/395', callback_data: 'hist:noop' });
      expect(keyboard[1].text).toBe('Next ➡️');
      expect(keyboard[1].callback_data).toMatch(/^hist:[0-9a-f]{8}:2$/);
    });

    it('keeps navigation hint and omits replyMarkup on WhatsApp', async () => {
      const mockGateway = {
        sendMessage: vi.fn().mockResolvedValue({ messageId: 'msg-1' }),
      };

      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [
            {
              id: 'rec-1',
              amount: -15000,
              currency: 'IDR',
              recordType: 'expense',
              recordDate: '2026-11-08T09:00:00Z',
              category: { id: 'cat-1', name: 'Transport' },
              note: 'Ojol',
            },
          ],
          total: 50,
          limit: 10,
          offset: 0,
          page: 1,
          totalPages: 5,
          hasMore: true,
          nextOffset: 10,
          sort: 'newest',
        }),
      };

      const executor = new FinancialActionExecutor(
        {} as any,
        {} as any,
        mockGateway as any,
        mockHistoryService as any
      );

      const whatsappEvent: IncomingUserMessageEvent = {
        channel: 'whatsapp',
        senderIdentifier: '6281234567890',
        chatIdentifier: '6281234567890@c.us',
        messageType: 'text',
        textPayload: 'riwayat',
      };

      await executor.executeTransactionHistory(whatsappEvent, { limit: 10 });

      expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
      const [channel, chatId, messageText, options] = mockGateway.sendMessage.mock.calls[0];

      expect(channel).toBe('whatsapp');
      expect(chatId).toBe('6281234567890@c.us');
      expect(messageText).toContain('_Ketik *riwayat hal 2* untuk halaman selanjutnya._');
      expect(options.replyMarkup).toBeUndefined();
    });
  });

  describe('TelegramMessagingAdapter hist: callback handling', () => {
    const dummyToken = '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';
    const dummyUserId = '123456789';

    it('answers callback on hist:noop without editing message', async () => {
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

      await handlers['callback_query:data']({
        callbackQuery: { data: 'hist:noop' },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      });

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });

    it('edits message in place with formatted page and updated markup on valid hist: callback', async () => {
      const mockHistoryService = {
        getTransactionHistory: vi.fn().mockResolvedValue({
          records: [
            {
              id: 'rec-2',
              amount: -54500,
              currency: 'IDR',
              recordType: 'expense',
              recordDate: '2026-11-07T16:24:00Z',
              category: { id: 'cat-food', name: 'Makan' },
              note: 'GrabFood',
            },
          ],
          total: 3950,
          limit: 10,
          offset: 10,
          page: 2,
          totalPages: 395,
          hasMore: true,
          nextOffset: 20,
          sort: 'newest',
        }),
      } as unknown as TransactionHistoryService;

      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, vi.fn(), {
        transactionHistoryService: mockHistoryService,
      });

      const handlers: Record<string, (ctx: any) => Promise<void>> = {};
      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };
      adapter.setupBotHandlers(mockBot);

      const sessionId = historySessionStore.createSession('123456789', { limit: 10 }, 395);

      const mockEditMessageText = vi.fn().mockResolvedValue({});
      const mockAnswerCallbackQuery = vi.fn().mockResolvedValue({});

      await handlers['callback_query:data']({
        callbackQuery: { data: `hist:${sessionId}:2` },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      });

      expect(mockAnswerCallbackQuery).toHaveBeenCalledTimes(1);
      expect(mockEditMessageText).toHaveBeenCalledTimes(1);
      const [editedText, editOptions] = mockEditMessageText.mock.calls[0];
      expect(editedText).toContain('Hal. 2/395');
      expect(editedText).toContain('GrabFood');
      expect(editedText).not.toContain('Ketik riwayat hal 3');
      expect(editOptions.parse_mode).toBe('HTML');
      expect(editOptions.reply_markup?.inline_keyboard).toBeDefined();
    });

    it('alerts user with toast when history session has expired', async () => {
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

      await handlers['callback_query:data']({
        callbackQuery: { data: 'hist:nonexistent:2' },
        chat: { id: 123456789 },
        from: { id: 123456789 },
        editMessageText: mockEditMessageText,
        answerCallbackQuery: mockAnswerCallbackQuery,
      });

      expect(mockAnswerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('telah berakhir'),
          show_alert: true,
        })
      );
      expect(mockEditMessageText).not.toHaveBeenCalled();
    });
  });
});
