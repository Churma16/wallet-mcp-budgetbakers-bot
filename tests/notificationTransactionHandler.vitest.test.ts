import { describe, expect, it, vi } from 'vitest';
import { NotificationTransactionHandler } from '../src/handlers/notificationTransactionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { TransactionCorrelationService } from '../src/services/transactionCorrelationService.js';

describe('NotificationTransactionHandler', () => {
  function createMockAiProvider(isTransaction = true, amount = -15799) {
    return {
      providerName: 'mock-ai',
      processEmailTransactionMessage: vi.fn().mockResolvedValue({
        isTransaction,
        transactionType: 'EXPENSE',
        amount,
        counterParty: 'Tabucci Snack',
        accountNameHint: 'Jago',
        matchedAccountId: 'acc-jago',
        matchedCategoryId: 'cat-shopping',
        matchedCategoryName: 'Shopping',
        note: 'Sotong 50pcs',
        recordDate: '2026-10-31T00:54:00.000Z',
        referenceNumber: 'REF-123',
        explanation: 'Mocked parsed transaction',
      }),
      processTextMessage: vi.fn(),
      processImageMessage: vi.fn(),
    };
  }

  function createMockWalletCache() {
    return {
      getAccounts: vi.fn().mockReturnValue([
        { id: 'acc-jago', name: 'Jago', currency: 'IDR', isBankSynced: false },
        { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
      ]),
      getCategories: vi.fn().mockReturnValue([
        { id: 'cat-shopping', name: 'Shopping' },
      ]),
      getLabels: vi.fn().mockReturnValue([]),
    };
  }

  function createMockMessaging() {
    return {
      broadcastNotification: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('skips non-transaction or blacklisted notifications at Gate 1', async () => {
    const aiProvider = createMockAiProvider();
    const walletCache = createMockWalletCache();
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    const handler = new NotificationTransactionHandler(
      aiProvider as any,
      walletCache as any,
      pendingManager,
      messaging as any
    );

    await handler.handleNotificationReceived({
      packageName: 'com.jago',
      title: 'Kode OTP',
      text: 'Kode OTP Anda 123456',
    });

    expect(aiProvider.processEmailTransactionMessage).not.toHaveBeenCalled();
    expect(pendingManager.getAllPendingTransactions().length).toBe(0);
    expect(messaging.broadcastNotification).not.toHaveBeenCalled();
  });

  it('skips notifications when Gate 2 AI determines it is not a transaction', async () => {
    const aiProvider = createMockAiProvider(false);
    const walletCache = createMockWalletCache();
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    const handler = new NotificationTransactionHandler(
      aiProvider as any,
      walletCache as any,
      pendingManager,
      messaging as any
    );

    await handler.handleNotificationReceived({
      packageName: 'com.jago',
      title: 'Informasi Akun',
      text: 'Saldo Anda aman bersama Bank Jago',
    });

    expect(aiProvider.processEmailTransactionMessage).toHaveBeenCalled();
    expect(pendingManager.getAllPendingTransactions().length).toBe(0);
    expect(messaging.broadcastNotification).not.toHaveBeenCalled();
  });

  it('creates pending ticket and broadcasts notification for valid transaction', async () => {
    const aiProvider = createMockAiProvider(true, -15799);
    const walletCache = createMockWalletCache();
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    const handler = new NotificationTransactionHandler(
      aiProvider as any,
      walletCache as any,
      pendingManager,
      messaging as any
    );

    await handler.handleNotificationReceived({
      packageName: 'com.jago',
      title: 'Transaksi Berhasil',
      text: 'Pembayaran Rp 15.799 di Tabucci Snack berhasil',
      timestamp: 1730335000000,
    });

    expect(aiProvider.processEmailTransactionMessage).toHaveBeenCalled();
    const pendingItems = pendingManager.getAllPendingTransactions();
    expect(pendingItems.length).toBe(1);
    expect(pendingItems[0].sourceType).toBe('PUSH_NOTIFICATION');
    expect(pendingItems[0].amount).toBe(-15799);
    expect(pendingItems[0].counterParty).toBe('Tabucci Snack');
    expect(pendingItems[0].matchedAccountId).toBe('acc-jago');
    expect(messaging.broadcastNotification).toHaveBeenCalledTimes(1);
    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('Rp 15.799')
    );
  });

  it('fuses with existing pending ticket when matching transaction is detected', async () => {
    const aiProvider = createMockAiProvider(true, -15799);
    const walletCache = createMockWalletCache();
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    // Pre-existing pending ticket from email
    const existingTicket = pendingManager.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: 'Bank Jago',
      accountNameHint: 'Jago',
      matchedAccountId: 'acc-jago',
      counterParty: 'Jago',
      amount: -15799,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      note: 'Debit card transaction of Rp15.799',
      recordDate: '2026-10-31T00:54:00.000Z',
      evidenceSources: ['EMAIL_BANK'],
    });

    const handler = new NotificationTransactionHandler(
      aiProvider as any,
      walletCache as any,
      pendingManager,
      messaging as any
    );

    // Incoming push notification for same transaction
    await handler.handleNotificationReceived({
      packageName: 'com.jago',
      title: 'Transaksi Berhasil',
      text: 'Pembayaran Rp 15.799 di Tabucci Snack berhasil',
      timestamp: new Date('2026-10-31T00:54:30.000Z').getTime(),
    });

    // Should NOT create duplicate ticket! Still exactly 1 ticket
    const pendingItems = pendingManager.getAllPendingTransactions();
    expect(pendingItems.length).toBe(1);
    expect(pendingItems[0].ticketId).toBe(existingTicket.ticketId);
    expect(pendingItems[0].evidenceSources).toContain('EMAIL_BANK');
    expect(pendingItems[0].evidenceSources).toContain('PUSH_NOTIFICATION');
    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('Transaksi Diperkaya')
    );
  });
});
