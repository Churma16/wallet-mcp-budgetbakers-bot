import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';

console.log('====================================================');
console.log('[test] Account Clarification vs Pending Ticket Routing');
console.log('====================================================\n');

let assertionCount = 0;

function assertCondition(testName: string, condition: boolean): void {
  assertionCount++;
  if (!condition) {
    throw new Error(`[FAIL] ${testName}`);
  }
  console.log(`[PASS] ${testName}`);
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
  const walletCacheService = {
    getAccounts: () => accounts,
    getCategories: () => categories,
  };
  const walletMcpClient = {
    createRecords: async () => ({}),
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
    handler,
    clarificationDraft,
    standardPending,
  };
}

async function main(): Promise<void> {
  const rejectHarness = createHarness();
  await rejectHarness.handler.handleIncomingUserMessage(
    createEvent(`batal #${rejectHarness.standardPending.ticketId}`)
  );

  assertCondition(
    'Ticket-specific rejection reaches the standard pending handler',
    rejectHarness.pendingActionHandler.calls.length === 1 &&
      rejectHarness.pendingActionHandler.calls[0].actionType === 'REJECT' &&
      rejectHarness.pendingActionHandler.calls[0].targetScope === rejectHarness.standardPending.ticketId
  );
  assertCondition(
    'Ticket-specific rejection leaves clarification draft unchanged',
    rejectHarness.pendingService.getPendingAccountSelectionDraft(
      rejectHarness.clarificationDraft.ticketId
    ) !== undefined
  );
  assertCondition('Ticket-specific rejection bypasses AI', rejectHarness.financialAiProvider.textCalls === 0);

  const confirmHarness = createHarness();
  await confirmHarness.handler.handleIncomingUserMessage(
    createEvent(`ya #${confirmHarness.standardPending.ticketId}`)
  );

  assertCondition(
    'Ticket-specific confirmation reaches the standard pending handler',
    confirmHarness.pendingActionHandler.calls.length === 1 &&
      confirmHarness.pendingActionHandler.calls[0].actionType === 'CONFIRM' &&
      confirmHarness.pendingActionHandler.calls[0].targetScope === confirmHarness.standardPending.ticketId
  );
  assertCondition(
    'Ticket-specific confirmation leaves clarification draft unchanged',
    confirmHarness.pendingService.getPendingAccountSelectionDraft(
      confirmHarness.clarificationDraft.ticketId
    ) !== undefined
  );
  assertCondition('Ticket-specific confirmation bypasses AI', confirmHarness.financialAiProvider.textCalls === 0);

  console.log(`\n[SUCCESS] ${assertionCount} assertions passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
