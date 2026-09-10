import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService, PendingTransactionItem } from '../src/services/pendingTransactionService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { PendingConfirmationIntent } from '../src/utils/fastPathIntentDetector.js';

console.log('====================================================');
console.log('[test] Pending Transaction Data Integrity & MCP Failure Recovery (Issue #72)');
console.log('====================================================\n');

let passedTestsCount = 0;
let totalTestsCount = 0;

function assertCondition(testName: string, condition: boolean, extraDetail?: string): void {
  totalTestsCount++;
  if (condition) {
    console.log(`[PASS] ${testName}`);
    passedTestsCount++;
  } else {
    console.error(`[FAIL] ${testName}${extraDetail ? ` -> ${extraDetail}` : ''}`);
  }
}

// Mock implementations
class MockWalletMcpClient {
  private shouldFail = false;
  private errorMessage = '';

  setFailure(shouldFail: boolean, errorMessage: string = 'MCP dispatch failed'): void {
    this.shouldFail = shouldFail;
    this.errorMessage = errorMessage;
  }

  async createRecords(): Promise<void> {
    if (this.shouldFail) {
      throw new Error(this.errorMessage);
    }
  }
}

class MockMessagingGateway {
  public messages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.messages.push({ channel, chatId, content });
  }
}

// Helper to create sample pending item
function createSamplePendingItem(overrides?: Partial<PendingTransactionItem>): PendingTransactionItem {
  return {
    ticketId: 1,
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings Account',
    counterParty: 'John Doe',
    amount: 500000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    matchedCategoryId: 'cat-001',
    note: 'Lunch with client',
    recordDate: '2026-09-10',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

// Helper to create mock event
function createMockEvent(): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: '+1234567890',
    userId: 'user123',
    messageContent: 'ya',
    timestamp: new Date(),
    messageId: 'msg123',
  };
}

// ============================================================
// TEST SUITE 1: Happy Path - Single Transaction
// ============================================================
console.log('\n--- TEST SUITE 1: Happy Path - Single Transaction Confirmation ---');

{
  const pendingService = new PendingTransactionService();
  const walletMcp = new MockWalletMcpClient();
  const messaging = new MockMessagingGateway();

  const handler = new PendingActionHandler(
    pendingService,
    walletMcp as any,
    messaging as any,
    () => null
  );

  // Add a pending transaction
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings Account',
    counterParty: 'John Doe',
    amount: 500000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    matchedCategoryId: 'cat-001',
    note: 'Lunch with client',
    recordDate: '2026-09-10',
  });

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 1,
  };

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'Single transaction confirmed and removed from queue',
      !pendingService.hasPendingTransactions()
    );
    assertCondition(
      'User received success notification',
      messaging.messages.length === 1 && messaging.messages[0].content.includes('berhasil')
    );
  })();
}

// ============================================================
// TEST SUITE 2: Happy Path - Bulk Transactions
// ============================================================
console.log('\n--- TEST SUITE 2: Happy Path - Bulk Transaction Confirmation ---');

{
  const pendingService = new PendingTransactionService();
  const walletMcp = new MockWalletMcpClient();
  const messaging = new MockMessagingGateway();

  const handler = new PendingActionHandler(
    pendingService,
    walletMcp as any,
    messaging as any,
    () => null
  );

  // Add multiple pending transactions
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings Account',
    counterParty: 'John Doe',
    amount: 500000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    matchedCategoryId: 'cat-001',
    note: 'Lunch',
    recordDate: '2026-09-10',
  });

  pendingService.addPendingTransaction({
    sourceType: 'EMAIL',
    bankDisplayName: 'Mandiri',
    accountNameHint: 'Checking',
    counterParty: 'Amazon',
    amount: -300000,
    transactionType: 'INCOME',
    matchedAccountId: 'acc-124',
    note: 'Refund',
    recordDate: '2026-09-10',
  });

  assertCondition('Setup: 2 transactions added to queue', pendingService.getAllPendingTransactions().length === 2);

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 'ALL',
  };

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'All transactions confirmed and removed from queue',
      !pendingService.hasPendingTransactions()
    );
    assertCondition(
      'User received bulk success notification',
      messaging.messages.length === 1
    );
  })();
}

// ============================================================
// TEST SUITE 3: CRITICAL - MCP Failure Recovery (Single)
// ============================================================
console.log('\n--- TEST SUITE 3: CRITICAL - MCP Failure Recovery (Single Transaction) ---');

{
  const pendingService = new PendingTransactionService();
  const walletMcp = new MockWalletMcpClient();
  const messaging = new MockMessagingGateway();

  const handler = new PendingActionHandler(
    pendingService,
    walletMcp as any,
    messaging as any,
    () => null
  );

  // Add a pending transaction
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings Account',
    counterParty: 'John Doe',
    amount: 500000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    matchedCategoryId: 'cat-001',
    note: 'Lunch with client',
    recordDate: '2026-09-10',
  });

  walletMcp.setFailure(true, 'Network timeout: MCP server unreachable');

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 1,
  };

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    // CRITICAL ASSERTION: Transaction must remain in queue after failure
    assertCondition(
      '[CRITICAL] Pending transaction remains in queue after MCP failure',
      pendingService.getPendingTransaction(1) !== undefined
    );
    assertCondition(
      '[CRITICAL] User received error notification with retry instructions',
      messaging.messages.length === 1 && 
      messaging.messages[0].content.includes('[ERROR]') &&
      messaging.messages[0].content.includes('mencoba lagi')
    );
  })();
}
