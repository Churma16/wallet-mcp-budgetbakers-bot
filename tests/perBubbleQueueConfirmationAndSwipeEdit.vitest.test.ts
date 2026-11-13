import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CheckQueueActionHandler } from '../src/core/handlers/readActionHandlers.js';
import { ModifyRecordHandler } from '../src/core/handlers/modifyRecordHandler.js';
import { MessageDispatcher } from '../src/core/dispatcher.js';
import { createTestAppContext } from './fixtures/testContext.js';
import {
  PendingTransactionService,
  PendingTransactionItem,
} from '../src/core/pending.js';
import {
  formatPendingQueueItemCard,
  formatPendingQueueItemFromViewModel,
} from '../src/wallet/formatters/transactionStatusFormatter.js';
import { createTelegramPendingConfirmInlineKeyboard } from '../src/gateway/telegramMenu.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { setActiveLanguage } from '../src/i18n/index.js';

class MockMessagingGateway {
  public readonly messages: Array<{
    channel: string;
    chatId: string;
    content: string;
    options?: any;
  }> = [];
  private nextMessageId = 1000;

  async sendMessage(
    channel: string,
    chatId: string,
    content: string,
    options?: any
  ): Promise<{ messageId: string }> {
    this.messages.push({ channel, chatId, content, options });
    return { messageId: String(this.nextMessageId++) };
  }

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  get lastMessage(): string | undefined {
    return this.messages[this.messages.length - 1]?.content;
  }
}

describe('Per-Bubble Queue Confirmation & Swipe-Reply Edit', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  describe('formatPendingQueueItemCard', () => {
    it('formats a standard expense pending card with clean mobile layout', () => {
      const item: PendingTransactionItem = {
        ticketId: 101,
        sourceType: 'EMAIL',
        bankDisplayName: 'BCA',
        counterParty: 'Kopi Kenangan',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA Prioritas',
        matchedCategoryName: 'Makanan & Minuman',
        note: 'Kopi Kenangan',
        recordDate: '2026-11-12T10:00:00.000Z',
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:00:00.000Z'),
      };

      const card = formatPendingQueueItemCard(item, 'id');
      expect(card).toContain('⏳ *Antrean Transaksi (#101)*');
      expect(card).toContain('Rp 50.000 • BCA Prioritas');
      expect(card).toContain('🏪 Kopi Kenangan');
      expect(card).toContain('🏷️ Makanan & Minuman');
      expect(card).toContain('_Geser (swipe) untuk edit (misal: c: <kategori> atau rek: <akun>)_');
    });

    it('formats an income card with icon and notice', () => {
      const item: PendingTransactionItem = {
        ticketId: 103,
        sourceType: 'EMAIL',
        bankDisplayName: 'BCA',
        counterParty: 'Gaji Kantor',
        amount: 15000000,
        currency: 'IDR',
        transactionType: 'INCOME',
        accountNameHint: 'BCA',
        note: 'Gaji Bulanan',
        isBankSyncedAccount: true,
        recordDate: '2026-11-12T10:00:00.000Z',
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:00:00.000Z'),
      };

      const cardId = formatPendingQueueItemCard(item, 'id');
      expect(cardId).toContain('💰 Rp 15.000.000');
      expect(cardId).toContain('Rekening ini terhubung dengan bank sync Wallet');

      const cardEn = formatPendingQueueItemCard(item, 'en');
      expect(cardEn).toContain('Pending Transaction (#103)');
      expect(cardEn).toContain('This account is synced with Wallet bank sync');
    });

    it('formats a transfer pending card with route display', () => {
      const item: PendingTransactionItem = {
        ticketId: 102,
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: 250000,
        currency: 'IDR',
        transactionType: 'TRANSFER',
        accountNameHint: 'BCA',
        destinationAccountNameHint: 'Bibit Reksadana',
        note: 'Topup Investasi',
        recordDate: '2026-11-12T10:00:00.000Z',
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:00:00.000Z'),
      };

      const card = formatPendingQueueItemCard(item, 'id');
      expect(card).toContain('⏳ *Antrean Transaksi (#102)*');
      expect(card).toContain('🔁 Rp 250.000');
      expect(card).toContain('💳 BCA ➔ Bibit Reksadana');
      expect(card).toContain('📝 Topup Investasi');
      expect(card).toContain('_Geser (swipe) untuk edit');
    });

    it('formats a transfer card without custom destination hint or note', () => {
      const item: PendingTransactionItem = {
        ticketId: 104,
        sourceType: 'NOTIFICATION',
        amount: 100000,
        currency: 'IDR',
        transactionType: 'TRANSFER',
        recordDate: '2026-11-12T10:00:00.000Z',
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        expiresAt: new Date('2026-11-13T10:00:00.000Z'),
      };

      const card = formatPendingQueueItemCard(item, 'id');
      expect(card).toContain('🔁 Rp 100.000');
      expect(card).toContain('💳 Akun');
    });
  });

  describe('formatPendingQueueItemFromViewModel', () => {
    it('formats view model for transfer and non-transfer items with fallbacks', () => {
      const transferVm = {
        ticketId: 201,
        status: 'WAITING_FOR_CONFIRMATION' as const,
        amount: 50000,
        formattedAmount: 'Rp 50.000',
        description: 'Pindah Saldo',
        accountName: 'BCA',
        destinationAccountName: 'Jago',
        isTransfer: true,
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        primaryAction: 'CONFIRM',
        secondaryAction: 'CANCEL',
        sourceKind: 'STANDARD' as const,
      };

      const cardTransfer = formatPendingQueueItemFromViewModel(transferVm, 'id');
      expect(cardTransfer).toContain('⏳ *Antrean Transaksi (#201)*');
      expect(cardTransfer).toContain('💳 BCA ➔ Jago');
      expect(cardTransfer).toContain('📝 Pindah Saldo');

      const expenseVm = {
        ticketId: 202,
        status: 'WAITING_FOR_CONFIRMATION' as const,
        amount: 30000,
        formattedAmount: 'Rp 30.000',
        description: 'Transaksi',
        accountName: 'Mandiri',
        isTransfer: false,
        createdAt: new Date('2026-11-12T10:00:00.000Z'),
        primaryAction: 'CONFIRM',
        secondaryAction: 'CANCEL',
        sourceKind: 'STANDARD' as const,
      };

      const cardExpense = formatPendingQueueItemFromViewModel(expenseVm, 'id');
      expect(cardExpense).toContain('💸 Rp 30.000 • Mandiri');
      expect(cardExpense).toContain('🏷️ Umum');
    });
  });

  describe('createTelegramPendingConfirmInlineKeyboard', () => {
    it('creates Telegram inline keyboard with Ya and Batalkan buttons', () => {
      const keyboard = createTelegramPendingConfirmInlineKeyboard(101, 'id');
      expect(keyboard).toBeDefined();
      const rows = (keyboard as any).inline_keyboard;
      expect(rows).toHaveLength(1);
      expect(rows[0][0].text).toBe('✅ Ya');
      expect(rows[0][0].callback_data).toBe('pending:confirm:101');
      expect(rows[0][1].text).toBe('❌ Batalkan');
      expect(rows[0][1].callback_data).toBe('pending:reject:101');
    });

    it('creates English buttons when language is en', () => {
      const keyboard = createTelegramPendingConfirmInlineKeyboard(101, 'en');
      const rows = (keyboard as any).inline_keyboard;
      expect(rows[0][0].text).toBe('✅ Yes');
      expect(rows[0][1].text).toBe('❌ Cancel');
    });
  });

  describe('CheckQueueActionHandler Per-Bubble Dispatching', () => {
    it('sends individual bubble per pending item and registers message IDs', async () => {
      const pendingService = new PendingTransactionService();
      const gateway = new MockMessagingGateway();

      const item1 = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -45000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        note: 'Makan Bakso',
        recordDate: new Date().toISOString(),
      });

      const item2 = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'Mandiri',
        amount: -100000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'Mandiri',
        note: 'Bensin Pertamina',
        recordDate: new Date().toISOString(),
      });

      const handler = new CheckQueueActionHandler(pendingService, gateway as any);
      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'antrian',
      };

      await handler.execute({
        action: 'CHECK_QUEUE',
        event,
        routingSource: 'FAST_PATH',
        processingStartTimestamp: Date.now(),
      });

      expect(gateway.messages).toHaveLength(2);
      expect(gateway.messages[0].content).toContain(`(#${item1.ticketId})`);
      expect(gateway.messages[0].options?.replyMarkup).toBeDefined();
      expect(gateway.messages[1].content).toContain(`(#${item2.ticketId})`);
      expect(gateway.messages[1].options?.replyMarkup).toBeDefined();

      // Verify notificationMessageIds updated
      const updatedItem1 = pendingService.getPendingTransaction(item1.ticketId);
      expect(updatedItem1?.notificationMessageIds?.telegram).toBe('1000');
    });

    it('caps output at 5 bubbles and sends remaining notice when queue has > 5 items', async () => {
      const pendingService = new PendingTransactionService();
      const gateway = new MockMessagingGateway();

      for (let i = 1; i <= 7; i++) {
        pendingService.addPendingTransaction({
          sourceType: 'NOTIFICATION',
          bankDisplayName: 'BCA',
          amount: -(i * 10000),
          currency: 'IDR',
          transactionType: 'EXPENSE',
          accountNameHint: 'BCA',
          note: `Item ${i}`,
          recordDate: new Date().toISOString(),
        });
      }

      const handler = new CheckQueueActionHandler(pendingService, gateway as any);
      await handler.execute({
        action: 'CHECK_QUEUE',
        event: {
          channel: 'telegram',
          chatIdentifier: '12345678',
          senderIdentifier: 'user_1',
          messageType: 'text',
          textPayload: 'antrian',
        },
        routingSource: 'FAST_PATH',
        processingStartTimestamp: Date.now(),
      });

      // 5 card bubbles + 1 remaining notice bubble = 6 messages
      expect(gateway.messages).toHaveLength(6);
      expect(gateway.messages[5].content).toContain('Masih ada 2 transaksi antrean lainnya');
    });

    it('dispatches to non-telegram channel without replyMarkup and handles additional draft items', async () => {
      const pendingService = new PendingTransactionService();
      const gateway = new MockMessagingGateway();

      pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        note: 'Makan',
        recordDate: new Date().toISOString(),
      });

      pendingService.addPendingAccountSelectionDraft({
        channel: 'whatsapp',
        chatIdentifier: 'chat-wa',
        senderIdentifier: 'user-wa',
        records: [{ amount: -30000, note: 'Buku' } as any],
        candidateAccounts: [{ id: 'acc-1', name: 'BCA' } as any],
      });

      const handler = new CheckQueueActionHandler(pendingService, gateway as any);
      await handler.execute({
        action: 'CHECK_QUEUE',
        event: {
          channel: 'whatsapp',
          chatIdentifier: 'chat-wa',
          senderIdentifier: 'user-wa',
          messageType: 'text',
          textPayload: 'antrian',
        },
        routingSource: 'FAST_PATH',
        processingStartTimestamp: Date.now(),
      });

      // 1 bubble for pending item (no markup) + 1 summary bubble for draft item
      expect(gateway.messages).toHaveLength(2);
      expect(gateway.messages[0].options?.replyMarkup).toBeUndefined();
      expect(gateway.messages[1].content).toContain('pilihan akun');
    });
  });

  describe('ModifyRecordHandler Fallthrough for Pending Items', () => {
    it('returns false and avoids sending recordEditNotFound when replying to a pending bubble', async () => {
      const pendingService = new PendingTransactionService();
      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        note: 'Coffee',
        recordDate: new Date().toISOString(),
      });
      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_pending_999' });

      const gateway = new MockMessagingGateway();
      const messageStore = new TransactionMessageStore();

      const handler = new ModifyRecordHandler(
        {} as any,
        {} as any,
        gateway as any,
        messageStore,
        undefined,
        undefined,
        pendingService
      );

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'c: Makanan n: Kopi Susu',
        replyToMessageId: 'msg_pending_999',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      // Must fall through (return false) so dispatcher can route to pending confirmation handler!
      expect(handled).toBe(false);
      expect(gateway.messages).toHaveLength(0);
    });

    it('sends recordEditNotFound when replying to an unknown message', async () => {
      const pendingService = new PendingTransactionService();
      const gateway = new MockMessagingGateway();
      const messageStore = new TransactionMessageStore();

      const handler = new ModifyRecordHandler(
        {} as any,
        {} as any,
        gateway as any,
        messageStore,
        undefined,
        undefined,
        pendingService
      );

      const event: IncomingUserMessageEvent = {
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'c: Makanan',
        replyToMessageId: 'msg_completely_unknown',
      };

      const handled = await handler.handleModifyRecordReply(event, Date.now());
      expect(handled).toBe(true);
      expect(gateway.messages).toHaveLength(1);
      expect(gateway.messages[0].content).toContain('tidak ditemukan');
    });
  });

  describe('Swipe-Reply Edit & Immediate Submit (Opsi B)', () => {
    it('applies category/note changes and commits transaction immediately on swipe-reply', async () => {
      const gateway = new MockMessagingGateway();
      const pendingService = new PendingTransactionService();
      const mockMcpClient = {
        createRecords: vi.fn().mockResolvedValue({
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ id: 'rec-1', success: true }],
        }),
      };
      const mockCache = {
        getAccounts: () => [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
        getCategories: () => [{ id: 'cat-1', name: 'Makanan' }],
      };

      const context = createTestAppContext({
        gateway: gateway as any,
        pending: pendingService,
        wallet: {
          client: mockMcpClient as any,
          cache: mockCache as any,
          recordPreparation: {
            prepareRecordsForDispatch: async (records: any) => records,
          } as any,
        },
      });

      const dispatcher = new MessageDispatcher(context);

      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -75000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        matchedAccountId: 'acc-1',
        matchedCategoryName: 'General',
        note: 'Resto ABC',
        recordDate: new Date().toISOString(),
      });

      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_bubble_777' });

      // Simulate swipe-reply with modification: "c: Makanan n: Nasi Padang"
      const replyEvent: IncomingUserMessageEvent = {
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'c: Makanan n: Nasi Padang',
        replyToMessageId: 'msg_bubble_777',
      };

      await dispatcher.handleIncomingUserMessage(replyEvent);

      // Verify transaction was resolved/submitted
      expect(pendingService.getPendingTransaction(item.ticketId)).toBeUndefined();
      expect(pendingService.wasTicketRecentlyResolved(item.ticketId)).toBe(true);
      expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    });

    it('handles swipe-reply starting with "e " or "edit " and strips prefix cleanly', async () => {
      const gateway = new MockMessagingGateway();
      const pendingService = new PendingTransactionService();
      const mockMcpClient = {
        createRecords: vi.fn().mockResolvedValue({
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ id: 'rec-1', success: true }],
        }),
      };
      const mockCache = {
        getAccounts: () => [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
        getCategories: () => [{ id: 'cat-1', name: 'Makanan' }],
      };

      const context = createTestAppContext({
        gateway: gateway as any,
        pending: pendingService,
        wallet: {
          client: mockMcpClient as any,
          cache: mockCache as any,
          recordPreparation: {
            prepareRecordsForDispatch: async (records: any) => records,
          } as any,
        },
      });

      const dispatcher = new MessageDispatcher(context);

      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -60000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        matchedAccountId: 'acc-1',
        note: 'Makan',
        recordDate: new Date().toISOString(),
      });

      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_bubble_prefix' });

      await dispatcher.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'e c: Makanan n: Bakso Rudal',
        replyToMessageId: 'msg_bubble_prefix',
      });

      expect(pendingService.getPendingTransaction(item.ticketId)).toBeUndefined();
      expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    });

    it('confirms transaction when swipe-reply says "ya"', async () => {
      const gateway = new MockMessagingGateway();
      const pendingService = new PendingTransactionService();
      const mockMcpClient = {
        createRecords: vi.fn().mockResolvedValue({
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ id: 'rec-1', success: true }],
        }),
      };
      const mockCache = {
        getAccounts: () => [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
        getCategories: () => [{ id: 'cat-1', name: 'Makanan' }],
      };

      const context = createTestAppContext({
        gateway: gateway as any,
        pending: pendingService,
        wallet: {
          client: mockMcpClient as any,
          cache: mockCache as any,
          recordPreparation: {
            prepareRecordsForDispatch: async (records: any) => records,
          } as any,
        },
      });

      const dispatcher = new MessageDispatcher(context);

      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        matchedAccountId: 'acc-1',
        note: 'Kopi',
        recordDate: new Date().toISOString(),
      });

      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_bubble_ya' });

      await dispatcher.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'ya',
        replyToMessageId: 'msg_bubble_ya',
      });

      expect(pendingService.getPendingTransaction(item.ticketId)).toBeUndefined();
      expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    });

    it('cancels pending transaction when swipe-reply says "batal"', async () => {
      const gateway = new MockMessagingGateway();
      const pendingService = new PendingTransactionService();

      const context = createTestAppContext({
        gateway: gateway as any,
        pending: pendingService,
      });

      const dispatcher = new MessageDispatcher(context);

      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        matchedAccountId: 'acc-1',
        note: 'Salah Catat',
        recordDate: new Date().toISOString(),
      });

      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_bubble_888' });

      const replyEvent: IncomingUserMessageEvent = {
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'batal',
        replyToMessageId: 'msg_bubble_888',
      };

      await dispatcher.handleIncomingUserMessage(replyEvent);

      // Verify transaction was canceled/rejected
      expect(pendingService.getPendingTransaction(item.ticketId)).toBeUndefined();
    });

    it('ignores casual conversational replies to pending bubble without structured edit keys', async () => {
      const gateway = new MockMessagingGateway();
      const pendingService = new PendingTransactionService();
      const mockMcpClient = {
        createRecords: vi.fn(),
      };

      const mockBrainProvider = {
        providerName: 'mock',
        analyzeFinancialIntent: vi.fn().mockResolvedValue({
          classification: 'GENERAL_CHAT',
          intentType: 'CHAT',
        }),
      };

      const context = createTestAppContext({
        gateway: gateway as any,
        pending: pendingService,
        brain: {
          provider: mockBrainProvider as any,
        },
        wallet: {
          client: mockMcpClient as any,
          cache: {
            getAccounts: () => [],
            getCategories: () => [],
          } as any,
        },
      });

      const dispatcher = new MessageDispatcher(context);

      const item = pendingService.addPendingTransaction({
        sourceType: 'NOTIFICATION',
        bankDisplayName: 'BCA',
        amount: -50000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
        accountNameHint: 'BCA',
        note: 'Kopi',
        recordDate: new Date().toISOString(),
      });

      pendingService.updateNotificationMessageIds(item.ticketId, { telegram: 'msg_bubble_chat' });

      await dispatcher.handleIncomingUserMessage({
        channel: 'telegram',
        chatIdentifier: '12345678',
        senderIdentifier: 'user_1',
        messageType: 'text',
        textPayload: 'ini transaksi apa ya?',
        replyToMessageId: 'msg_bubble_chat',
      });

      // Transaction MUST NOT be committed as a note
      expect(pendingService.getPendingTransaction(item.ticketId)).toBeDefined();
      expect(mockMcpClient.createRecords).not.toHaveBeenCalled();
    });
  });

  describe('Telegram Interactive Pending Callbacks', () => {
    it('handles pending:confirm:101 callback query and clears markup', async () => {
      const mockOnUserMessageReceived = vi.fn().mockResolvedValue(undefined);
      const adapter = new TelegramMessagingAdapter('dummy-token', '12345678', mockOnUserMessageReceived);
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

      const mockAnswer = vi.fn().mockResolvedValue({});
      const mockEditMarkup = vi.fn().mockResolvedValue({});

      await handlers['callback_query:data']({
        callbackQuery: {
          data: 'pending:confirm:101',
          message: { message_id: 555 },
        },
        chat: { id: 12345678 },
        from: { id: 12345678 },
        answerCallbackQuery: mockAnswer,
        editMessageReplyMarkup: mockEditMarkup,
      });

      expect(mockAnswer).toHaveBeenCalledTimes(1);
      expect(mockEditMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
      expect(mockOnUserMessageReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'telegram',
          textPayload: 'ya #101',
          replyToMessageId: '555',
        })
      );
    });

    it('handles pending:reject:101 callback query and clears markup', async () => {
      const mockOnUserMessageReceived = vi.fn().mockResolvedValue(undefined);
      const adapter = new TelegramMessagingAdapter('dummy-token', '12345678', mockOnUserMessageReceived);
      const handlers: Record<string, (ctx: any) => Promise<void>> = {};

      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          handlers[event] = handler;
        }),
        catch: vi.fn(),
      };

      adapter.setupBotHandlers(mockBot);
      const mockAnswer = vi.fn().mockResolvedValue({});
      const mockEditMarkup = vi.fn().mockResolvedValue({});

      await handlers['callback_query:data']({
        callbackQuery: {
          data: 'pending:reject:101',
          message: { message_id: 777 },
        },
        chat: { id: 12345678 },
        from: { id: 12345678 },
        answerCallbackQuery: mockAnswer,
        editMessageReplyMarkup: mockEditMarkup,
      });

      expect(mockAnswer).toHaveBeenCalledTimes(1);
      expect(mockEditMarkup).toHaveBeenCalledWith({ reply_markup: undefined });
      expect(mockOnUserMessageReceived).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'telegram',
          textPayload: 'batal #101',
          replyToMessageId: '777',
        })
      );
    });
  });
});
