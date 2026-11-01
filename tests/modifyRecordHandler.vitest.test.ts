import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ModifyRecordHandler } from '../src/core/handlers/modifyRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import { PendingTransactionService } from '../src/core/pending.js';
import type { WalletCacheService, WalletMcpClientService, WalletCategoryItem } from '../src/wallet/index.js';
import type { MessagingGatewayService, IncomingUserMessageEvent } from '../src/gateway/index.js';

describe('ModifyRecordHandler', () => {
  let mockClient: WalletMcpClientService;
  let mockCache: WalletCacheService;
  let mockGateway: MessagingGatewayService;
  let store: TransactionMessageStore;
  let pendingService: PendingTransactionService;
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
    pendingService = new PendingTransactionService();

    handler = new ModifyRecordHandler(
      mockClient,
      mockCache,
      mockGateway,
      store,
      pendingService
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

  it('edits a pending ticket when replying to a pending ticket notification', async () => {
    const item = pendingService.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: 'BCA',
      accountNameHint: 'BCA',
      counterParty: 'Merchant',
      amount: -50000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-bca',
      note: 'Old pending note',
      recordDate: '2026-10-22T03:34:03Z',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'n: Updated note c: Transportasi',
      replyToMessageId: 'pending-alert-msg',
      replyToMessageText: `Konfirmasi transaksi Tiket #${item.ticketId}: Rp 50.000`,
    };

    const handled = await handler.handleModifyRecordReply(event, Date.now());
    expect(handled).toBe(true);

    const updated = pendingService.getPendingTransaction(item.ticketId);
    expect(updated?.note).toBe('Updated note');
    expect(updated?.matchedCategoryId).toBe('cat-transport');

    const sentMessage = (mockGateway.sendMessage as any).mock.calls[0][2];
    expect(sentMessage).toContain(`Draft Tiket #${item.ticketId} berhasil diperbarui`);
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
