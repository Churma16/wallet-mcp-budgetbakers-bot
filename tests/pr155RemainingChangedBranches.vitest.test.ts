import { describe, expect, it, vi } from 'vitest';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { createDefaultFinancialActionRegistry, FinancialActionRegistry } from '../src/actions/index.js';

const event = {
  channel: 'whatsapp',
  chatIdentifier: 'chat-1',
  senderIdentifier: 'sender-1',
  messageType: 'text',
  textPayload: 'batal',
} as any;

function addUnknownDraft(service: PendingTransactionService) {
  const draft = service.addPendingAccountSelectionDraft({
    channel: 'whatsapp',
    chatIdentifier: 'chat-1',
    senderIdentifier: 'sender-1',
    records: [{
      accountId: '',
      amount: -25_000,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Dinner',
    }],
    pendingRecordIndex: 0,
    candidateAccounts: [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
  });
  service.markPendingAccountSelectionDraftUnknown(draft.ticketId);
  return draft;
}

describe('PR #155 remaining changed branches', () => {
  it('lets generic cancel fall through when UNKNOWN account draft competes with a standard pending transaction', async () => {
    const service = new PendingTransactionService();
    const draft = addUnknownDraft(service);
    service.addPendingTransaction({
      sourceType: 'WHATSAPP',
      counterParty: 'Merchant',
      amount: 10_000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-1',
      currency: 'IDR',
      recordDate: '2026-09-13',
    });
    const sendMessage = vi.fn();
    const handler = new AccountClarificationHandler(
      service,
      { createRecords: vi.fn() } as any,
      { getAccounts: () => [], getCategories: () => [] } as any,
      { sendMessage } as any,
      { prepareRecordsForDispatch: vi.fn() } as any
    );

    await expect(handler.handlePendingAccountSelectionReply(event, 'batal', Date.now())).resolves.toBe(false);
    expect(service.getPendingAccountSelectionDraftState(draft.ticketId)).toBe('UNKNOWN');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('constructs fast-path handler with an explicit registry', () => {
    const registry = new FinancialActionRegistry();
    const handler = new FastPathHandler(registry);
    expect(handler).toBeInstanceOf(FastPathHandler);
  });

  it('registers and executes CHECK_QUEUE through the default financial action registry factory', async () => {
    const service = new PendingTransactionService();
    service.addPendingTransaction({
      sourceType: 'WHATSAPP',
      counterParty: 'Factory Merchant',
      amount: 15_000,
      transactionType: 'EXPENSE',
      matchedAccountId: 'acc-1',
      currency: 'IDR',
      recordDate: '2026-09-13',
    });
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const registry = createDefaultFinancialActionRegistry({
      financialActionExecutor: {} as any,
      walletMcpClient: {} as any,
      walletCacheService: {} as any,
      messagingGateway: { sendMessage } as any,
      recordPreparationService: {} as any,
      accountClarificationHandler: {} as any,
      pendingTransactionService: service,
    });

    expect(registry.hasHandler('CHECK_QUEUE')).toBe(true);
    await registry.execute({
      action: 'CHECK_QUEUE',
      event: { ...event, textPayload: 'status transaksi' },
      processingStartTimestamp: Date.now(),
      routingSource: 'fast-path',
    });
    expect(sendMessage).toHaveBeenCalledWith('whatsapp', 'chat-1', expect.stringContaining('Status Transaksi'));
  });
});
