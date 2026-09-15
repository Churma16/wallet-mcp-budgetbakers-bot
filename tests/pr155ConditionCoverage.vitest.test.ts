import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { setActiveLanguage, englishDictionary, indonesianDictionary } from '../src/i18n/index.js';
import { formatAccountSelectionUnknownOutcome } from '../src/utils/accountClarificationFormatter.js';

const event = {
  channel: 'whatsapp',
  chatIdentifier: 'chat-1',
  senderIdentifier: 'sender-1',
  messageType: 'text',
  textPayload: 'test',
} as any;

function addTransaction(
  service: PendingTransactionService,
  suffix: string,
  overrides: Record<string, unknown> = {}
) {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Main',
    counterParty: `Merchant ${suffix}`,
    amount: 10_000,
    transactionType: 'EXPENSE',
    matchedAccountId: `acc-${suffix}`,
    matchedCategoryId: 'cat-food',
    matchedCategoryName: 'Food',
    note: suffix,
    recordDate: '2026-09-13',
    currency: 'IDR',
    ...overrides,
  } as any);
}

function createHandler(
  service: PendingTransactionService,
  dispatch: (records: any[]) => Promise<any>,
  emailListener: any = null
) {
  const messages: string[] = [];
  const handler = new PendingActionHandler(
    service,
    { createRecords: vi.fn(dispatch) } as any,
    {
      sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
        messages.push(message);
      }),
    } as any,
    () => emailListener
  );
  return { handler, messages };
}

function addDraft(service: PendingTransactionService, overrides: Record<string, unknown> = {}) {
  return service.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: 'whatsapp',
    chatIdentifier: 'chat-1',
    senderIdentifier: 'sender-1',
    records: [{
      accountId: '',
      amount: -12_500,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Draft note',
      counterParty: 'Draft party',
    }],
    pendingRecordIndex: 0,
    accountHint: 'Primary',
    candidateAccounts: [{ id: 'acc-1', name: 'Candidate', currency: 'IDR' }],
    ...overrides,
  } as any);
}

describe('PR #155 changed-condition coverage', () => {
  beforeEach(() => setActiveLanguage('id'));

  describe('PendingActionHandler outcome combinations', () => {
    it('covers success plus UNKNOWN', async () => {
      const service = new PendingTransactionService();
      addTransaction(service, 'success');
      addTransaction(service, 'unknown');
      const { handler, messages } = createHandler(service, async records => {
        if (records[0].note === 'unknown') {
          throw new WalletMcpRequestError('unknown', 'UNKNOWN');
        }
        return {};
      });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      expect(messages.at(-1)).toContain('1/2 transaksi berhasil');
      expect(messages.at(-1)).toContain('Belum bisa memastikan');
      expect(messages.at(-1)).not.toContain('Gagal mencatat tiket');
    });

    it('covers success plus retryable failure', async () => {
      const service = new PendingTransactionService();
      addTransaction(service, 'success');
      const failed = addTransaction(service, 'failed');
      const { handler, messages } = createHandler(service, async records => {
        if (records[0].note === 'failed') {
          throw new WalletMcpRequestError('bad request', 'DEFINITIVE_FAILURE');
        }
        return {};
      });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      expect(messages.at(-1)).toContain('1/2 transaksi berhasil');
      expect(messages.at(-1)).toContain(`#${failed.ticketId}`);
      expect(messages.at(-1)).not.toContain('Belum bisa memastikan');
    });

    it('covers retryable plus UNKNOWN without success', async () => {
      const service = new PendingTransactionService();
      const retry = addTransaction(service, 'retry');
      const unknown = addTransaction(service, 'unknown');
      const { handler, messages } = createHandler(service, async records => {
        if (records[0].note === 'retry') {
          throw new WalletMcpRequestError('bad request', 'DEFINITIVE_FAILURE');
        }
        throw new WalletMcpRequestError('timeout', 'UNKNOWN');
      });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      expect(messages.at(-1)).toContain(`#${retry.ticketId}`);
      expect(messages.at(-1)).toContain(`(#${unknown.ticketId})`);
      expect(messages.at(-1)).not.toContain('/2 transaksi berhasil');
    });

    it('covers INCOME sign and transfer note/account fallbacks', async () => {
      const service = new PendingTransactionService();
      addTransaction(service, 'income', {
        amount: -50_000,
        transactionType: 'INCOME',
        note: '',
        counterParty: '',
      });
      addTransaction(service, 'transfer', {
        amount: -75_000,
        transactionType: 'TRANSFER',
        accountNameHint: '',
        destinationAccountNameHint: '',
        matchedDestinationAccountId: 'acc-dest',
        note: '',
      });
      const calls: any[][] = [];
      const { handler } = createHandler(service, async records => {
        calls.push(records);
        return {};
      });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      const flattened = calls.flat();
      expect(flattened.some(record => record.amount === 50_000)).toBe(true);
      expect(flattened.some(record => record.note === 'Transfer ke akun lain')).toBe(true);
      expect(flattened.some(record => record.transfer?.accountId === 'acc-dest')).toBe(true);
      expect(flattened.filter(record => record.transfer).length).toBe(1);
    });

    it('covers email success with and without reference number', async () => {
      const service = new PendingTransactionService();
      addTransaction(service, 'email-ref', { sourceType: 'EMAIL', referenceNumber: 'REF-1' });
      addTransaction(service, 'email-no-ref', { sourceType: 'EMAIL', referenceNumber: undefined });
      const recordProcessedTransaction = vi.fn();
      const { handler } = createHandler(service, async () => ({}), { recordProcessedTransaction });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      expect(recordProcessedTransaction).toHaveBeenCalledWith(undefined, 'REF-1');
      expect(recordProcessedTransaction).toHaveBeenCalledWith(undefined, undefined);
    });

    it('covers multiple UNKNOWN-only results from one dispatch', async () => {
      const service = new PendingTransactionService();
      const first = addTransaction(service, 'u1');
      const second = addTransaction(service, 'u2');
      const { handler, messages } = createHandler(service, async () => {
        throw new WalletMcpRequestError('timeout', 'UNKNOWN');
      });

      await handler.handlePendingAction(event, { actionType: 'CONFIRM', targetScope: 'ALL' }, Date.now());
      expect(messages.at(-1)).toContain(`#${first.ticketId}`);
      expect(messages.at(-1)).toContain(`#${second.ticketId}`);
      expect(messages.at(-1)).toContain(`Sudah ada #${first.ticketId}`);
    });
  });

  describe('reconciliation combinations', () => {
    it('reconciles numbered standard UNKNOWN as recorded', async () => {
      const service = new PendingTransactionService();
      const tx = addTransaction(service, 'recorded');
      service.markPendingTransactionUnknown(tx.ticketId);
      const { handler, messages } = createHandler(service, async () => ({}));

      expect(await handler.handleReconciliationAction(
        event,
        { actionType: 'CONFIRM_RECORDED', targetTicketId: tx.ticketId },
        Date.now()
      )).toBe(true);
      expect(service.getPendingTransaction(tx.ticketId)).toBeUndefined();
      expect(messages.at(-1)).toContain(`#${tx.ticketId}`);
    });

    it('reconciles numbered and unnumbered UNKNOWN drafts as recorded', async () => {
      const numberedService = new PendingTransactionService();
      const numberedDraft = addDraft(numberedService);
      numberedService.markPendingAccountSelectionDraftUnknown(numberedDraft.ticketId);
      const numbered = createHandler(numberedService, async () => ({}));
      await numbered.handler.handleReconciliationAction(
        event,
        { actionType: 'CONFIRM_RECORDED', targetTicketId: numberedDraft.ticketId },
        Date.now()
      );
      expect(numberedService.getPendingAccountSelectionDraft(numberedDraft.ticketId)).toBeUndefined();

      const singleService = new PendingTransactionService();
      const singleDraft = addDraft(singleService);
      singleService.markPendingAccountSelectionDraftUnknown(singleDraft.ticketId);
      const single = createHandler(singleService, async () => ({}));
      await single.handler.handleReconciliationAction(event, { actionType: 'CONFIRM_RECORDED' }, Date.now());
      expect(singleService.getPendingAccountSelectionDraft(singleDraft.ticketId)).toBeUndefined();
    });

    it('reconciles a single standard UNKNOWN as recorded and absent', async () => {
      for (const actionType of ['CONFIRM_RECORDED', 'CONFIRM_ABSENT'] as const) {
        const service = new PendingTransactionService();
        const tx = addTransaction(service, actionType);
        service.markPendingTransactionUnknown(tx.ticketId);
        const { handler } = createHandler(service, async () => ({}));

        await handler.handleReconciliationAction(event, { actionType }, Date.now());
        if (actionType === 'CONFIRM_RECORDED') {
          expect(service.getPendingTransaction(tx.ticketId)).toBeUndefined();
        } else {
          expect(service.getPendingTransactionState(tx.ticketId)).toBe('PENDING');
        }
      }
    });
  });

  describe('unknown account-draft formatter conditions', () => {
    it.each(['id', 'en'] as const)('covers note/account-hint safe default in %s', language => {
      setActiveLanguage(language);
      const service = new PendingTransactionService();
      const d = addDraft(service);
      const output = formatAccountSelectionUnknownOutcome(d);
      expect(output).toContain('Draft note');
      expect(output).toContain('Primary');
      expect(output).toContain(`#${d.ticketId}`);
    });

    it.each(['id', 'en'] as const)('covers counterparty/candidate fallbacks in %s', language => {
      setActiveLanguage(language);
      const service = new PendingTransactionService();
      const d = addDraft(service, {
        records: [{
          accountId: '', amount: -5000, currency: 'IDR', recordDate: '2026-09-13',
          note: '', counterParty: 'Counterparty fallback',
        }],
        accountHint: '',
      });
      const output = formatAccountSelectionUnknownOutcome(d, 1);
      expect(output).toContain('Counterparty fallback');
      expect(output).toContain('Candidate');
      expect(output).not.toContain(language === 'id' ? `Sudah ada #${d.ticketId}` : `Already exists #${d.ticketId}`);
    });

    it.each(['id', 'en'] as const)('covers generic description/account fallbacks in %s', language => {
      setActiveLanguage(language);
      const service = new PendingTransactionService();
      const d = addDraft(service, {
        records: [{
          accountId: '', amount: -5000, currency: 'IDR', recordDate: '2026-09-13',
          note: '', counterParty: '',
        }],
        accountHint: '',
        candidateAccounts: [],
      });
      const output = formatAccountSelectionUnknownOutcome(d, 2);
      expect(output).toContain(language === 'id' ? 'Transaksi' : 'Transaction');
      expect(output).toContain(language === 'id' ? 'Akun:' : 'Account:');
      expect(output).toContain(`#${d.ticketId}`);
    });
  });

  describe('email pending notification conditions', () => {
    it.each([
      ['id', indonesianDictionary],
      ['en', englishDictionary],
    ] as const)('covers notification condition matrix in %s', (_language, dictionary) => {
      const base = {
        ticketId: 9,
        typeIcon: '📩',
        formattedAmount: '100',
        formattedTime: 'now',
        bankDisplayName: 'Fallback Bank',
        totalPendingCount: 1,
      } as any;

      expect(dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Payment', counterParty: 'Merchant',
        accountNameHint: 'Main', matchedCategoryName: undefined,
      })).toContain('Main');
      expect(dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Payment', counterParty: undefined,
        accountNameHint: undefined, matchedCategoryName: 'Food',
      })).toContain('Food');
      expect(dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Payment', counterParty: undefined,
        accountNameHint: undefined, matchedCategoryName: undefined,
      })).toContain('Fallback Bank');

      const transferMissing = dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Transfer', accountNameHint: undefined,
        destinationAccountNameHint: undefined, matchedCategoryName: 'Ignored',
      });
      expect(transferMissing).not.toContain('Ignored');
      expect(dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Transfer', accountNameHint: 'Source',
        destinationAccountNameHint: undefined,
      })).toContain('Source');
      expect(dictionary.emailPending.formatNotification({
        ...base, typeLabel: 'Transfer', accountNameHint: undefined,
        destinationAccountNameHint: 'Destination',
      })).toContain('Destination');
      expect(dictionary.emailPending.formatNotification({
        ...base, ticketId: 10, typeLabel: 'Payment', counterParty: 'Merchant', totalPendingCount: 2,
      })).toContain('#10');
    });
  });

  describe('UserMessageHandler changed routing conditions', () => {
    function harness() {
      const pendingAction = {
        handlePendingAction: vi.fn().mockResolvedValue(false),
        handleReconciliationAction: vi.fn().mockResolvedValue(false),
      };
      const clarification = { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false) };
      const fastPath = { handleFastPath: vi.fn().mockResolvedValue(false) };
      const ai = {
        providerName: 'mock',
        processTextMessage: vi.fn().mockResolvedValue({ action: 'GENERAL_REPLY', explanation: 'ok' }),
        processImageMessage: vi.fn().mockResolvedValue({ action: 'GENERAL_REPLY', explanation: 'image ok' }),
      };
      const handler = new UserMessageHandler(
        { sendTypingPresence: vi.fn(), clearTypingPresence: vi.fn(), sendMessage: vi.fn() } as any,
        new PendingTransactionService(),
        pendingAction as any,
        fastPath as any,
        ai as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        {} as any,
        {} as any,
        { hasHandler: () => false, execute: vi.fn() } as any,
        clarification as any
      );
      return { handler, pendingAction, clarification, fastPath, ai };
    }

    it('covers image false-branches for text-only routing stages', async () => {
      const h = harness();
      await h.handler.handleIncomingUserMessage({
        ...event,
        messageType: 'image',
        textPayload: undefined,
        imageBase64Data: 'abc',
        imageMimeType: 'image/jpeg',
      });
      expect(h.pendingAction.handlePendingAction).not.toHaveBeenCalled();
      expect(h.pendingAction.handleReconciliationAction).not.toHaveBeenCalled();
      expect(h.clarification.handlePendingAccountSelectionReply).not.toHaveBeenCalled();
      expect(h.fastPath.handleFastPath).not.toHaveBeenCalled();
      expect(h.ai.processTextMessage).toHaveBeenCalledOnce();
    });

    it('covers empty text-payload false-branches', async () => {
      const h = harness();
      await h.handler.handleIncomingUserMessage({ ...event, textPayload: '' });
      expect(h.pendingAction.handlePendingAction).not.toHaveBeenCalled();
      expect(h.pendingAction.handleReconciliationAction).not.toHaveBeenCalled();
      expect(h.clarification.handlePendingAccountSelectionReply).not.toHaveBeenCalled();
      expect(h.fastPath.handleFastPath).not.toHaveBeenCalled();
    });
  });
});
