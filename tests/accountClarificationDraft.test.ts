import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';

console.log('====================================================');
console.log('[test] Pending Account Clarification Drafts (Issue #81)');
console.log('====================================================\n');

let passedCaseCount = 0;
let assertionCount = 0;

function assertCondition(testName: string, condition: boolean, extraDetail?: string): void {
  assertionCount++;
  if (!condition) {
    throw new Error(`[FAIL] ${testName}${extraDetail ? ` -> ${extraDetail}` : ''}`);
  }
  console.log(`[PASS] ${testName}`);
}

async function runCase(testName: string, testFunction: () => Promise<void> | void): Promise<void> {
  console.log(`\n--- ${testName} ---`);
  await testFunction();
  passedCaseCount++;
}

class MockMessagingGateway {
  public readonly messages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.messages.push({ channel, chatId, content });
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
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
  async handleFastPath(): Promise<boolean> {
    return false;
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

function createHarness(records: CreateRecordInputPayload[]) {
  const pendingService = new PendingTransactionService();
  const messaging = new MockMessagingGateway();
  const walletMcp = new MockWalletMcpClient();
  const cache = new MockWalletCacheService(accounts, categories);
  const ai = new MockFinancialAiProvider({
    action: 'CREATE_RECORD',
    explanation: 'Create transaction',
    records,
  });
  const handler = new UserMessageHandler(
    messaging as any,
    pendingService,
    new MockPendingActionHandler() as any,
    new MockFastPathHandler() as any,
    ai as any,
    cache as any,
    walletMcp as any
  );

  return { pendingService, messaging, walletMcp, ai, handler };
}

async function main(): Promise<void> {
  setActiveLanguage('id');

  await runCase('Suite 1: missing account becomes a draft and numeric selection finalizes it', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));

    assertCondition('No Wallet write happens before clarification', harness.walletMcp.calls.length === 0);
    assertCondition('One account-selection draft is stored', harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1);
    assertCondition('Prompt lists the fallback account choices', harness.messaging.messages[0].content.includes('3. Cash'));

    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    assertCondition('Numeric choice dispatches exactly once', harness.walletMcp.calls.length === 1);
    assertCondition('Selected account ID is used', harness.walletMcp.calls[0][0].accountId === 'acc-cash');
    assertCondition('Draft is removed after success', harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0);
    assertCondition('Clarification reply bypasses AI', harness.ai.textCalls === 1);
  });

  await runCase('Suite 2: ambiguous account limits the prompt to matching candidates and accepts a name', async () => {
    const harness = createHarness([createRecord('BCA')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan pakai BCA'));

    const prompt = harness.messaging.messages[0].content;
    assertCondition('Ambiguous prompt includes BCA Personal', prompt.includes('BCA Personal'));
    assertCondition('Ambiguous prompt includes BCA Business', prompt.includes('BCA Business'));
    assertCondition('Ambiguous prompt excludes unrelated Cash account', !prompt.includes('3. Cash'));

    await harness.handler.handleIncomingUserMessage(createEvent('BCA Business'));

    assertCondition('Name selection dispatches transaction', harness.walletMcp.calls.length === 1);
    assertCondition('Name selection resolves correct account', harness.walletMcp.calls[0][0].accountId === 'acc-bca-business');
  });

  await runCase('Suite 3: invalid or still-ambiguous selection keeps the draft pending', async () => {
    const harness = createHarness([createRecord('BCA')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan pakai BCA'));
    await harness.handler.handleIncomingUserMessage(createEvent('BCA'));

    assertCondition('Ambiguous reply does not dispatch', harness.walletMcp.calls.length === 0);
    assertCondition('Draft remains pending', harness.pendingService.getAllPendingAccountSelectionDrafts().length === 1);
    assertCondition('User receives retry guidance', harness.messaging.messages.at(-1)?.content.includes('belum valid') === true);
    assertCondition('Invalid clarification reply bypasses AI', harness.ai.textCalls === 1);
  });

  await runCase('Suite 4: cancellation discards the draft without writing to Wallet', async () => {
    const harness = createHarness([createRecord('')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan siang 45rb'));
    await harness.handler.handleIncomingUserMessage(createEvent('batal'));

    assertCondition('Cancellation performs no Wallet write', harness.walletMcp.calls.length === 0);
    assertCondition('Cancellation removes the draft', harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0);
    assertCondition('Cancellation message is returned', harness.messaging.messages.at(-1)?.content.includes('dibatalkan') === true);
  });

  await runCase('Suite 5: expired account-selection drafts are purged', () => {
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

    assertCondition('Expired draft is no longer retrievable', pendingService.getPendingAccountSelectionDraft(draft.ticketId) === undefined);
    assertCondition('Expired draft state metadata is removed', pendingService.getPendingAccountSelectionDraftState(draft.ticketId) === undefined);
  });

  await runCase('Suite 6: unambiguous account still follows the immediate create flow', async () => {
    const harness = createHarness([createRecord('Cash')]);

    await harness.handler.handleIncomingUserMessage(createEvent('Makan 45rb pakai Cash'));

    assertCondition('Unambiguous transaction dispatches immediately', harness.walletMcp.calls.length === 1);
    assertCondition('No clarification draft is created', harness.pendingService.getAllPendingAccountSelectionDrafts().length === 0);
    assertCondition('Immediate flow resolves Cash correctly', harness.walletMcp.calls[0][0].accountId === 'acc-cash');
  });

  await runCase('Suite 7: multi-record batch never partially writes before every account is resolved', async () => {
    const harness = createHarness([
      createRecord('', { note: 'Lunch' }),
      createRecord('Cash', { amount: -15000, note: 'Coffee' }),
    ]);

    await harness.handler.handleIncomingUserMessage(createEvent('Lunch dan coffee'));

    assertCondition('Batch is not partially dispatched while one account is unresolved', harness.walletMcp.calls.length === 0);

    await harness.handler.handleIncomingUserMessage(createEvent('3'));

    assertCondition('Resolved batch dispatches in one MCP call', harness.walletMcp.calls.length === 1);
    assertCondition('Both records are included after clarification', harness.walletMcp.calls[0].length === 2);
    assertCondition('First record uses selected account', harness.walletMcp.calls[0][0].accountId === 'acc-cash');
    assertCondition('Second record remains on its original resolved account', harness.walletMcp.calls[0][1].accountId === 'acc-cash');
  });

  console.log('\n====================================================');
  console.log(`[SUCCESS] ${passedCaseCount} suites passed with ${assertionCount} assertions.`);
  console.log('====================================================');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
