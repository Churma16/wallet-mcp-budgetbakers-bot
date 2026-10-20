import { describe, expect, it, vi } from 'vitest';
import {
  detectPendingConfirmationAction,
  PendingConfirmationIntent,
} from '../src/utils/fastPathIntentDetector.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { MessagingGatewayService, IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
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

describe('Inline Note & Category Override on Pending Confirmation', () => {
  describe('1. Intent Detection: detectPendingConfirmationAction', () => {
    it('detects simple inline note without ticket ID', () => {
      const intent = detectPendingConfirmationAction('Ya: Headset Sony');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
        customNote: 'Headset Sony',
        customCategoryHint: undefined,
        customTags: undefined,
        rawCustomInput: 'Headset Sony',
      });
    });

    it('detects inline note with comma or dash separator', () => {
      const commaIntent = detectPendingConfirmationAction('Ya, Headset Sony');
      expect(commaIntent?.customNote).toBe('Headset Sony');
      expect(commaIntent?.targetScope).toBe('LATEST');
      expect(commaIntent?.rawCustomInput).toBe('Headset Sony');

      const dashIntent = detectPendingConfirmationAction('Catat - Beli Kopi');
      expect(dashIntent?.customNote).toBe('Beli Kopi');
      expect(dashIntent?.targetScope).toBe('LATEST');
      expect(dashIntent?.rawCustomInput).toBe('Beli Kopi');
    });

    it('detects inline note with explicit ticket number', () => {
      const intent = detectPendingConfirmationAction('Ya 1: Headset Sony');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 1,
        customNote: 'Headset Sony',
        customCategoryHint: undefined,
        customTags: undefined,
        rawCustomInput: 'Headset Sony',
      });

      const hashTicket = detectPendingConfirmationAction('Ya #2: Casing HP');
      expect(hashTicket?.targetScope).toBe(2);
      expect(hashTicket?.customNote).toBe('Casing HP');
      expect(hashTicket?.rawCustomInput).toBe('Casing HP');
    });

    it('detects inline note with hashtag category override', () => {
      const intent = detectPendingConfirmationAction('Ya: Headset Sony #Elektronik');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
        customNote: 'Headset Sony',
        customCategoryHint: 'Elektronik',
        customTags: ['Elektronik'],
        rawCustomInput: 'Headset Sony #Elektronik',
      });
    });

    it('detects hashtag-only override without note', () => {
      const intent = detectPendingConfirmationAction('Ya #Shopping');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
        customNote: undefined,
        customCategoryHint: 'Shopping',
        customTags: ['Shopping'],
        rawCustomInput: '#Shopping',
      });
    });

    it('preserves existing pure confirmation and cancellation commands', () => {
      expect(detectPendingConfirmationAction('ya')).toEqual({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
      });
      expect(detectPendingConfirmationAction('catat')).toEqual({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
      });
      expect(detectPendingConfirmationAction('ya 1')).toEqual({
        actionType: 'CONFIRM',
        targetScope: 1,
      });
      expect(detectPendingConfirmationAction('ya semua')).toEqual({
        actionType: 'CONFIRM',
        targetScope: 'ALL',
      });
      expect(detectPendingConfirmationAction('batal')).toEqual({
        actionType: 'REJECT',
        targetScope: 'LATEST',
      });
      expect(detectPendingConfirmationAction('batal 2')).toEqual({
        actionType: 'REJECT',
        targetScope: 2,
      });
    });

    it('does not treat new manual expenses as pending confirmations', () => {
      expect(detectPendingConfirmationAction('catat beli bakso 50000')).toBeNull();
      expect(detectPendingConfirmationAction('catat 50rb makan siang')).toBeNull();
      expect(detectPendingConfirmationAction('catat Rp 25.000 bensin')).toBeNull();
    });
  });

  describe('2. End-to-End Handler Execution with Overrides', () => {
    it('overrides note and dispatches to Wallet MCP with custom note and labels', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ inputIndex: 0, success: true, recordId: 'rec-123' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-shopping', name: 'Shopping' },
          { id: 'cat-elektronik', name: 'Elektronik' },
        ]),
        getAccounts: vi.fn(() => [
          { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
        ]),
      } as unknown as WalletCacheService;

      const handler = new PendingActionHandler(
        pendingService,
        mockWalletClient,
        mockGateway,
        () => null,
        mockCacheService
      );

      // Create a pending Shopee transaction with generic note
      const pendingItem = pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Shopee Indonesia',
        amount: -360500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Payment to Shopee Indonesia',
        recordDate: '2026-10-18T17:42:34Z',
      });

      // User confirms with: "Ya: Headset Sony #Elektronik"
      const intent = detectPendingConfirmationAction('Ya: Headset Sony #Elektronik');
      expect(intent).not.toBeNull();

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya: Headset Sony #Elektronik'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(mockWalletClient.createRecords).toHaveBeenCalledTimes(1);

      // Verify dispatched record has updated note, category, and labels
      expect(dispatchedRecords).toHaveLength(1);
      expect(dispatchedRecords[0].note).toBe('Headset Sony');
      expect(dispatchedRecords[0].categoryId).toBe('cat-elektronik');
      expect(dispatchedRecords[0].labels).toEqual(['Elektronik']);

      // Verify success message displays updated note and tag badge
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Headset Sony (Shopee Indonesia)');
      expect(sentMessages[0]).toContain('📂 Elektronik');
      expect(sentMessages[0]).toContain('🔖 #Elektronik');

      // Verify ticket is resolved
      expect(pendingService.getPendingTransaction(pendingItem.ticketId)).toBeUndefined();
    });

    it('matches multi-word category exactly even when earlier category shares substring (e.g. Makan Nafsu vs Makan Hangout)', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ inputIndex: 0, success: true, recordId: 'rec-nafsu' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-hangout', name: 'Makan Hangout' },
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
          { id: 'cat-pokok', name: 'Makan Pokok' },
        ]),
        getAccounts: vi.fn(() => [
          { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
        ]),
      } as unknown as WalletCacheService;

      const handler = new PendingActionHandler(
        pendingService,
        mockWalletClient,
        mockGateway,
        () => null,
        mockCacheService
      );

      // Add dummy Ticket #1 and target Ticket #2
      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Bank Jago',
        amount: -54500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'Debit card transaction',
        recordDate: '2026-10-20T04:00:40Z',
      });

      const grabPending = pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago Expense',
        counterParty: "d'BestO - RSUD Koja",
        amount: -54500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-pokok',
        matchedCategoryName: 'Makan Pokok',
        note: "GrabFood dari d'BestO - RSUD Koja: 1x Paket Sadas",
        recordDate: '2026-10-20T04:27:48Z',
      });

      expect(grabPending.ticketId).toBe(2);

      // User types: "Ya 2: #makan nafsu"
      const intent = detectPendingConfirmationAction('Ya 2: #makan nafsu');
      expect(intent).not.toBeNull();
      expect(intent?.targetScope).toBe(2);

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya 2: #makan nafsu'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords).toHaveLength(1);
      // Category MUST be matched to Makan Nafsu (cat-nafsu), NOT Makan Hangout (cat-hangout)
      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
      // Original rich item note is preserved because the input was recognized as category
      expect(dispatchedRecords[0].note).toBe("GrabFood dari d'BestO - RSUD Koja: 1x Paket Sadas");
      expect(sentMessages[0]).toContain('📂 Makan Nafsu');
    });

    it('supports hyphenated/underscored multi-word category in hashtag (e.g. #makan-nafsu)', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ inputIndex: 0, success: true, recordId: 'rec-nafsu-2' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-hangout', name: 'Makan Hangout' },
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
        ]),
        getAccounts: vi.fn(() => [
          { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
        ]),
      } as unknown as WalletCacheService;

      const handler = new PendingActionHandler(
        pendingService,
        mockWalletClient,
        mockGateway,
        () => null,
        mockCacheService
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago Expense',
        counterParty: "d'BestO",
        amount: -54500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'GrabFood',
        recordDate: '2026-10-20T04:27:48Z',
      });

      const intent = detectPendingConfirmationAction('Ya: #makan-nafsu');
      expect(intent).not.toBeNull();
      expect(intent?.customCategoryHint).toBe('makan nafsu');

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya: #makan-nafsu'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
    });

    it('works with specific ticket number syntax: Ya 1: Headset Sony', async () => {
      const pendingService = new PendingTransactionService();
      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: vi.fn(async (_channel, _chatId, text) => {
          sentMessages.push(text);
        }),
      } as unknown as MessagingGatewayService;

      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return {
            summary: { total: 1, succeeded: 1, failed: 0 },
            results: [{ inputIndex: 0, success: true, recordId: 'rec-124' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const handler = new PendingActionHandler(
        pendingService,
        mockWalletClient,
        mockGateway,
        () => null
      );

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Shopee Indonesia',
        amount: -360500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'Payment to Shopee Indonesia',
        recordDate: '2026-10-18T17:42:34Z',
      });

      const intent = detectPendingConfirmationAction('Ya 1: Headset Sony');
      expect(intent).not.toBeNull();
      expect(intent?.targetScope).toBe(1);

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya 1: Headset Sony'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords[0].note).toBe('Headset Sony');
      expect(sentMessages[0]).toContain('Headset Sony (Shopee Indonesia)');
    });
  });

  describe('3. Notification Formatting Hints', () => {
    it('includes inline note hint in Indonesian notification', () => {
      const notifSingle = indonesianDictionary.emailPending.formatNotification({
        ticketId: 1,
        bankDisplayName: 'Bank Jago',
        typeIcon: '📩',
        formattedAmount: 'Rp 360.500',
        typeLabel: 'Pembayaran',
        formattedTime: '00:42 WIB',
        counterParty: 'Shopee Indonesia',
        totalPendingCount: 1,
      });

      expect(notifSingle).toContain('Balas *Ya: <catatan>* untuk tambah rincian');

      const notifMulti = indonesianDictionary.emailPending.formatNotification({
        ticketId: 2,
        bankDisplayName: 'Bank Jago',
        typeIcon: '📩',
        formattedAmount: 'Rp 360.500',
        typeLabel: 'Pembayaran',
        formattedTime: '00:42 WIB',
        counterParty: 'Shopee Indonesia',
        totalPendingCount: 2,
      });

      expect(notifMulti).toContain('Balas *Ya 2: <catatan>* untuk tambah rincian');
    });

    it('includes inline note hint in English notification', () => {
      const notif = englishDictionary.emailPending.formatNotification({
        ticketId: 1,
        bankDisplayName: 'Chase Bank',
        typeIcon: '📩',
        formattedAmount: '$36.50',
        typeLabel: 'Payment',
        formattedTime: '12:42 AM',
        counterParty: 'Amazon',
        totalPendingCount: 1,
      });

      expect(notif).toContain('Reply *Yes: <note>* to add details');
    });
  });
});
