import { AccountClarificationHandler } from '../src/core/handlers/accountClarificationHandler.js';
import { MessageDispatcher } from '../src/core/dispatcher.js';
import { createTestMessageDispatcher } from './fixtures/testContext.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { WalletMcpRequestError } from '../src/wallet/index.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/wallet/index.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';



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
  const handler = createTestMessageDispatcher({
    messagingGateway: messaging as any,
    pendingTransactionManager: pendingService,
    pendingActionHandler: pendingActionHandler as any,
    fastPathHandler: fastPathHandler as any,
    financialAiProvider: financialAiProvider as any,
    walletCacheService: cache as any,
    walletMcpClient: walletMcp as any,
  });

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

  expect(pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) !== undefined &&
      pendingService.getPendingAccountSelectionDraftState(clarificationDraft.ticketId) === 'PENDING', 'Bare cancellation leaves clarification draft unchanged when both workflows coexist').toBe(true);
  expect(pendingService.getPendingTransaction(standardPending.ticketId) !== undefined &&
      pendingService.getPendingTransactionState(standardPending.ticketId) === 'PENDING', 'Bare cancellation leaves standard pending ticket unchanged when both workflows coexist').toBe(true);
  expect(harness.pendingActionHandler.calls.length === 0, 'Bare ambiguous cancellation does not reach pending action handler').toBe(true);
  expect(harness.walletMcp.calls.length === 0, 'Bare ambiguous cancellation never dispatches Wallet').toBe(true);
  expect(messaging.messages.at(-1)?.includes(`batal #${clarificationDraft.ticketId}`) === true &&
      messaging.messages.at(-1)?.includes(`batal #${standardPending.ticketId}`) === true, 'Disambiguation guidance names both ticket-specific cancellation commands').toBe(true);

  await harness.handler.handleIncomingUserMessage(
    createEvent(`batal #${standardPending.ticketId}`)
  );
  expect(pendingService.getPendingTransaction(standardPending.ticketId) === undefined &&
      pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) !== undefined, 'Ticket-specific standard cancellation removes only the standard ticket').toBe(true);

  const replacementStandardPending = addStandardPending(pendingService, 'Standard pending C');
  await harness.handler.handleIncomingUserMessage(
    createEvent(`batal #${clarificationDraft.ticketId}`)
  );
  expect(pendingService.getPendingAccountSelectionDraft(clarificationDraft.ticketId) === undefined &&
      pendingService.getPendingTransaction(replacementStandardPending.ticketId) !== undefined, 'Ticket-specific clarification cancellation removes only the clarification draft').toBe(true);
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

  expect(handled, 'UNKNOWN dispatch with warning delivery failure is still handled').toBe(true);
  expect(pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === 'UNKNOWN', 'UNKNOWN warning delivery failure leaves draft UNKNOWN').toBe(true);
  expect(walletMcp.calls.length === 1, 'UNKNOWN warning delivery failure performs exactly one Wallet dispatch').toBe(true);
  expect(messaging.messages.every(message => !/(coba\s*lagi|retry|mencoba ulang)/i.test(message)), 'UNKNOWN warning delivery failure emits no retry or coba-lagi guidance').toBe(true);

  const repeatedChoiceHandled = await handler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  expect(repeatedChoiceHandled === false, 'UNKNOWN draft no longer claims a repeated account choice automatically').toBe(true);
  expect(walletMcp.calls.length === 1, 'UNKNOWN draft is never redispatched automatically').toBe(true);
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

  expect(promptFailureObserved, 'Initial clarification prompt delivery failure propagates to caller').toBe(true);
  expect(pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Undelivered initial clarification draft is rolled back').toBe(true);

  const userHarness = createUserHandlerHarness(pendingService, messaging);
  await userHarness.handler.handleIncomingUserMessage(createEvent('saldo'));

  expect(userHarness.fastPathHandler.calls.includes('CHECK_BALANCE'), 'Next unrelated message follows normal fast-path routing').toBe(true);
  expect(userHarness.financialAiProvider.textCalls === 0, 'Hidden failed draft does not consume the next message').toBe(true);
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
  expect(initialCreated, 'Initial multi-record prompt is delivered successfully').toBe(true);
  const draft = pendingService.getAllPendingAccountSelectionDrafts()[0];
  expect(Boolean(draft) && pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === 'PENDING', 'First-step draft is PENDING for record 1').toBe(true);
  expect(messaging.messages.length === 1, 'First prompt delivered to user').toBe(true);

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

  expect(secondPromptFailureObserved, 'Follow-up prompt delivery failure propagates to caller').toBe(true);
  expect(walletMcp.calls.length === 0, 'Wallet dispatch count remains 0 after follow-up prompt failure').toBe(true);
  expect(pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Second-step draft is not left claimable as PENDING').toBe(true);
  expect(pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === undefined, 'Second-step draft state is cleared from tracking').toBe(true);

  const userHarness = createUserHandlerHarness(pendingService, messaging);
  await userHarness.handler.handleIncomingUserMessage(createEvent('1'));

  expect(walletMcp.calls.length === 0, 'Subsequent numeric reply cannot silently resolve record 2 or call Wallet').toBe(true);
  expect(pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'No draft exists to be resolved by subsequent numeric reply').toBe(true);

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
  expect(Boolean(successDraft), 'Success multi-record draft created').toBe(true);

  const firstChoiceHandled = await successHandler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  expect(firstChoiceHandled, 'First account choice handled successfully').toBe(true);
  expect(successWalletMcp.calls.length === 0, 'Wallet dispatch count remains 0 before final account selection').toBe(true);
  expect(successPendingService.getPendingAccountSelectionDraftState(successDraft.ticketId) === 'PENDING' &&
      successPendingService.getPendingAccountSelectionDraft(successDraft.ticketId)?.pendingRecordIndex === 1, 'Second-step draft becomes PENDING only after successful delivery of second prompt').toBe(true);
  expect(successMessaging.messages.at(-1)?.includes('Item 2 dari 2') === true, 'Second prompt delivered to user').toBe(true);

  const secondChoiceHandled = await successHandler.handlePendingAccountSelectionReply(
    createEvent('1'),
    '1',
    Date.now()
  );
  expect(secondChoiceHandled, 'Second account choice completes the batch normally').toBe(true);
  expect(successWalletMcp.calls.length === 1, 'Wallet dispatch count is exactly 1 after full batch resolution').toBe(true);
  expect(successWalletMcp.calls[0].length === 2, 'Both records dispatched in the single batch').toBe(true);
  expect(successWalletMcp.calls[0][0].accountId === 'acc-cash', 'First record resolved to selected account').toBe(true);
  expect(successWalletMcp.calls[0][1].accountId === 'acc-cash', 'Second record resolved to selected account').toBe(true);
  expect(successPendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Completed draft is removed after resolution').toBe(true);
}

describe('Account Clarification Safety Regressions', () => {
  beforeEach(() => setActiveLanguage('id'));
  afterEach(() => setActiveLanguage('id'));

  it('handles ambiguous bare cancellation safely', testAmbiguousBareCancellation);
  it('retains UNKNOWN state when warning delivery fails', testUnknownWarningDeliveryFailure);
  it('rolls back when the initial clarification prompt fails', testInitialPromptFailureRollback);
  it('recovers safely when a follow-up prompt cannot be delivered', testFollowUpPromptDeliveryFailure);
});
