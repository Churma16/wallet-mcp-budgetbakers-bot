import { beforeEach, describe, expect, it } from 'vitest';
import { TransactionCorrelationService } from '../src/services/transactionCorrelationService.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { TransactionEvidence } from '../src/types/transactionCorrelationTypes.js';
import { WalletRecordItem } from '../src/wallet/index.js';

describe('pushNotificationCorrelation', () => {
  let correlationService: TransactionCorrelationService;
  let pendingManager: PendingTransactionService;

  beforeEach(() => {
    correlationService = new TransactionCorrelationService();
    pendingManager = new PendingTransactionService();
  });

  function createDebitItem(overrides: Record<string, any> = {}) {
    return {
      bankDisplayName: 'Bank Jago',
      accountNameHint: 'Jago',
      matchedAccountId: 'acc-jago-1',
      counterParty: 'Jago',
      amount: -15799,
      currency: 'IDR',
      transactionType: 'EXPENSE' as const,
      matchedCategoryId: 'cat-shopping',
      matchedCategoryName: 'Shopping',
      note: 'Debit card transaction of Rp15.799',
      recordDate: '2026-10-31T00:54:00.000Z',
      ...overrides,
    };
  }

  function createEvidence(overrides: Partial<TransactionEvidence> = {}): TransactionEvidence {
    return {
      sourceType: 'EMAIL_BANK',
      sourceId: 'evid-1',
      amount: -15799,
      currency: 'IDR',
      occurredAt: '2026-10-31T00:54:09.000Z',
      merchant: 'Jago',
      note: 'Debit card transaction',
      ...overrides,
    };
  }

  it('Scenario 1: Fuses incoming Bank Email into existing Bank Push Notification pending ticket (same debit)', () => {
    const pushPending = pendingManager.addPendingTransaction(
      createDebitItem({
        sourceType: 'PUSH_NOTIFICATION',
        evidenceSources: ['PUSH_NOTIFICATION'],
      })
    );

    const emailEvidence = createEvidence({
      sourceType: 'EMAIL_BANK',
      referenceNumbers: ['REF-JAGO-12345'],
      accountId: 'acc-jago-1',
      accountHint: 'Jago',
    });

    const correlation = correlationService.correlateEvidence(
      emailEvidence,
      pendingManager.getAllPendingTransactions(),
      []
    );

    expect(correlation.confidence).toBe('HIGH');
    expect(correlation.suggestedAction).toBe('MERGE_PENDING');
    if (correlation.matchTarget.type === 'PENDING_TRANSACTION') {
      expect(correlation.matchTarget.pendingItem.ticketId).toBe(pushPending.ticketId);
    }
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('PUSH_NOTIFICATION');
    expect(correlation.fusedPendingItem?.evidenceSources).toContain('EMAIL_BANK');
    expect(correlation.fusedPendingItem?.referenceNumbers).toContain('REF-JAGO-12345');
  });

  it('Scenario 2: Fuses incoming Bank Push Notification into existing Bank Email pending ticket', () => {
    const emailPending = pendingManager.addPendingTransaction(
      createDebitItem({
        sourceType: 'EMAIL',
        evidenceSources: ['EMAIL_BANK'],
        referenceNumber: 'REF-JAGO-12345',
      })
    );

    const pushEvidence = createEvidence({
      sourceType: 'PUSH_NOTIFICATION',
      accountId: 'acc-jago-1',
      accountHint: 'Jago',
      merchant: 'Tabucci Snack',
      note: 'Pembayaran Rp 15.799 di Tabucci Snack',
    });

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
    pendingManager.addPendingTransaction(
      createDebitItem({
        sourceType: 'PUSH_NOTIFICATION',
        bankDisplayName: 'Bank Mandiri (Livin)',
        accountNameHint: 'Mandiri',
        matchedAccountId: 'acc-mandiri-1',
        counterParty: 'Mandiri',
        amount: -89000,
        recordDate: '2026-10-31T01:00:00.000Z',
        evidenceSources: ['PUSH_NOTIFICATION'],
      })
    );

    const receiptEvidence = createEvidence({
      sourceType: 'RECEIPT',
      amount: -89000,
      occurredAt: '2026-10-31T01:00:30.000Z',
      merchant: 'Shopee',
      note: 'Order #SHP-992123',
    });

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

    const pushEvidence = createEvidence({
      sourceType: 'PUSH_NOTIFICATION',
      accountId: 'acc-jago-1',
      accountHint: 'Jago',
      merchant: 'Tabucci Snack',
    });

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
