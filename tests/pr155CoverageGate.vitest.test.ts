import { describe, expect, it, vi } from 'vitest';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { buildTransactionAttentionSummary } from '../src/services/transactionStatusViewModel.js';
import {
  formatAccountSelectionUnknownDismissal,
  formatAccountSelectionUnknownOutcome,
} from '../src/utils/accountClarificationFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

const event = {
  channel: 'whatsapp',
  chatIdentifier: 'chat-coverage',
  senderIdentifier: 'sender-coverage',
  messageType: 'text',
  textPayload: 'ya',
} as any;

function addDraft(
  service: PendingTransactionService,
  overrides: Partial<{ channel: 'whatsapp' | 'telegram'; chatIdentifier: string; senderIdentifier: string }> = {}
) {
  return service.addPendingAccountSelectionDraft({
    channel: overrides.channel ?? 'whatsapp',
    chatIdentifier: overrides.chatIdentifier ?? 'chat-coverage',
    senderIdentifier: overrides.senderIdentifier ?? 'sender-coverage',
    records: [{
      accountId: '',
      amount: -25_000,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Coverage draft',
    }],
    pendingRecordIndex: 0,
    candidateAccounts: [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
  });
}

function addPending(service: PendingTransactionService, counterParty: string) {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    counterParty,
    amount: 10_000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    accountNameHint: 'BCA',
    currency: 'IDR',
    recordDate: '2026-09-13',
  });
}

describe('PR #155 Sonar new-code coverage gate', () => {
  it('covers scoped latest clarification lookup mismatches and the matching branch', () => {
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    expect(service.getLatestPendingAccountSelectionDraft('telegram', 'chat-coverage', 'sender-coverage')).toBeUndefined();
    expect(service.getLatestPendingAccountSelectionDraft('whatsapp', 'other-chat', 'sender-coverage')).toBeUndefined();
    expect(service.getLatestPendingAccountSelectionDraft('whatsapp', 'chat-coverage', 'other-sender')).toBeUndefined();
    expect(service.getLatestPendingAccountSelectionDraft('whatsapp', 'chat-coverage', 'sender-coverage')?.ticketId).toBe(draft.ticketId);
  });

  it('returns a warning for missing latest and numbered confirmation targets', async () => {
    const service = new PendingTransactionService();
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const handler = new PendingActionHandler(
      service,
      {} as any,
      { sendMessage } as any,
      () => null
    );

    await expect(handler.handlePendingAction(
      event,
      { actionType: 'CONFIRM', targetScope: 'LATEST' },
      Date.now()
    )).resolves.toBe(true);
    await expect(handler.handlePendingAction(
      event,
      { actionType: 'CONFIRM', targetScope: 999 },
      Date.now()
    )).resolves.toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'whatsapp',
      'chat-coverage',
      expect.stringContaining('Tiket transaksi tidak tersedia')
    );
  });

  it('summarizes PENDING and UNKNOWN standard items and clarification drafts together', () => {
    const service = new PendingTransactionService();

    addPending(service, 'Pending merchant');
    const uncertain = addPending(service, 'Uncertain merchant');
    service.markPendingTransactionUnknown(uncertain.ticketId);

    addDraft(service);
    const uncertainDraft = addDraft(service, {
      chatIdentifier: 'chat-other',
      senderIdentifier: 'sender-other',
    });
    service.markPendingAccountSelectionDraftUnknown(uncertainDraft.ticketId);

    const summary = buildTransactionAttentionSummary(service, 'id');

    expect(summary.totalNeedingAttention).toBe(4);
    expect(summary.waitingConfirmationItems).toHaveLength(1);
    expect(summary.waitingAccountItems).toHaveLength(1);
    expect(summary.needsCheckItems).toHaveLength(2);
  });

  it('uses unnumbered reconciliation commands only when the caller proves one UNKNOWN draft exists', () => {
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    setActiveLanguage('id');
    const id = formatAccountSelectionUnknownOutcome(draft, 1);
    expect(id).toContain('• *Sudah ada*');
    expect(id).toContain('• *Belum ada*');
    expect(id).not.toContain(`Sudah ada #${draft.ticketId}`);

    setActiveLanguage('en');
    const en = formatAccountSelectionUnknownOutcome(draft, 1);
    expect(en).toContain('• *Already exists*');
    expect(en).toContain('• *Not there*');
    expect(en).not.toContain(`Already exists #${draft.ticketId}`);
  });

  it('keeps the UNKNOWN dismissal compatibility formatter reconciliation-only in both languages', () => {
    const service = new PendingTransactionService();
    const draft = addDraft(service);

    setActiveLanguage('id');
    expect(formatAccountSelectionUnknownDismissal(draft)).toContain(`Sudah ada #${draft.ticketId}`);

    setActiveLanguage('en');
    expect(formatAccountSelectionUnknownDismissal(draft)).toContain(`Already exists #${draft.ticketId}`);
  });
});
