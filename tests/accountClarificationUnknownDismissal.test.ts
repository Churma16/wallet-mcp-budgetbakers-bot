import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';

console.log('====================================================');
console.log('[test] UNKNOWN Account Clarification Dismissal');
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
  public readonly messages: string[] = [];

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(_channel: string, _chatId: string, content: string): Promise<void> {
    this.messages.push(content);
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private failWithUnknownOutcome = true;

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
    if (this.failWithUnknownOutcome) {
      this.failWithUnknownOutcome = false;
      throw new WalletMcpRequestError('simulated uncertain Wallet outcome', 'UNKNOWN');
    }
    return {};
  }
}

class MockWalletCacheService {
  constructor(
    private readonly accounts: WalletAccountItem[],
    private readonly categories: WalletCategoryItem[]
  ) {}

  getAccounts(): WalletAccountItem[] {
    return this.accounts;
  }

  getCategories(): WalletCategoryItem[] {
    return this.categories;
  }
}

class RecordingPendingActionHandler {
  public readonly calls: Array<{ actionType: string; targetScope: string | number }> = [];

  async handlePendingAction(
    _event: IncomingUserMessageEvent,
    intent: { actionType: string; targetScope: string | number }
  ): Promise<boolean> {
    this.calls.push({ ...intent });
    return true;
  }
}

class NoopFastPathHandler {
  async handleFastPath(): Promise<boolean> {
    return false;
  }
}

class FailIfCalledAiProvider {
  public readonly providerName = 'test';

  async processTextMessage(): Promise<never> {
    throw new Error('AI must not run for ticket-specific pending commands');
  }

  async processImageMessage(): Promise<never> {
    throw new Error('AI must not run for ticket-specific pending commands');
  }
}

const accounts: WalletAccountItem[] = [
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const categories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food' },
];

const event: IncomingUserMessageEvent = {
  channel: 'whatsapp',
  senderIdentifier: '+628123456789',
  chatIdentifier: '+628123456789',
  messageType: 'text',
  textPayload: '1',
};

const unresolvedRecord: CreateRecordInputPayload = {
  accountId: '',
  amount: -45000,
  recordDate: '2026-09-11T07:00:00+07:00',
  categoryId: 'cat-food',
  note: 'Lunch',
  counterParty: 'Warung',
};

function addStandardPendingTransaction(pendingService: PendingTransactionService, note: string) {
  return pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Cash',
    counterParty: 'Pending merchant',
    amount: -10000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-cash',
    matchedCategoryId: 'cat-food',
    matchedCategoryName: 'Food',
    note,
    recordDate: '2026-09-11T07:05:00+07:00',
    currency: 'IDR',
  });
}

async function main(): Promise<void> {
  setActiveLanguage('id');

  const pendingService = new PendingTransactionService();
  const messaging = new MockMessagingGateway();
  const walletMcp = new MockWalletMcpClient();
  const cache = new MockWalletCacheService(accounts, categories);
  const handler = new AccountClarificationHandler(
    pendingService,
    walletMcp as any,
    cache as any,
    messaging as any
  );

  const draft = pendingService.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: event.channel,
    senderIdentifier: event.senderIdentifier,
    chatIdentifier: event.chatIdentifier,
    records: [unresolvedRecord],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: accounts,
  });

  const selectionHandled = await handler.handlePendingAccountSelectionReply(
    event,
    '1',
    Date.now()
  );

  assertCondition('Initial account choice is handled', selectionHandled);
  assertCondition('Wallet dispatch occurs exactly once', walletMcp.calls.length === 1);
  assertCondition(
    'Uncertain Wallet outcome marks draft UNKNOWN',
    pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === 'UNKNOWN'
  );
  assertCondition(
    'Uncertainty warning gives ticket-specific reconciliation syntax',
    messaging.messages.at(-1)?.includes(`batal #${draft.ticketId}`) === true
  );

  addStandardPendingTransaction(pendingService, 'Separate pending transaction');

  const genericCancellationHandled = await handler.handlePendingAccountSelectionReply(
    { ...event, textPayload: 'batal' },
    'batal',
    Date.now()
  );

  assertCondition(
    'Generic cancellation is left for the standard pending-action router',
    genericCancellationHandled === false
  );
  assertCondition(
    'Generic cancellation does not remove UNKNOWN reconciliation draft',
    pendingService.getPendingAccountSelectionDraft(draft.ticketId) !== undefined
  );
  assertCondition('Generic cancellation does not retry Wallet', walletMcp.calls.length === 1);

  const targetedCancellationHandled = await handler.handlePendingAccountSelectionReply(
    { ...event, textPayload: `batal #${draft.ticketId}` },
    `batal #${draft.ticketId}`,
    Date.now()
  );

  const dismissalMessage = messaging.messages.at(-1) || '';
  assertCondition('Ticket-specific UNKNOWN dismissal is handled', targetedCancellationHandled);
  assertCondition(
    'Ticket-specific UNKNOWN dismissal removes only the reconciliation draft',
    pendingService.getPendingAccountSelectionDraft(draft.ticketId) === undefined
  );
  assertCondition('UNKNOWN dismissal never retries Wallet', walletMcp.calls.length === 1);
  assertCondition(
    'UNKNOWN dismissal does not falsely claim the transaction was not recorded',
    !dismissalMessage.includes('Transaksi tidak dicatat ke Wallet') &&
      !dismissalMessage.includes('transaksi tidak dicatat ke Wallet')
  );
  assertCondition(
    'UNKNOWN dismissal preserves the uncertain-outcome warning',
    dismissalMessage.includes('tetap belum dapat dipastikan')
  );
  assertCondition(
    'Separate standard pending transaction remains available',
    pendingService.hasPendingTransactions()
  );

  // Regression: an active PENDING clarification must not swallow ticket-specific commands that
  // target a standard pending transaction. Exercise the real UserMessageHandler ordering so the
  // test proves those commands actually reach PendingActionHandler.
  const routingPendingService = new PendingTransactionService();
  const routingMessaging = new MockMessagingGateway();
  const routingWalletMcp = new MockWalletMcpClient();
  const routingCache = new MockWalletCacheService(accounts, categories);
  const routingPendingAction = new RecordingPendingActionHandler();
  const routingHandler = new UserMessageHandler(
    routingMessaging as any,
    routingPendingService,
    routingPendingAction as any,
    new NoopFastPathHandler() as any,
    new FailIfCalledAiProvider() as any,
    routingCache as any,
    routingWalletMcp as any
  );

  const routingDraft = routingPendingService.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: event.channel,
    senderIdentifier: event.senderIdentifier,
    chatIdentifier: event.chatIdentifier,
    records: [unresolvedRecord],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: accounts,
  });
  const standardTicket = addStandardPendingTransaction(
    routingPendingService,
    'Standard ticket targeted by explicit commands'
  );

  await routingHandler.handleIncomingUserMessage({
    ...event,
    textPayload: `batal #${standardTicket.ticketId}`,
  });

  assertCondition(
    'Ticket-specific reject reaches standard pending handler',
    routingPendingAction.calls.length === 1 &&
      routingPendingAction.calls[0].actionType === 'REJECT' &&
      routingPendingAction.calls[0].targetScope === standardTicket.ticketId
  );
  assertCondition(
    'Ticket-specific reject leaves clarification draft untouched',
    routingPendingService.getPendingAccountSelectionDraft(routingDraft.ticketId) !== undefined &&
      routingPendingService.getPendingAccountSelectionDraftState(routingDraft.ticketId) === 'PENDING'
  );

  await routingHandler.handleIncomingUserMessage({
    ...event,
    textPayload: `ya #${standardTicket.ticketId}`,
  });

  assertCondition(
    'Ticket-specific confirm reaches standard pending handler',
    routingPendingAction.calls.length === 2 &&
      routingPendingAction.calls[1].actionType === 'CONFIRM' &&
      routingPendingAction.calls[1].targetScope === standardTicket.ticketId
  );
  assertCondition(
    'Ticket-specific confirm also leaves clarification draft untouched',
    routingPendingService.getPendingAccountSelectionDraft(routingDraft.ticketId) !== undefined &&
      routingPendingService.getPendingAccountSelectionDraftState(routingDraft.ticketId) === 'PENDING'
  );
  assertCondition(
    'Ticket-specific standard commands do not dispatch clarification Wallet writes',
    routingWalletMcp.calls.length === 0
  );

  console.log(`\n[SUCCESS] ${assertionCount} assertions passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
