import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModifyRecordHandler } from '../src/core/handlers/modifyRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import type { WalletCacheService, WalletMcpClientService, WalletCategoryItem } from '../src/wallet/index.js';
import type { MessagingGatewayService, IncomingUserMessageEvent } from '../src/gateway/index.js';

describe('ModifyRecordHandler', () => {
  let mockClient: WalletMcpClientService;
  let mockCache: WalletCacheService;
  let mockGateway: MessagingGatewayService;
  let store: TransactionMessageStore;
  let handler: ModifyRecordHandler;

  const sampleCategories: WalletCategoryItem[] = [
    { id: 'cat-food', name: 'Makanan & Minuman', group: { id: 'food', name: 'Food' }, isAssignable: true },
    { id: 'cat-transport', name: 'Transportasi', group: { id: 'transport', name: 'Transport' }, isAssignable: true },
    { id: 'cat-uncat', name: 'Uncategorized', group: { id: 'system_categories', name: 'System' }, isAssignable: false },
  ];

  beforeEach(() => {
    mockClient = {
      patchRecords: vi.fn(async () => ({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-101', inputIndex: 0, success: true }],
      })),
      createLabel: vi.fn(async (name: string) => ({
        id: `lbl-${name.toLowerCase()}`,
        name,
      })),
    } as unknown as WalletMcpClientService;

    mockCache = {
      getCategories: vi.fn(() => sampleCategories),
      findLabelByName: vi.fn((nameHint: string) => {
        if (nameHint.toLowerCase() === 'jajan') {
          return { id: 'lbl-jajan', name: 'jajan' };
        }
        return undefined;
      }),
      isLabelsLoaded: vi.fn(() => true),
      addLabelToCache: vi.fn(),
    } as unknown as WalletCacheService;

    mockGateway = {
      sendMessage: vi.fn(async () => ({ messageId: 'reply-1' })),
    } as unknown as MessagingGatewayService;

    store = new TransactionMessageStore();

    handler = new ModifyRecordHandler(
      mockClient,
      mockCache,
      mockGateway,
      store
    );
  });

  it('ignores non-reply messages or messages without text', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makan',
      // no replyToMessageId
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();
  });

  it('ignores replies that do not match edit command patterns', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'terima kasih bot',
      replyToMessageId: 'bot-msg-1',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();
  });

  it('successfully patches a recorded transaction on reply with shorthand keys', async () => {
    store.recordMessageMapping('bot-msg-1', {
      recordId: 'rec-101',
      accountId: 'acc-bca',
      note: 'Old note',
      categoryId: 'cat-transport',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makanan & Minuman t: #jajan, #baru n: Kopi Kenangan a: -28000',
      replyToMessageId: 'bot-msg-1',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledTimes(1);
    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-101',
        categoryId: 'cat-food',
        labelIds: ['lbl-jajan', 'lbl-baru'],
        note: 'Kopi Kenangan',
        amount: -28000,
      },
    ]);

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('Transaksi berhasil diperbarui');
    expect(sentMessage).toContain('Makanan & Minuman');
    expect(sentMessage).toContain('Kopi Kenangan');
    expect(sentMessage).toContain('#jajan');
  });

  it('supports explicit prefix `e` on reply', async () => {
    store.recordMessageMapping('bot-msg-2', {
      recordId: 'rec-202',
      accountId: 'acc-bca',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'e c: Transportasi n: Bensin motor',
      replyToMessageId: 'bot-msg-2',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-202',
        categoryId: 'cat-transport',
        note: 'Bensin motor',
      },
    ]);
  });

  it('preserves negative sign for expenses when amount is edited without explicit plus sign', async () => {
    store.recordMessageMapping('bot-msg-exp', {
      recordId: 'rec-exp-1',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: 35000',
      replyToMessageId: 'bot-msg-exp',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-exp-1',
        amount: -35000,
      },
    ]);
  });

  it('allows explicit positive sign on existing expense to convert it to income', async () => {
    store.recordMessageMapping('bot-msg-exp2', {
      recordId: 'rec-exp-2',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: +75000',
      replyToMessageId: 'bot-msg-exp2',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-exp-2',
        amount: 75000,
      },
    ]);
  });

  it('rejects zero amount update with human warning', async () => {
    store.recordMessageMapping('bot-msg-zero', {
      recordId: 'rec-zero',
      accountId: 'acc-bca',
      amount: -50000,
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'a: 0',
      replyToMessageId: 'bot-msg-zero',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('Nominal transaksi tidak boleh bernilai 0');
  });

  it('supports chained edits by recording the new confirmation message ID', async () => {
    store.recordMessageMapping('initial-bot-msg', {
      recordId: 'rec-chain-1',
      accountId: 'acc-bca',
      amount: -20000,
    });

    (mockGateway.sendMessage as any).mockResolvedValueOnce({ messageId: 'confirmation-msg-1' });

    // 1st Edit
    const event1: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Transportasi',
      replyToMessageId: 'initial-bot-msg',
    };
    await handler.handleModifyRecordReply(event1, Date.now());

    // 2nd Edit: user replies to confirmation-msg-1
    const chainedMapping = store.getMessageMapping('confirmation-msg-1');
    expect(chainedMapping).toBeDefined();
    expect(chainedMapping?.recordId).toBe('rec-chain-1');
    expect(chainedMapping?.categoryName).toBe('Transportasi');

    const event2: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: Bensin Shell',
      replyToMessageId: 'confirmation-msg-1',
    };
    const handled2 = await handler.handleModifyRecordReply(event2, Date.now());
    expect(handled2).toBe(true);
    expect(mockClient.patchRecords).toHaveBeenCalledWith([
      {
        id: 'rec-chain-1',
        note: 'Bensin Shell',
      },
    ]);
  });

  it('sends not-found error if reply references an unknown or expired message ID', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makanan',
      replyToMessageId: 'unknown-msg-id',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('tidak ditemukan atau pesan yang dibalas sudah kedaluwarsa');
  });

  it('rejects unassignable or non-existent categories', async () => {
    store.recordMessageMapping('bot-msg-3', {
      recordId: 'rec-303',
      accountId: 'acc-bca',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: KategoriGaib',
      replyToMessageId: 'bot-msg-3',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockClient.patchRecords).not.toHaveBeenCalled();

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('tidak ditemukan atau tidak dapat digunakan');
  });

  it('handles MCP patch failure and informs user', async () => {
    store.recordMessageMapping('bot-msg-4', {
      recordId: 'rec-404',
      accountId: 'acc-bca',
    });

    (mockClient.patchRecords as any).mockRejectedValueOnce(new Error('records.update scope missing'));

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: Catatan baru',
      replyToMessageId: 'bot-msg-4',
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain('Gagal memperbarui transaksi');
    expect(sentMessage).toContain('records.update scope missing');
  });
});
