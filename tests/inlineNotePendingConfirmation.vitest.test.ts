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
import { formatPendingConfirmationPrompt } from '../src/utils/humanResponseFormatter.js';

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

    it('detects explicit cat: trigger with multi-word category and separate tags', () => {
      const intent = detectPendingConfirmationAction('Ya: makan siang cat:makan nafsu #kantor #reimburse');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
        customNote: 'makan siang',
        customCategoryHint: 'makan nafsu',
        customTags: ['kantor', 'reimburse'],
        rawCustomInput: 'makan siang cat:makan nafsu #kantor #reimburse',
      });
    });

    it('detects explicit cat: trigger with spaces around colon and without tags', () => {
      const intent = detectPendingConfirmationAction('Ya 1: Gemini Pro cat: Pengeluaran Digital');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 1,
        customNote: 'Gemini Pro',
        customCategoryHint: 'Pengeluaran Digital',
        customTags: undefined,
        rawCustomInput: 'Gemini Pro cat: Pengeluaran Digital',
      });
    });

    it('detects explicit cat: trigger alone without custom note', () => {
      const intent = detectPendingConfirmationAction('Ya: cat:Makan Nafsu');
      expect(intent).toEqual<PendingConfirmationIntent>({
        actionType: 'CONFIRM',
        targetScope: 'LATEST',
        customNote: undefined,
        customCategoryHint: 'Makan Nafsu',
        customTags: undefined,
        rawCustomInput: 'cat:Makan Nafsu',
      });
    });

    it('detects kategori: and category: synonyms with optional quotes', () => {
      const intentKategori = detectPendingConfirmationAction('Catat: bakso kategori: "Makan Pokok" #lunch');
      expect(intentKategori?.customNote).toBe('bakso');
      expect(intentKategori?.customCategoryHint).toBe('Makan Pokok');
      expect(intentKategori?.customTags).toEqual(['lunch']);

      const intentCategory = detectPendingConfirmationAction("Ya: coffee category: 'Food & Dining'");
      expect(intentCategory?.customNote).toBe('coffee');
      expect(intentCategory?.customCategoryHint).toBe('Food & Dining');
      expect(intentCategory?.customTags).toBeUndefined();
    });

    it('detects cat: placed after hashtags', () => {
      const intent = detectPendingConfirmationAction('Ya: makan siang #kantor cat:makan nafsu');
      expect(intent?.customNote).toBe('makan siang');
      expect(intent?.customCategoryHint).toBe('makan nafsu');
      expect(intent?.customTags).toEqual(['kantor']);
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

    it('matches category via word boundary pattern when no exact match exists (Priority B)', async () => {
      const pendingService = new PendingTransactionService();
      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return { summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ inputIndex: 0, success: true, recordId: 'r1' }] };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-hangout', name: 'Makan Hangout' },
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
        ]),
        getAccounts: vi.fn(() => []),
      } as unknown as WalletCacheService;

      const handler = new PendingActionHandler(pendingService, mockWalletClient, { sendMessage: vi.fn() } as any, () => null, mockCacheService);

      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago',
        counterParty: 'Store',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'Order',
        recordDate: '2026-10-20T04:27:48Z',
      });

      // "#Nafsu" matches word boundary inside "Makan Nafsu"
      const intent = detectPendingConfirmationAction('Ya: #Nafsu');
      await handler.handlePendingAction(createMockEvent('Ya: #Nafsu'), intent!, Date.now());

      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
    });

    it('matches category via substring fallback (Priority C) and respects alreadySatisfied', async () => {
      const pendingService = new PendingTransactionService();
      let dispatchedRecords: any[] = [];
      const mockWalletClient = {
        createRecords: vi.fn(async (records) => {
          dispatchedRecords = records;
          return { summary: { total: 1, succeeded: 1, failed: 0 }, results: [{ inputIndex: 0, success: true, recordId: 'r2' }] };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-hangout', name: 'Makan Hangout' },
          { id: 'cat-pokok', name: 'Makan Pokok' },
        ]),
        getAccounts: vi.fn(() => []),
      } as unknown as WalletCacheService;

      const handler = new PendingActionHandler(pendingService, mockWalletClient, { sendMessage: vi.fn() } as any, () => null, mockCacheService);

      // Scenario 1: Substring match "#Hang" matches "Makan Hangout"
      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago',
        counterParty: 'Store',
        amount: -10000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        note: 'Order',
        recordDate: '2026-10-20T04:27:48Z',
      });

      const intent1 = detectPendingConfirmationAction('Ya: #Hang');
      await handler.handlePendingAction(createMockEvent('Ya: #Hang'), intent1!, Date.now());
      expect(dispatchedRecords[0].categoryId).toBe('cat-hangout');

      // Scenario 2: alreadySatisfied - Item already has Makan Pokok and user confirms with #Makan
      dispatchedRecords = [];
      pendingService.addPendingTransaction({
        sourceType: 'EMAIL',
        bankDisplayName: 'Grab',
        accountNameHint: 'Jago',
        counterParty: 'Store',
        amount: -15000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-pokok',
        matchedCategoryName: 'Makan Pokok',
        note: 'Order Pokok',
        recordDate: '2026-10-20T04:27:48Z',
      });

      const intent2 = detectPendingConfirmationAction('Ya: #Makan');
      await handler.handlePendingAction(createMockEvent('Ya: #Makan'), intent2!, Date.now());
      // Category remains cat-pokok because Makan Pokok already satisfies the hint "Makan"
      expect(dispatchedRecords[0].categoryId).toBe('cat-pokok');
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

    it('end-to-end: resolves explicit cat: trigger to category and attaches separate tags to Wallet MCP without category duplication', async () => {
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
            results: [{ inputIndex: 0, success: true, recordId: 'rec-cat-test' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
          { id: 'cat-shopping', name: 'Shopping' },
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
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Warung Nasi',
        amount: -45000,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Payment to Warung Nasi',
        recordDate: '2026-10-21T02:00:00Z',
      });

      // User confirms with: "Ya: makan siang cat:makan nafsu #kantor #reimburse"
      const intent = detectPendingConfirmationAction('Ya: makan siang cat:makan nafsu #kantor #reimburse');
      expect(intent).not.toBeNull();

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya: makan siang cat:makan nafsu #kantor #reimburse'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords).toHaveLength(1);
      // Note is overridden to "makan siang"
      expect(dispatchedRecords[0].note).toBe('Makan Siang');
      // Category is resolved to "Makan Nafsu"
      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
      // Labels contain only the explicit tags
      expect(dispatchedRecords[0].labels).toEqual(['kantor', 'reimburse']);
      expect(sentMessages[0]).toContain('📂 Makan Nafsu');
      expect(sentMessages[0]).toContain('🔖 #kantor #reimburse');
    });

    it('end-to-end: resolves explicit cat: trigger without tags and does not add any labels', async () => {
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
            results: [{ inputIndex: 0, success: true, recordId: 'rec-digital' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-digital', name: 'Pengeluaran Digital' },
          { id: 'cat-shopping', name: 'Shopping' },
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
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Google',
        amount: -85470,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Payment to Google',
        recordDate: '2026-10-20T16:26:18Z',
      });

      // User confirms with: "Ya 1: Gemini Pro cat: Pengeluaran Digital"
      const intent = detectPendingConfirmationAction('Ya 1: Gemini Pro cat: Pengeluaran Digital');
      expect(intent).not.toBeNull();
      expect(intent?.targetScope).toBe(1);

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya 1: Gemini Pro cat: Pengeluaran Digital'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords).toHaveLength(1);
      expect(dispatchedRecords[0].note).toBe('Gemini Pro');
      expect(dispatchedRecords[0].categoryId).toBe('cat-digital');
      // Labels MUST be undefined, ensuring no unwanted tags (like #produk) are created
      expect(dispatchedRecords[0].labels).toBeUndefined();
      expect(sentMessages[0]).toContain('📂 Pengeluaran Digital');
      expect(sentMessages[0]).not.toContain('🔖');
    });

    it('end-to-end: preserves existing pending note when only cat: is provided', async () => {
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
            results: [{ inputIndex: 0, success: true, recordId: 'rec-preserve' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
          { id: 'cat-shopping', name: 'Shopping' },
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
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Bank Jago',
        amount: -54500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'GrabFood dari dBestO: 1x Paket Sadas',
        recordDate: '2026-10-20T04:27:48Z',
      });

      // User confirms with: "Ya: cat:Makan Nafsu"
      const intent = detectPendingConfirmationAction('Ya: cat:Makan Nafsu');
      expect(intent).not.toBeNull();

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya: cat:Makan Nafsu'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords).toHaveLength(1);
      // Original note is preserved
      expect(dispatchedRecords[0].note).toBe('GrabFood dari dBestO: 1x Paket Sadas');
      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
      expect(dispatchedRecords[0].labels).toBeUndefined();
    });

    it('end-to-end: legacy #makan nafsu category override does not add makan to labels', async () => {
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
            results: [{ inputIndex: 0, success: true, recordId: 'rec-legacy-nafsu' }],
          };
        }),
      } as unknown as WalletMcpClientService;

      const mockCacheService = {
        getCategories: vi.fn(() => [
          { id: 'cat-nafsu', name: 'Makan Nafsu' },
          { id: 'cat-shopping', name: 'Shopping' },
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
        bankDisplayName: 'Bank Jago',
        accountNameHint: 'Jago Expense',
        counterParty: 'Bank Jago',
        amount: -54500,
        transactionType: 'EXPENSE',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'GrabFood dari dBestO: 1x Paket Sadas',
        recordDate: '2026-10-20T04:27:48Z',
      });

      // User confirms with legacy: "Ya 1: #makan nafsu"
      const intent = detectPendingConfirmationAction('Ya 1: #makan nafsu');
      expect(intent).not.toBeNull();

      const handled = await handler.handlePendingAction(
        createMockEvent('Ya 1: #makan nafsu'),
        intent!,
        Date.now()
      );

      expect(handled).toBe(true);
      expect(dispatchedRecords[0].categoryId).toBe('cat-nafsu');
      // Labels MUST be undefined (not ['makan'])
      expect(dispatchedRecords[0].labels).toBeUndefined();
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

      expect(notifSingle).toContain('Balas *Ya: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');

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

      expect(notifMulti).toContain('Balas *Ya 2: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');
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

      expect(notif).toContain('Reply *Yes: <note> cat:<category> #<tag>* to add details');
    });

    it('formats centralized pending confirmation prompt in Indonesian and English', () => {
      const idSingle = indonesianDictionary.emailPending.formatConfirmationPrompt({
        ticketId: 1,
        totalPendingCount: 1,
      });
      expect(idSingle).toContain('Catat transaksi ini?');
      expect(idSingle).toContain('• Balas *Ya* atau *Catat* (atau *Ya 1*)');
      expect(idSingle).toContain('• Balas *Ya: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');
      expect(idSingle).toContain('• Balas *Batal* atau *Abaikan* (atau *Batal 1*)');

      const idMulti = indonesianDictionary.emailPending.formatConfirmationPrompt({
        ticketId: 5,
        totalPendingCount: 3,
      });
      expect(idMulti).toContain('• Balas *Ya 5* (atau *Ya semua*)');
      expect(idMulti).toContain('• Balas *Ya 5: <catatan> cat:<kategori> #<tag>* untuk tambah rincian');
      expect(idMulti).toContain('• Balas *Batal 5*');
      expect(idMulti).toContain('_Ada 2 transaksi lain yang juga menunggu konfirmasi._');

      const enSingle = englishDictionary.emailPending.formatConfirmationPrompt({
        ticketId: 1,
        totalPendingCount: 1,
      });
      expect(enSingle).toContain('Record this transaction?');
      expect(enSingle).toContain('• Reply *Yes* or *Record* (or *Yes 1*)');
      expect(enSingle).toContain('• Reply *Yes: <note> cat:<category> #<tag>* to add details');
      expect(enSingle).toContain('• Reply *Cancel* or *Ignore* (or *Cancel 1*)');

      const enMulti = englishDictionary.emailPending.formatConfirmationPrompt({
        ticketId: 8,
        totalPendingCount: 4,
      });
      expect(enMulti).toContain('• Reply *Yes 8* (or *Yes all*)');
      expect(enMulti).toContain('• Reply *Yes 8: <note> cat:<category> #<tag>* to add details');
      expect(enMulti).toContain('• Reply *Cancel 8*');
      expect(enMulti).toContain('_There is 3 other transaction waiting for confirmation._');

      const helperId = formatPendingConfirmationPrompt(1, 1, 'id');
      expect(helperId).toBe(idSingle);

      const helperEn = formatPendingConfirmationPrompt(8, 4, 'en');
      expect(helperEn).toBe(enMulti);
    });
  });
});
