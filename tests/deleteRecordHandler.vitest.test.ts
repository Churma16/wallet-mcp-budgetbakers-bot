import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DeleteRecordHandler,
  isRecordDeleteCommand,
} from '../src/core/handlers/deleteRecordHandler.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';
import { MessageDispatcher } from '../src/core/dispatcher.js';
import { createTestAppContext } from './fixtures/testContext.js';
import { applicationLogger } from '../src/lib/logger.js';
import { getDictionary } from '../src/i18n/index.js';
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

  it('sends warning and returns true if replied message has no mapping or expired for explicit hapus', async () => {
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

  it('returns false for generic cancellation "batal" when no record mapping exists to allow downstream handlers', async () => {
    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'batal',
      replyToMessageId: 'msg-unknown',
    };

    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(false);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(mockGateway.sendMessage).not.toHaveBeenCalled();
  });

  it('cancels pending transaction if replied message matches an active pending ticket', async () => {
    const mockPendingService = {
      getAllPendingTransactions: vi.fn().mockReturnValue([
        {
          ticketId: 42,
          counterParty: 'Gojez Store',
          amount: 27000,
          currency: 'IDR',
          transactionType: 'EXPENSE',
          notificationMessageIds: { telegram: 'msg-pending-ticket-42' },
        },
      ]),
      rejectPendingTransaction: vi.fn().mockReturnValue({
        ticketId: 42,
        counterParty: 'Gojez Store',
        amount: 27000,
        currency: 'IDR',
        transactionType: 'EXPENSE',
      }),
    } as any;

    const handlerWithPending = new DeleteRecordHandler(
      mockMcpClient as WalletMcpClientService,
      mockCacheService as WalletCacheService,
      mockGateway as MessagingGatewayService,
      messageStore,
      mockPendingService
    );

    const event: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'batal',
      replyToMessageId: 'msg-pending-ticket-42',
    };

    const handled = await handlerWithPending.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockPendingService.rejectPendingTransaction).toHaveBeenCalledWith(42);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('#42')
    );
  });

  it('prompts for confirmation with inline keyboard when delete command is received and deletes upon confirmation', async () => {
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

    // 1. First reply prompts for confirmation and does NOT delete immediately
    const handled = await handler.handleDeleteRecordReply(event, Date.now());
    expect(handled).toBe(true);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(messageStore.hasMapping('msg-receipt-1')).toBe(true);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Hapus transaksi Makan Malam Sushi?'),
      expect.objectContaining({ replyMarkup: expect.anything() })
    );

    // 2. Confirmation command triggers actual deletion
    const confirmEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_confirm msg-receipt-1',
    };

    const confirmHandled = await handler.handleDeleteConfirmationCommand(confirmEvent);
    expect(confirmHandled).toBe(true);

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

  it('cancels deletion when cancellation command is issued', async () => {
    messageStore.recordMessageMapping('msg-receipt-cancel', {
      recordId: 'rec-cancel',
      accountId: 'acc-bca',
      amount: -50000,
      channel: 'telegram',
    });

    const cancelEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_cancel msg-receipt-cancel',
    };

    const handled = await handler.handleDeleteCancellationCommand(cancelEvent);
    expect(handled).toBe(true);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(messageStore.hasMapping('msg-receipt-cancel')).toBe(true);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('dibatalkan')
    );
  });

  it('handles conversational confirmation "ya" and "batal" for active delete prompts', async () => {
    messageStore.recordMessageMapping('msg-receipt-conv', {
      recordId: 'rec-conv-1',
      accountId: 'acc-bca',
      amount: -25000,
      channel: 'whatsapp',
    });

    // Prompt for confirmation
    await handler.handleDeleteRecordReply({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-conv',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'msg-receipt-conv',
    }, Date.now());

    expect(handler.hasActiveConfirmation('chat-conv')).toBe(true);

    // Cancel conversationally
    const cancelHandled = await handler.handleConversationalReply({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-conv',
      messageType: 'text',
      textPayload: 'batal',
    });

    expect(cancelHandled).toBe(true);
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(handler.hasActiveConfirmation('chat-conv')).toBe(false);

    // Prompt again and confirm conversationally
    await handler.handleDeleteRecordReply({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-conv',
      messageType: 'text',
      textPayload: 'hapus',
      replyToMessageId: 'msg-receipt-conv',
    }, Date.now());

    const confirmHandled = await handler.handleConversationalReply({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-conv',
      messageType: 'text',
      textPayload: 'ya',
    });

    expect(confirmHandled).toBe(true);
    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-conv-1']);
    expect(messageStore.hasMapping('msg-receipt-conv')).toBe(false);
  });

  it('deletes paired transfer transaction deleting both legs atomically upon confirmation', async () => {
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
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();

    const confirmEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_confirm msg-receipt-transfer',
    };

    const confirmHandled = await handler.handleDeleteConfirmationCommand(confirmEvent);
    expect(confirmHandled).toBe(true);

    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-leg-1', 'rec-leg-2']);
    expect(messageStore.hasMapping('msg-receipt-transfer')).toBe(false);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Transfer berhasil dihapus!')
    );
  });

  it('handles deletion errors gracefully and retains mapping in store for retry', async () => {
    const errorSpy = vi.spyOn(applicationLogger, 'error').mockImplementation(() => {});
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

    const confirmEvent: IncomingUserMessageEvent = {
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_confirm msg-error',
    };

    const confirmHandled = await handler.handleDeleteConfirmationCommand(confirmEvent);
    expect(confirmHandled).toBe(true);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('Gagal menghapus transaksi: BudgetBakers API rate limited')
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete record 'rec-error': BudgetBakers API rate limited")
    );
    // Mapping is preserved so user can retry later
    expect(messageStore.hasMapping('msg-error')).toBe(true);
    errorSpy.mockRestore();
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

    // Deletion is not executed immediately, prompt is sent
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'whatsapp',
      'chat-1',
      expect.stringContaining('Hapus transaksi Kopi Kenangan?'),
      expect.anything()
    );

    // Confirm conversationally via "ya"
    await dispatcher.handleIncomingUserMessage({
      channel: 'whatsapp',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: 'ya',
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

  it('handles explicit /delete_confirm and /delete_cancel via MessageDispatcher', async () => {
    const mockMcpClient = {
      deleteRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-dispatch-1', success: true }],
      }),
    };

    const mockGateway = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'reply-del' } as any),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
      clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    };

    const messageStore = new TransactionMessageStore();
    messageStore.recordMessageMapping('receipt-msg-cancel-cmd', {
      recordId: 'rec-cancel-1',
      accountId: 'acc-1',
      amount: -15000,
      channel: 'telegram',
    });
    messageStore.recordMessageMapping('receipt-msg-confirm-cmd', {
      recordId: 'rec-dispatch-1',
      accountId: 'acc-1',
      amount: -30000,
      channel: 'telegram',
    });

    const context = createTestAppContext({
      gateway: mockGateway,
      wallet: {
        client: mockMcpClient,
        cache: {
          getAccounts: () => [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
          getCategories: () => [{ id: 'cat-1', name: 'Makan' }],
        },
        transactionMessages: messageStore,
      },
    });

    const dispatcher = new MessageDispatcher(context);

    // 1. Cancel via command
    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_cancel receipt-msg-cancel-cmd',
    });
    expect(mockMcpClient.deleteRecords).not.toHaveBeenCalled();
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      'telegram',
      'chat-1',
      expect.stringContaining('dibatalkan')
    );

    // 2. Confirm via command
    await dispatcher.handleIncomingUserMessage({
      channel: 'telegram',
      senderIdentifier: 'user-1',
      chatIdentifier: 'chat-1',
      messageType: 'text',
      textPayload: '/delete_confirm receipt-msg-confirm-cmd',
    });
    expect(mockMcpClient.deleteRecords).toHaveBeenCalledWith(['rec-dispatch-1']);
    expect(messageStore.hasMapping('receipt-msg-confirm-cmd')).toBe(false);
  });

  it('renders English locale delete confirm prompt correctly', () => {
    const enDict = getDictionary('en');
    const prompt = enDict.records.deleteConfirmPrompt({
      transactionTitle: 'Coffee at Starbucks',
      formattedAmount: '$5.50',
      accountName: 'Chase Checking',
      categoryName: 'Food & Drinks',
      recordTimestampDisplay: '11/06/2026, 21:00',
      transactionTypeIcon: '💸',
      isTransfer: false,
    });
    expect(prompt).toContain('Delete transaction Coffee at Starbucks?');
    expect(prompt).toContain('Chase Checking');
    expect(prompt).toContain('Confirm delete this transaction?');

    const transferPrompt = enDict.records.deleteConfirmPrompt({
      transactionTitle: 'Transfer',
      formattedAmount: '$500.00',
      accountName: 'Checking',
      destinationAccountName: 'Savings',
      categoryName: 'Transfer',
      recordTimestampDisplay: '11/06/2026, 21:00',
      transactionTypeIcon: '🔄',
      isTransfer: true,
    });
    expect(transferPrompt).toContain('Delete this Transfer?');
    expect(transferPrompt).toContain('Checking ➔ Savings');
  });

});