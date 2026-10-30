import { beforeEach, describe, expect, it } from 'vitest';
import { TransactionCorrelationService } from '../src/services/transactionCorrelationService.js';
import { PendingTransactionItem, PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { TransactionEvidence } from '../src/types/transactionCorrelationTypes.js';
import { WalletRecordItem } from '../src/wallet/index.js';

describe('pushNotificationCorrelation', () => {
  let correlationService: TransactionCorrelationService;
  let pendingManager: PendingTransactionService;

  beforeEach(() => {
    correlationService = new TransactionCorrelationService();
    pendingManager = new PendingTransactionService();
  });

  it('Scenario 1: Fuses incoming Bank Email into existing Bank Push Notification pending ticket (same debit)', () => {
    // 1. User receives Bank Jago push notification first -> Pending Ticket #1 is created
    const pushPending = pendingManager.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'Bank Jago',
      accountNameHint: 'Jago',
      matchedAccountId: 'acc-jago-1',
      counterParty: 'Jago',
      amount: -15799,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      matchedCategoryId: 'cat-shopping',
      matchedCategoryName: 'Shopping',
      note: 'Pembayaran Rp 15.799 menggunakan Jago debit card',
      recordDate: '2026-10-31T00:54:00.000Z',
      evidenceSources: ['PUSH_NOTIFICATION'],
    });

    // 2. Bank Jago email arrives 2 minutes later
    const emailEvidence: TransactionEvidence = {
      sourceType: 'EMAIL_BANK',
      sourceId: 'email-jago-msg-1',
      amount: -15799,
      currency: 'IDR',
      occurredAt: '2026-10-31T00:54:09.000Z',
      merchant: 'Jago',
      accountHint: 'Jago',
      accountId: 'acc-jago-1',
      referenceNumbers: ['REF-JAGO-12345'],
      note: 'Debit card transaction of Rp15.799',
      categoryId: 'cat-shopping',
      categoryName: 'Shopping',
    };

    const correlation = correlationService.correlateEvidence(
      emailEvidence,
      pendingManager.getAllPendingTransactions(),
      []
    );

    expect(correlation.confidence).toBe('HIGH');
    expect(correlation.suggestedAction).toBe('MERGE_PENDING');
    expect(correlation.matchTarget.type).toBe('PENDING_TRANSACTION');
    if (correlation.matchTarget.type === 'PENDING_TRANSACTION') {
      expect(correlation.matchTarget.pendingItem.ticketId).toBe(pushPending.ticketId);
    }
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('PUSH_NOTIFICATION');
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('EMAIL_BANK');
    expect(correlation.fusedPendingItem?.referenceNumbers).toContain('REF-JAGO-12345');
  });

  it('Scenario 2: Fuses incoming Bank Push Notification into existing Bank Email pending ticket', () => {
    // 1. Email arrives first -> Pending Ticket #1
    const emailPending = pendingManager.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: 'Bank Jago',
      accountNameHint: 'Jago',
      matchedAccountId: 'acc-jago-1',
      counterParty: 'Jago',
      amount: -15799,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      matchedCategoryId: 'cat-shopping',
      matchedCategoryName: 'Shopping',
      note: 'Debit card transaction of Rp15.799',
      recordDate: '2026-10-31T00:54:09.000Z',
      referenceNumber: 'REF-JAGO-12345',
      evidenceSources: ['EMAIL_BANK'],
    });

    // 2. Push notification arrives 30 seconds later
    const pushEvidence: TransactionEvidence = {
      sourceType: 'PUSH_NOTIFICATION',
      sourceId: 'push-jago-1',
      amount: -15799,
      currency: 'IDR',
      occurredAt: '2026-10-31T00:54:15.000Z',
      accountHint: 'Jago',
      accountId: 'acc-jago-1',
      merchant: 'Jago',
      note: 'Pembayaran Rp 15.799 di Tabucci Snack',
    };

    const correlation = correlationService.correlateEvidence(
      pushEvidence,
      pendingManager.getAllPendingTransactions(),
      []
    );

    expect(correlation.confidence).toBe('HIGH');
    expect(correlation.suggestedAction).toBe('MERGE_PENDING');
    if (correlation.matchTarget.type === 'PENDING_TRANSACTION') {
      expect(correlation.matchTarget.pendingItem.ticketId).toBe(emailPending.ticketId);
    }
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('EMAIL_BANK');
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('PUSH_NOTIFICATION');
  });

  it('Scenario 3: Fuses Bank Push Notification with Merchant Email Receipt', () => {
    // Bank push notification pending
    const pushPending = pendingManager.addPendingTransaction({
      sourceType: 'PUSH_NOTIFICATION',
      bankDisplayName: 'Bank Mandiri (Livin)',
      accountNameHint: 'Mandiri',
      matchedAccountId: 'acc-mandiri-1',
      counterParty: 'Mandiri',
      amount: -89000,
      currency: 'IDR',
      transactionType: 'EXPENSE',
      note: 'Debit rekening Rp 89.000',
      recordDate: '2026-10-31T01:00:00.000Z',
      evidenceSources: ['PUSH_NOTIFICATION'],
    });

    // Merchant email receipt arrives (e.g. Shopee / Grab)
    const receiptEvidence: TransactionEvidence = {
      sourceType: 'RECEIPT',
      amount: -89000,
      currency: 'IDR',
      occurredAt: '2026-10-31T01:00:30.000Z',
      merchant: 'Shopee',
      note: 'Order #SHP-992123',
    };

    const correlation = correlationService.correlateEvidence(
      receiptEvidence,
      pendingManager.getAllPendingTransactions(),
      []
    );

    expect(correlation.confidence).toBe('HIGH');
    expect(correlation.suggestedAction).toBe('MERGE_PENDING');
    expect(correlation.fusedPendingItem?.counterParty).toBe('Shopee');
  });

  it('Scenario 4: Deduplicates Push Notification if transaction is already recorded in Wallet', () => {
    const existingWalletRecords: WalletRecordItem[] = [
      {
        id: 'rec-12345',
        accountId: 'acc-jago-1',
        amount: -15799,
        recordType: 'expense',
        currency: 'IDR',
        recordDate: '2026-10-31T00:54:00.000Z',
        category: { id: 'cat-1', name: 'Shopping' },
        counterParty: 'Tabucci Snack',
        note: 'Sotong 50pcs',
      },
    ];

    const pushEvidence: TransactionEvidence = {
      sourceType: 'PUSH_NOTIFICATION',
      sourceId: 'push-1',
      amount: -15799,
      currency: 'IDR',
      occurredAt: '2026-10-31T00:54:30.000Z',
      accountId: 'acc-jago-1',
      accountHint: 'Jago',
      merchant: 'Tabucci Snack',
    };

    const correlation = correlationService.correlateEvidence(
      pushEvidence,
      [],
      existingWalletRecords
    );

    expect(correlation.confidence).toBe('HIGH');
    expect(correlation.suggestedAction).toBe('ATTACH_WALLET_RECORD');
    expect(correlation.matchTarget.type).toBe('WALLET_RECORD');
  });
});
