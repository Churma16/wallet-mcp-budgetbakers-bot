import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';

console.log('====================================================');
console.log('[test] Account Clarification Safety Regressions');
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
  public failNextSend = false;
  public failWhen: ((content: string) => boolean) | null = null;

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(_channel: string, _chatId: string, content: string): Promise<void> {
    const shouldFail = this.failNextSend || Boolean(this.failWhen?.(content));
    if (shouldFail) {
      this.failNextSend = false;
      this.failWhen = null;
      throw new Error('simulated messaging timeout');
    }
    this.messages.push(content);
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  public failNextWithUnknownOutcome = false;

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
    if (this.failNextWithUnknownOutcome) {
      this.failNextWithUnknownOutcome = false;
      throw new WalletMcpRequestError('simulated uncertain Wallet outcome', 'UNKNOWN');
    }
    return {};
  }

  async fetchBudgets(): Promise<never[]> {
    return [];
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

  async refreshAccounts(): Promise<WalletAccountItem[]> {
    return this.accounts;
  }
}

class MockPendingActionHandler {
  public readonly calls: Array<{ actionType: string; targetScope: string | number }> = [];

  constructor(private readonly pendingService: PendingTransactionService) {}

  async handlePendingAction(
    _event: IncomingUserMessageEvent,
    intent: { actionType: 'CONFIRM' | 'REJECT'; targetScope: 'LATEST' | 'ALL' | number }
  ): Promise<boolean> {
    this.calls.push(intent);

    if (intent.actionType === 'REJECT') {
      if (intent.targetScope === 'ALL') {
        this.pendingService.rejectAllPendingTransactions();
      } else if (typeof intent.targetScope === 'number') {
        this.pendingService.rejectPendingTransaction(intent.targetScope);
      } else {
        const latestItem = this.pendingService.getLatestPendingTransaction();
        if (latestItem) {
          this.pendingService.rejectPendingTransaction(latestItem.ticketId);
        }
      }
    }

    return true;
  }
}

class MockFastPathHandler {
  public readonly calls: string[] = [];

  async handleFastPath(_event: IncomingUserMessageEvent, action: string): Promise<boolean> {
    this.calls.push(action);
    return true;
  }
}

class MockFinancialAiProvider {
  public readonly providerName = 'mock';
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
  recordDate: '2026-09-11T10:00:00+07:00',
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

function addClarificationDraft(pendingService: PendingTransactionService) {
  return pendingService.addPendingAccountSelectionDraft({
    sourceType: 'USER',
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    records: [unresolvedRecord],
    pendingRecordIndex: 0,
    accountHint: '',
    candidateAccounts: accounts,
  });
}

function addStandardPending(pendingService: PendingTransactionService, note: string) {
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
    recordDate: '2026-09-11T10:05:00+07:00',
    currency: 'IDR',
  });
}

function createUserHandlerHarness(pendingService: PendingTransactionService, messaging: MockMessagingGateway) {
  const walletMcp = new MockWalletMcpClient();
  const cache = new MockWalletCacheService(accounts, categories);
  const pendingActionHandler = new MockPendingActionHandler(pendingService);
  const fastPathHandler = new MockFastPathHandler();
  const financialAiProvider = new MockFinancialAiProvider();
  const handler = new UserMessageHandler(
    messaging as any,
    pendingService,
    pendingActionHandler as any,
    fastPathHandler as any,
    financialAiProvider as any,
    cache as any,
    walletMcp as any
  );

  return {
    handler,
    walletMcp,
    pendingActionHandler,
    fastPathHandler,
    financialAiProvider,
  };
}

async function testAmbiguousBareCancellation(): Promise<void> {
  const pendingService = new PendingTransactionService();
  const messaging = new MockMessagingGateway();
  const clarificationDraft = addClarificationDraft(pendingService);
  const standardPending = addStandardPending(pendingService, 'Standard pending B');
  const harness = createUserHandlerHarness(pendingService, messaging);

  await harness.handler.handleIncomingUserMessage(createEvent('batal'));

  assertCondition(
    'Bare cancellation leaves clarification draft unchanged when both workflows coexist',
    pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) !== undefined &&
      pendingService.getPendingAccountSelectionDraftState(clarificationDraft.ticketId) === 'PENDING'
  );
  assertCondition(
    'Bare cancellation leaves standard pending ticket unchanged when both workflows coexist',
    pendingService.getPendingTransaction(standardPending.ticketId) !== undefined &&
      pendingService.getPendingTransactionState(standardPending.ticketId) === 'PENDING'
  );
  assertCondition('Bare ambiguous cancellation does not reach pending action handler', harness.pendingActionHandler.calls.length === 0);
  assertCondition('Bare ambiguous cancellation never dispatches Wallet', harness.walletMcp.calls.length === 0);
  assertCondition(
    'Disambiguation guidance names both ticket-specific cancellation commands',
    messaging.messages.at(-1)?.includes(`batal #${clarificationDraft.ticketId}`) === true &&
      messaging.messages.at(-1)?.includes(`batal #${standardPending.ticketId}`) === true
  );

  await harness.handler.handleIncomingUserMessage(
    createEvent(`batal #${standardPending.ticketId}`)
  );
  assertCondition(
    'Ticket-specific standard cancellation removes only the standard ticket',
    pendingService.getPendingTransaction(standardPending.ticketId) === undefined &&
      pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) !== undefined
  );

  const replacementStandardPending = addStandardPending(pendingService, 'Standard pending C');
  await harness.handler.handleIncomingUserMessage(
    createEvent(`batal #${clarificationDraft.ticketId}`)
  );
  assertCondition(
    'Ticket-specific clarification cancellation removes only the clarification draft',
    pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) === undefined &&
      pendingService.getPendingTransaction(replacementStandardPending.ticketId) !== undefined
  );
}

async function testUnknownWarningDeliveryFailure(): Promise<void> {
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
  const draft = addClarificationDraft(pendingService);

  walletMcp.failNextWithUnknownOutcome = true;
  messaging.failWhen = content => content.includes('belum dapat dipastikan');

  const handled = await handler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );

  assertCondition('UNKNOWN dispatch with warning delivery failure is still handled', handled);
  assertCondition('UNKNOWN warning delivery failure leaves draft UNKNOWN', pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === 'UNKNOWN');
  assertCondition('UNKNOWN warning delivery failure performs exactly one Wallet dispatch', walletMcp.calls.length === 1);
  assertCondition(
    'UNKNOWN warning delivery failure emits no retry or coba-lagi guidance',
    messaging.messages.every(message => !/(coba\s*lagi|retry|mencoba ulang)/i.test(message))
  );

  const repeatedChoiceHandled = await handler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  assertCondition('UNKNOWN draft no longer claims a repeated account choice automatically', repeatedChoiceHandled === false);
  assertCondition('UNKNOWN draft is never redispatched automatically', walletMcp.calls.length === 1);
}

async function testInitialPromptFailureRollback(): Promise<void> {
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

  messaging.failNextSend = true;
  let promptFailureObserved = false;
  try {
    await handler.createPendingAccountSelectionDraft(
      createEvent('Lunch 45k'),
      [unresolvedRecord],
      [{ recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] }],
      accounts,
      categories
    );
  } catch {
    promptFailureObserved = true;
  }

  assertCondition('Initial clarification prompt delivery failure propagates to caller', promptFailureObserved);
  assertCondition('Undelivered initial clarification draft is rolled back', pendingService.getAllPendingAccountSelectionDrafts().length === 0);

  const userHarness = createUserHandlerHarness(pendingService, messaging);
  await userHarness.handler.handleIncomingUserMessage(createEvent('saldo'));

  assertCondition('Next unrelated message follows normal fast-path routing', userHarness.fastPathHandler.calls.includes('CHECK_BALANCE'));
  assertCondition('Hidden failed draft does not consume the next message', userHarness.financialAiProvider.textCalls === 0);
}

async function testFollowUpPromptDeliveryFailure(): Promise<void> {
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

  const twoUnresolvedRecords: CreateRecordInputPayload[] = [
    { ...unresolvedRecord, note: 'Lunch' },
    { ...unresolvedRecord, amount: -20000, note: 'Coffee' },
  ];

  const initialCreated = await handler.createPendingAccountSelectionDraft(
    createEvent('Lunch and coffee'),
    twoUnresolvedRecords,
    [
      { recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] },
      { recordIndex: 1, accountHint: '', reason: 'UNRESOLVED', candidates: [] },
    ],
    accounts,
    categories
  );
  assertCondition('Initial multi-record prompt is delivered successfully', initialCreated);
  const draft = pendingService.getAllPendingAccountSelectionDrafts()[0];
  assertCondition(
    'First-step draft is PENDING for record 1',
    Boolean(draft) && pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === 'PENDING'
  );
  assertCondition('First prompt delivered to user', messaging.messages.length === 1);

  messaging.failNextSend = true;
  let secondPromptFailureObserved = false;
  try {
    await handler.handlePendingAccountSelectionReply(
      createEvent('1'),
      '1',
      Date.now()
    );
  } catch {
    secondPromptFailureObserved = true;
  }

  assertCondition('Follow-up prompt delivery failure propagates to caller', secondPromptFailureObserved);
  assertCondition('Wallet dispatch count remains 0 after follow-up prompt failure', walletMcp.calls.length === 0);
  assertCondition(
    'Second-step draft is not left claimable as PENDING',
    pendingService.getAllPendingAccountSelectionDrafts().length === 0
  );
  assertCondition(
    'Second-step draft state is cleared from tracking',
    pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === undefined
  );

  const userHarness = createUserHandlerHarness(pendingService, messaging);
  await userHarness.handler.handleIncomingUserMessage(createEvent('1'));

  assertCondition('Subsequent numeric reply cannot silently resolve record 2 or call Wallet', walletMcp.calls.length === 0);
  assertCondition('No draft exists to be resolved by subsequent numeric reply', pendingService.getAllPendingAccountSelectionDrafts().length === 0);

  const successPendingService = new PendingTransactionService();
  const successMessaging = new MockMessagingGateway();
  const successWalletMcp = new MockWalletMcpClient();
  const successHandler = new AccountClarificationHandler(
    successPendingService,
    successWalletMcp as any,
    cache as any,
    successMessaging as any
  );

  await successHandler.createPendingAccountSelectionDraft(
    createEvent('Lunch and coffee'),
    twoUnresolvedRecords,
    [
      { recordIndex: 0, accountHint: '', reason: 'UNRESOLVED', candidates: [] },
      { recordIndex: 1, accountHint: '', reason: 'UNRESOLVED', candidates: [] },
    ],
    accounts,
    categories
  );
  const successDraft = successPendingService.getAllPendingAccountSelectionDrafts()[0];
  assertCondition('Success multi-record draft created', Boolean(successDraft));

  const firstChoiceHandled = await successHandler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  assertCondition('First account choice handled successfully', firstChoiceHandled);
  assertCondition('Wallet dispatch count remains 0 before final account selection', successWalletMcp.calls.length === 0);
  assertCondition(
    'Second-step draft becomes PENDING only after successful delivery of second prompt',
    successPendingService.getPendingAccountSelectionDraftState(successDraft.ticketId) === 'PENDING' &&
      successPendingService.getPendingAccountSelectionDraft(successDraft.ticketId)?.pendingRecordIndex === 1
  );
  assertCondition('Second prompt delivered to user', successMessaging.messages.at(-1)?.includes('Item 2 dari 2') === true);

  const secondChoiceHandled = await successHandler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  assertCondition('Second account choice completes the batch normally', secondChoiceHandled);
  assertCondition('Wallet dispatch count is exactly 1 after full batch resolution', successWalletMcp.calls.length === 1);
  assertCondition('Both records dispatched in the single batch', successWalletMcp.calls[0].length === 2);
  assertCondition('First record resolved to selected account', successWalletMcp.calls[0][0].accountId === 'acc-cash');
  assertCondition('Second record resolved to selected account', successWalletMcp.calls[0][1].accountId === 'acc-cash');
  assertCondition('Completed draft is removed after resolution', successPendingService.getAllPendingAccountSelectionDrafts().length === 0);
}

async function main(): Promise<void> {
  setActiveLanguage('id');
  await testAmbiguousBareCancellation();
  await testUnknownWarningDeliveryFailure();
  await testInitialPromptFailureRollback();
  await testFollowUpPromptDeliveryFailure();
  console.log(`\n[SUCCESS] ${assertionCount} assertions passed.`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
