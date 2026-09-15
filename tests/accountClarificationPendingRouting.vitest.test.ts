import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { expect, it } from 'vitest';

function assertCondition(testName: string, condition: boolean): void {
  expect(condition, testName).toBe(true);
}

class MockMessagingGateway {
  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}
  async sendMessage(): Promise<void> {}
}

class MockPendingActionHandler {
  public readonly calls: Array<{ actionType: string; targetScope: string | number }> = [];

  async handlePendingAction(
    _event: IncomingUserMessageEvent,
    intent: { actionType: string; targetScope: string | number }
  ): Promise<boolean> {
    this.calls.push(intent);
    return true;
  }
}

class MockFastPathHandler {
  public calls = 0;
  async handleFastPath(): Promise<boolean> {
    this.calls++;
    return true;
  }
}

class MockFinancialAiProvider {
  public providerName = 'mock';
  public textCalls = 0;
  async processTextMessage(): Promise<Record<string, unknown>> {
    this.textCalls++;
    return { action: 'GENERAL_REPLY', explanation: 'unused' };
  }
  async processImageMessage(): Promise<Record<string, unknown>> {
    return { action: 'GENERAL_REPLY', explanation: 'unused' };
  }
}

const accounts: WalletAccountItem[] = [
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const categories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food' },
];

const unresolvedRecord: CreateRecordInputPayload = {
  accountId: '',
  amount: -45000,
  recordDate: '2026-09-11T08:00:00+07:00',
  categoryId: 'cat-food',
  note: 'Lunch',
  counterParty: 'Warung',
};

function createEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload,
  };
}

function createHarness() {
  const pendingService = new PendingTransactionService();
  const pendingActionHandler = new MockPendingActionHandler();
  const fastPathHandler = new MockFastPathHandler();
  const financialAiProvider = new MockFinancialAiProvider();
  const messagingGateway = new MockMessagingGateway();
  const walletDispatch = { calls: 0 };
  const walletCacheService = {
    getAccounts: () => accounts,
    getCategories: () => categories,
  };
  const walletMcpClient = {
    createRecords: async () => {
      walletDispatch.calls++;
      return {};
    },
    fetchBudgets: async () => [],
  };

  const clarificationDraft = pendingService.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    records: [unresolvedRecord],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: accounts,
  });

  const standardPending = pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Cash',
    counterParty: 'Separate merchant',
    amount: -10000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-cash',
    matchedCategoryId: 'cat-food',
    matchedCategoryName: 'Food',
    note: 'Separate pending transaction',
    recordDate: '2026-09-11T08:05:00+07:00',
    currency: 'IDR',
  });

  const handler = new UserMessageHandler(
    messagingGateway as any,
    pendingService,
    pendingActionHandler as any,
    fastPathHandler as any,
    financialAiProvider as any,
    walletCacheService as any,
    walletMcpClient as any
  );

  return {
    pendingService,
    pendingActionHandler,
    fastPathHandler,
    financialAiProvider,
    walletDispatch,
    handler,
    clarificationDraft,
    standardPending,
  };
}

function assertClarificationUntouched(
  label: string,
  harness: ReturnType<typeof createHarness>
): void {
  assertCondition(
    `${label} leaves clarification draft present`,
    harness.pendingService.getPendingAccountSelectionDraft(
      harness.clarificationDraft.ticketId
    ) !== undefined
  );
  assertCondition(
    `${label} leaves clarification draft PENDING`,
    harness.pendingService.getPendingAccountSelectionDraftState(
      harness.clarificationDraft.ticketId
    ) === 'PENDING'
  );
  assertCondition(`${label} bypasses AI`, harness.financialAiProvider.textCalls === 0);
  assertCondition(`${label} does not dispatch clarification Wallet write`, harness.walletDispatch.calls === 0);
}

async function assertPendingRoute(
  textPayload: string | ((harness: ReturnType<typeof createHarness>) => string),
  expectedActionType: 'CONFIRM' | 'REJECT',
  expectedTargetScope: 'LATEST' | 'ALL' | ((harness: ReturnType<typeof createHarness>) => number),
  label: string
): Promise<void> {
  const harness = createHarness();
  const message = typeof textPayload === 'function' ? textPayload(harness) : textPayload;
  const targetScope = typeof expectedTargetScope === 'function'
    ? expectedTargetScope(harness)
    : expectedTargetScope;

  await harness.handler.handleIncomingUserMessage(createEvent(message));

  assertCondition(
    `${label} reaches the standard pending handler`,
    harness.pendingActionHandler.calls.length === 1 &&
      harness.pendingActionHandler.calls[0].actionType === expectedActionType &&
      harness.pendingActionHandler.calls[0].targetScope === targetScope
  );
  assertClarificationUntouched(label, harness);
}

it('routes ticket-specific rejection without disturbing the clarification draft', async () => {
  await assertPendingRoute(
    harness => `batal #${harness.standardPending.ticketId}`,
    'REJECT',
    harness => harness.standardPending.ticketId,
    'Ticket-specific rejection'
  );
});

it('routes ticket-specific confirmation without disturbing the clarification draft', async () => {
  await assertPendingRoute(
    harness => `ya #${harness.standardPending.ticketId}`,
    'CONFIRM',
    harness => harness.standardPending.ticketId,
    'Ticket-specific confirmation'
  );
});

it('routes generic latest confirmation without disturbing the clarification draft', async () => {
  await assertPendingRoute('ya', 'CONFIRM', 'LATEST', 'Generic latest confirmation');
});

it('routes English generic confirmation without disturbing the clarification draft', async () => {
  await assertPendingRoute('confirm', 'CONFIRM', 'LATEST', 'English generic confirmation');
});

it('routes confirm-all without disturbing the clarification draft', async () => {
  await assertPendingRoute('ya semua', 'CONFIRM', 'ALL', 'Confirm-all');
});

it('routes reject-all without disturbing the clarification draft', async () => {
  await assertPendingRoute('batal semua', 'REJECT', 'ALL', 'Reject-all');
});

it('routes unambiguous latest rejection without disturbing the clarification draft', async () => {
  await assertPendingRoute('tolak', 'REJECT', 'LATEST', 'Unambiguous generic latest rejection');
});
