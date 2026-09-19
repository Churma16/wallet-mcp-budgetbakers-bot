import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { FinancialActionRegistry, CheckQueueActionHandler } from '../src/actions/index.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import {
  buildItemViewModelFromClarificationDraft,
  buildItemViewModelFromPendingItem,
  buildTransactionAttentionSummary,
  type TransactionAttentionItemViewModel,
} from '../src/services/transactionStatusViewModel.js';
import {
  formatReconciliationAbsentResponse,
  formatReconciliationAmbiguousResponse,
  formatReconciliationNotFoundResponse,
  formatReconciliationRecordedResponse,
  formatTransactionAttentionSummary,
  formatUncertainOutcomeResponse,
} from '../src/utils/transactionStatusFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';

const event = {
  channel: 'whatsapp',
  chatIdentifier: 'chat-1',
  senderIdentifier: 'sender-1',
  messageType: 'text',
  textPayload: 'test',
} as any;

function addTransaction(
  service: PendingTransactionService,
  overrides: Record<string, unknown> = {}
) {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Main',
    counterParty: 'Merchant',
    amount: 25_000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    matchedCategoryId: 'cat-food',
    matchedCategoryName: 'Food',
    note: 'Lunch',
    recordDate: '2026-09-13',
    currency: 'IDR',
    ...overrides,
  } as any);
}

function addDraft(
  service: PendingTransactionService,
  overrides: Record<string, unknown> = {}
) {
  return service.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: 'whatsapp',
    chatIdentifier: 'chat-1',
    senderIdentifier: 'sender-1',
    records: [{
      accountId: '',
      amount: -35_000,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Draft purchase',
    }],
    pendingRecordIndex: 0,
    accountHint: 'BCA',
    candidateAccounts: [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
    ...overrides,
  } as any);
}

function item(ticketId: number, overrides: Partial<TransactionAttentionItemViewModel> = {}) {
  return {
    ticketId,
    status: 'NEEDS_CHECK',
    amount: 10_000,
    currency: 'IDR',
    formattedAmount: 'Rp 10.000',
    description: `Item ${ticketId}`,
    accountName: 'BCA',
    isTransfer: false,
    createdAt: new Date('2026-09-13T00:00:00Z'),
    primaryAction: 'MARK_PRESENT',
    secondaryAction: 'MARK_ABSENT',
    sourceKind: 'STANDARD',
    ...overrides,
  } as TransactionAttentionItemViewModel;
}

function createPendingHandler(
  service: PendingTransactionService,
  createRecords: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({}),
  emailListener: any = null
) {
  const messages: string[] = [];
  const handler = new PendingActionHandler(
    service,
    { createRecords } as any,
    {
      sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
        messages.push(message);
      }),
    } as any,
    () => emailListener
  );
  return { handler, messages, createRecords };
}

describe('PR #155 final changed-branch coverage', () => {
  beforeEach(() => setActiveLanguage('id'));

  describe('transaction status formatter matrix', () => {
    it.each([
      ['id', true],
      ['id', false],
      ['en', true],
      ['en', false],
    ] as const)('formats uncertain queue hints for %s single=%s', (language, single) => {
      const needsCheckItems = single ? [item(1)] : [item(1), item(2)];
      const output = formatTransactionAttentionSummary({
        totalNeedingAttention: needsCheckItems.length,
        needsCheckItems,
        waitingConfirmationItems: [],
        waitingAccountItems: [],
      }, language);

      if (language === 'id') {
        expect(output).toContain(single ? 'Sudah ada*' : 'Sudah ada #1');
        expect(output).toContain('Tidak ada transaksi lain');
      } else {
        expect(output).toContain(single ? 'Already exists*' : 'Already exists #1');
        expect(output).toContain('No other');
      }
    });

    it.each(['id', 'en'] as const)('formats single and multi waiting confirmation in %s', language => {
      const single = formatTransactionAttentionSummary({
        totalNeedingAttention: 1,
        needsCheckItems: [],
        waitingConfirmationItems: [item(3, { status: 'WAITING_FOR_CONFIRMATION' })],
        waitingAccountItems: [],
      }, language);
      const multi = formatTransactionAttentionSummary({
        totalNeedingAttention: 2,
        needsCheckItems: [item(1)],
        waitingConfirmationItems: [item(3, { status: 'WAITING_FOR_CONFIRMATION' })],
        waitingAccountItems: [],
      }, language);

      expect(single).toContain(language === 'id' ? 'Ya*' : 'Yes*');
      expect(multi).toContain(language === 'id' ? 'Ya #3' : 'Yes #3');
    });

    it.each(['id', 'en'] as const)('formats waiting account branch in %s', language => {
      const output = formatTransactionAttentionSummary({
        totalNeedingAttention: 1,
        needsCheckItems: [],
        waitingConfirmationItems: [],
        waitingAccountItems: [item(4, { status: 'WAITING_FOR_ACCOUNT', sourceKind: 'CLARIFICATION_DRAFT' })],
      }, language);
      expect(output).toContain(language === 'id' ? 'Batal #4' : 'Cancel #4');
    });

    it('formats empty attention summary', () => {
      expect(formatTransactionAttentionSummary({
        totalNeedingAttention: 0,
        needsCheckItems: [],
        waitingConfirmationItems: [],
        waitingAccountItems: [],
      })).toContain('Tidak ada transaksi');
    });

    it.each(['id', 'en'] as const)('covers uncertain single/multiple account-label branches in %s', language => {
      const withAccount = formatUncertainOutcomeResponse(item(5), language, 1);
      const withoutAccount = formatUncertainOutcomeResponse(item(6, { accountName: '' }), language, 2);
      const multiple = formatUncertainOutcomeResponse([
        item(7),
        item(8, { accountName: '' }),
      ], language, 2);

      expect(withAccount).toContain(language === 'id' ? 'Akun:' : 'Account:');
      expect(withoutAccount).not.toContain(language === 'id' ? 'Akun:' : 'Account:');
      expect(withoutAccount).toContain(`#6`);
      expect(multiple).toContain('#7');
      expect(multiple).toContain('#8');
    });

    it.each(['id', 'en'] as const)('covers every reconciliation formatter variant in %s', language => {
      expect(formatReconciliationRecordedResponse(9, language)).toContain('#9');
      expect(formatReconciliationRecordedResponse(undefined, language)).not.toContain('#9');
      expect(formatReconciliationAbsentResponse(10, language)).toContain('#10');
      expect(formatReconciliationAbsentResponse(undefined, language).length).toBeGreaterThan(0);
      expect(formatReconciliationNotFoundResponse(11, language)).toContain('#11');
      expect(formatReconciliationNotFoundResponse(undefined, language).length).toBeGreaterThan(0);
      const ambiguous = formatReconciliationAmbiguousResponse([item(12), item(13)], language);
      expect(ambiguous).toContain('#12');
      expect(ambiguous).toContain('#13');
    });
  });

  describe('transaction status view-model edge states', () => {
    it('omits PROCESSING standard transactions and PROCESSING drafts from attention summary', () => {
      const service = new PendingTransactionService();
      const transaction = addTransaction(service);
      const draft = addDraft(service);
      service.claimPendingTransaction(transaction.ticketId);
      service.claimPendingAccountSelectionDraft(draft.ticketId);

      const summary = buildTransactionAttentionSummary(service);
      expect(summary.totalNeedingAttention).toBe(0);
      expect(summary.needsCheckItems).toEqual([]);
      expect(summary.waitingConfirmationItems).toEqual([]);
      expect(summary.waitingAccountItems).toEqual([]);
    });

    it('builds all three attention buckets and sorts them by ticket id', () => {
      const service = new PendingTransactionService();
      const pending = addTransaction(service, { counterParty: '' });
      const unknown = addTransaction(service, { counterParty: '', note: '', bankDisplayName: 'Fallback Bank' });
      service.markPendingTransactionUnknown(unknown.ticketId);
      const draft = addDraft(service);

      const summary = buildTransactionAttentionSummary(service, 'en');
      expect(summary.totalNeedingAttention).toBe(3);
      expect(summary.waitingConfirmationItems[0].ticketId).toBe(pending.ticketId);
      expect(summary.needsCheckItems[0].ticketId).toBe(unknown.ticketId);
      expect(summary.waitingAccountItems[0].ticketId).toBe(draft.ticketId);
      expect(summary.needsCheckItems[0].description).toBe('Fallback Bank');
    });

    it('covers fallback fields in standard and draft item builders', () => {
      const service = new PendingTransactionService();
      const standard = addTransaction(service, {
        counterParty: '',
        note: '',
        bankDisplayName: '',
        accountNameHint: '',
        transactionType: 'TRANSFER',
        destinationAccountNameHint: 'Savings',
      });
      const draft = addDraft(service, {
        records: [{ accountId: '', amount: 'not-a-number', recordDate: '2026-09-13', counterParty: 'Fallback party' }],
        accountHint: '',
        candidateAccounts: [{ id: 'acc-x', name: 'Fallback Account', currency: 'USD' }],
      });

      const standardVm = buildItemViewModelFromPendingItem(standard, 'NEEDS_CHECK', 'en');
      const draftVm = buildItemViewModelFromClarificationDraft(draft, 'WAITING_FOR_ACCOUNT', 'en');
      expect(standardVm.description).toBe('Transaksi');
      expect(standardVm.accountName).toBe('Akun');
      expect(standardVm.isTransfer).toBe(true);
      expect(standardVm.destinationAccountName).toBe('Savings');
      expect(draftVm.description).toBe('Fallback party');
      expect(draftVm.accountName).toBe('Fallback Account');
      expect(draftVm.primaryAction).toBe('SELECT_ACCOUNT');
      expect(draftVm.secondaryAction).toBe('CANCEL');
    });
  });

  describe('FastPathHandler changed CHECK_QUEUE wiring', () => {
    it('returns false for null action and forwards CHECK_QUEUE to an injected registry', async () => {
      const execute = vi.fn().mockResolvedValue(undefined);
      const registry = { execute } as any;
      const handler = new FastPathHandler(registry);

      expect(await handler.handleFastPath(event, null, 123)).toBe(false);
      expect(await handler.handleFastPath(event, 'CHECK_QUEUE', 456)).toBe(true);
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        action: 'CHECK_QUEUE',
        processingStartTimestamp: 456,
        routingSource: 'fast-path',
      }));
    });

    it('registers and executes CHECK_QUEUE in the provided registry when pending service is supplied', async () => {
      const service = new PendingTransactionService();
      addTransaction(service);
      const messages: string[] = [];
      const gateway = {
        sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => messages.push(message)),
      } as any;
      const registry = new FinancialActionRegistry();
      registry.register(new CheckQueueActionHandler(service, gateway));
      const handler = new FastPathHandler(registry);

      expect(await handler.handleFastPath(event, 'CHECK_QUEUE', Date.now())).toBe(true);
      expect(messages.at(-1)).toContain('Status Transaksi');
      expect(messages.at(-1)).toContain('Ya');
    });
  });

  describe('PendingActionHandler changed edge branches', () => {
    it('returns false for an unsupported pending action type', async () => {
      const service = new PendingTransactionService();
      const { handler } = createPendingHandler(service);
      await expect(handler.handlePendingAction(
        event,
        { actionType: 'UNSUPPORTED', targetScope: 'ALL' } as any,
        Date.now()
      )).resolves.toBe(false);
    });

    it('warns when confirmation cannot claim any ticket', async () => {
      const service = new PendingTransactionService();
      const { handler, messages, createRecords } = createPendingHandler(service);
      expect(await handler.handlePendingAction(
        event,
        { actionType: 'CONFIRM', targetScope: 999 },
        Date.now()
      )).toBe(true);
      expect(createRecords).not.toHaveBeenCalled();
      expect(messages.at(-1)).toContain('tidak tersedia');
    });

    it('rejects transfer without a resolved destination before dispatch', async () => {
      const service = new PendingTransactionService();
      const tx = addTransaction(service, {
        sourceType: 'EMAIL',
        transactionType: 'TRANSFER',
        destinationAccountNameHint: '',
        matchedDestinationAccountId: undefined,
        referenceNumber: 'REF-X',
        counterParty: '',
        note: '',
      });
      const recordProcessedTransaction = vi.fn();
      const { handler, createRecords } = createPendingHandler(service, vi.fn().mockResolvedValue({}), {
        recordProcessedTransaction,
      });

      await handler.handlePendingAction(
        event,
        { actionType: 'CONFIRM', targetScope: tx.ticketId },
        Date.now()
      );

      expect(createRecords).not.toHaveBeenCalled();
      expect(service.getPendingTransactionState(tx.ticketId)).toBe('PENDING');
      expect(recordProcessedTransaction).not.toHaveBeenCalled();
    });

    it('uses compatibility fallback when reject manager lacks uncertain-query capability', async () => {
      const real = new PendingTransactionService();
      const tx = addTransaction(real);
      const partial = {
        rejectPendingTransaction: real.rejectPendingTransaction.bind(real),
        rejectAllPendingTransactions: real.rejectAllPendingTransactions.bind(real),
        getLatestPendingTransaction: real.getLatestPendingTransaction.bind(real),
        getUncertainAccountSelectionDrafts: real.getUncertainAccountSelectionDrafts.bind(real),
      } as any;
      const messages: string[] = [];
      const handler = new PendingActionHandler(
        partial,
        {} as any,
        { sendMessage: vi.fn(async (_c: string, _i: string, m: string) => messages.push(m)) } as any,
        () => null
      );

      expect(await handler.handlePendingAction(
        event,
        { actionType: 'REJECT', targetScope: tx.ticketId },
        Date.now()
      )).toBe(true);
      expect(messages.at(-1)).toContain('Dibatalkan');
    });

    it('warns for reject when there is no matching/latest pending ticket', async () => {
      const service = new PendingTransactionService();
      const { handler, messages } = createPendingHandler(service);
      await handler.handlePendingAction(event, { actionType: 'REJECT', targetScope: 404 }, Date.now());
      expect(messages.at(-1)).toContain('tidak ditemukan');

      messages.length = 0;
      await handler.handlePendingAction(event, { actionType: 'REJECT' } as any, Date.now());
      expect(messages.at(-1)).toContain('tidak ditemukan');
    });

    it('covers targeted reconciliation not-found and invalid-action terminal return', async () => {
      const service = new PendingTransactionService();
      const { handler, messages } = createPendingHandler(service);

      expect(await handler.handleReconciliationAction(
        event,
        { actionType: 'CONFIRM_RECORDED', targetTicketId: 404 },
        Date.now()
      )).toBe(true);
      expect(messages.at(-1)).toContain('#404');

      const unknown = addTransaction(service);
      service.markPendingTransactionUnknown(unknown.ticketId);
      expect(await handler.handleReconciliationAction(
        event,
        { actionType: 'INVALID', targetTicketId: unknown.ticketId } as any,
        Date.now()
      )).toBe(false);
    });

    it('covers unnumbered reconciliation with no uncertain items', async () => {
      const service = new PendingTransactionService();
      const { handler, messages } = createPendingHandler(service);
      expect(await handler.handleReconciliationAction(
        event,
        { actionType: 'CONFIRM_ABSENT' },
        Date.now()
      )).toBe(true);
      expect(messages.at(-1)).toContain('Tidak ada transaksi');
    });
  });
});
