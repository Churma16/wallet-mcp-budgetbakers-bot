import { describe, expect, it, vi } from 'vitest';
import { EmailTransactionHandler } from '../src/handlers/emailTransactionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { TransactionCorrelationService } from '../src/email/index.js';
import { EmailTransactionDetectedEvent } from '../src/email/index.js';
import { BANK_EMAIL_RULES } from '../src/email/index.js';

describe('EmailTransactionHandler Multi-Source Correlation Integration (Issue #153)', () => {
  const mandiriRule = BANK_EMAIL_RULES.find(r => r.bankKey === 'mandiri')!;
  const blibliRule = BANK_EMAIL_RULES.find(r => r.bankKey === 'blibli')!;

  function createMockAiProvider(responses: Record<string, any>) {
    return {
      providerName: 'mock-ai',
      processEmailTransactionMessage: vi.fn().mockImplementation((gateResult, subject) => {
        return Promise.resolve(responses[subject] || {
          isTransaction: true,
          transactionType: 'EXPENSE',
          amount: -16700,
          counterParty: 'Merchant',
          accountNameHint: 'Cash',
          matchedAccountId: 'acc-cash',
          note: subject,
          recordDate: '2026-10-14T10:18:00.000Z',
          explanation: 'Mocked',
        });
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

  function createMockMessaging() {
    return {
      broadcastNotification: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockEmailListener() {
    return {
      recordProcessedTransaction: vi.fn(),
    };
  }

  it('enriches an existing Bank pending ticket when a merchant receipt (Blibli) arrives', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();
    const emailListener = createMockEmailListener();
    const correlationService = new TransactionCorrelationService();

    const mockAi = createMockAiProvider({
      'Pembayaran Berhasil!': {
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
      },
      'Pembayaran QRIS Anda Telah Kami Terima - Offline Store': {
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -16700,
        counterParty: 'Blibli Offline Store',
        accountNameHint: 'Cash',
        matchedAccountId: 'acc-cash',
        matchedCategoryId: 'cat-food',
        matchedCategoryName: 'Makanan & Minuman',
        note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
        recordDate: '2026-10-14T10:18:15.000Z',
        referenceNumber: 'BLIBLI-ORDER-200',
        explanation: 'Blibli Receipt',
      },
    });

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      correlationService,
      () => emailListener as any
    );

    // 1. Mandiri Bank notification arrives first
    const mandiriEvent: EmailTransactionDetectedEvent = {
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      cleanedBodyText: 'Transaksi QRIS berhasil sebesar Rp 16.700',
      gateResult: {
        passed: true,
        matchedBankRule: mandiriRule,
        candidateAmount: 16700,
        referenceNumber: 'MANDIRI-REF-100',
      },
    };

    await handler.handleEmailTransactionDetected(mandiriEvent);

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(1);
    const initialTicket = pendingManager.getAllPendingTransactions()[0];
    expect(initialTicket.ticketId).toBe(1);
    expect(initialTicket.matchedAccountId).toBe('acc-mandiri');
    expect(initialTicket.note).toBe('Pembayaran QRIS');

    // 2. Blibli merchant receipt arrives second
    const blibliEvent: EmailTransactionDetectedEvent = {
      emailSubject: 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store',
      emailSender: 'transaction@blibli.com',
      emailDate: new Date('2026-10-14T10:18:15.000Z'),
      cleanedBodyText: 'Offline Store - Bakwan Sayur, Nasi Uduk. Total: Rp 16.700',
      gateResult: {
        passed: true,
        matchedBankRule: blibliRule,
        candidateAmount: 16700,
        referenceNumber: 'BLIBLI-ORDER-200',
      },
    };

    await handler.handleEmailTransactionDetected(blibliEvent);

    // Must NOT create a second pending ticket!
    const allPending = pendingManager.getAllPendingTransactions();
    expect(allPending).toHaveLength(1);

    const enrichedTicket = allPending[0];
    expect(enrichedTicket.ticketId).toBe(1);
    expect(enrichedTicket.matchedAccountId).toBe('acc-mandiri'); // Retained authoritative bank
    expect(enrichedTicket.counterParty).toBe('Blibli Offline Store'); // Updated to clean merchant name
    expect(enrichedTicket.note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR'); // Rich items!
    expect(enrichedTicket.matchedCategoryName).toBe('Makanan & Minuman'); // Refined specific category
    expect(enrichedTicket.referenceNumbers).toContain('MANDIRI-REF-100');
    expect(enrichedTicket.referenceNumbers).toContain('BLIBLI-ORDER-200');

    // Verify broadcast messaging was called twice (initial + enriched notification)
    expect(messaging.broadcastNotification).toHaveBeenCalledTimes(2);
    const lastBroadcastMessage = messaging.broadcastNotification.mock.calls[1][0];
    expect(lastBroadcastMessage).toContain('Transaksi Diperkaya');
    expect(lastBroadcastMessage).toContain('Bakwan Sayur');

    // Listener registered the Blibli reference to prevent duplicate ingestion
    expect(emailListener.recordProcessedTransaction).toHaveBeenCalledWith(undefined, 'BLIBLI-ORDER-200');
  });

  it('updates account to Bank account when merchant receipt (Blibli) arrives first and Bank arrives second', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();
    const emailListener = createMockEmailListener();
    const correlationService = new TransactionCorrelationService();

    const mockAi = createMockAiProvider({
      'Pembayaran Berhasil!': {
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -16700,
        counterParty: 'BLIBLI.COM KUDUS - ID',
        accountNameHint: 'Mandiri Utama',
        matchedAccountId: 'acc-mandiri',
        matchedCategoryId: 'cat-general',
        matchedCategoryName: 'Belanja',
        note: 'Pembayaran QRIS',
        recordDate: '2026-10-14T10:18:15.000Z',
        referenceNumber: 'MANDIRI-REF-100',
        explanation: 'Bank Debit',
      },
      'Pembayaran QRIS Anda Telah Kami Terima - Offline Store': {
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -16700,
        counterParty: 'Blibli Offline Store',
        accountNameHint: 'Cash',
        matchedAccountId: 'acc-cash',
        matchedCategoryId: 'cat-food',
        matchedCategoryName: 'Makanan & Minuman',
        note: '2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR',
        recordDate: '2026-10-14T10:18:00.000Z',
        referenceNumber: 'BLIBLI-ORDER-200',
        explanation: 'Blibli Receipt',
      },
    });

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      correlationService,
      () => emailListener as any
    );

    // 1. Blibli arrives first
    await handler.handleEmailTransactionDetected({
      emailSubject: 'Pembayaran QRIS Anda Telah Kami Terima - Offline Store',
      emailSender: 'transaction@blibli.com',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      cleanedBodyText: 'Offline Store - Bakwan Sayur, Nasi Uduk. Total: Rp 16.700',
      gateResult: {
        passed: true,
        matchedBankRule: blibliRule,
        candidateAmount: 16700,
        referenceNumber: 'BLIBLI-ORDER-200',
      },
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(1);
    expect(pendingManager.getAllPendingTransactions()[0].matchedAccountId).toBe('acc-cash');

    // 2. Mandiri arrives second
    await handler.handleEmailTransactionDetected({
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:15.000Z'),
      cleanedBodyText: 'Transaksi QRIS berhasil sebesar Rp 16.700',
      gateResult: {
        passed: true,
        matchedBankRule: mandiriRule,
        candidateAmount: 16700,
        referenceNumber: 'MANDIRI-REF-100',
      },
    });

    // Still exactly 1 ticket, with account promoted to Mandiri!
    const allPending = pendingManager.getAllPendingTransactions();
    expect(allPending).toHaveLength(1);
    expect(allPending[0].matchedAccountId).toBe('acc-mandiri');
    expect(allPending[0].counterParty).toBe('Blibli Offline Store');
    expect(allPending[0].note).toBe('2x Bakwan Sayur [1pcs], 1x NASI UDUK + TELUR');
    expect(allPending[0].matchedCategoryName).toBe('Makanan & Minuman');
  });

  it('skips creating pending ticket when transaction is already recorded in native Wallet records', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();
    const emailListener = createMockEmailListener();
    const correlationService = new TransactionCorrelationService();

    const mockAi = createMockAiProvider({
      'Pembayaran Berhasil!': {
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -16700,
        counterParty: 'BLIBLI.COM KUDUS - ID',
        accountNameHint: 'Mandiri Utama',
        matchedAccountId: 'acc-mandiri',
        recordDate: '2026-10-14T10:18:00.000Z',
        referenceNumber: 'MANDIRI-REF-100',
        explanation: 'Bank Debit',
      },
    });

    const mockWalletMcpClient = {
      fetchRecords: vi.fn().mockResolvedValue({
        records: [
          {
            id: 'rec-synced-999',
            accountId: 'acc-mandiri',
            amount: -16700,
            currency: 'IDR',
            recordDate: '2026-10-14T10:17:30.000Z',
            recordType: 'expense',
            counterParty: 'BLIBLI.COM KUDUS - ID',
            source: 'bank_sync',
          },
        ],
      }),
    };

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      correlationService,
      () => emailListener as any,
      mockWalletMcpClient as any
    );

    await handler.handleEmailTransactionDetected({
      emailSubject: 'Pembayaran Berhasil!',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      cleanedBodyText: 'Transaksi QRIS berhasil sebesar Rp 16.700',
      gateResult: {
        passed: true,
        matchedBankRule: mandiriRule,
        candidateAmount: 16700,
        referenceNumber: 'MANDIRI-REF-100',
      },
    });

    // Zero pending tickets created!
    expect(pendingManager.getAllPendingTransactions()).toHaveLength(0);

    // Broadcast notified user that transaction is already recorded
    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('Transaksi Sudah Tercatat')
    );
    expect(emailListener.recordProcessedTransaction).toHaveBeenCalledWith(undefined, 'MANDIRI-REF-100');
  });

  it('exits early when AI Gate 2 classifies email as non-transaction', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();
    const mockAi = {
      processEmailTransactionMessage: vi.fn().mockResolvedValue({
        isTransaction: false,
        explanation: 'Promotional newsletter without real transaction',
      }),
    };

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any
    );

    await handler.handleEmailTransactionDetected({
      emailSubject: 'Promo Akhir Pekan',
      emailSender: 'noreply@bankmandiri.co.id',
      emailDate: new Date(),
      cleanedBodyText: 'Dapatkan promo cashback',
      gateResult: { passed: true, matchedBankRule: mandiriRule },
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(0);
    expect(messaging.broadcastNotification).not.toHaveBeenCalled();
  });

  it('resolves destination account for TRANSFER transactions and handles MCP fetchRecords error gracefully', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();
    const mockAi = {
      processEmailTransactionMessage: vi.fn().mockResolvedValue({
        isTransaction: true,
        transactionType: 'TRANSFER',
        amount: 500000,
        counterParty: 'Self',
        accountNameHint: 'Mandiri Utama',
        matchedAccountId: 'acc-mandiri',
        destinationAccountNameHint: 'Cash',
        matchedDestinationAccountId: undefined,
        note: 'Transfer ke Cash',
        recordDate: '2026-10-14T10:18:00.000Z',
      }),
    };

    const failingWalletMcpClient = {
      fetchRecords: vi.fn().mockRejectedValue(new Error('MCP server connection timeout')),
    };

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any,
      'IDR',
      new TransactionCorrelationService(),
      () => null,
      failingWalletMcpClient as any
    );

    await handler.handleEmailTransactionDetected({
      emailSubject: 'Transfer Berhasil',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:00.000Z'),
      cleanedBodyText: 'Transfer dana ke rekening Cash',
      gateResult: { passed: true, matchedBankRule: mandiriRule },
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(1);
    const item = pendingManager.getAllPendingTransactions()[0];
    expect(item.transactionType).toBe('TRANSFER');
    expect(item.matchedDestinationAccountId).toBe('acc-cash');
    expect(item.destinationAccountNameHint).toBe('Cash');
    expect(messaging.broadcastNotification).toHaveBeenCalled();
  });

  it('marks pending note and includes prompt in broadcast message when correlation result is CLARIFY (Finding 4)', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    // Existing ambiguous pending item
    pendingManager.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: 'Bank',
      accountNameHint: 'Cash',
      matchedAccountId: 'acc-cash',
      counterParty: '',
      amount: -100000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      note: 'Transfer',
      recordDate: '2026-10-14T10:18:00.000Z',
    });

    const mockAi = {
      processEmailTransactionMessage: vi.fn().mockResolvedValue({
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -100000,
        counterParty: '',
        accountNameHint: 'Cash',
        matchedAccountId: 'acc-cash',
        note: 'Transfer',
        recordDate: '2026-10-14T10:18:30.000Z',
      }),
    };

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any
    );

    await handler.handleEmailTransactionDetected({
      emailSubject: 'Notifikasi',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T10:18:30.000Z'),
      cleanedBodyText: 'Nominal Rp 100.000',
      gateResult: { passed: true, matchedBankRule: mandiriRule, candidateAmount: 100000 },
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(2);
    const secondItem = pendingManager.getAllPendingTransactions()[1];
    expect(secondItem.note).toContain('[Klarifikasi: #1]');
    expect(secondItem.clarificationPrompt).toContain('tiket #1');

    // Broadcast message MUST include the clarification warning and prompt
    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('Perlu Klarifikasi')
    );
    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('tiket #1')
    );
  });

  it('includes bank-synced advisory in notification when matched account is bank-synced (Finding 3)', async () => {
    const pendingManager = new PendingTransactionService();
    const messaging = createMockMessaging();

    const mockAi = {
      processEmailTransactionMessage: vi.fn().mockResolvedValue({
        isTransaction: true,
        transactionType: 'EXPENSE',
        amount: -85000,
        counterParty: 'Sushi Tei',
        accountNameHint: 'Mandiri Utama',
        matchedAccountId: 'acc-mandiri',
        note: 'Makan Siang',
        recordDate: '2026-10-14T12:00:00.000Z',
      }),
    };

    const handler = new EmailTransactionHandler(
      mockAi as any,
      createMockWalletCache() as any,
      pendingManager,
      messaging as any
    );

    await handler.handleEmailTransactionDetected({
      emailSubject: 'Notifikasi Transaksi Mandiri',
      emailSender: 'noreply.livin@bankmandiri.co.id',
      emailDate: new Date('2026-10-14T12:00:00.000Z'),
      cleanedBodyText: 'Debit Mandiri Rp 85.000',
      gateResult: { passed: true, matchedBankRule: mandiriRule },
    });

    expect(pendingManager.getAllPendingTransactions()).toHaveLength(1);
    const item = pendingManager.getAllPendingTransactions()[0];
    expect(item.isBankSyncedAccount).toBe(true);

    expect(messaging.broadcastNotification).toHaveBeenCalledWith(
      expect.stringContaining('Rekening ini terhubung dengan bank sync Wallet')
    );
  });
});

