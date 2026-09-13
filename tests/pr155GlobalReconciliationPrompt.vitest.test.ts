import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { formatUncertainOutcomeResponse } from '../src/utils/transactionStatusFormatter.js';
import { formatAccountSelectionUnknownOutcome } from '../src/utils/accountClarificationFormatter.js';

function addTransaction(service: PendingTransactionService, note: string) {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Main',
    counterParty: note,
    amount: 20000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    note,
    recordDate: '2026-09-13',
    currency: 'IDR',
  });
}

function addDraft(service: PendingTransactionService) {
  return service.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: 'whatsapp',
    chatIdentifier: 'chat-1',
    senderIdentifier: 'sender-1',
    records: [{
      accountId: '',
      amount: -30000,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Draft purchase',
    }],
    pendingRecordIndex: 0,
    accountHint: 'BCA',
    candidateAccounts: [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
  });
}

const event = {
  channel: 'whatsapp',
  chatIdentifier: 'chat-1',
  senderIdentifier: 'sender-1',
  messageType: 'text',
  textPayload: 'ya',
} as any;

describe('PR #155 global reconciliation prompt safety', () => {
  beforeEach(() => setActiveLanguage('id'));

  it('qualifies a newly UNKNOWN ticket when another UNKNOWN ticket already exists', async () => {
    const service = new PendingTransactionService();
    const first = addTransaction(service, 'First unknown');
    service.markPendingTransactionUnknown(first.ticketId);
    const second = addTransaction(service, 'Second becomes unknown');

    const messages: string[] = [];
    const handler = new PendingActionHandler(
      service,
      {
        createRecords: vi.fn().mockRejectedValue(
          new WalletMcpRequestError('lost response', 'UNKNOWN')
        ),
      } as any,
      {
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
          messages.push(message);
        }),
      } as any,
      () => null
    );

    await handler.handlePendingAction(
      event,
      { actionType: 'CONFIRM', targetScope: second.ticketId },
      Date.now()
    );

    expect(service.getPendingTransactionState(first.ticketId)).toBe('UNKNOWN');
    expect(service.getPendingTransactionState(second.ticketId)).toBe('UNKNOWN');
    expect(messages.at(-1)).toContain(`Sudah ada #${second.ticketId}`);
    expect(messages.at(-1)).toContain(`Belum ada #${second.ticketId}`);
    expect(messages.at(-1)).not.toContain('• *Sudah ada*');
    expect(messages.at(-1)).not.toContain('• *Belum ada*');
  });

  it('qualifies a protected UNKNOWN cancellation when another UNKNOWN draft exists globally', async () => {
    const service = new PendingTransactionService();
    const transaction = addTransaction(service, 'Protected unknown');
    service.markPendingTransactionUnknown(transaction.ticketId);
    const draft = addDraft(service);
    service.markPendingAccountSelectionDraftUnknown(draft.ticketId);

    const messages: string[] = [];
    const handler = new PendingActionHandler(
      service,
      {} as any,
      {
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
          messages.push(message);
        }),
      } as any,
      () => null
    );

    await handler.handlePendingAction(
      event,
      { actionType: 'REJECT', targetScope: transaction.ticketId },
      Date.now()
    );

    expect(service.getPendingTransactionState(transaction.ticketId)).toBe('UNKNOWN');
    expect(messages.at(-1)).toContain(`Sudah ada #${transaction.ticketId}`);
    expect(messages.at(-1)).toContain(`Belum ada #${transaction.ticketId}`);
  });

  it('formatter uses unnumbered actions only when the caller proves there is one UNKNOWN item', () => {
    const item = {
      ticketId: 7,
      status: 'NEEDS_CHECK',
      amount: 10000,
      formattedAmount: 'Rp 10.000',
      description: 'Coffee',
      accountName: 'BCA',
      isTransfer: false,
      createdAt: new Date(),
      primaryAction: 'Sudah ada #7',
      secondaryAction: 'Belum ada #7',
      sourceKind: 'STANDARD',
    } as any;

    const globallyAmbiguous = formatUncertainOutcomeResponse(item, 'id', 2);
    expect(globallyAmbiguous).toContain('Sudah ada #7');
    expect(globallyAmbiguous).toContain('Belum ada #7');

    const globallySingle = formatUncertainOutcomeResponse(item, 'id', 1);
    expect(globallySingle).toContain('Sudah ada');
    expect(globallySingle).toContain('Belum ada');
    expect(globallySingle).not.toContain('Sudah ada #7');
  });

  it('account-draft formatter defaults to ticket-qualified actions when global state is unknown', () => {
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    const safeDefault = formatAccountSelectionUnknownOutcome(draft);
    expect(safeDefault).toContain(`Sudah ada #${draft.ticketId}`);
    expect(safeDefault).toContain(`Belum ada #${draft.ticketId}`);

    const explicitlySingle = formatAccountSelectionUnknownOutcome(draft, 1);
    expect(explicitlySingle).toContain('• *Sudah ada*');
    expect(explicitlySingle).toContain('• *Belum ada*');
  });

  it('English account-draft safe default is also ticket-qualified', () => {
    setActiveLanguage('en');
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    const message = formatAccountSelectionUnknownOutcome(draft);
    expect(message).toContain(`Already exists #${draft.ticketId}`);
    expect(message).toContain(`Not there #${draft.ticketId}`);
  });
});
