import { UserMessageHandler } from '../src/core/dispatcher.js';
import { createTestUserMessageHandler } from './fixtures/testContext.js';
import { PendingTransactionService } from '../src/core/pending.js';
import { WalletMcpRequestError } from '../src/wallet/index.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/wallet/index.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';




class MockMessagingGateway {
  public readonly messages: Array<{ channel: string; chatId: string; content: string }> = [];
  public failNextSend = false;

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('simulated messaging failure');
    }
    this.messages.push({ channel, chatId, content });
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private nextFailure: Error | null = null;

  failNextDefinitively(message: string = 'definitive MCP failure'): void {
    this.nextFailure = new WalletMcpRequestError(message, 'DEFINITIVE_FAILURE');
  }

  failNextWithUnknownOutcome(message: string = 'MCP response lost'): void {
    this.nextFailure = new WalletMcpRequestError(message, 'UNKNOWN');
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
    const configuredFailure = this.nextFailure;
    this.nextFailure = null;
    if (configuredFailure) {
      throw configuredFailure;
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

class MockFinancialAiProvider {
  public readonly providerName = 'mock';
  public textCalls = 0;

  constructor(private readonly intent: Record<string, unknown>) {}

  async processTextMessage(): Promise<Record<string, unknown>> {
    this.textCalls++;
    return this.intent;
  }

  async processImageMessage(): Promise<Record<string, unknown>> {
    return this.intent;
  }
}

class MockPendingActionHandler {
  async handlePendingAction(): Promise<boolean> {
    return false;
  }
}

class MockFastPathHandler {
  public readonly calls: string[] = [];

  async handleFastPath(_event: unknown, action: string): Promise<boolean> {
    this.calls.push(action);
    return true;
  }
}

const accounts: WalletAccountItem[] = [
  { id: 'acc-bca-personal', name: 'BCA Personal', currency: 'IDR' },
  { id: 'acc-bca-business', name: 'BCA Business', currency: 'IDR' },
  { id: 'acc-cash', name: 'Cash', currency: 'IDR' },
];

const categories: WalletCategoryItem[] = [
  { id: 'cat-food', name: 'Food' },
];

function createEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload,
  };
}

function createRecord(accountId: string, overrides: Partial<CreateRecordInputPayload> = {}): CreateRecordInputPayload {
  return {
    accountId,
    amount: -45000,
    recordDate: '2026-09-10T12:00:00+07:00',
    categoryId: 'cat-food',
    note: 'Lunch',
    counterParty: 'Warung',
    ...overrides,
  };
}

function createHarness(
  records: CreateRecordInputPayload[],
  accountList: WalletAccountItem[] = accounts,
  categoryList: WalletCategoryItem[] = categories
) {
  const pendingService = new PendingTransactionService();
  const messaging = new MockMessagingGateway();
  const walletMcp = new MockWalletMcpClient();
  const cache = new MockWalletCacheService(accountList, categoryList);
  const ai = new MockFinancialAiProvider({
    action: 'CREATE_RECORD',
    explanation: 'Create transaction',
    records,
  });
  const fastPath = new MockFastPathHandler();
  const handler = createTestUserMessageHandler({
    messagingGateway: messaging as any,
    pendingTransactionManager: pendingService,
    pendingActionHandler: new MockPendingActionHandler() as any,
    fastPathHandler: fastPath as any,
    financialAiProvider: ai as any,
    walletCacheService: cache as any,
    walletMcpClient: walletMcp as any,
  });

  return { pendingService, messaging, walletMcp, ai, fastPath, handler };
}

describe('Pending Account Clarification Drafts', () => {
  beforeEach(() => setActiveLanguage('id'));
  afterEach(() => setActiveLanguage('id'));

  it('missing account becomes a draft and numeric selection finalizes it', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));

    expect(harness.walletMcp.calls.length === 0, 'No Wallet write happens before clarification').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1, 'One account-selection draft is stored').toBe(true);
    expect(harness.messaging.messages[0].content.includes('3. Cash'), 'Prompt lists the fallback account choices').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 1, 'Numeric choice dispatches exactly once').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-cash', 'Selected account ID is used').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Draft is removed after success').toBe(true);
    expect(harness.ai.textCalls === 1, 'Clarification reply bypasses AI').toBe(true);
  });

  it('ambiguous account limits the prompt to matching candidates and accepts a name', async () => {
    const harness = createHarness([createRecord('BCA')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan pakai BCA'));

    const prompt = harness.messaging.messages[0].content;
    expect(prompt.includes('BCA Personal'), 'Ambiguous prompt includes BCA Personal').toBe(true);
    expect(prompt.includes('BCA Business'), 'Ambiguous prompt includes BCA Business').toBe(true);
    expect(!prompt.includes('3. Cash'), 'Ambiguous prompt excludes unrelated Cash account').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('BCA Business'));

    expect(harness.walletMcp.calls.length === 1, 'Name selection dispatches transaction').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-bca-business', 'Name selection resolves correct account').toBe(true);
  });

  it('invalid or still-ambiguous selection keeps the draft pending', async () => {
    const harness = createHarness([createRecord('BCA')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan pakai BCA'));
    await harness.handler.handleIncomingUserMessage(createEvent('BCA'));

    expect(harness.walletMcp.calls.length === 0, 'Ambiguous reply does not dispatch').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1, 'Draft remains pending').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('belum valid') === true, 'User receives retry guidance').toBe(true);
    expect(harness.ai.textCalls === 1, 'Invalid clarification reply bypasses AI').toBe(true);
  });

  it('cancellation discards the draft without writing to Wallet', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));
    await harness.handler.handleIncomingUserMessage(createEvent('batal'));

    expect(harness.walletMcp.calls.length === 0, 'Cancellation performs no Wallet write').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Cancellation removes the draft').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('dibatalkan') === true, 'Cancellation message is returned').toBe(true);
  });

  it('expired account-selection drafts are purged', () => {
    const pendingService = new PendingTransactionService();
    const draft = pendingService.addPendingAccountSelectionDraft({
      sourceType: 'USER',
      channel: 'whatsapp',
      senderIdentifier: '+628123456789',
      chatIdentifier: '+628123456789',
      records: [createRecord('')],
      pendingRecordIndex: 0,
      accountHint: '',
      candidateAccounts: accounts,
    });

    draft.expiresAt = new Date(Date.now() - 1000);

    expect(pendingService.getPendingAccountSelectionDraft(draft.ticketId) === undefined, 'Expired draft is no longer retrievable').toBe(true);
    expect(pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === undefined, 'Expired draft state metadata is removed').toBe(true);
  });

  it('unambiguous account still follows the immediate create flow', async () => {
    const harness = createHarness([createRecord('Cash')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan 45rb pakai Cash'));

    expect(harness.walletMcp.calls.length === 1, 'Unambiguous transaction dispatches immediately').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'No clarification draft is created').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-cash', 'Immediate flow resolves Cash correctly').toBe(true);
  });

  it('multi-record batch never partially writes before every account is resolved', async () => {
    const harness = createHarness([
      createRecord('', { note: 'Lunch' }),
      createRecord('Cash', { amount: -15000, note: 'Coffee' }),
    ]);

    await harness.handler.handleIncomingUserMessage(createEvent('Lunch dan coffee'));

    expect(harness.walletMcp.calls.length === 0, 'Batch is not partially dispatched while one account is unresolved').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 1, 'Resolved batch dispatches in one MCP call').toBe(true);
    expect(harness.walletMcp.calls[0].length === 2, 'Both records are included after clarification').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-cash', 'First record uses selected account').toBe(true);
    expect(harness.walletMcp.calls[0][1].accountId === 'acc-cash', 'Second record remains on its original resolved account').toBe(true);
  });

  it('UNKNOWN draft does not lock normal commands and cannot be cancelled before reconciliation', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));
    harness.walletMcp.failNextWithUnknownOutcome();
    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    const pendingDraft = harness.pendingService.getAllPendingAccountSelectionDrafts()[0];
    expect(Boolean(pendingDraft), 'Unknown MCP outcome retains the draft for reconciliation').toBe(true);
    expect(harness.pendingService.getPendingAccountSelectionDraftState(pendingDraft.ticketId) === 'UNKNOWN', 'Draft is marked UNKNOWN after uncertain MCP outcome').toBe(true);
    expect(harness.walletMcp.calls.length === 1, 'Only one Wallet dispatch occurred before reconciliation').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('saldo'));

    expect(harness.fastPath.calls.includes('CHECK_BALANCE'), 'Saldo reaches normal fast-path routing').toBe(true);
    expect(harness.walletMcp.calls.length === 1, 'Saldo does not retry the UNKNOWN Wallet write').toBe(true);
    expect(harness.ai.textCalls === 1, 'Saldo does not invoke AI while fast path handles it').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('batal'));

    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1, 'Explicit cancellation preserves the UNKNOWN reconciliation draft').toBe(true);
    expect(harness.pendingService.getPendingAccountSelectionDraftState(pendingDraft.ticketId) === 'UNKNOWN', 'Explicit cancellation preserves UNKNOWN state').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('Sudah ada') === true &&
        harness.messaging.messages.at(-1)?.content.includes('Belum ada') === true, 'Cancellation reminds the user to reconcile Wallet state').toBe(true);
    expect(harness.walletMcp.calls.length === 1, 'Cancellation still does not retry Wallet').toBe(true);
  });

  it('success acknowledgement failure cannot turn a committed write into UNKNOWN', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));
    harness.messaging.failNextSend = true;
    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 1, 'Wallet was called exactly once').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Committed draft remains resolved after messaging failure').toBe(true);
    expect(harness.pendingService.getPendingAccountSelectionDraftState(1) === undefined, 'Resolved draft has no remaining dispatch state').toBe(true);
  });

  it('numeric account choice remains stable across definitive MCP retry', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));
    harness.walletMcp.failNextDefinitively();
    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 1, 'First attempt reached Wallet once').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-cash', 'First attempt used option 3 account').toBe(true);
    expect(harness.pendingService.getPendingAccountSelectionDraftState(1) === 'PENDING', 'Definitive failure returns draft to PENDING').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 2, 'Same numeric reply triggers exactly one retry').toBe(true);
    expect(harness.walletMcp.calls[1][0].accountId === 'acc-cash', 'Retry preserves option 3 account mapping').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0, 'Successful retry resolves the draft').toBe(true);
  });

  it('mixed-currency candidates never invent a currency before selection', async () => {
    const mixedCurrencyAccounts: WalletAccountItem[] = [
      { id: 'acc-idr', name: 'Rupiah Wallet', currency: 'IDR' },
      { id: 'acc-usd', name: 'Dollar Wallet', currency: 'USD' },
    ];
    const harness = createHarness([createRecord('')], mixedCurrencyAccounts);

    await harness.handler.handleIncomingUserMessage(createEvent('Lunch 45k'));

    const prompt = harness.messaging.messages[0].content;
    expect(prompt.includes('Rupiah Wallet (IDR)'), 'Prompt exposes IDR candidate currency').toBe(true);
    expect(prompt.includes('Dollar Wallet (USD)'), 'Prompt exposes USD candidate currency').toBe(true);
    expect(prompt.includes('mata uang mengikuti akun'), 'Prompt explains that currency follows the selected account').toBe(true);
    expect(!prompt.includes('*Nominal:* Rp'), 'Prompt does not falsely format the amount as IDR').toBe(true);
  });

  it('multi-step clarification advances to the next unresolved record before dispatch', async () => {
    const harness = createHarness([
      createRecord('', { note: 'Lunch' }),
      createRecord('BCA', { amount: -15000, note: 'Coffee' }),
    ]);

    await harness.handler.handleIncomingUserMessage(createEvent('Lunch dan coffee'));
    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    expect(harness.walletMcp.calls.length === 0, 'First resolved record still does not partially dispatch the batch').toBe(true);
    expect(harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1, 'Draft remains for second unresolved record').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('Item 2 dari 2') === true, 'Second prompt identifies item 2').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('2. BCA Business') === true, 'Second prompt switches to BCA candidates').toBe(true);

    await harness.handler.handleIncomingUserMessage(createEvent('2'));

    expect(harness.walletMcp.calls.length === 1, 'Batch dispatches only after both account choices resolve').toBe(true);
    expect(harness.walletMcp.calls[0][0].accountId === 'acc-cash', 'First record retains Cash selection').toBe(true);
    expect(harness.walletMcp.calls[0][1].accountId === 'acc-bca-business', 'Second record uses BCA Business selection').toBe(true);
  });

  it('PROCESSING draft reports busy state without starting another dispatch', async () => {
    const harness = createHarness([createRecord('Cash')]);
    const draft = harness.pendingService.addPendingAccountSelectionDraft({
      sourceType: 'USER',
      channel: 'whatsapp',
      senderIdentifier: '+628123456789',
      chatIdentifier: '+628123456789',
      records: [createRecord('')],
      pendingRecordIndex: 0,
      accountHint: '',
      candidateAccounts: accounts,
    });
    harness.pendingService.claimPendingAccountSelectionDraft(draft.ticketId);

    await harness.handler.handleIncomingUserMessage(createEvent('1'));

    expect(harness.walletMcp.calls.length === 0, 'PROCESSING draft does not dispatch again').toBe(true);
    expect(harness.messaging.messages.at(-1)?.content.includes('sedang diproses') === true, 'PROCESSING draft returns busy guidance').toBe(true);
    expect(harness.ai.textCalls === 0, 'PROCESSING reply bypasses AI').toBe(true);
  });

  it('English mixed-currency prompt remains currency-neutral', async () => {
    setActiveLanguage('en');
    const mixedCurrencyAccounts: WalletAccountItem[] = [
      { id: 'acc-idr', name: 'Rupiah Wallet', currency: 'IDR' },
      { id: 'acc-usd', name: 'Dollar Wallet', currency: 'USD' },
    ];
    const harness = createHarness([createRecord('')], mixedCurrencyAccounts);

    await harness.handler.handleIncomingUserMessage(createEvent('Lunch 45k'));

    const prompt = harness.messaging.messages[0].content;
    expect(prompt.includes('currency follows the selected account'), 'English prompt explains deferred currency').toBe(true);
    expect(prompt.includes('Dollar Wallet (USD)'), 'English prompt includes candidate currency labels').toBe(true);
    expect(!prompt.includes('*Amount:* $'), 'English prompt does not invent a dollar amount').toBe(true);
    setActiveLanguage('id');
  });

});
