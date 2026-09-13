import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';

class MockMessagingGateway {
  public readonly messages: string[] = [];

  async sendMessage(_channel: string, _chatId: string, content: string): Promise<void> {
    this.messages.push(content);
  }

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  get lastMessage(): string {
    return this.messages[this.messages.length - 1] || '';
  }
}

function event(text: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: '+6281234567890',
    senderIdentifier: 'user-1',
    messageType: 'text',
    textPayload: text,
  };
}

function addUnknownStandardTransaction(service: PendingTransactionService): number {
  const item = service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    counterParty: 'Regression Merchant',
    amount: 25000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    currency: 'IDR',
    recordDate: '2026-09-13',
  });
  service.markPendingTransactionUnknown(item.ticketId);
  return item.ticketId;
}

function addUnknownAccountDraft(service: PendingTransactionService): number {
  const draft = service.addPendingAccountSelectionDraft({
    channel: 'whatsapp',
    chatIdentifier: '+6281234567890',
    senderIdentifier: 'user-1',
    records: [
      {
        accountId: '',
        amount: -55000,
        currency: 'IDR',
        recordDate: '2026-09-13',
        note: 'Grab Ride',
      },
    ],
    pendingRecordIndex: 0,
    candidateAccounts: [
      { id: 'acc-1', name: 'BCA', currency: 'IDR' },
      { id: 'acc-2', name: 'Jago', currency: 'IDR' },
    ],
  });
  service.markPendingAccountSelectionDraftUnknown(draft.ticketId);
  return draft.ticketId;
}

describe('PR #155 reconciliation protocol regressions', () => {
  beforeEach(() => {
    setActiveLanguage('id');
  });

  describe('bounded reconciliation routing', () => {
    function createUserMessageHandler(
      pendingService: PendingTransactionService,
      reconciliationHandler = vi.fn().mockResolvedValue(true),
      accountClarificationHandler = vi.fn().mockResolvedValue(true)
    ): UserMessageHandler {
      const gateway = new MockMessagingGateway();
      return new UserMessageHandler(
        gateway as any,
        pendingService,
        {
          handlePendingAction: vi.fn().mockResolvedValue(false),
          handleReconciliationAction: reconciliationHandler,
        } as any,
        { handleFastPath: vi.fn().mockResolvedValue(false) } as any,
        {
          providerName: 'mock',
          processTextMessage: vi.fn(),
          processImageMessage: vi.fn(),
        } as any,
        { getAccounts: () => [], getCategories: () => [] } as any,
        {} as any,
        {} as any,
        {} as any,
        { execute: vi.fn(), hasHandler: vi.fn().mockReturnValue(false) } as any,
        { handlePendingAccountSelectionReply: accountClarificationHandler } as any
      );
    }

    it.each(['ada', 'sudah', 'belum', 'missing', 'not yet'])(
      'does not consume free-form alias "%s" as reconciliation even with one UNKNOWN item',
      async alias => {
        const pendingService = new PendingTransactionService();
        addUnknownStandardTransaction(pendingService);
        const reconciliationHandler = vi.fn().mockResolvedValue(true);
        const accountClarificationHandler = vi.fn().mockResolvedValue(true);
        const handler = createUserMessageHandler(
          pendingService,
          reconciliationHandler,
          accountClarificationHandler
        );

        await handler.handleIncomingUserMessage(event(alias));

        expect(reconciliationHandler).not.toHaveBeenCalled();
        expect(accountClarificationHandler).toHaveBeenCalledTimes(1);
      }
    );

    it('routes the canonical numbered protocol command while an UNKNOWN item exists', async () => {
      const pendingService = new PendingTransactionService();
      const ticketId = addUnknownStandardTransaction(pendingService);
      const reconciliationHandler = vi.fn().mockResolvedValue(true);
      const accountClarificationHandler = vi.fn().mockResolvedValue(true);
      const handler = createUserMessageHandler(
        pendingService,
        reconciliationHandler,
        accountClarificationHandler
      );

      await handler.handleIncomingUserMessage(event(`sudah ada #${ticketId}`));

      expect(reconciliationHandler).toHaveBeenCalledWith(
        expect.objectContaining({ textPayload: `sudah ada #${ticketId}` }),
        { actionType: 'CONFIRM_RECORDED', targetTicketId: ticketId },
        expect.any(Number)
      );
      expect(accountClarificationHandler).not.toHaveBeenCalled();
    });

    it('does not consume a bare alias when there is no UNKNOWN workflow', async () => {
      const pendingService = new PendingTransactionService();
      const reconciliationHandler = vi.fn().mockResolvedValue(true);
      const accountClarificationHandler = vi.fn().mockResolvedValue(true);
      const handler = createUserMessageHandler(
        pendingService,
        reconciliationHandler,
        accountClarificationHandler
      );

      await handler.handleIncomingUserMessage(event('belum'));

      expect(reconciliationHandler).not.toHaveBeenCalled();
      expect(accountClarificationHandler).toHaveBeenCalledTimes(1);
    });

    it('routes the canonical English protocol command while an UNKNOWN item exists', async () => {
      const pendingService = new PendingTransactionService();
      const ticketId = addUnknownStandardTransaction(pendingService);
      const reconciliationHandler = vi.fn().mockResolvedValue(true);
      const handler = createUserMessageHandler(pendingService, reconciliationHandler);

      await handler.handleIncomingUserMessage(event(`not there ${ticketId}`));

      expect(reconciliationHandler).toHaveBeenCalledWith(
        expect.anything(),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        expect.any(Number)
      );
    });
  });

  describe('account-selection draft reconciliation', () => {
    function createPendingActionHandler(service: PendingTransactionService, gateway: MockMessagingGateway) {
      return new PendingActionHandler(
        service,
        { createRecords: vi.fn() } as any,
        gateway as any,
        () => null
      );
    }

    it('returns a numbered UNKNOWN account draft to account selection instead of Ya/Batal', async () => {
      const service = new PendingTransactionService();
      const gateway = new MockMessagingGateway();
      const handler = createPendingActionHandler(service, gateway);
      const ticketId = addUnknownAccountDraft(service);

      await handler.handleReconciliationAction(
        event(`belum ada #${ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        Date.now()
      );

      expect(service.getPendingAccountSelectionDraftState(ticketId)).toBe('PENDING');
      expect(gateway.lastMessage).toContain(`Pilih Akun Transaksi (#${ticketId})`);
      expect(gateway.lastMessage).toContain('BCA');
      expect(gateway.lastMessage).toContain('Jago');
      expect(gateway.lastMessage).not.toContain(`Ya #${ticketId}`);
      expect(gateway.lastMessage).not.toContain(`Batal #${ticketId}`);
    });

    it('returns an unnumbered single UNKNOWN account draft to account selection', async () => {
      const service = new PendingTransactionService();
      const gateway = new MockMessagingGateway();
      const handler = createPendingActionHandler(service, gateway);
      const ticketId = addUnknownAccountDraft(service);

      await handler.handleReconciliationAction(
        event('belum ada'),
        { actionType: 'CONFIRM_ABSENT' },
        Date.now()
      );

      expect(service.getPendingAccountSelectionDraftState(ticketId)).toBe('PENDING');
      expect(gateway.lastMessage).toContain(`Pilih Akun Transaksi (#${ticketId})`);
      expect(gateway.lastMessage).toContain('Balas dengan nomor atau nama akun');
    });

    it('preserves Ya/Batal retry instructions for a standard UNKNOWN transaction', async () => {
      const service = new PendingTransactionService();
      const gateway = new MockMessagingGateway();
      const handler = createPendingActionHandler(service, gateway);
      const ticketId = addUnknownStandardTransaction(service);

      await handler.handleReconciliationAction(
        event(`belum ada #${ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        Date.now()
      );

      expect(service.getPendingTransactionState(ticketId)).toBe('PENDING');
      expect(gateway.lastMessage).toContain(`Ya #${ticketId}`);
      expect(gateway.lastMessage).toContain(`Batal #${ticketId}`);
    });

    it('uses the localized account-selection prompt after English reconciliation', async () => {
      setActiveLanguage('en');
      const service = new PendingTransactionService();
      const gateway = new MockMessagingGateway();
      const handler = createPendingActionHandler(service, gateway);
      const ticketId = addUnknownAccountDraft(service);

      await handler.handleReconciliationAction(
        event(`not there #${ticketId}`),
        { actionType: 'CONFIRM_ABSENT', targetTicketId: ticketId },
        Date.now()
      );

      expect(gateway.lastMessage).toContain(`Choose Transaction Account (#${ticketId})`);
      expect(gateway.lastMessage).toContain('Reply with the account number or name');
    });
  });
});
