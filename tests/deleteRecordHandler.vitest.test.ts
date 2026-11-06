import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeleteRecordHandler,
  isRecordDeleteCommand,
} from '../src/core/handlers/deleteRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import { MessageDispatcher } from '../src/core/dispatcher.js';
import { createTestAppContext } from './fixtures/testContext.js';
import type { IncomingUserMessageEvent, MessagingGatewayService } from '../src/gateway/index.js';
import type { WalletCacheService, WalletMcpClientService } from '../src/wallet/index.js';

describe('isRecordDeleteCommand', () => {
  it.each([
    'hapus',
    'HAPUS',
    'delete',
    'DELETE',
    'del',
    'rm',
    'batal',
    'cancel',
    '/hapus',
    '/delete',
    'hapus transaksi',
    'delete transaction',
    'hapus ini',
    'delete this',
    'hapus rekor',
    'batal transaksi',
    'hapus transaksi ini',
    'hapus catatan ini',
    'delete this transaction',
    'hapus!',
    'delete?',
    '   hapus   ',
  ])('matches valid delete command variant: %s', command => {
    expect(isRecordDeleteCommand(command)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'c: Makan',
    't: #jajan',
    'n: Kopi',
    '+50000',
    '-25000',
    'halo bot',
    'hapus dong uang saya kemarin',
    'tolong hapusin ya',
    'mau makan apa',
  ])('does not match non-delete input: %s', input => {
    expect(isRecordDeleteCommand(input)).toBe(false);
  });
});

describe('DeleteRecordHandler', () => {
  let mockMcpClient: Partial<WalletMcpClientService>;
  let mockCacheService: Partial<WalletCacheService>;
  let mockGateway: Partial<MessagingGatewayService>;
  let messageStore: TransactionMessageStore;
  let handler: DeleteRecordHandler;

  beforeEach(() => {
    mockMcpClient = {
      deleteRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-1', success: true }],
      }),
    };

    mockCacheService = {
      getAccounts: vi.fn().mockReturnValue([
        { id: 'acc-bca', name: 'BCA Utama', currency: 'IDR' },
        { id: 'acc-jago', name: 'Jago', currency: 'IDR' },
      ]),
      getCategories: vi.fn().mockReturnValue([
        { id: 'cat-makan', name: 'Makanan & Minuman' },
      ]),
    };

    mockGateway = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'reply-1' } as any),
    };

    messageStore = new TransactionMessageStore();

    handler = new DeleteRecordHandler(
      mockMcpClient as WalletMcpClientService,
      mockCacheService as WalletCacheService,
      mockGateway as MessagingGatewayService,
      messageStore
    );
  });

  it('returns false if event has no replyToMessageId', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'hapus',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
  });

  it('returns false if textPayload is not a delete command', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makanan',
      replyToMessageId: 'msg-original',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
  });

  it('sends warning and returns true if replied message has no mapping or expired', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'msg-unknown',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Transaksi tidak ditemukan atau pesan yang dibalas sudah kedaluwarsa')
    );
  });

  it('deletes single expense transaction, removes store mapping, and sends receipt', async () => {
    messageStore.recordMessageMapping('msg-receipt-1', {
      recordId: 'rec-123',
      accountId: 'acc-bca',
      accountName: 'BCA Utama',
      currency: 'IDR',
      amount: -75000,
      categoryId: 'cat-makan',
      categoryName: 'Makanan & Minuman',
      note: 'Makan Malam Sushi',
      channel: 'telegram',
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'msg-receipt-1',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-123']);
    expect(messageStore.hasMapping('msg-receipt-1')).toBe(false);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('berhasil dihapus!')
    );
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Makan Malam Sushi')
    );
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('BCA Utama')
    );
  });

  it('deletes paired transfer transaction deleting both legs atomically', async () => {
    messageStore.recordMessageMapping('msg-receipt-transfer', {
      recordId: 'rec-leg-1',
      partnerRecordId: 'rec-leg-2',
      isTransfer: true,
      accountId: 'acc-bca',
      accountName: 'BCA Utama',
      currency: 'IDR',
      amount: -500000,
      note: 'Pindah ke Jago',
      channel: 'telegram',
    });

    vi.mocked(mockMcpClient.deleteRecords!).mockResolvedValueOnce({
      summary: { total: 2, succeeded: 2 },
      results: [
        { id: 'rec-leg-1', success: true },
        { id: 'rec-leg-2', success: true },
      ],
    });

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'delete',
      replyToMessageId: 'msg-receipt-transfer',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-leg-1', 'rec-leg-2']);
    expect(messageStore.hasMapping('msg-receipt-transfer')).toBe(false);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Transfer berhasil dihapus!')
    );
  });

  it('handles deletion errors gracefully and retains mapping in store for retry', async () => {
    messageStore.recordMessageMapping('msg-error', {
      recordId: 'rec-error',
      accountId: 'acc-bca',
      amount: -10000,
      channel: 'telegram',
    });

    vi.mocked(mockMcpClient.deleteRecords!).mockRejectedValueOnce(
      new Error('BudgetBakers API rate limited')
    );

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'msg-error',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Gagal menghapus transaksi: BudgetBakers API rate limited')
    );
    // Mapping is preserved so user can retry later
    expect(messageStore.hasMapping('msg-error')).toBe(true);
  });
});

describe('MessageDispatcher delete routing integration', () => {
  it('intercepts reply delete command before pending or AI pipelines', async () => {
    const mockMcpClient = {
      deleteRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-intercept', success: true }],
      }),
    };

    const mockGateway = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'reply-del' } as any),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    };

    const messageStore = new TransactionMessageStore();
    messageStore.recordMessageMapping('receipt-msg-99', {
      recordId: 'rec-intercept',
      accountId: 'acc-1',
      accountName: 'BCA',
      amount: -25000,
      note: 'Kopi Kenangan',
      channel: 'whatsapp',
    });

    const context = createTestAppContext({
      gateway: mockGateway,
      wallet: {
        client: mockMcpClient,
        cache: {
          getAccounts: () => [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
          getCategories: () => [{ id: 'cat-1', name: 'Kopi' }],
        },
        transactionMessages: messageStore,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    await dispatcher.handleIncomingUserMessage({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'receipt-msg-99',
    });

    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-intercept']);
    expect(messageStore.hasMapping('receipt-msg-99')).toBe(false);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'whatsapp',
      'chat-1',
      expect.stringContaining('berhasil dihapus!')
    );
  });
  it('passes through edit commands like "c: Makan t: #jajan n: Kopi" to modifyRecordHandler', async () => {
    const mockModifyRecordHandler = {
      handleModifyRecordReply: vi.fn().mockResolvedValue(true),
    };

    const mockGateway = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'reply-edit' } as any),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    };

    const context = createTestAppContext({
      gateway: mockGateway,
    });

    const dispatcher = new MessageDispatcher(context, {
      modifyRecordHandler: mockModifyRecordHandler as any,
    });

    await dispatcher.handleIncomingUserMessage({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'c: Makan t: #jajan n: Kopi',
      replyToMessageId: 'receipt-msg-101',
    });

    expect(mockModifyRecordHandler.handleModifyRecordReply).toHaveBeenCalled();
  });

});