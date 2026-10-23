import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { createTestUserMessageHandler } from './fixtures/compositionFixtures.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { setActiveLanguage } from '../src/i18n/index.js';

function event(text: string) {
  return {
    channel: 'whatsapp',
    chatIdentifier: 'chat-1',
    senderIdentifier: 'sender-1',
    messageType: 'text',
    textPayload: text,
  } as any;
}

function addPending(service: PendingTransactionService) {
  return service.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Main',
    counterParty: 'Merchant',
    amount: 10000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    note: 'Test',
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
      amount: -10000,
      currency: 'IDR',
      recordDate: '2026-09-13',
      note: 'Draft',
    }],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: [{ id: 'acc-1', name: 'BCA', currency: 'IDR' }],
  });
}

function createHandler(options: {
  pending?: any;
  pendingAction?: any;
  fastPath?: any;
  accountClarification?: any;
  ai?: any;
  messages?: string[];
} = {}) {
  const messages = options.messages ?? [];
  const gateway = {
    sendTypingPresence: vi.fn().mockResolvedValue(undefined),
    clearTypingPresence: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn(async (_channel: string, _chat: string, message: string) => {
      messages.push(message);
    }),
  };
  const pending = options.pending ?? new PendingTransactionService();
  const pendingAction = options.pendingAction ?? {
    handlePendingAction: vi.fn().mockResolvedValue(false),
    handleReconciliationAction: vi.fn().mockResolvedValue(false),
  };
  const fastPath = options.fastPath ?? { handleFastPath: vi.fn().mockResolvedValue(false) };
  const accountClarification = options.accountClarification ?? {
    handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false),
  };
  const ai = options.ai ?? {
    providerName: 'mock',
    processTextMessage: vi.fn().mockResolvedValue({ action: 'GENERAL_REPLY', explanation: 'fallback' }),
    processImageMessage: vi.fn(),
  };
  const cache = {
    getAccounts: vi.fn().mockReturnValue([]),
    getCategories: vi.fn().mockReturnValue([]),
  };
  const registry = {
    hasHandler: vi.fn().mockReturnValue(false),
    execute: vi.fn(),
  };

  const handler = createTestUserMessageHandler({
    messagingGateway: gateway as any,
    pendingTransactionManager: pending as any,
    pendingActionHandler: pendingAction as any,
    fastPathHandler: fastPath as any,
    financialAiProvider: ai as any,
    walletCacheService: cache as any,
    financialActionRegistry: registry as any,
    accountClarificationHandler: accountClarification as any,
  });

  return { handler, gateway, pending, pendingAction, fastPath, accountClarification, ai, messages };
}

describe('PR #155 UserMessageHandler routing branch coverage', () => {
  beforeEach(() => setActiveLanguage('id'));

  it('falls back safely when a partial pending manager has no hasPendingTransactions method', async () => {
    const partialPending = {};
    const harness = createHandler({ pending: partialPending });

    await harness.handler.handleIncomingUserMessage(event('halo bot'));

    expect(harness.accountClarification.handlePendingAccountSelectionReply).toHaveBeenCalledOnce();
    expect(harness.ai.processTextMessage).toHaveBeenCalledOnce();
    expect(harness.gateway.clearTypingPresence).toHaveBeenCalledOnce();
  });

  it('continues after explicit reconciliation when reconciliation handler declines the command', async () => {
    const service = new PendingTransactionService();
    const reconciliation = vi.fn().mockResolvedValue(false);
    const accountClarification = { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(true) };
    const harness = createHandler({
      pending: service,
      pendingAction: {
        handlePendingAction: vi.fn().mockResolvedValue(false),
        handleReconciliationAction: reconciliation,
      },
      accountClarification,
    });

    await harness.handler.handleIncomingUserMessage(event('sudah ada #404'));

    expect(reconciliation).toHaveBeenCalledOnce();
    expect(accountClarification.handlePendingAccountSelectionReply).toHaveBeenCalledOnce();
    expect(harness.ai.processTextMessage).not.toHaveBeenCalled();
  });

  it('routes a numbered pending command in the later pending stage', async () => {
    const service = new PendingTransactionService();
    const item = addPending(service);
    const pendingAction = {
      handlePendingAction: vi.fn().mockResolvedValue(true),
      handleReconciliationAction: vi.fn().mockResolvedValue(false),
    };
    const accountClarification = { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(false) };
    const harness = createHandler({ pending: service, pendingAction, accountClarification });

    await harness.handler.handleIncomingUserMessage(event(`ya #${item.ticketId}`));

    expect(accountClarification.handlePendingAccountSelectionReply).toHaveBeenCalledOnce();
    expect(pendingAction.handlePendingAction).toHaveBeenCalledOnce();
    expect(pendingAction.handlePendingAction).toHaveBeenCalledWith(
      expect.anything(),
      { actionType: 'CONFIRM', targetScope: item.ticketId },
      expect.any(Number)
    );
    expect(harness.ai.processTextMessage).not.toHaveBeenCalled();
  });

  it('continues to account clarification after an early generic pending handler declines', async () => {
    const service = new PendingTransactionService();
    addPending(service);
    const pendingAction = {
      handlePendingAction: vi.fn().mockResolvedValue(false),
      handleReconciliationAction: vi.fn().mockResolvedValue(false),
    };
    const accountClarification = { handlePendingAccountSelectionReply: vi.fn().mockResolvedValue(true) };
    const harness = createHandler({ pending: service, pendingAction, accountClarification });

    await harness.handler.handleIncomingUserMessage(event('ya'));

    expect(pendingAction.handlePendingAction).toHaveBeenCalledOnce();
    expect(accountClarification.handlePendingAccountSelectionReply).toHaveBeenCalledOnce();
    expect(harness.ai.processTextMessage).not.toHaveBeenCalled();
  });

  it('continues to AI when fast-path detector matches but fast-path handler declines', async () => {
    const fastPath = { handleFastPath: vi.fn().mockResolvedValue(false) };
    const harness = createHandler({ fastPath });

    await harness.handler.handleIncomingUserMessage(event('status'));

    expect(fastPath.handleFastPath).toHaveBeenCalledWith(
      expect.anything(),
      'CHECK_QUEUE',
      expect.any(Number)
    );
    expect(harness.ai.processTextMessage).toHaveBeenCalledOnce();
  });

  it('disambiguates bare Indonesian cancellation when both workflows have PENDING items', async () => {
    const service = new PendingTransactionService();
    const standard = addPending(service);
    const draft = addDraft(service);
    const harness = createHandler({ pending: service });

    await harness.handler.handleIncomingUserMessage(event('batal'));

    expect(harness.messages.at(-1)).toContain(`batal #${draft.ticketId}`);
    expect(harness.messages.at(-1)).toContain(`batal #${standard.ticketId}`);
    expect(service.getPendingTransaction(standard.ticketId)).toBeDefined();
    expect(service.getPendingAccountSelectionDraft(draft.ticketId)).toBeDefined();
    expect(harness.pendingAction.handlePendingAction).not.toHaveBeenCalled();
  });

  it('disambiguates bare English cancellation using localized wording', async () => {
    setActiveLanguage('en');
    const service = new PendingTransactionService();
    const standard = addPending(service);
    const draft = addDraft(service);
    const harness = createHandler({ pending: service });

    await harness.handler.handleIncomingUserMessage(event('cancel'));

    expect(harness.messages.at(-1)).toContain(`cancel #${draft.ticketId}`);
    expect(harness.messages.at(-1)).toContain(`cancel #${standard.ticketId}`);
    expect(harness.messages.at(-1)).toContain('Nothing was cancelled');
  });

  it('does not enter ambiguity branch when the clarification draft is not PENDING', async () => {
    const service = new PendingTransactionService();
    addPending(service);
    const draft = addDraft(service);
    service.markPendingAccountSelectionDraftUnknown(draft.ticketId);
    const pendingAction = {
      handlePendingAction: vi.fn().mockResolvedValue(true),
      handleReconciliationAction: vi.fn().mockResolvedValue(false),
    };
    const harness = createHandler({ pending: service, pendingAction });

    await harness.handler.handleIncomingUserMessage(event('batal'));

    expect(pendingAction.handlePendingAction).toHaveBeenCalledOnce();
    expect(harness.messages).toHaveLength(0);
  });
});
