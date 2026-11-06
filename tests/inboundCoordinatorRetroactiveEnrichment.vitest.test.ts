import { beforeEach, describe, expect, it, vi } from 'vitest';
import { coordinateInboundTransactionCandidate } from '../src/core/inboundCoordinator.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { TransactionCorrelationService } from '../src/email/index.js';
import { EnrichmentPoolService } from '../src/wallet/records/enrichmentPool.js';
import { TransactionMessageStore } from '../src/wallet/records/transactionMessageStore.js';

describe('InboundCoordinator Retroactive Record Enrichment', () => {
  let pendingManager: PendingTransactionService;
  let correlationService: TransactionCorrelationService;
  let enrichmentPool: EnrichmentPoolService;
  let transactionMessageStore: TransactionMessageStore;

  const mockWalletCache = {
    getAccounts: vi.fn().mockReturnValue([
      { id: 'acc-jago', name: 'Jago Expense', currency: 'IDR' },
      { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
    ]),
    getCategories: vi.fn().mockReturnValue([
      { id: 'cat-unknown', name: 'Unknown expense', isAssignable: true },
      { id: 'cat-ojol', name: 'Ojol', isAssignable: true },
      { id: 'cat-food', name: 'Makanan & Minuman', isAssignable: true },
    ]),
    getLabels: vi.fn().mockReturnValue([]),
  };

  beforeEach(() => {
    pendingManager = new PendingTransactionService();
    correlationService = new TransactionCorrelationService();
    enrichmentPool = new EnrichmentPoolService();
    transactionMessageStore = new TransactionMessageStore();
  });

  it('retroactively patches generic Wallet MCP record, cleans pool, and dismisses dangling push ticket when e-receipt arrives', async () => {
    const recordId = '321f074f-62e6-4319-a34e-f02d82723731';

    // 1. Existing generic record registered in enrichment pool
    enrichmentPool.addCandidate({
      recordId,
      accountId: 'acc-jago',
      accountName: 'Jago Expense',
      amount: -65800,
      currency: 'IDR',
      recordDate: '2026-11-05T18:32:00.000Z',
      counterParty: 'Merchant',
      note: 'Pembayaran kartu debit Bank Jago (Merchant)',
      categoryId: 'cat-unknown',
      categoryName: 'Unknown expense',
    });

    // 2. Dangling push notification ticket created earlier
    const pendingTicket = pendingManager.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'Grab',
      accountNameHint: 'Jago Expense',
      counterParty: 'Grab',
      amount: -65800,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-jago',
      matchedCategoryId: 'cat-ojol',
      matchedCategoryName: 'Ojol',
      note: 'Grab',
      recordDate: '2026-11-05T18:32:00.000Z',
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(1);
    expect(enrichmentPool.size()).toBe(1);

    // 3. Mock MCP client and Gateway
    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      createRecords: vi.fn(),
      patchRecords: vi.fn().mockResolvedValue({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: recordId, success: true }],
      }),
    };

    const mockMessaging = {
      broadcastNotification: vi.fn().mockResolvedValue({ telegram: { messageId: 'msg-enriched-1' } }),
      editBroadcastNotification: vi.fn().mockResolvedValue(false),
      sendMessage: vi.fn(),
    };

    // 4. Late Grab E-Receipt email arrives 49 mins later
    await coordinateInboundTransactionCandidate(
      {
        parsedData: {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: -65800,
          counterParty: 'Grab',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          matchedCategoryId: 'cat-ojol',
          matchedCategoryName: 'Ojol',
          note: 'GrabCar: Kantor ke BSD',
          recordDate: '2026-11-05T18:32:00.000Z',
          explanation: 'Grab e-receipt breakdown',
        },
        gateResult: {
          isCandidate: true,
          matchedBankRule: { bankKey: 'grab', displayName: 'Grab' } as any,
          ruleCategory: 'MERCHANT_RECEIPT' as any,
        },
        sourceType: 'EMAIL',
        evidenceSourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-grab-receipt-1',
        sourceDate: new Date('2026-11-05T19:21:00.000Z'),
        sourceDisplayName: 'Grab',
        fallbackNote: 'Grab E-Receipt',
      },
      {
        walletCacheService: mockWalletCache as any,
        pendingTransactionManager: pendingManager,
        messagingGateway: mockMessaging as any,
        defaultCurrency: 'IDR',
        correlationService,
        walletMcpClient: mockMcpClient as any,
        enrichmentPoolService: enrichmentPool,
        transactionMessageStore,
      }
    );

    // Verify MCP patchRecords was called with enriched fields
    expect(mockMcpClient.patchRecords).toHaveBeenCalledTimes(1);
    expect(mockMcpClient.patchRecords).toHaveBeenCalledWith([
      expect.objectContaining({
        id: recordId,
        counterParty: 'Grab',
        categoryId: 'cat-ojol',
        note: 'GrabCar: Kantor ke BSD',
      }),
    ]);

    // Verify removed from enrichment pool
    expect(enrichmentPool.getCandidate(recordId)).toBeUndefined();
    expect(enrichmentPool.size()).toBe(0);

    // Verify dangling pending ticket #1 was auto-dismissed
    expect(pendingManager.getAllPendingTransactions()).toHaveLength(0);

    // Verify notification broadcasted with updated details
    expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
    const notificationCallArg = mockMessaging.broadcastNotification.mock.calls[0][0];
    expect(notificationCallArg).toContain('berhasil diperbarui!');
    expect(notificationCallArg).toContain('Grab');
    expect(notificationCallArg).toContain('Rp 65.800');
    expect(notificationCallArg).toContain('Ojol');
    expect(notificationCallArg).toContain('GrabCar: Kantor ke BSD');
  });

  it('attempts in-place message edit if original notificationMessageIds is tracked', async () => {
    const recordId = 'rec-edit-test';

    enrichmentPool.addCandidate({
      recordId,
      accountId: 'acc-jago',
      amount: -50000,
      currency: 'IDR',
      recordDate: '2026-11-05T12:00:00.000Z',
      counterParty: 'Merchant',
      note: 'Pembayaran kartu debit',
      notificationMessageIds: { telegram: 'msg-original-42' },
    });

    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      patchRecords: vi.fn().mockResolvedValue({ summary: { total: 1, succeeded: 1 } }),
    };

    const mockMessaging = {
      broadcastNotification: vi.fn(),
      editBroadcastNotification: vi.fn().mockResolvedValue(true),
    };

    await coordinateInboundTransactionCandidate(
      {
        parsedData: {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: -50000,
          counterParty: 'Kopi Kenangan',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          matchedCategoryId: 'cat-food',
          matchedCategoryName: 'Makanan & Minuman',
          note: '2x Kopi Kenangan Mantan',
          recordDate: '2026-11-05T12:00:00.000Z',
          explanation: 'Merchant receipt',
        },
        gateResult: { isCandidate: true },
        sourceType: 'EMAIL',
        evidenceSourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-kopi-1',
        sourceDate: new Date('2026-11-05T12:15:00.000Z'),
        sourceDisplayName: 'Kopi Kenangan',
        fallbackNote: 'Receipt',
      },
      {
        walletCacheService: mockWalletCache as any,
        pendingTransactionManager: pendingManager,
        messagingGateway: mockMessaging as any,
        defaultCurrency: 'IDR',
        correlationService,
        walletMcpClient: mockMcpClient as any,
        enrichmentPoolService: enrichmentPool,
      }
    );

    expect(mockMessaging.editBroadcastNotification).toHaveBeenCalledWith(
      { telegram: 'msg-original-42' },
      expect.stringContaining('berhasil diperbarui!')
    );
    expect(mockMessaging.broadcastNotification).not.toHaveBeenCalled();
  });

  it('skips retroactive patch and sends duplicate advisory when matched record is already fully specific', async () => {
    const existingSpecificRecord = {
      id: 'rec-specific-99',
      accountId: 'acc-jago',
      amount: -120000,
      currency: 'IDR',
      recordDate: '2026-11-05T10:00:00.000Z',
      recordType: 'expense' as const,
      counterParty: 'Uniqlo',
      category: { id: 'cat-fashion', name: 'Pakaian & Belanja' },
      note: 'Kaos Airism Oversized',
    };

    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [existingSpecificRecord] }),
      patchRecords: vi.fn(),
    };

    const mockMessaging = {
      broadcastNotification: vi.fn().mockResolvedValue({}),
      editBroadcastNotification: vi.fn(),
    };

    await coordinateInboundTransactionCandidate(
      {
        parsedData: {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: -120000,
          counterParty: 'Uniqlo',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          matchedCategoryId: 'cat-fashion',
          matchedCategoryName: 'Pakaian & Belanja',
          note: 'Kaos Airism Oversized',
          recordDate: '2026-11-05T10:00:00.000Z',
          explanation: 'Receipt duplicate',
        },
        gateResult: { isCandidate: true },
        sourceType: 'EMAIL',
        evidenceSourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-uniqlo-dup',
        sourceDate: new Date('2026-11-05T10:30:00.000Z'),
        sourceDisplayName: 'Uniqlo',
        fallbackNote: 'Uniqlo Receipt',
      },
      {
        walletCacheService: mockWalletCache as any,
        pendingTransactionManager: pendingManager,
        messagingGateway: mockMessaging as any,
        defaultCurrency: 'IDR',
        correlationService,
        walletMcpClient: mockMcpClient as any,
        enrichmentPoolService: enrichmentPool,
      }
    );

    // MCP patchRecords should NOT be called since record was already specific
    expect(mockMcpClient.patchRecords).not.toHaveBeenCalled();

    // Sends normal duplicate advisory
    expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
    const notifArg = mockMessaging.broadcastNotification.mock.calls[0][0];
    expect(notifArg).toContain('sudah tercatat di Wallet!');
  });

  it('handles patchRecords error gracefully and falls back to duplicate advisory', async () => {
    const recordId = 'rec-err-fallback';

    enrichmentPool.addCandidate({
      recordId,
      accountId: 'acc-jago',
      amount: -45000,
      currency: 'IDR',
      recordDate: '2026-11-05T14:00:00.000Z',
      counterParty: 'Merchant',
    });

    const mockMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({ records: [] }),
      patchRecords: vi.fn().mockRejectedValue(new Error('MCP Server Timeout')),
    };

    const mockMessaging = {
      broadcastNotification: vi.fn().mockResolvedValue({}),
      editBroadcastNotification: vi.fn(),
    };

    await coordinateInboundTransactionCandidate(
      {
        parsedData: {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: -45000,
          counterParty: 'Bakmi GM',
          accountNameHint: 'Jago Expense',
          matchedAccountId: 'acc-jago',
          matchedCategoryId: 'cat-food',
          matchedCategoryName: 'Makanan & Minuman',
          note: 'Bakmi Spesial GM',
          recordDate: '2026-11-05T14:00:00.000Z',
          explanation: 'Bakmi GM receipt',
        },
        gateResult: { isCandidate: true },
        sourceType: 'EMAIL',
        evidenceSourceType: 'EMAIL_PAYMENT',
        sourceId: 'email-bakmi-1',
        sourceDate: new Date('2026-11-05T14:20:00.000Z'),
        sourceDisplayName: 'Bakmi GM',
        fallbackNote: 'Bakmi Receipt',
      },
      {
        walletCacheService: mockWalletCache as any,
        pendingTransactionManager: pendingManager,
        messagingGateway: mockMessaging as any,
        defaultCurrency: 'IDR',
        correlationService,
        walletMcpClient: mockMcpClient as any,
        enrichmentPoolService: enrichmentPool,
      }
    );

    // Fallback broadcast was sent despite patch error
    expect(mockMessaging.broadcastNotification).toHaveBeenCalledTimes(1);
    const notifArg = mockMessaging.broadcastNotification.mock.calls[0][0];
    expect(notifArg).toContain('sudah tercatat di Wallet!');
  });
});
