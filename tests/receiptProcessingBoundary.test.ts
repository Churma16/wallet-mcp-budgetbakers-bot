import assert from 'node:assert';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';
import { ExtractedFinancialIntent, FinancialAiProvider } from '../src/services/ai/financialAiProvider.js';

console.log('================================================================');
console.log('[TEST] Receipt Processing Boundary & Recovery Tests (Issue #123)');
console.log('================================================================\n');

class MockMessagingGateway {
  public readonly sentMessages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendTypingPresence(): Promise<void> {}
  async clearTypingPresence(): Promise<void> {}

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.sentMessages.push({ channel, chatId, content });
  }

  get lastMessage(): string | undefined {
    return this.sentMessages[this.sentMessages.length - 1]?.content;
  }
}

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  private nextError: Error | null = null;

  setNextError(error: Error | null): void {
    this.nextError = error;
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<Record<string, unknown>> {
    this.calls.push(records.map(record => ({ ...record })));
    const configuredError = this.nextError;
    this.nextError = null;
    if (configuredError) {
      throw configuredError;
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

class ConfigurableMockAiProvider implements FinancialAiProvider {
  public readonly providerName = 'configurable-mock-ai';
  private imageHandler: () => Promise<ExtractedFinancialIntent> = async () => ({
    action: 'GENERAL_REPLY',
    explanation: 'default',
  });

  setImageHandler(handler: () => Promise<ExtractedFinancialIntent>): void {
    this.imageHandler = handler;
  }

  async processTextMessage(): Promise<ExtractedFinancialIntent> {
    return { action: 'GENERAL_REPLY', explanation: 'text fallback' };
  }

  async processImageMessage(): Promise<ExtractedFinancialIntent> {
    return this.imageHandler();
  }

  async processEmailTransactionMessage(): Promise<never> {
    throw new Error('Not implemented in mock');
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

const mockAccounts: WalletAccountItem[] = [
  {
    id: 'acc-jago',
    name: 'Jago',
    currency: 'IDR',
    bankAccountNumber: '507431877335',
  },
  {
    id: 'acc-bca',
    name: 'BCA',
    currency: 'IDR',
    bankAccountNumber: '1234567890',
  },
  {
    id: 'acc-gopay',
    name: 'Gopay',
    currency: 'IDR',
  },
];

const mockCategories: WalletCategoryItem[] = [
  { id: 'cat-shopping', name: 'Belanja' },
  { id: 'cat-food', name: 'Makanan & Minuman' },
  { id: 'cat-donation', name: 'Donasi' },
];

function createImageEvent(caption?: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'image',
    imageBuffer: Buffer.from('fake-image-bytes'),
    imageMimeType: 'image/jpeg',
    textPayload: caption,
  };
}

function createTextEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: '+628123456789',
    chatIdentifier: '+628123456789',
    messageType: 'text',
    textPayload,
  };
}

interface TestHarness {
  userMessageHandler: UserMessageHandler;
  accountClarificationHandler: AccountClarificationHandler;
  pendingTransactionService: PendingTransactionService;
  mockGateway: MockMessagingGateway;
  mockMcpClient: MockWalletMcpClient;
  mockAiProvider: ConfigurableMockAiProvider;
}

function buildTestHarness(): TestHarness {
  const mockGateway = new MockMessagingGateway();
  const mockMcpClient = new MockWalletMcpClient();
  const mockCache = new MockWalletCacheService(mockAccounts, mockCategories);
  const pendingTransactionService = new PendingTransactionService();
  const mockAiProvider = new ConfigurableMockAiProvider();

  const accountClarificationHandler = new AccountClarificationHandler(
    pendingTransactionService,
    mockMcpClient as any,
    mockCache as any,
    mockGateway as any
  );

  const userMessageHandler = new UserMessageHandler(
    mockGateway as any,
    pendingTransactionService,
    new MockPendingActionHandler() as any,
    new MockFastPathHandler() as any,
    mockAiProvider,
    mockCache as any,
    mockMcpClient as any
  );

  return {
    userMessageHandler,
    accountClarificationHandler,
    pendingTransactionService,
    mockGateway,
    mockMcpClient,
    mockAiProvider,
  };
}

async function runReceiptProcessingBoundaryTests(): Promise<void> {
  setActiveLanguage('id');

  // =========================================================================
  // Case 1: Jago receipt + explicit caption override succeeds
  // =========================================================================
  console.log('--- Case 1: Jago receipt + explicit caption override reaches CREATE_RECORD ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'Jago',
          amount: -10079,
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Donate trakteer ke bang al',
          counterParty: 'trakteer',
        },
      ],
      explanation: 'Donasi Rp10.079 via Jago',
    }));

    const event = createImageEvent('Donate trakteer ke bang al pake jago');
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP createRecords was called once');
    const createdRecord = harness.mockMcpClient.calls[0][0];
    assert.strictEqual(createdRecord.accountId, 'acc-jago', 'Account resolved to Jago ID acc-jago');
    assert.strictEqual(createdRecord.amount, -10079, 'Amount is -10079');
    assert.strictEqual(createdRecord.counterParty, 'trakteer', 'CounterParty is preserved');

    const reply = harness.mockGateway.lastMessage || '';
    assert.ok(reply.includes('Donate trakteer ke bang al'), 'Success reply contains note');
    assert.ok(reply.includes('Jago'), 'Success reply contains account name');
    assert.ok(!reply.includes('format datanya kurang pas'), 'Does not return format error');
    assert.strictEqual(harness.pendingTransactionService.getAllPendingAccountSelectionDrafts().length, 0, 'No pending drafts created');
    console.log('[PASS] Case 1 passed.');
  }

  // =========================================================================
  // Case 2: Jago receipt with bank account number and formatted string amount
  // =========================================================================
  console.log('\n--- Case 2: Jago receipt with bank account number & string currency amount ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: '507431877335',
          amount: '-Rp10.079' as any,
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Donate trakteer ke bang al',
          counterParty: 'trakteer',
        },
      ],
      explanation: 'Donasi Rp10.079 via Jago',
    }));

    const event = createImageEvent('Donate trakteer ke bang al pake jago');
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP createRecords called once');
    const createdRecord = harness.mockMcpClient.calls[0][0];
    assert.strictEqual(createdRecord.accountId, 'acc-jago', 'Account resolved from bank account number 507431877335');
    assert.strictEqual(createdRecord.amount, -10079, 'Formatted string amount -Rp10.079 parsed to numeric -10079');
    console.log('[PASS] Case 2 passed.');
  }

  // =========================================================================
  // Case 3: Partial receipt with missing account triggers clarification draft
  // =========================================================================
  console.log('\n--- Case 3: Partial receipt with missing account creates clarification draft ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: '', // Missing account
          amount: -15100,
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Belanja Bliblimart',
          counterParty: 'Bliblimart',
        },
      ],
      explanation: 'Transaksi Bliblimart Rp15.100',
    }));

    const event = createImageEvent();
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero Wallet writes performed before clarification');
    const drafts = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
    assert.strictEqual(drafts.length, 1, 'Draft successfully created in PendingTransactionService');
    assert.strictEqual(drafts[0].records[0].amount, -15100, 'Draft preserved extracted amount');
    assert.strictEqual(drafts[0].records[0].counterParty, 'Bliblimart', 'Draft preserved counterParty');

    const promptMessage = harness.mockGateway.lastMessage || '';
    assert.ok(promptMessage.includes('disiapkan sebagai draft'), 'User prompt announces draft preparation');
    assert.ok(promptMessage.includes('15.100'), 'User prompt shows extracted amount');
    assert.ok(promptMessage.includes('Bliblimart'), 'User prompt shows extracted merchant');
    assert.ok(promptMessage.includes('Pilih akun yang digunakan'), 'User prompt asks for payment account');
    assert.ok(!promptMessage.includes('format datanya kurang pas'), 'Does not produce format error');

    // Follow-up: user selects account choice '1' (Jago)
    const replyEvent = createTextEvent('1');
    const handledReply = await harness.accountClarificationHandler.handlePendingAccountSelectionReply(
      replyEvent,
      '1',
      Date.now()
    );

    assert.strictEqual(handledReply, true, 'Clarification reply handled successfully');
    assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP called after user account selection');
    assert.strictEqual(harness.mockMcpClient.calls[0][0].accountId, 'acc-jago', 'Recorded using chosen Jago account');
    console.log('[PASS] Case 3 passed.');
  }

  // =========================================================================
  // Case 4: Malformed Vision response produces receipt recovery & zero writes
  // =========================================================================
  console.log('\n--- Case 4: Malformed Vision response returns receipt-specific recovery ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => {
      throw new AiResponseParseError('No valid JSON object structure found in AI response', 'Raw non-json text');
    });

    const event = createImageEvent();
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero Wallet writes on unparseable Vision response');
    const reply = harness.mockGateway.lastMessage || '';
    assert.ok(reply.includes('Foto struk belum berhasil dibaca dengan jelas'), 'Returns receipt-specific recovery message');
    assert.ok(!reply.includes('format datanya kurang pas'), 'Does not blame user input format');
    assert.strictEqual(harness.pendingTransactionService.getAllPendingAccountSelectionDrafts().length, 0, 'Zero drafts created');
    console.log('[PASS] Case 4 passed.');
  }

  // =========================================================================
  // Case 5: Deterministic validation rejection returns concrete error
  // =========================================================================
  console.log('\n--- Case 5: Deterministic validation rejection returns concrete error ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-jago',
          amount: 0, // Zero amount is invalid
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Belanja',
        },
      ],
    }));

    const event = createImageEvent();
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero Wallet writes on invalid record');
    const reply = harness.mockGateway.lastMessage || '';
    assert.ok(reply.includes('Nominal transaksi tidak boleh bernilai 0'), 'User receives concrete validation problem');
    assert.ok(!reply.includes('format datanya kurang pas'), 'Does not return generic schema validation error');
    console.log('[PASS] Case 5 passed.');
  }

  // =========================================================================
  // Case 6: Downstream create_records failure is not blamed on user formatting
  // =========================================================================
  console.log('\n--- Case 6: Downstream create_records failure returns system error ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: 'acc-jago',
          amount: -10000,
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Makan',
        },
      ],
    }));

    harness.mockMcpClient.setNextError(
      new WalletMcpRequestError(
        "[error] MCP Tool 'create_records' rejected 1 record(s) with definitive failure",
        'DEFINITIVE_FAILURE'
      )
    );

    const event = createImageEvent();
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    const reply = harness.mockGateway.lastMessage || '';
    assert.ok(
      !reply.includes('format datanya kurang pas'),
      'Downstream create_records failure must not be blamed on user schema formatting'
    );
    assert.ok(
      reply.includes('Ada kendala saat memproses pesanmu'),
      'Downstream failure reported as system processing error'
    );
    console.log('[PASS] Case 6 passed.');
  }

  // =========================================================================
  // Case 7: Image with CREATE_RECORD but 0 records returns receipt recovery
  // =========================================================================
  console.log('\n--- Case 7: Image with CREATE_RECORD but 0 records returns receipt recovery ---');
  {
    const harness = buildTestHarness();
    harness.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [],
    }));

    const event = createImageEvent();
    await harness.userMessageHandler.handleIncomingUserMessage(event);

    assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero Wallet writes on empty records array');
    const reply = harness.mockGateway.lastMessage || '';
    assert.ok(
      reply.includes('Foto struk belum berhasil dibaca dengan jelas'),
      'Returns receipt-specific recovery message when records array is empty'
    );
    console.log('[PASS] Case 7 passed.');
  }

  // =========================================================================
  // Case 8: English localization for receipt recovery & drafts
  // =========================================================================
  console.log('\n--- Case 8: English localized recovery and partial draft ---');
  {
    setActiveLanguage('en');

    // Subcase 8A: English receipt recovery
    const harnessA = buildTestHarness();
    harnessA.mockAiProvider.setImageHandler(async () => {
      throw new AiResponseParseError('Malformed AI json', 'unparseable');
    });

    await harnessA.userMessageHandler.handleIncomingUserMessage(createImageEvent());
    const replyA = harnessA.mockGateway.lastMessage || '';
    assert.ok(replyA.includes('Could not clearly read the receipt image'), 'English receipt recovery returned');

    // Subcase 8B: English partial draft
    const harnessB = buildTestHarness();
    harnessB.mockAiProvider.setImageHandler(async () => ({
      action: 'CREATE_RECORD',
      records: [
        {
          accountId: '',
          amount: -25000,
          recordDate: '2026-09-08T04:54:00.000Z',
          note: 'Groceries',
        },
      ],
    }));

    await harnessB.userMessageHandler.handleIncomingUserMessage(createImageEvent());
    const replyB = harnessB.mockGateway.lastMessage || '';
    assert.ok(replyB.includes('Transaction prepared as draft'), 'English draft prompt returned');
    assert.ok(replyB.includes('Choose the account to use'), 'English prompt asks for account');

    setActiveLanguage('id'); // Reset
    console.log('[PASS] Case 8 passed.');
  }

  console.log('\n================================================================');
  console.log('[SUCCESS] ALL RECEIPT PROCESSING BOUNDARY TESTS PASSED!');
  console.log('================================================================\n');
}

runReceiptProcessingBoundaryTests().catch((error: unknown) => {
  console.error('[FAIL] Test suite failed:', error);
  process.exit(1);
});
