import assert from 'node:assert';
import test from 'node:test';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { AccountClarificationHandler } from '../src/handlers/accountClarificationHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import { WalletMcpRequestError } from '../src/services/walletMcpService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { CreateRecordInputPayload, WalletAccountItem, WalletCategoryItem } from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { AiResponseParseError } from '../src/services/ai/jsonExtractionHelper.js';
import { ExtractedFinancialIntent, FinancialAiProvider } from '../src/services/ai/financialAiProvider.js';
import { parseFinancialAmount, parseFinancialAmountString } from '../src/utils/financialAmountParser.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import { validateReceiptFinancialIntentEnvelope } from '../src/services/ai/jsonExtractionHelper.js';
import { OpenAiCompatibleAiProvider } from '../src/services/ai/openAiCompatibleAiProvider.js';
import { FallbackAiProvider } from '../src/services/ai/fallbackAiProvider.js';

console.log('[TEST] Starting Receipt Processing Boundary & Recovery Tests (Issue #123)...');

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
  {
    id: 'acc-usd',
    name: 'USD Account',
    currency: 'USD',
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

function buildTestHarness(
  customAiProvider?: FinancialAiProvider,
  customAccounts: WalletAccountItem[] = mockAccounts
): TestHarness {
  const mockGateway = new MockMessagingGateway();
  const mockMcpClient = new MockWalletMcpClient();
  const mockCache = new MockWalletCacheService(customAccounts, mockCategories);
  const pendingTransactionService = new PendingTransactionService();
  const mockAiProvider = new ConfigurableMockAiProvider();
  const effectiveAiProvider = customAiProvider || mockAiProvider;

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
    effectiveAiProvider,
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

// =========================================================================
// Currency scale & ambiguity parsing tests
// =========================================================================
test('parseFinancialAmountString preserves decimal scale and fails closed on ambiguous inputs', () => {
  // Required review test cases
  assert.strictEqual(parseFinancialAmountString('-$10.50'), -10.5, '-$10.50 preserves decimal scale as -10.5');
  assert.strictEqual(parseFinancialAmountString('$1,234.50'), 1234.5, '$1,234.50 preserves decimal scale as 1234.5');
  assert.strictEqual(parseFinancialAmountString('-Rp10.079'), -10079, '-Rp10.079 parses IDR thousands separator as -10079');
  assert.strictEqual(parseFinancialAmountString('Rp15.100'), 15100, 'Rp15.100 parses IDR thousands separator as 15100');

  // Additional positive formats
  assert.strictEqual(parseFinancialAmountString('(10.50)'), -10.5, 'Parentheses negative with decimal');
  assert.strictEqual(parseFinancialAmountString('Rp 1.500.000'), 1500000, 'Multiple IDR thousands dots');
  assert.strictEqual(parseFinancialAmountString('1,500,000'), 1500000, 'Multiple US thousands commas');
  assert.strictEqual(parseFinancialAmountString('10.5'), 10.5, 'Lone dot with single decimal digit');

  // Ambiguous inputs that must fail closed (return null)
  assert.strictEqual(parseFinancialAmountString('$10.500'), null, '$10.500 is ambiguous');
  assert.strictEqual(parseFinancialAmountString('10.500'), null, '10.500 without currency is ambiguous');
  assert.strictEqual(parseFinancialAmountString('10.079'), null, '10.079 without currency is ambiguous');
  assert.strictEqual(parseFinancialAmountString('10,500'), null, '10,500 without currency is ambiguous');
  assert.strictEqual(parseFinancialAmountString('1,234'), null, '1,234 without currency is ambiguous');
  assert.strictEqual(parseFinancialAmountString('10.50.00'), null, '10.50.00 is invalid format');
  assert.strictEqual(parseFinancialAmountString('1,23.45'), null, '1,23.45 is invalid thousands grouping');
  assert.strictEqual(parseFinancialAmountString('10..50'), null, '10..50 consecutive dots');
  assert.strictEqual(parseFinancialAmountString('abc'), null, 'abc is not a number');
  assert.strictEqual(parseFinancialAmountString('Rp10k'), null, 'Rp10k has unparsed letters');
  assert.strictEqual(parseFinancialAmountString(''), null, 'Empty string returns null');
});

test('validateAndSanitizeFinancialRecords normalizes currency strings and rejects ambiguous amounts', () => {
  // Positive decimal normalization in validator
  const validResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-usd', amount: '-$10.50' as any, recordDate: '2026-09-08T04:54:00.000Z' },
      { accountId: 'acc-usd', amount: '$1,234.50' as any, recordDate: '2026-09-08T04:54:00.000Z' },
      { accountId: 'acc-jago', amount: '-Rp10.079' as any, recordDate: '2026-09-08T04:54:00.000Z' },
      { accountId: 'acc-jago', amount: 'Rp15.100' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(validResult.isValid, true);
  assert.strictEqual(validResult.sanitizedRecords[0].amount, -10.5);
  assert.strictEqual(validResult.sanitizedRecords[1].amount, 1234.5);
  assert.strictEqual(validResult.sanitizedRecords[2].amount, -10079);
  assert.strictEqual(validResult.sanitizedRecords[3].amount, 15100);

  // Ambiguous currency amount in validator fails validation
  const ambiguousResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-usd', amount: '$10.500' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(ambiguousResult.isValid, false);
  assert.ok(ambiguousResult.validationErrors[0].includes('Nominal tidak valid ($10.500)'));
});

test('validateAndSanitizeFinancialRecords rejects explicit currency conflicting with resolved account currency', () => {
  // Case A: IDR amount explicitly stated on USD account fails
  const idrOnUsdResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-usd', amount: '-Rp10.079' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(idrOnUsdResult.isValid, false, 'IDR amount on USD account must fail validation');
  assert.ok(
    idrOnUsdResult.validationErrors[0].includes('berbeda dengan mata uang akun USD Account (USD)'),
    'Validation error explains IDR vs USD currency mismatch'
  );

  // Case B: USD amount explicitly stated on IDR account fails
  const usdOnIdrResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-jago', amount: '-$10.50' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(usdOnIdrResult.isValid, false, 'USD amount on IDR account must fail validation');
  assert.ok(
    usdOnIdrResult.validationErrors[0].includes('berbeda dengan mata uang akun Jago (IDR)'),
    'Validation error explains USD vs IDR currency mismatch'
  );

  // Case C: Matching currencies succeed
  const matchingIdrResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-jago', amount: '-Rp10.079' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(matchingIdrResult.isValid, true, 'IDR amount on IDR account succeeds');
  assert.strictEqual(matchingIdrResult.sanitizedRecords[0].amount, -10079);

  const matchingUsdResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-usd', amount: '-$10.50' as any, recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(matchingUsdResult.isValid, true, 'USD amount on USD account succeeds');
  assert.strictEqual(matchingUsdResult.sanitizedRecords[0].amount, -10.5);

  // Case D: Numeric amount with explicit currency field "IDR" on USD account fails
  const numericIdrOnUsdResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-usd', amount: -10079, currency: 'IDR', recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(numericIdrOnUsdResult.isValid, false, 'Numeric IDR on USD account must fail validation');
  assert.ok(
    numericIdrOnUsdResult.validationErrors[0].includes('berbeda dengan mata uang akun USD Account (USD)'),
    'Validation error explains numeric IDR vs USD currency mismatch'
  );

  // Case E: Numeric amount with explicit currency field "USD" on IDR account fails
  const numericUsdOnIdrResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-jago', amount: -10.5, currency: 'USD', recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(numericUsdOnIdrResult.isValid, false, 'Numeric USD on IDR account must fail validation');
  assert.ok(
    numericUsdOnIdrResult.validationErrors[0].includes('berbeda dengan mata uang akun Jago (IDR)'),
    'Validation error explains numeric USD vs IDR currency mismatch'
  );

  // Case F: Currency field "USD" conflicting with string amount "-Rp10.079" fails closed
  const conflictingHintsResult = validateAndSanitizeFinancialRecords(
    [
      { accountId: 'acc-jago', amount: '-Rp10.079' as any, currency: 'USD', recordDate: '2026-09-08T04:54:00.000Z' },
    ],
    mockAccounts,
    mockCategories
  );
  assert.strictEqual(conflictingHintsResult.isValid, false, 'Conflicting currency hints must fail validation');
  assert.ok(
    conflictingHintsResult.validationErrors[0].includes('Konflik mata uang terdeteksi antara data transaksi (USD) dan nominal (IDR)'),
    'Validation error explains USD vs IDR hint conflict'
  );
});

test('Message flow rejects conflicting currency receipts before Wallet MCP write', async () => {
  setActiveLanguage('id');

  // Subcase A: Vision returning USD Account with string IDR amount
  const harnessA = buildTestHarness();
  harnessA.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'USD Account',
        amount: '-Rp10.079' as any,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee',
      },
    ],
  }));

  await harnessA.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessA.mockMcpClient.calls.length, 0, 'Zero writes sent to Wallet MCP on currency mismatch');
  const replyA = harnessA.mockGateway.lastMessage || '';
  assert.ok(replyA.includes('berbeda dengan mata uang akun USD Account'), 'Reply explains currency mismatch');

  // Subcase B: Vision returning Jago with string USD amount
  const harnessB = buildTestHarness();
  harnessB.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'Jago',
        amount: '-$10.50' as any,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee',
      },
    ],
  }));

  await harnessB.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessB.mockMcpClient.calls.length, 0, 'Zero writes sent to Wallet MCP on currency mismatch');
  const replyB = harnessB.mockGateway.lastMessage || '';
  assert.ok(replyB.includes('berbeda dengan mata uang akun Jago'), 'Reply explains currency mismatch');

  // Subcase C: Vision returning numeric IDR amount with USD Account
  const harnessC = buildTestHarness();
  harnessC.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'USD Account',
        amount: -10079,
        currency: 'IDR',
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee',
      },
    ],
  }));

  await harnessC.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessC.mockMcpClient.calls.length, 0, 'Zero writes sent to Wallet MCP on numeric currency mismatch');
  const replyC = harnessC.mockGateway.lastMessage || '';
  assert.ok(replyC.includes('berbeda dengan mata uang akun USD Account'), 'Reply explains numeric currency mismatch');

  // Subcase D: Vision returning currency USD with string amount -Rp10.079
  const harnessD = buildTestHarness();
  harnessD.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'Jago',
        amount: '-Rp10.079' as any,
        currency: 'USD',
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee',
      },
    ],
  }));

  await harnessD.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessD.mockMcpClient.calls.length, 0, 'Zero writes sent to Wallet MCP on conflicting hints');
  const replyD = harnessD.mockGateway.lastMessage || '';
  assert.ok(replyD.includes('Konflik mata uang terdeteksi'), 'Reply explains conflicting currency hints');
});

test('validateReceiptFinancialIntentEnvelope validates runtime envelope and rejects malformed shapes', () => {
  // Invalid action
  assert.throws(
    () => validateReceiptFinancialIntentEnvelope({ action: 'INVALID_ACTION' }),
    (error: unknown) => error instanceof AiResponseParseError && error.message.includes('invalid action')
  );

  // Out-of-contract action: RECORD_EXPENSE (only CREATE_RECORD and GENERAL_REPLY allowed)
  assert.throws(
    () => validateReceiptFinancialIntentEnvelope({ action: 'RECORD_EXPENSE', records: [] }),
    (error: unknown) => error instanceof AiResponseParseError && error.message.includes('invalid action')
  );

  // Out-of-contract action: CHECK_BALANCE
  assert.throws(
    () => validateReceiptFinancialIntentEnvelope({ action: 'CHECK_BALANCE' }),
    (error: unknown) => error instanceof AiResponseParseError && error.message.includes('invalid action')
  );

  // Non-array records for CREATE_RECORD
  assert.throws(
    () => validateReceiptFinancialIntentEnvelope({ action: 'CREATE_RECORD', records: 'oops' }),
    (error: unknown) => error instanceof AiResponseParseError && error.message.includes('requires records to be an array')
  );

  // Null record in array
  assert.throws(
    () => validateReceiptFinancialIntentEnvelope({ action: 'CREATE_RECORD', records: [null] }),
    (error: unknown) => error instanceof AiResponseParseError && error.message.includes('must be a non-null object')
  );

  // Valid CREATE_RECORD envelope passes and preserves fields
  const validEnvelope = validateReceiptFinancialIntentEnvelope({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'Jago',
        amount: -10079,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Valid',
      },
    ],
    explanation: 'Valid note',
  });
  assert.strictEqual(validEnvelope.action, 'CREATE_RECORD');
  assert.strictEqual(validEnvelope.records?.length, 1);
  assert.strictEqual(validEnvelope.records?.[0].accountId, 'Jago');
});

test('Message flow returns receiptExtractionFailed on parseable-but-structurally-invalid Vision outputs', async () => {
  setActiveLanguage('id');

  // Case A: records is a string instead of array
  const harnessA = buildTestHarness();
  harnessA.mockAiProvider.setImageHandler(async () => {
    // Simulates Vision output { action: "CREATE_RECORD", records: "oops" } validated by envelope
    return validateReceiptFinancialIntentEnvelope({ action: 'CREATE_RECORD', records: 'oops' });
  });

  await harnessA.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessA.mockMcpClient.calls.length, 0, 'Zero writes to Wallet MCP');
  const replyA = harnessA.mockGateway.lastMessage || '';
  assert.ok(replyA.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed');
  assert.ok(!replyA.includes('format datanya kurang pas'), 'Does not blame format');

  // Case B: records contains null item
  const harnessB = buildTestHarness();
  harnessB.mockAiProvider.setImageHandler(async () => {
    return validateReceiptFinancialIntentEnvelope({ action: 'CREATE_RECORD', records: [null] });
  });

  await harnessB.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessB.mockMcpClient.calls.length, 0, 'Zero writes to Wallet MCP');
  const replyB = harnessB.mockGateway.lastMessage || '';
  assert.ok(replyB.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed');

  // Case C: invalid action
  const harnessC = buildTestHarness();
  harnessC.mockAiProvider.setImageHandler(async () => {
    return validateReceiptFinancialIntentEnvelope({ action: 'INVALID_ACTION' });
  });

  await harnessC.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessC.mockMcpClient.calls.length, 0, 'Zero writes to Wallet MCP');
  const replyC = harnessC.mockGateway.lastMessage || '';
  assert.ok(replyC.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed');

  // Case D: RECORD_EXPENSE out-of-contract action
  const harnessD = buildTestHarness();
  harnessD.mockAiProvider.setImageHandler(async () => {
    return validateReceiptFinancialIntentEnvelope({
      action: 'RECORD_EXPENSE' as any,
      records: [{ accountId: 'Jago', amount: -10079 }],
    });
  });

  await harnessD.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessD.mockMcpClient.calls.length, 0, 'Zero writes on RECORD_EXPENSE');
  const replyD = harnessD.mockGateway.lastMessage || '';
  assert.ok(replyD.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed on RECORD_EXPENSE');

  // Case E: CHECK_BALANCE out-of-contract action
  const harnessE = buildTestHarness();
  harnessE.mockAiProvider.setImageHandler(async () => {
    return validateReceiptFinancialIntentEnvelope({ action: 'CHECK_BALANCE' as any });
  });

  await harnessE.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessE.mockMcpClient.calls.length, 0, 'Zero writes on CHECK_BALANCE');
  const replyE = harnessE.mockGateway.lastMessage || '';
  assert.ok(replyE.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed on CHECK_BALANCE');
});

// =========================================================================
// Case 1: Jago receipt + explicit caption override succeeds
// =========================================================================
test('Case 1: Jago receipt + explicit caption override reaches CREATE_RECORD', async () => {
  setActiveLanguage('id');
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
});

// =========================================================================
// Case 2: Jago receipt with bank account number and formatted string amount
// =========================================================================
test('Case 2: Jago receipt with bank account number & string currency amount', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: '507431877335',
        amount: '-Rp10.079' as any,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Payment to Trakteer',
        counterParty: 'Trakteer',
      },
    ],
  }));

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP createRecords called');
  const record = harness.mockMcpClient.calls[0][0];
  assert.strictEqual(record.accountId, 'acc-jago', 'Resolved by account number to Jago');
  assert.strictEqual(record.amount, -10079, 'Sanitized amount is numeric -10079');
});

// =========================================================================
// Case 3: Partial extraction without account emits draft and prompts user
// =========================================================================
test('Case 3: Partial extraction without account emits draft and prompts user', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: '',
        amount: -10079,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Donate trakteer ke bang al',
        counterParty: 'trakteer',
      },
    ],
    explanation: 'Transaksi berhasil dibaca, namun nama akun belum tertera pada bukti transfer.',
  }));

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'No direct records created without account');
  const drafts = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
  assert.strictEqual(drafts.length, 1, 'One pending account selection draft created');

  const activeDraft = drafts[0];
  assert.strictEqual(activeDraft.records[0].amount, -10079, 'Draft preserved amount -10079');
  assert.strictEqual(activeDraft.records[0].note, 'Donate trakteer ke bang al', 'Draft preserved note');
  assert.strictEqual(activeDraft.records[0].counterParty, 'trakteer', 'Draft preserved counterParty');

  const reply = harness.mockGateway.lastMessage || '';
  assert.ok(reply.includes('Transaksi disiapkan sebagai draft'), 'Clarification prompt sent to user');
  assert.ok(reply.includes('Pilih akun yang digunakan'), 'Prompt asks for account');
  assert.ok(!reply.includes('format datanya kurang pas'), 'Does not accuse format');
});

// =========================================================================
// Case 4: Interactive resolution of partial receipt draft
// =========================================================================
test('Case 4: Interactive resolution of partial receipt draft', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: '',
        amount: -10079,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Donate trakteer ke bang al',
        counterParty: 'trakteer',
      },
    ],
  }));

  await harness.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harness.pendingTransactionService.getAllPendingAccountSelectionDrafts().length, 1);

  const clarificationEvent = createTextEvent('1');
  await harness.userMessageHandler.handleIncomingUserMessage(clarificationEvent);

  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP createRecords was called');
  const finalRecord = harness.mockMcpClient.calls[0][0];
  assert.strictEqual(finalRecord.accountId, 'acc-jago', 'Account assigned to Jago');
  assert.strictEqual(finalRecord.amount, -10079, 'Amount preserved');
  assert.strictEqual(finalRecord.note, 'Donate trakteer ke bang al', 'Note preserved');
  assert.strictEqual(harness.pendingTransactionService.getAllPendingAccountSelectionDrafts().length, 0, 'Draft resolved and removed');

  const finalReply = harness.mockGateway.lastMessage || '';
  assert.ok(finalReply.includes('Donate trakteer ke bang al'), 'Success reply contains note');
});

// =========================================================================
// Case 4B: Partial extraction with string amount "-Rp10.079" stores normalized numeric -10079 in draft
// =========================================================================
test('Case 4B: Partial extraction with string amount "-Rp10.079" stores normalized numeric -10079 in draft and formats prompt correctly', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: '',
        amount: '-Rp10.079' as any,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee meeting',
        counterParty: 'Starbucks',
      },
    ],
  }));

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'No direct writes without account');
  const drafts = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
  assert.strictEqual(drafts.length, 1, 'One draft created');
  const draft = drafts[0];
  assert.strictEqual(typeof draft.records[0].amount, 'number', 'Draft stored amount must be numeric');
  assert.strictEqual(draft.records[0].amount, -10079, 'Draft stored amount is -10079');
  assert.strictEqual(draft.records[0].currency, 'IDR', 'Draft stored currency is IDR');

  const promptReply = harness.mockGateway.lastMessage || '';
  assert.ok(!promptReply.includes('NaN'), 'Prompt must NOT format amount as NaN');
  assert.ok(promptReply.includes('10.079'), 'Prompt displays formatted 10.079 amount');

  // Select account 1 (Jago)
  await harness.userMessageHandler.handleIncomingUserMessage(createTextEvent('1'));
  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Exactly one Wallet MCP write dispatched');
  const recorded = harness.mockMcpClient.calls[0][0];
  assert.strictEqual(recorded.accountId, 'acc-jago', 'Recorded with selected account');
  assert.strictEqual(recorded.amount, -10079, 'Recorded with normalized numeric amount');
});

// =========================================================================
// Case 4C: Ambiguous same-name accounts with currency hint filters out incompatible currency candidates
// =========================================================================
test('Case 4C: Ambiguous same-name accounts with currency hint filters out incompatible currency candidates', async () => {
  setActiveLanguage('id');
  const accountsWithSameName: WalletAccountItem[] = [
    { id: 'acc-pocket-idr', name: 'Pocket', currency: 'IDR' },
    { id: 'acc-pocket-usd', name: 'Pocket', currency: 'USD' },
    { id: 'acc-bca-idr', name: 'BCA', currency: 'IDR' },
  ];

  const harness = buildTestHarness(undefined, accountsWithSameName);
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'Pocket',
        amount: -10079,
        currency: 'IDR',
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Ambiguous same name test',
      },
    ],
  }));

  await harness.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  const drafts = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
  assert.strictEqual(drafts.length, 1, 'Draft created for ambiguous account');
  const draft = drafts[0];
  assert.strictEqual(draft.candidateAccounts.length, 1, 'Only IDR candidate kept, USD filtered out');
  assert.strictEqual(draft.candidateAccounts[0].id, 'acc-pocket-idr', 'Candidate is acc-pocket-idr');

  // Select candidate 1
  await harness.userMessageHandler.handleIncomingUserMessage(createTextEvent('1'));
  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP write dispatched');
  assert.strictEqual(harness.mockMcpClient.calls[0][0].accountId, 'acc-pocket-idr');
});

// =========================================================================
// Case 4D: Multi-record clarification flow across IDR and USD preserves currency constraints at each step
// =========================================================================
test('Case 4D: Multi-record clarification flow across IDR and USD preserves currency constraints at each step', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: '',
        amount: -50000,
        currency: 'IDR',
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'IDR Expense',
      },
      {
        accountId: '',
        amount: -15,
        currency: 'USD',
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'USD Expense',
      },
    ],
  }));

  await harness.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  const drafts1 = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
  assert.strictEqual(drafts1.length, 1, 'First clarification draft created');
  const draft1 = drafts1[0];
  assert.strictEqual(draft1.pendingRecordIndex, 0, 'Clarification for record 0 (IDR)');
  assert.ok(
    draft1.candidateAccounts.every(c => c.currency === 'IDR' || !c.currency),
    'Only IDR candidate accounts offered in prompt 1'
  );
  assert.ok(
    !draft1.candidateAccounts.some(c => c.id === 'acc-usd'),
    'USD account is NOT offered for IDR record'
  );

  // User selects option 1 (acc-jago)
  await harness.userMessageHandler.handleIncomingUserMessage(createTextEvent('1'));

  // Should now prompt for record 1 (USD)
  const drafts2 = harness.pendingTransactionService.getAllPendingAccountSelectionDrafts();
  assert.strictEqual(drafts2.length, 1, 'Follow-up clarification draft active for record 1');
  const draft2 = drafts2[0];
  assert.strictEqual(draft2.pendingRecordIndex, 1, 'Clarification for record 1 (USD)');
  assert.ok(
    draft2.candidateAccounts.every(c => c.currency === 'USD' || !c.currency),
    'Only USD candidate accounts offered in prompt 2'
  );
  assert.ok(
    draft2.candidateAccounts.some(c => c.id === 'acc-usd'),
    'USD account is offered for USD record'
  );
  assert.ok(
    !draft2.candidateAccounts.some(c => c.id === 'acc-jago'),
    'IDR account Jago is NOT offered for USD record'
  );

  // User selects option 1 (USD Account)
  await harness.userMessageHandler.handleIncomingUserMessage(createTextEvent('1'));
  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Exactly one batch write sent to Wallet MCP');
  assert.strictEqual(harness.mockMcpClient.calls[0].length, 2, 'Both records dispatched');
  assert.strictEqual(harness.mockMcpClient.calls[0][0].accountId, 'acc-jago', 'Record 0 assigned to Jago');
  assert.strictEqual(harness.mockMcpClient.calls[0][1].accountId, 'acc-usd', 'Record 1 assigned to USD Account');
});

// =========================================================================
// Case 5: Malformed AI JSON in image flow returns receiptExtractionFailed with 0 MCP writes
// =========================================================================
test('Case 5: Malformed AI JSON in image flow returns receiptExtractionFailed with 0 MCP writes', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => {
    throw new AiResponseParseError('No valid JSON object structure found in AI response', 'Some raw OCR text');
  });

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero writes sent to Wallet MCP');
  const reply = harness.mockGateway.lastMessage || '';
  assert.ok(
    reply.includes('Foto struk belum berhasil dibaca'),
    'Malformed AI JSON returns receipt extraction recovery message'
  );
  assert.ok(
    reply.includes('Pastikan foto terang'),
    'Directs user to make sure photo is clear'
  );
  assert.ok(
    !reply.includes('format datanya kurang pas'),
    'Does not blame format'
  );
});

// =========================================================================
// Case 6: Zero-record intent on image message returns receiptExtractionFailed
// =========================================================================
test('Case 6: Zero-record intent on image message returns receiptExtractionFailed', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [],
    explanation: '',
  }));

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero records created');
  const reply = harness.mockGateway.lastMessage || '';
  assert.ok(
    reply.includes('Foto struk belum berhasil dibaca'),
    'Zero-record image intent returns receiptExtractionFailed'
  );
  assert.ok(
    reply.includes('Pastikan foto terang'),
    'Directs user to make sure photo is clear'
  );
});

// =========================================================================
// Case 7: Validation failure on receipt record returns error message without calling Wallet MCP
// =========================================================================
test('Case 7: Validation failure on receipt record returns error message without calling Wallet MCP', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'acc-jago',
        amount: 'invalid-amount' as any,
        recordDate: '2026-09-08T04:54:00.000Z',
      },
    ],
  }));

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 0, 'Zero calls to Wallet MCP');
  const reply = harness.mockGateway.lastMessage || '';
  assert.ok(reply.includes('Nominal tidak valid'), 'Reply contains validation error');
});

// =========================================================================
// Case 8: Downstream Wallet MCP JSON-RPC failure in image flow returns generic system error
// =========================================================================
test('Case 8: Downstream Wallet MCP JSON-RPC failure in image flow returns generic system error', async () => {
  setActiveLanguage('id');
  const harness = buildTestHarness();
  harness.mockAiProvider.setImageHandler(async () => ({
    action: 'CREATE_RECORD',
    records: [
      {
        accountId: 'Jago',
        amount: -10079,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Valid coffee transaction',
      },
    ],
  }));

  harness.mockMcpClient.setNextError(
    new WalletMcpRequestError('[error] MCP JSON-RPC Error: tool execution failed', 'DEFINITIVE_FAILURE')
  );

  const event = createImageEvent();
  await harness.userMessageHandler.handleIncomingUserMessage(event);

  assert.strictEqual(harness.mockMcpClient.calls.length, 1, 'Wallet MCP createRecords was called');
  const reply = harness.mockGateway.lastMessage || '';
  assert.ok(
    !reply.includes('Foto struk belum berhasil dibaca'),
    'Downstream JSON-RPC failure must NEVER be presented as receipt extraction failure'
  );
  assert.ok(
    !reply.includes('format datanya kurang pas'),
    'Downstream JSON-RPC failure must NEVER be presented as schema validation failure'
  );
  assert.ok(
    reply.includes('Ada kendala saat memproses pesanmu'),
    'Downstream JSON-RPC failure returns generic system error'
  );
});

// =========================================================================
// Case 9: English localization returns English receiptExtractionFailed and draft messages
// =========================================================================
test('Case 9: English localization returns English receiptExtractionFailed and draft messages', async () => {
  setActiveLanguage('en');

  // Subcase A: Malformed receipt parse in English
  const harnessA = buildTestHarness();
  harnessA.mockAiProvider.setImageHandler(async () => {
    throw new AiResponseParseError('Malformed AI vision output');
  });

  await harnessA.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  const replyA = harnessA.mockGateway.lastMessage || '';
  assert.ok(
    replyA.includes('Could not clearly read the receipt image'),
    'English receipt extraction failure message returned'
  );
  assert.ok(
    replyA.includes('well-lit and legible'),
    'English prompt asks for legible photo'
  );

  // Subcase B: Partial extraction draft in English
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
});

// =========================================================================
// Case 10: OpenAI-compatible and Fallback providers reject out-of-contract receipt actions and trigger receipt recovery
// =========================================================================
test('Case 10: OpenAI-compatible and Fallback providers reject out-of-contract receipt actions and trigger receipt recovery', async () => {
  setActiveLanguage('id');

  // Subcase A: OpenAI-compatible provider returning RECORD_EXPENSE
  let capturedOpenAiResponse = JSON.stringify({
    action: 'RECORD_EXPENSE',
    records: [
      {
        accountId: 'acc-jago',
        amount: -10079,
        recordDate: '2026-09-08T04:54:00.000Z',
        note: 'Coffee',
      },
    ],
  });

  const openAiProvider = new OpenAiCompatibleAiProvider({
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    primaryModelName: 'gpt-4o',
  });

  (openAiProvider as any).httpClient.post = async () => ({
    data: {
      choices: [
        {
          message: {
            content: capturedOpenAiResponse,
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    },
  });

  const harnessA = buildTestHarness(openAiProvider);
  await harnessA.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessA.mockMcpClient.calls.length, 0, 'Zero Wallet writes on RECORD_EXPENSE');
  const replyA = harnessA.mockGateway.lastMessage || '';
  assert.ok(replyA.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed on RECORD_EXPENSE');

  // Subcase B: FallbackAiProvider with primary returning CHECK_BALANCE
  capturedOpenAiResponse = JSON.stringify({
    action: 'CHECK_BALANCE',
    explanation: 'Checking balance is not allowed on receipts',
  });

  const fallbackProvider = new FallbackAiProvider([openAiProvider]);
  const harnessB = buildTestHarness(fallbackProvider);
  await harnessB.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessB.mockMcpClient.calls.length, 0, 'Zero Wallet writes on CHECK_BALANCE');
  const replyB = harnessB.mockGateway.lastMessage || '';
  assert.ok(replyB.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed on CHECK_BALANCE');

  // Subcase C: OpenAI-compatible provider returning malformed Vision JSON (records: "oops")
  capturedOpenAiResponse = JSON.stringify({
    action: 'CREATE_RECORD',
    records: 'oops',
  });

  const harnessC = buildTestHarness(openAiProvider);
  await harnessC.userMessageHandler.handleIncomingUserMessage(createImageEvent());
  assert.strictEqual(harnessC.mockMcpClient.calls.length, 0, 'Zero Wallet writes on malformed Vision JSON');
  const replyC = harnessC.mockGateway.lastMessage || '';
  assert.ok(replyC.includes('Foto struk belum berhasil dibaca'), 'Returns receiptExtractionFailed on malformed Vision JSON');
});

