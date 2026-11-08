import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailTransactionHandler } from '../src/core/index.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { TransactionCorrelationEngine, BANK_EMAIL_RULES } from '../src/email/index.js';
import { RuntimeSettingsManager } from '../src/config/runtimeSettingsManager.js';
import { TransactionMessageStore } from '../src/wallet/records/index.js';

describe('Inbound Auto-Record Enriched Transactions Integration', () => {
  const mandiriRule = BANK_EMAIL_RULES.find(r => r.bankKey === 'mandiri')!;
  const blibliRule = BANK_EMAIL_RULES.find(r => r.bankKey === 'blibli')!;

  function createMockAiProvider() {
    return {
      providerName: 'mock-ai',
      processEmailTransactionMessage: vi.fn().mockImplementation((gateResult, subject) => {
        if (subject === 'Pembayaran Berhasil!') {
          return Promise.resolve({
            isTransaction: true,
            transactionType: 'EXPENSE',
            amount: -16700,
            counterParty: 'BLIBLI.COM KUDUS - ID',
            accountNameHint: 'Mandiri Utama',
            matchedAccountId: 'acc-mandiri',
            matchedCategoryId: 'cat-general',
            matchedCategoryName: 'Belanja',
            note: 'Pembayaran QRIS',
            recordDate: '2026-10-14T10:18:00.000Z',
            referenceNumber: 'MANDIRI-REF-100',
            explanation: 'Bank Debit',
          });
        }
        if (subject === 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store') {
          return Promise.resolve({
            isTransaction: true,
            transactionType: 'EXPENSE',
            amount: -16700,
            counterParty: 'Blibli Offline Store',
            accountNameHint: 'Cash',
            matchedAccountId: 'acc-cash',
            matchedCategoryId: 'cat-food',
            matchedCategoryName: 'Makanan & Minuman',
            note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
            recordDate: '2026-10-14T10:19:00.000Z',
            referenceNumber: 'BLIBLI-ORDER-200',
            explanation: 'Merchant receipt with itemized breakdown',
          });
        }
        if (subject === 'Struk Belanja Tanpa Kategori') {
          return Promise.resolve({
            isTransaction: true,
            transactionType: 'EXPENSE',
            amount: -16700,
            counterParty: 'Blibli Offline Store',
            accountNameHint: 'Cash',
            matchedAccountId: 'acc-cash',
            matchedCategoryId: undefined,
            matchedCategoryName: 'Unknown',
            note: 'Barang tidak jelas',
            recordDate: '2026-10-14T10:19:00.000Z',
            referenceNumber: 'BLIBLI-ORDER-200',
            explanation: 'Ambiguous merchant receipt',
          });
        }
        return Promise.resolve(null);
      }),
      processTextMessage: vi.fn(),
      processImageMessage: vi.fn(),
    };
  }

  function createMockWalletCache() {
    return {
      getAccounts: vi.fn().mockReturnValue([
        { id: 'acc-mandiri', name: 'Mandiri Utama', currency: 'IDR', isBankSynced: true },
        { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
      ]),
      getCategories: vi.fn().mockReturnValue([
        { id: 'cat-general', name: 'Belanja' },
        { id: 'cat-food', name: 'Makanan & Minuman' },
      ]),
      getLabels: vi.fn().mockReturnValue([]),
    };
  }

  let mockRuntimeSettingsManager: any;

  beforeEach(() => {
    mockRuntimeSettingsManager = {
      getSettings: vi.fn().mockReturnValue({
        autoRecordEnriched: true,
        categoryResolutionMode: 'ask',
      }),
    };
  });

  it('automatically dispatches to Wallet MCP and resolves ticket when enriched and autoRecordEnriched is true', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = {
      broadcastNotification: vi.fn().mockResolvedValue({ telegram: { messageId: 'msg-101' } }),
      editBroadcastNotification: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const emailListener = {
      recordProcessedTransaction: vi.fn(),
    };
    const correlationService = new TransactionCorrelationEngine();
    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      createRecords: vi.fn().mockResolvedValue({
        results: [{ id: 'rec-wallet-999' }],
      }),
    };
    const mockMessageStore = {
      recordMessageMapping: vi.fn(),
    };

    const handler = new EmailTransactionHandler(
      createMockAiProvider() as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      correlationService,
      () => emailListener as any,
      mockMcpClient as any,
      mockMessageStore as any
    );

    // 1. Initial Bank email arrives -> creates pending ticket #1
    await handler.handleEmailTransactionDetected({
      emailId: 'email-1',
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'no-reply@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: mandiriRule },
      accountNameHint: 'Mandiri Utama',
      emailBodyText: 'Pembayaran QRIS Rp 16.700 di BLIBLI.COM KUDUS - ID Berhasil',
    });

    expect(pendingManager.getAllPendingTransactions().length).toBe(1);
    const initialTicket = pendingManager.getAllPendingTransactions()[0];
    expect(initialTicket.ticketId).toBe(1);

    // Simulate initial broadcast having set notificationMessageIds
    pendingManager.updateNotificationMessageIds(initialTicket.ticketId, {
      telegram: 'msg-bubble-1',
    });

    // Mock settings manager injection via RuntimeSettingsManager singleton
    vi.spyOn(RuntimeSettingsManager, 'getInstance').mockReturnValue({
      getSettings: () => ({ autoRecordEnriched: true }),
    } as any);

    // 2. Merchant receipt arrives -> correlates, enriches, and triggers auto-record!
    await handler.handleEmailTransactionDetected({
      emailId: 'email-2',
      emailSubject: 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store',
      emailSender: 'notification@blibli.com',
      emailDate: new Date('2026-10-14T10:19:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: blibliRule },
      accountNameHint: 'Cash',
      emailBodyText: 'Pesanan Blibli Offline Store: 2x Bakwan Sayur, 1x NASI UDUK + TELUR Rp 16.700',
    });

    // Ticket should now be resolved (no longer in active pending queue)
    expect(pendingManager.getAllPendingTransactions().length).toBe(0);

    // Wallet MCP should have been called with enriched details
    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);
    const createdPayloads = mockMcpClient.createRecords.mock.calls[0][0];
    expect(createdPayloads.length).toBe(1);
    expect(createdPayloads[0]).toMatchObject({
      accountId: 'acc-mandiri',
      categoryId: 'cat-food',
      amount: -16700,
      counterParty: 'Blibli Offline Store',
      note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
    });

    // Notification bubble should have been edited in-place with success message
    expect(messaging.editBroadcastNotification).toHaveBeenCalledTimes(1);
    const editedNotificationText = messaging.editBroadcastNotification.mock.calls[0][1];
    expect(editedNotificationText).toContain('berhasil dicatat!');

    // TransactionMessageStore should have mapped msg-bubble-1 to rec-wallet-999
    expect(mockMessageStore.recordMessageMapping).toHaveBeenCalledWith('msg-bubble-1', expect.objectContaining({
      recordId: 'rec-wallet-999',
      accountId: 'acc-mandiri',
      amount: -16700,
    }));

    // Processed references recorded
    expect(emailListener.recordProcessedTransaction).toHaveBeenCalledWith(undefined, 'BLIBLI-ORDER-200');
  });

  it('falls back to pending queue when autoRecordEnriched is false', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = {
      broadcastNotification: vi.fn().mockResolvedValue({ telegram: { messageId: 'msg-102' } }),
      editBroadcastNotification: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      createRecords: vi.fn().mockResolvedValue({ results: [{ id: 'rec-wallet-100' }] }),
    };

    const handler = new EmailTransactionHandler(
      createMockAiProvider() as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      new TransactionCorrelationEngine(),
      () => null,
      mockMcpClient as any
    );

    // Initial Bank ticket
    await handler.handleEmailTransactionDetected({
      emailId: 'email-1',
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'no-reply@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: mandiriRule },
      accountNameHint: 'Mandiri Utama',
      emailBodyText: 'Pembayaran QRIS Rp 16.700',
    });

    vi.spyOn(RuntimeSettingsManager, 'getInstance').mockReturnValue({
      getSettings: () => ({ autoRecordEnriched: false }),
    } as any);

    // Merchant email arrives
    await handler.handleEmailTransactionDetected({
      emailId: 'email-2',
      emailSubject: 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store',
      emailSender: 'notification@blibli.com',
      emailDate: new Date('2026-10-14T10:19:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: blibliRule },
      accountNameHint: 'Cash',
      emailBodyText: 'Pesanan Blibli Offline Store',
    });

    // Should NOT record to MCP
    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();

    // Ticket remains in pending queue
    expect(pendingManager.getAllPendingTransactions().length).toBe(1);
    const pendingItem = pendingManager.getAllPendingTransactions()[0];
    expect(pendingItem.ticketId).toBe(1);
    expect(pendingItem.counterParty).toBe('Blibli Offline Store');
  });

  it('falls back to pending queue when category is Unknown despite autoRecordEnriched being true', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = {
      broadcastNotification: vi.fn().mockResolvedValue({ telegram: { messageId: 'msg-103' } }),
      editBroadcastNotification: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      createRecords: vi.fn().mockResolvedValue({ results: [{ id: 'rec-wallet-100' }] }),
    };

    const handler = new EmailTransactionHandler(
      createMockAiProvider() as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      new TransactionCorrelationEngine(),
      () => null,
      mockMcpClient as any
    );

    // Initial Bank ticket with generic category
    await handler.handleEmailTransactionDetected({
      emailId: 'email-1',
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'no-reply@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: mandiriRule },
      accountNameHint: 'Mandiri Utama',
      emailBodyText: 'Pembayaran QRIS Rp 16.700',
    });

    // Manually force category to Unknown to test guardrail
    pendingManager.enrichPendingTransaction(1, {
      matchedCategoryId: undefined,
      matchedCategoryName: 'Unknown',
    });

    vi.spyOn(RuntimeSettingsManager, 'getInstance').mockReturnValue({
      getSettings: () => ({ autoRecordEnriched: true }),
    } as any);

    // Merchant email arrives with Unknown category
    await handler.handleEmailTransactionDetected({
      emailId: 'email-3',
      emailSubject: 'Struk Belanja Tanpa Kategori',
      emailSender: 'notification@blibli.com',
      emailDate: new Date('2026-10-14T10:19:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: blibliRule },
      accountNameHint: 'Cash',
      emailBodyText: 'Barang tidak jelas',
    });

    // Should NOT auto-record to MCP because category is Unknown
    expect(mockMcpClient.createRecords).not.toHaveBeenCalled();

    // Ticket remains in pending queue
    expect(pendingManager.getAllPendingTransactions().length).toBe(1);
  });

  it('safely retains ticket in pending queue when MCP createRecords throws an error', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = {
      broadcastNotification: vi.fn().mockResolvedValue({ telegram: { messageId: 'msg-104' } }),
      editBroadcastNotification: vi.fn().mockResolvedValue(true),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      createRecords: vi.fn().mockRejectedValue(new Error('MCP service unavailable')),
    };

    const handler = new EmailTransactionHandler(
      createMockAiProvider() as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      new TransactionCorrelationEngine(),
      () => null,
      mockMcpClient as any
    );

    // Initial Bank ticket
    await handler.handleEmailTransactionDetected({
      emailId: 'email-1',
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'no-reply@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: mandiriRule },
      accountNameHint: 'Mandiri Utama',
      emailBodyText: 'Pembayaran QRIS Rp 16.700',
    });

    vi.spyOn(RuntimeSettingsManager, 'getInstance').mockReturnValue({
      getSettings: () => ({ autoRecordEnriched: true }),
    } as any);

    // Merchant email arrives -> MCP fails
    await handler.handleEmailTransactionDetected({
      emailId: 'email-2',
      emailSubject: 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store',
      emailSender: 'notification@blibli.com',
      emailDate: new Date('2026-10-14T10:19:00.000Z'),
      gateResult: { isFinancialCandidate: true, matchedBankRule: blibliRule },
      accountNameHint: 'Cash',
      emailBodyText: 'Pesanan Blibli Offline Store',
    });

    // createRecords was attempted
    expect(mockMcpClient.createRecords).toHaveBeenCalledTimes(1);

    // But ticket was NOT lost: safely retained in pending queue!
    expect(pendingManager.getAllPendingTransactions().length).toBe(1);
    expect(pendingManager.getAllPendingTransactions()[0].ticketId).toBe(1);
  });
});
