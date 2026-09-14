import { describe, expect, it } from 'vitest';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';

function addTransaction(service: PendingTransactionService, suffix = '1') {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Main',
    counterParty: `Merchant ${suffix}`,
    amount: 25000,
    transactionType: 'EXPENSE',
    matchedAccountId: `acc-${suffix}`,
    matchedCategoryId: 'cat-food',
    matchedCategoryName: 'Food',
    note: `Transaction ${suffix}`,
    recordDate: '2026-09-13',
    currency: 'IDR',
  });
}

function addDraft(
  service: PendingTransactionService,
  suffix = '1',
  scope: { channel?: 'whatsapp' | 'telegram'; chat?: string; sender?: string } = {}
) {
  return service.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: scope.channel ?? 'whatsapp',
    chatIdentifier: scope.chat ?? 'chat-1',
    senderIdentifier: scope.sender ?? 'sender-1',
    records: [
      {
        accountId: '',
        amount: -35000,
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: `Draft ${suffix}`,
      },
    ],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: [
      { id: `acc-${suffix}`, name: `Account ${suffix}`, currency: 'IDR' },
    ],
    sourceUserText: `draft ${suffix}`,
  });
}

describe('PR #155 PendingTransactionService state branch coverage', () => {
  it('covers scoped account-draft lookup, latest ordering, and empty paths', () => {
    const service = new PendingTransactionService();

    expect(service.getLatestPendingTransaction()).toBeUndefined();
    expect(service.getLatestPendingAccountSelectionDraft('whatsapp', 'chat-1', 'sender-1')).toBeUndefined();
    expect(service.hasPendingAccountSelectionDrafts()).toBe(false);
    expect(service.hasPendingAccountSelectionDrafts('whatsapp', 'chat-1', 'sender-1')).toBe(false);

    const first = addDraft(service, '1');
    addDraft(service, '2', { chat: 'other-chat' });
    const latestMatching = addDraft(service, '3');

    expect(service.hasPendingAccountSelectionDrafts()).toBe(true);
    expect(service.hasPendingAccountSelectionDrafts('whatsapp', 'chat-1', 'sender-1')).toBe(true);
    expect(service.hasPendingAccountSelectionDrafts('whatsapp', 'missing', 'sender-1')).toBe(false);
    expect(service.hasPendingAccountSelectionDrafts('whatsapp')).toBe(true);
    expect(service.getLatestPendingAccountSelectionDraft('whatsapp', 'chat-1', 'sender-1')?.ticketId)
      .toBe(latestMatching.ticketId);
    expect(service.getPendingAccountSelectionDraft(first.ticketId)?.ticketId).toBe(first.ticketId);
  });

  it('covers account-draft claim/release/update success and no-op branches', () => {
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    expect(service.claimPendingAccountSelectionDraft(9999)).toBeUndefined();
    expect(service.claimPendingAccountSelectionDraft(draft.ticketId)?.ticketId).toBe(draft.ticketId);
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PROCESSING');
    expect(service.claimPendingAccountSelectionDraft(draft.ticketId)).toBeUndefined();

    service.releaseProcessingAccountSelectionDraft(9999);
    service.releaseProcessingAccountSelectionDraft(draft.ticketId);
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');
    service.releaseProcessingAccountSelectionDraft(draft.ticketId);
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');

    expect(service.updatePendingAccountSelectionDraft(9999, { accountHint: 'x' })).toBeUndefined();
    const unchangedCollections = service.updatePendingAccountSelectionDraft(draft.ticketId, {
      accountHint: 'Main Account',
      pendingRecordIndex: 0,
    });
    expect(unchangedCollections?.records[0].note).toBe('Draft 1');
    expect(unchangedCollections?.candidateAccounts[0].name).toBe('Account 1');

    const changedCollections = service.updatePendingAccountSelectionDraft(draft.ticketId, {
      records: [{ ...draft.records[0], note: 'Updated' }],
      candidateAccounts: [{ id: 'new-id', name: 'New Account', currency: 'USD' }],
      sourceUserText: 'updated text',
      sourceReferenceInstant: new Date('2026-09-13T00:00:00Z'),
    });
    expect(changedCollections?.records[0].note).toBe('Updated');
    expect(changedCollections?.candidateAccounts[0].id).toBe('new-id');
  });

  it('covers UNKNOWN marking, querying, and reopening for both ticket kinds', () => {
    const service = new PendingTransactionService();
    const transaction = addTransaction(service);
    const draft = addDraft(service);

    service.markPendingTransactionUnknown(9999);
    service.markPendingAccountSelectionDraftUnknown(9999);
    expect(service.hasUncertainTransactions()).toBe(false);
    expect(service.reopenUnknownTransactionAsPending(9999)).toBe(false);
    expect(service.reopenUnknownTransactionAsPending(transaction.ticketId)).toBe(false);

    service.markPendingTransactionUnknown(transaction.ticketId);
    expect(service.getUncertainTransactions().map(item => item.ticketId)).toEqual([transaction.ticketId]);
    expect(service.getUncertainAccountSelectionDrafts()).toEqual([]);
    expect(service.hasUncertainTransactions()).toBe(true);
    expect(service.reopenUnknownTransactionAsPending(transaction.ticketId)).toBe(true);
    expect(service.getPendingTransactionState(transaction.ticketId)).toBe('PENDING');

    service.markPendingAccountSelectionDraftUnknown(draft.ticketId);
    expect(service.getUncertainTransactions()).toEqual([]);
    expect(service.getUncertainAccountSelectionDrafts().map(item => item.ticketId)).toEqual([draft.ticketId]);
    expect(service.hasUncertainTransactions()).toBe(true);
    expect(service.reopenUnknownTransactionAsPending(draft.ticketId)).toBe(true);
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');
  });

  it('covers transaction and draft state getters', () => {
    const service = new PendingTransactionService();
    const transaction = addTransaction(service);
    const draft = addDraft(service);

    expect(service.getPendingTransactionState(9999)).toBeUndefined();
    expect(service.getPendingAccountSelectionDraftState(9999)).toBeUndefined();
    expect(service.getPendingTransactionState(transaction.ticketId)).toBe('PENDING');
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('PENDING');

  });

  it('covers standard transaction claim/release and latest/all claim branches', () => {
    const service = new PendingTransactionService();
    const first = addTransaction(service, '1');
    const second = addTransaction(service, '2');

    expect(service.claimPendingTransaction(9999)).toBeUndefined();
    expect(service.claimPendingTransaction(first.ticketId)?.ticketId).toBe(first.ticketId);
    expect(service.claimPendingTransaction(first.ticketId)).toBeUndefined();
    service.releaseProcessingTransaction(9999);
    service.releaseProcessingTransaction(first.ticketId);
    expect(service.getPendingTransactionState(first.ticketId)).toBe('PENDING');
    service.releaseProcessingTransaction(first.ticketId);

    service.markPendingTransactionUnknown(second.ticketId);
    const claimedAll = service.claimAllPendingTransactions();
    expect(claimedAll.map(item => item.ticketId)).toEqual([first.ticketId]);
    expect(service.getPendingTransactionState(second.ticketId)).toBe('UNKNOWN');
    expect(service.claimLatestPendingTransaction()).toBeUndefined();

    service.releaseProcessingTransaction(first.ticketId);
    expect(service.claimLatestPendingTransaction()?.ticketId).toBe(first.ticketId);
  });

  it('covers resolve and reject success/missing/non-PENDING branches', () => {
    const service = new PendingTransactionService();
    const pendingTransaction = addTransaction(service, '1');
    const processingTransaction = addTransaction(service, '2');
    const unknownTransaction = addTransaction(service, '3');
    const pendingDraft = addDraft(service, '4');
    const processingDraft = addDraft(service, '5');
    const unknownDraft = addDraft(service, '6');

    service.claimPendingTransaction(processingTransaction.ticketId);
    service.markPendingTransactionUnknown(unknownTransaction.ticketId);
    service.claimPendingAccountSelectionDraft(processingDraft.ticketId);
    service.markPendingAccountSelectionDraftUnknown(unknownDraft.ticketId);

    expect(service.rejectPendingTransaction(9999)).toBeUndefined();
    expect(service.rejectPendingTransaction(processingTransaction.ticketId)).toBeUndefined();
    expect(service.rejectPendingTransaction(unknownTransaction.ticketId)).toBeUndefined();
    expect(service.rejectPendingTransaction(pendingTransaction.ticketId)?.ticketId).toBe(pendingTransaction.ticketId);

    expect(service.rejectPendingAccountSelectionDraft(9999)).toBeUndefined();
    expect(service.rejectPendingAccountSelectionDraft(processingDraft.ticketId)).toBeUndefined();
    expect(service.rejectPendingAccountSelectionDraft(unknownDraft.ticketId)).toBeUndefined();
    expect(service.rejectPendingAccountSelectionDraft(pendingDraft.ticketId)?.ticketId).toBe(pendingDraft.ticketId);

    expect(service.resolvePendingTransaction(9999)).toBeUndefined();
    expect(service.resolvePendingAccountSelectionDraft(9999)).toBeUndefined();
    expect(service.resolvePendingTransaction(unknownTransaction.ticketId)?.ticketId).toBe(unknownTransaction.ticketId);
    expect(service.resolvePendingAccountSelectionDraft(unknownDraft.ticketId)?.ticketId).toBe(unknownDraft.ticketId);
  });

  it('covers bulk reject and resolve while preserving non-PENDING states', () => {
    const service = new PendingTransactionService();
    const pending = addTransaction(service, '1');
    const processing = addTransaction(service, '2');
    const unknown = addTransaction(service, '3');

    service.claimPendingTransaction(processing.ticketId);
    service.markPendingTransactionUnknown(unknown.ticketId);

    expect(service.rejectAllPendingTransactions().map(item => item.ticketId)).toEqual([pending.ticketId]);
    expect(service.getPendingTransaction(processing.ticketId)).toBeDefined();
    expect(service.getPendingTransaction(unknown.ticketId)).toBeDefined();

    const remaining = service.resolveAllPendingTransactions();
    expect(remaining.map(item => item.ticketId).sort((a, b) => a - b))
      .toEqual([processing.ticketId, unknown.ticketId]);
    expect(service.hasPendingTransactions()).toBe(false);
  });

  it('purges only expired PENDING entries while retaining expired PROCESSING/UNKNOWN entries', () => {
    const service = new PendingTransactionService();
    const pendingTransaction = addTransaction(service, '1');
    const processingTransaction = addTransaction(service, '2');
    const unknownTransaction = addTransaction(service, '3');
    const pendingDraft = addDraft(service, '4');
    const processingDraft = addDraft(service, '5');
    const unknownDraft = addDraft(service, '6');

    service.claimPendingTransaction(processingTransaction.ticketId);
    service.markPendingTransactionUnknown(unknownTransaction.ticketId);
    service.claimPendingAccountSelectionDraft(processingDraft.ticketId);
    service.markPendingAccountSelectionDraftUnknown(unknownDraft.ticketId);

    for (const item of service.getAllPendingTransactions()) {
      item.expiresAt = new Date(0);
    }
    for (const draft of service.getAllPendingAccountSelectionDrafts()) {
      draft.expiresAt = new Date(0);
    }

    service.purgeExpiredTransactions();

    expect(service.getPendingTransaction(pendingTransaction.ticketId)).toBeUndefined();
    expect(service.getPendingAccountSelectionDraft(pendingDraft.ticketId)).toBeUndefined();
    expect(service.getPendingTransactionState(processingTransaction.ticketId)).toBe('PROCESSING');
    expect(service.getPendingTransactionState(unknownTransaction.ticketId)).toBe('UNKNOWN');
    expect(service.getPendingAccountSelectionDraftState(processingDraft.ticketId)).toBe('PROCESSING');
    expect(service.getPendingAccountSelectionDraftState(unknownDraft.ticketId)).toBe('UNKNOWN');
  });
});
