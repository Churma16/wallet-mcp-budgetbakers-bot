import { describe, expect, it, vi } from 'vitest';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { WalletMcpClientService } from '../src/wallet/index.js';
import { indonesianDictionary, englishDictionary } from '../src/i18n/index.js';

function createMockEvent(text: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: 'test-chat-jid',
    senderIdentifier: 'test-sender',
    messageType: 'text',
    textPayload: text,
  };
}

describe('Pending Transaction UX & Concurrency Improvements', () => {
  describe('1. Single Notification Badging and Prompts', () => {
    it('always includes ticketId badge (#1) and prompt hints in Indonesian', () => {
      const output = indonesianDictionary.emailPending.formatNotification({
        ticketId: 1,
        bankDisplayName: 'Bank Mandiri',
        typeIcon: '📩',
        formattedAmount: 'Rp 10.500',
        typeLabel: 'Pembayaran',
        formattedTime: '10:04 WIB',
        counterParty: 'BLIBLI.COM KUDUS - ID',
        totalPendingCount: 1,
      });

      expect(output).toContain('BLIBLI.COM KUDUS - ID (#1)');
      expect(output).toContain('Balas *Ya* atau *Catat* (atau *Ya 1*)');
      expect(output).toContain('Balas *Batal* atau *Abaikan* (atau *Batal 1*)');
    });

    it('always includes ticketId badge (#1) and prompt hints in English', () => {
      const output = englishDictionary.emailPending.formatNotification({
        ticketId: 1,
        bankDisplayName: 'Chase Bank',
        typeIcon: '📩',
        formattedAmount: '$10.50',
        typeLabel: 'Payment',
        formattedTime: '10:04 AM',
        counterParty: 'Amazon',
        totalPendingCount: 1,
      });

      expect(output).toContain('Amazon (#1)');
      expect(output).toContain('Reply *Yes* or *Record* (or *Yes 1*)');
      expect(output).toContain('Reply *Cancel* or *Ignore* (or *Cancel 1*)');
    });
  });

  describe('2. FIFO Resolution for Sequential Unnumbered Ya and Numbered Ya N', () => {
    it('resolves bare Ya to oldest ticket and Ya 2 to second ticket without race condition', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const mockWalletClient = {
        createRecords: vi.fn().mockResolvedValue({
          summary: { total: 1, succeeded: 1, failed: 0 },
          results: [{ inputIndex: 0, success: true, recordId: 'rec-123' }],
        }),
      } as unknown as WalletMcpClientService;

      const handler = new PendingActionHandler(
        pendingService,
        mockWalletClient,
        mockGateway,
        () => null
      );

      // Ticket 1: Blibli (created at 10:05)
      const ticket1 = pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'BLIBLI.COM KUDUS - ID',
        amount: -10500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-mandiri',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'BLIBLI.COM KUDUS - ID',
        recordDate: '2026-10-19T03:04:00Z',
      });

      // Ticket 2: Barokah (created at 11:51)
      const ticket2 = pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'BAROKAH JENG SRI',
        amount: -3000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-mandiri',
        matchedCategoryId: 'cat-groceries',
        matchedCategoryName: 'Groceries',
        note: 'BAROKAH JENG SRI',
        recordDate: '2026-10-19T04:50:00Z',
      });

      expect(ticket1.ticketId).toBe(1);
      expect(ticket2.ticketId).toBe(2);

      // User sends "Ya" (unnumbered confirmation) -> Must claim Ticket 1 (FIFO)
      const handledFirst = await handler.handlePendingAction(
        createMockEvent('Ya'),
        { actionType: 'CONFIRM', targetScope: 'LATEST' },
        Date.now()
      );
      expect(handledFirst).toBe(true);
      expect(sentMessages[0]).toContain('(#1)');
      expect(sentMessages[0]).toContain('BLIBLI.COM KUDUS - ID');

      // User sends "Ya 2" (numbered confirmation) -> Claims Ticket 2
      const handledSecond = await handler.handlePendingAction(
        createMockEvent('Ya 2'),
        { actionType: 'CONFIRM', targetScope: 2 },
        Date.now()
      );
      expect(handledSecond).toBe(true);
      expect(sentMessages[1]).toContain('(#2)');
      expect(sentMessages[1]).toContain('BAROKAH JENG SRI');

      // All tickets resolved
      expect(pendingService.hasPendingTransactions()).toBe(false);
    });
  });

  describe('3. Friendly Contextual Feedback for In-Flight and Duplicate Actions', () => {
    it('replies with friendly in-progress status when ticket is already PROCESSING', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'Merchant A',
        amount: -5000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Merchant A',
        recordDate: '2026-10-19T00:00:00Z',
      });

      // Manually claim ticket 1 into PROCESSING state
      pendingService.claimPendingTransaction(1);
      expect(pendingService.isTicketProcessing(1)).toBe(true);

      // Inbound confirmation arrives for ticket 1 while it is still PROCESSING
      await handler.handlePendingAction(
        createMockEvent('Ya 1'),
        { actionType: 'CONFIRM', targetScope: 1 },
        Date.now()
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('⏳ *Transaksi #1 sedang diproses...*');
      expect(sentMessages[0]).not.toContain('[WARN]');
    });

    it('replies with friendly already-recorded status when ticket was recently resolved', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'Merchant A',
        amount: -5000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Merchant A',
        recordDate: '2026-10-19T00:00:00Z',
      });

      // Resolve ticket 1
      pendingService.resolvePendingTransaction(1);
      expect(pendingService.wasTicketRecentlyResolved(1)).toBe(true);

      // Inbound confirmation arrives for ticket 1 after it was already resolved
      await handler.handlePendingAction(
        createMockEvent('Ya 1'),
        { actionType: 'CONFIRM', targetScope: 1 },
        Date.now()
      );

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('ℹ️ *Transaksi #1 sudah berhasil dicatat sebelumnya.*');
      expect(sentMessages[0]).not.toContain('[WARN]');
    });

    it('replies with friendly not-found message when ticket does not exist', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      await handler.handlePendingAction(
        createMockEvent('Ya 99'),
        { actionType: 'CONFIRM', targetScope: 99 },
        Date.now()
      );

      expect(sentMessages[0]).toContain('ℹ️ *Tiket #99 tidak ditemukan atau sudah selesai diproses.*');
      expect(sentMessages[0]).not.toContain('[WARN]');
    });

    it('replies with friendly no-pending message when bare Ya sent with empty queue', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      await handler.handlePendingAction(
        createMockEvent('Ya'),
        { actionType: 'CONFIRM', targetScope: 'LATEST' },
        Date.now()
      );

      expect(sentMessages[0]).toContain('ℹ️ *Tidak ada transaksi yang menunggu konfirmasi saat ini.*');
      expect(sentMessages[0]).not.toContain('[WARN]');
    });
  });

  describe('4. Friendly Rejection Handling', () => {
    it('prevents cancellation and sends friendly notice when ticket is PROCESSING', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'Merchant A',
        amount: -5000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Merchant A',
        recordDate: '2026-10-19T00:00:00Z',
      });

      pendingService.claimPendingTransaction(1);

      await handler.handlePendingAction(
        createMockEvent('Batal 1'),
        { actionType: 'REJECT', targetScope: 1 },
        Date.now()
      );

      expect(sentMessages[0]).toContain('⏳ *Transaksi #1 sedang diproses dan tidak dapat dibatalkan.*');
      expect(sentMessages[0]).not.toContain('[WARN]');
    });

    it('cancels oldest pending transaction when bare Batal is sent', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      const handler = new PendingActionHandler(
        pendingService,
        {} as WalletMcpClientService,
        mockGateway,
        () => null
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'First Merchant',
        amount: -5000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'First Merchant',
        recordDate: '2026-10-19T00:00:00Z',
      });

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Mandiri',
        accountNameHint: 'Mandiri Debit Card',
        counterParty: 'Second Merchant',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-1',
        note: 'Second Merchant',
        recordDate: '2026-10-19T01:00:00Z',
      });

      // Bare Batal cancels ticket 1 (FIFO)
      await handler.handlePendingAction(
        createMockEvent('Batal'),
        { actionType: 'REJECT', targetScope: 'LATEST' },
        Date.now()
      );

      expect(sentMessages[0]).toContain('Transaksi #1 Dibatalkan');
      expect(pendingService.getPendingTransaction(1)).toBeUndefined();
      expect(pendingService.getPendingTransaction(2)).toBeDefined();
    });
  });
});
