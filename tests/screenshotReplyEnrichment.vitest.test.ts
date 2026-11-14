import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageDispatcher } from '../src/core/dispatcher.js';
import { createTestAppContext } from './fixtures/testContext.js';
import {
  PendingTransactionService,
  PendingTransactionItem,
} from '../src/core/pending.js';
import { TicketDispatchState } from '../src/brain/constants.js';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { MessagingGatewayService } from '../src/gateway/coordinator.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { setActiveLanguage } from '../src/i18n/index.js';

class MockMessagingGateway {
  public readonly messages: Array<{
    channel: string;
    chatId: string;
    content: string;
    options?: any;
  }> = [];
  public readonly clearedMarkups: Array<Record<string, string>> = [];
  private nextMessageId = 5000;

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

  async clearNotificationReplyMarkup(messageIds?: Record<string, string>): Promise<void> {
    if (messageIds) {
      this.clearedMarkups.push(messageIds);
    }
  }

  get lastMessage(): string | undefined {
    return this.messages[this.messages.length - 1]?.content;
  }
}

describe('Screenshot Reply Enrichment with Auto-Commit (Skenario A - Opsi 1)', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  it('enriches pending transaction with screenshot details and auto-commits to MCP', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ id: 'rec-enriched-1', success: true }],
      }),
    };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-bca', name: 'BCA', currency: 'IDR' }],
      getCategories: () => [
        { id: 'cat-coffee', name: 'Makanan & Minuman' },
        { id: 'cat-transport', name: 'Transportasi' },
      ],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'CREATE_RECORD',
        records: [
          {
            amount: -55000,
            currency: 'IDR',
            counterParty: 'Kopi Kenangan',
            note: '2x Kopi Kenangan Mantan Large',
            categoryId: 'cat-coffee',
            categoryHint: 'Makanan & Minuman',
            labels: ['kopi', 'jajan'],
          },
        ],
        explanation: 'Ekstraksi struk Kopi Kenangan berhasil',
      }),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: {
        provider: mockAiProvider as any,
      },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
        recordPreparation: {
          prepareRecordsForDispatch: async (records: any) => records,
        } as any,
      },
      config: {
        geminiModel: 'gemini-3.5-flash-lite',
        defaultCurrency: 'IDR',
      } as any,
    });

    const dispatcher = new MessageDispatcher(context);

    // Initial pending payment (e.g. from bank push notification QRIS)
    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -55000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      matchedAccountId: 'acc-bca',
      counterParty: 'QRIS',
      note: 'Pembayaran QRIS',
      recordDate: '2026-11-14T04:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_101',
    });

    // Simulate user swipe-replying to the notification bubble with a screenshot
    const imageReplyEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('mock-image-binary-data'),
      imageMimeType: 'image/jpeg',
      textPayload: 'nih struknya',
      replyToMessageId: 'msg_notif_bubble_101',
    };

    await dispatcher.handleIncomingUserMessage(imageReplyEvent);

    // 1. Verify AI Vision was invoked with the image buffer and caption
    expect(mockAiProvider.processImageMessage).toHaveBeenCalledTimes(1);
    expect(mockAiProvider.processImageMessage).toHaveBeenCalledWith(
      imageReplyEvent.imageBuffer,
      'image/jpeg',
      'nih struknya',
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );

    // 2. Verify auto-commit to MCP was executed immediately
    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    const submittedRecords = mockMcpClient.createRecords.mock.calls[0][0];
    expect(submittedRecords).toHaveLength(1);
    expect(submittedRecords[0]).toMatchObject({
      accountId: 'acc-bca',
      amount: -55000,
      categoryId: 'cat-coffee',
      counterParty: 'Kopi Kenangan',
      note: '2x Kopi Kenangan Mantan Large',
    });

    // 3. Verify ticket was resolved in pending manager
    expect(pendingService.getPendingTransaction(pendingItem.ticketId)).toBeUndefined();
    expect(pendingService.wasTicketRecentlyResolved(pendingItem.ticketId)).toBe(true);

    // 4. Verify confirmation success card was sent to user
    expect(gateway.messages.length).toBeGreaterThanOrEqual(1);
    const lastMsg = gateway.lastMessage!;
    expect(lastMsg).toContain('Kopi Kenangan');
    expect(lastMsg).toContain('Rp 55.000');
    expect(lastMsg).toContain('BCA');

    // 5. Verify inline buttons on the old bubble were cleared
    expect(gateway.clearedMarkups).toContainEqual({
      telegram: 'msg_notif_bubble_101',
    });
  });

  it('handles screenshot reply with caption tag overrides and merges labels', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ id: 'rec-2', success: true }],
      }),
    };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-mandiri', name: 'Mandiri', currency: 'IDR' }],
      getCategories: () => [
        { id: 'cat-food', name: 'Makanan' },
        { id: 'cat-office', name: 'Kantor' },
      ],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'CREATE_RECORD',
        records: [
          {
            amount: -75000,
            currency: 'IDR',
            counterParty: 'Ayam Geprek Bu Sri',
            note: 'Paket Ayam Geprek Komplit',
            categoryId: 'cat-food',
            categoryHint: 'Makanan',
            labels: ['reimburse'],
          },
        ],
      }),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: { provider: mockAiProvider as any },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
        recordPreparation: { prepareRecordsForDispatch: async (records: any) => records } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'Mandiri',
      amount: -75000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'Mandiri',
      matchedAccountId: 'acc-mandiri',
      counterParty: 'EDC MANDIRI',
      note: 'Debit Mandiri',
      recordDate: '2026-11-14T04:30:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_102',
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('image-bytes'),
      imageMimeType: 'image/png',
      textPayload: 'makan siang bareng tim #proyek #reimburse',
      replyToMessageId: 'msg_notif_bubble_102',
    });

    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    const record = mockMcpClient.createRecords.mock.calls[0][0][0];
    expect(record.counterParty).toBe('Ayam Geprek Bu Sri');
    expect(record.categoryId).toBe('cat-food');
    expect(pendingService.getPendingTransaction(pendingItem.ticketId)).toBeUndefined();
  });

  it('keeps pending item intact when screenshot extraction returns no valid records', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn(),
    };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-bca', name: 'BCA' }],
      getCategories: () => [{ id: 'cat-1', name: 'Umum' }],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'CREATE_RECORD',
        records: [], // Empty records (e.g. blurry receipt or non-financial photo)
      }),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: { provider: mockAiProvider as any },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -120000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      matchedAccountId: 'acc-bca',
      note: 'Debit BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_103',
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('blurry-image'),
      replyToMessageId: 'msg_notif_bubble_103',
    });

    // Verify MCP createRecords was NOT called
    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();

    // Verify pending item is STILL PENDING and safe
    const stillPending = pendingService.getPendingTransaction(pendingItem.ticketId);
    expect(stillPending).toBeDefined();
    expect(pendingService.getPendingTransactionState(pendingItem.ticketId)).toBe('PENDING');

    // Verify error message was sent
    expect(gateway.lastMessage).toContain('Foto struk belum berhasil dibaca');
  });

  it('notifies user if replied pending ticket was already resolved', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      wallet: {
        client: mockMcpClient as any,
        cache: { getAccounts: () => [], getCategories: () => [] } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -50000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_104',
    });

    // Resolve the ticket beforehand
    pendingService.resolvePendingTransaction(pendingItem.ticketId);

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('late-screenshot'),
      replyToMessageId: 'msg_notif_bubble_104',
    });

    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();
    expect(gateway.lastMessage).toContain('sudah berhasil dicatat sebelumnya');
  });

  it('handles screenshot reply when AI Vision extraction throws an error', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = { createRecords: vi.fn() };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-bca', name: 'BCA' }],
      getCategories: () => [{ id: 'cat-1', name: 'Umum' }],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockRejectedValue(new Error('AI Vision timeout or rate limit')),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: { provider: mockAiProvider as any },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -88000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_105',
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('error-image'),
      replyToMessageId: 'msg_notif_bubble_105',
    });

    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();
    expect(gateway.lastMessage).toContain('Foto struk belum berhasil dibaca');
    expect(pendingService.getPendingTransaction(pendingItem.ticketId)).toBeDefined();
  });

  it('enriches category hint from cachedCategories when receiptRecord only provides categoryId', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ id: 'rec-cat-lookup', success: true }],
      }),
    };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-bca', name: 'BCA', currency: 'IDR' }],
      getCategories: () => [{ id: 'cat-lookup-id', name: 'Kategori Khusus' }],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'CREATE_RECORD',
        records: [
          {
            amount: -30000,
            currency: 'IDR',
            counterParty: 'Toko Kelontong',
            note: 'Sabun & Pasta Gigi',
            categoryId: 'cat-lookup-id',
          },
        ],
      }),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: { provider: mockAiProvider as any },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
        recordPreparation: { prepareRecordsForDispatch: async (records: any) => records } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -30000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_106',
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('receipt-image'),
      replyToMessageId: 'msg_notif_bubble_106',
    });

    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    const rec = mockMcpClient.createRecords.mock.calls[0][0][0];
    expect(rec.categoryId).toBe('cat-lookup-id');
    expect(rec.counterParty).toBe('Toko Kelontong');
  });

  it('handles screenshot reply when ticket state is processing or already resolved', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = { createRecords: vi.fn() };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      wallet: {
        client: mockMcpClient as any,
        cache: { getAccounts: () => [], getCategories: () => [] } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    // 1. Ticket in processing state
    const pendingItemProcessing = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -45000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });
    pendingService.updateNotificationMessageIds(pendingItemProcessing.ticketId, {
      telegram: 'msg_processing_107',
    });
    (pendingService as any).dispatchStateMap.set(
      pendingItemProcessing.ticketId,
      TicketDispatchState.Processing
    );

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('processing-screenshot'),
      replyToMessageId: 'msg_processing_107',
    });

    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();
    expect(gateway.lastMessage).toContain('sedang diproses');

    // 2. Ticket in state other than PENDING or PROCESSING (e.g. Unknown)
    const pendingItemUnknown = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -45000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });
    pendingService.updateNotificationMessageIds(pendingItemUnknown.ticketId, {
      telegram: 'msg_unknown_108',
    });
    (pendingService as any).dispatchStateMap.set(
      pendingItemUnknown.ticketId,
      TicketDispatchState.Unknown
    );

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('unknown-screenshot'),
      replyToMessageId: 'msg_unknown_108',
    });

    expect(gateway.lastMessage).toContain('sudah berhasil dicatat sebelumnya');
  });

  it('returns false and falls through when screenshot reply does not match any pending or resolved message', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = { createRecords: vi.fn() };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: {
        provider: {
          providerName: 'gemini',
          processImageMessage: vi.fn().mockResolvedValue({
            action: 'CREATE_RECORD',
            records: [{ amount: -10000, currency: 'IDR', note: 'Random photo' }],
          }),
        } as any,
      },
      wallet: {
        client: mockMcpClient as any,
        cache: { getAccounts: () => [], getCategories: () => [] } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    // Replying to a normal chat bubble (not a pending notification)
    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('random-image'),
      replyToMessageId: 'non_existent_bubble_999',
    });

    // Because it did not match any pending ticket, it fell through to normal message handling
    expect(context.brain.provider.processImageMessage).toHaveBeenCalled();
  });

  it('handles direct parameter edge cases on handlePendingScreenshotReply', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
    });
    const dispatcher = new MessageDispatcher(context);

    // Missing replyToMessageId or imageBuffer
    const result1 = await (dispatcher as any).handlePendingScreenshotReply(
      { channel: 'telegram', chatIdentifier: '123' },
      Date.now(),
      new Date()
    );
    expect(result1).toBe(false);

    // Missing or invalid pending service
    (dispatcher as any).context.pending = {};
    const result2 = await (dispatcher as any).handlePendingScreenshotReply(
      {
        channel: 'telegram',
        chatIdentifier: '123',
        replyToMessageId: 'msg_999',
        imageBuffer: Buffer.from('test'),
      },
      Date.now(),
      new Date()
    );
    expect(result2).toBe(false);
  });

  it('handles confirmationIntent with unknown customCategoryId gracefully', async () => {
    const gateway = new MockMessagingGateway();
    const pendingService = new PendingTransactionService();
    const mockMcpClient = {
      createRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1, failed: 0 },
        results: [{ id: 'rec-unknown-cat', success: true }],
      }),
    };
    const mockCache = {
      getAccounts: () => [{ id: 'acc-bca', name: 'BCA', currency: 'IDR' }],
      getCategories: () => [{ id: 'cat-existing', name: 'Exist' }],
    };

    const mockAiProvider = {
      providerName: 'gemini',
      processImageMessage: vi.fn().mockResolvedValue({
        action: 'CREATE_RECORD',
        records: [
          {
            amount: -25000,
            currency: 'IDR',
            counterParty: 'Merchant X',
            categoryId: 'cat-not-in-cache',
          },
        ],
      }),
      processTextMessage: vi.fn(),
    };

    const context = createTestAppContext({
      gateway: gateway as any,
      pending: pendingService,
      brain: { provider: mockAiProvider as any },
      wallet: {
        client: mockMcpClient as any,
        cache: mockCache as any,
        recordPreparation: { prepareRecordsForDispatch: async (records: any) => records } as any,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -25000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_notif_bubble_unknown_cat',
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      chatIdentifier: '12345678',
      senderIdentifier: 'user_1',
      messageType: 'image',
      imageBuffer: Buffer.from('test-image'),
      replyToMessageId: 'msg_notif_bubble_unknown_cat',
    });

    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    expect(pendingService.getPendingTransaction(pendingItem.ticketId)).toBeUndefined();
  });
});

describe('TelegramMessagingAdapter clearMessageReplyMarkup', () => {
  it('handles clearing message reply markup with valid and invalid cases', async () => {
    const adapter = new TelegramMessagingAdapter('123:test-token', '12345', vi.fn());

    // 1. Bot instance not initialized
    (adapter as any).botInstance = null;
    expect(await adapter.clearMessageReplyMarkup('12345', '101')).toBe(false);

    // 2. Non-numeric identifiers
    const mockEditMessageReplyMarkup = vi.fn().mockResolvedValue({});
    (adapter as any).botInstance = {
      api: {
        editMessageReplyMarkup: mockEditMessageReplyMarkup,
      },
    };
    expect(await adapter.clearMessageReplyMarkup('abc', '101')).toBe(false);
    expect(await adapter.clearMessageReplyMarkup('12345', 'xyz')).toBe(false);

    // 3. Successful markup clearing
    const successResult = await adapter.clearMessageReplyMarkup('12345', '101');
    expect(successResult).toBe(true);
    expect(mockEditMessageReplyMarkup).toHaveBeenCalledWith(12345, 101, {
      reply_markup: undefined,
    });

    // 4. API rejection / error
    mockEditMessageReplyMarkup.mockRejectedValueOnce(new Error('Telegram API error'));
    const failureResult = await adapter.clearMessageReplyMarkup('12345', '102');
    expect(failureResult).toBe(false);
  });
});

describe('MessagingGatewayService clearNotificationReplyMarkup', () => {
  it('clears markup across adapters and handles empty or failing adapters', async () => {
    const gatewayService = new MessagingGatewayService();

    // 1. Empty or undefined messageIds
    await expect(gatewayService.clearNotificationReplyMarkup()).resolves.toBeUndefined();
    await expect(gatewayService.clearNotificationReplyMarkup({})).resolves.toBeUndefined();

    // 2. Telegram adapter clearing
    const mockTelegramAdapter = {
      channelName: 'telegram',
      normalizedAllowedUserId: '987654',
      clearMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };
    (gatewayService as any).adapterMap.set('telegram', mockTelegramAdapter);

    // 3. Non-telegram adapter (should not attempt clearing)
    const mockOtherAdapter = {
      channelName: 'whatsapp',
      clearMessageReplyMarkup: vi.fn(),
    };
    (gatewayService as any).adapterMap.set('whatsapp', mockOtherAdapter);

    await gatewayService.clearNotificationReplyMarkup({
      telegram: '444',
      whatsapp: '555',
    });

    expect(mockTelegramAdapter.clearMessageReplyMarkup).toHaveBeenCalledWith('987654', '444');
    expect(mockOtherAdapter.clearMessageReplyMarkup).not.toHaveBeenCalled();

    // 4. Adapter throws an error (handled gracefully without throwing)
    mockTelegramAdapter.clearMessageReplyMarkup.mockRejectedValueOnce(new Error('Network failure'));
    await expect(
      gatewayService.clearNotificationReplyMarkup({ telegram: '444' })
    ).resolves.toBeUndefined();
  });
});

describe('PendingTransactionService messageId tracking and expiration', () => {
  it('tracks rejected ticket message IDs and purges them upon expiration', () => {
    const pendingService = new PendingTransactionService();

    const pendingItem = pendingService.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'BCA',
      amount: -15000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      accountNameHint: 'BCA',
      recordDate: '2026-11-14T05:00:00.000Z',
    });

    pendingService.updateNotificationMessageIds(pendingItem.ticketId, {
      telegram: 'msg_reject_track_101',
    });

    // Reject transaction
    const rejectedItem = pendingService.rejectPendingTransaction(pendingItem.ticketId);
    expect(rejectedItem).toBeDefined();

    // Verify lookup by message ID works
    expect(
      pendingService.getRecentlyResolvedTicketIdByMessageId('msg_reject_track_101')
    ).toBe(pendingItem.ticketId);

    // Fast forward timestamp to simulate expiration (> 5 minutes)
    const expiredTimestamp = Date.now() - 6 * 60 * 1000;
    (pendingService as any).recentlyResolvedTicketIds.set(
      pendingItem.ticketId,
      expiredTimestamp
    );

    // Purge expired transactions
    (pendingService as any).purgeExpiredTransactions();

    // Verify it was purged from both recentlyResolved maps
    expect(
      pendingService.getRecentlyResolvedTicketIdByMessageId('msg_reject_track_101')
    ).toBeUndefined();
    expect(
      pendingService.wasTicketRecentlyResolved(pendingItem.ticketId)
    ).toBe(false);
  });
});
