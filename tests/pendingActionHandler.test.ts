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
  private callCount = 0;
  private failOnCallNumbers: number[] = []; // e.g. [2, 4] = fail on 2nd and 4th calls

  setFailure(shouldFail: boolean, errorMessage: string = 'MCP dispatch failed'): void {
    this.shouldFail = shouldFail;
    this.errorMessage = errorMessage;
    this.callCount = 0;
    this.failOnCallNumbers = [];
  }

  setFailureOnCalls(callNumbers: number[], errorMessage: string = 'MCP dispatch failed'): void {
    this.callCount = 0;
    this.failOnCallNumbers = callNumbers;
    this.errorMessage = errorMessage;
  }

  async createRecords(): Promise<void> {
    this.callCount++;
    
    if (this.shouldFail) {
      throw new Error(this.errorMessage);
    }

    if (this.failOnCallNumbers.includes(this.callCount)) {
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

// ============================================================
// TEST SUITE 4: Edge Case - Transfer Transactions
// ============================================================
console.log('\n--- TEST SUITE 4: Edge Case - Transfer Transactions ---');

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

  // Add a transfer transaction (creates 2 records)
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Checking',
    counterParty: 'Jane Doe',
    amount: 1000000,
    transactionType: 'TRANSFER',
    matchedAccountId: 'acc-source',
    matchedDestinationAccountId: 'acc-dest',
    note: 'Transfer to Jane',
    recordDate: '2026-09-10',
  });

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 1,
  };

  walletMcp.setFailure(true, 'MCP server unavailable');

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'Transfer transaction remains in queue after MCP failure',
      pendingService.getPendingTransaction(1) !== undefined
    );
    assertCondition(
      'User notified of transfer failure',
      messaging.messages.length === 1
    );
  })();
}

// ============================================================
// TEST SUITE 5: Edge Case - Email Listener Integration
// ============================================================
console.log('\n--- TEST SUITE 5: Edge Case - Email Listener Integration ---');

{
  const pendingService = new PendingTransactionService();
  const walletMcp = new MockWalletMcpClient();
  const messaging = new MockMessagingGateway();

  class MockEmailListener {
    public recordedReferences: string[] = [];

    recordProcessedTransaction(a: any, referenceNumber?: string): void {
      if (referenceNumber) {
        this.recordedReferences.push(referenceNumber);
      }
    }
  }

  const emailListener = new MockEmailListener();

  const handler = new PendingActionHandler(
    pendingService,
    walletMcp as any,
    messaging as any,
    () => emailListener
  );

  // Add transaction with reference number
  pendingService.addPendingTransaction({
    sourceType: 'EMAIL',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings',
    counterParty: 'Vendor',
    amount: 250000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    matchedCategoryId: 'cat-001',
    note: 'Invoice payment',
    recordDate: '2026-09-10',
    referenceNumber: 'REF-12345',
  });

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 1,
  };

  walletMcp.setFailure(true, 'Network error');

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'Email listener NOT called on MCP failure',
      emailListener.recordedReferences.length === 0
    );
    assertCondition(
      'Transaction remains pending to retry recording',
      pendingService.getPendingTransaction(1) !== undefined
    );
  })();
}

// ============================================================
// TEST SUITE 6: Edge Case - Bulk with Partial Missing Fields
// ============================================================
console.log('\n--- TEST SUITE 6: Edge Case - Bulk with Partial Missing Fields ---');

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

  // Add transaction without categoryId (optional field)
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Account 1',
    counterParty: 'Seller',
    amount: 100000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-123',
    // No matchedCategoryId
    note: 'Purchase',
    recordDate: '2026-09-10',
  });

  // Add transfer without destination account (single-entry only)
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'Mandiri',
    accountNameHint: 'Account 2',
    counterParty: 'Recipient',
    amount: 500000,
    transactionType: 'TRANSFER',
    matchedAccountId: 'acc-456',
    // No matchedDestinationAccountId
    note: 'Transfer out',
    recordDate: '2026-09-10',
  });

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 'ALL',
  };

  walletMcp.setFailure(true, 'Invalid payload');

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'Transaction without categoryId remains in queue',
      pendingService.getPendingTransaction(1) !== undefined
    );
    assertCondition(
      'Transfer without dest account remains in queue',
      pendingService.getPendingTransaction(2) !== undefined
    );
    assertCondition(
      'All 2 transactions still pending after failure',
      pendingService.getAllPendingTransactions().length === 2
    );
  })();
}

// ============================================================
// TEST SUITE 7: CRITICAL - Partial Failure (3/5 success)
// ============================================================
console.log('\n--- TEST SUITE 7: CRITICAL - Partial Failure (3/5 success) ---');

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

  // Add 5 transactions
  for (let i = 0; i < 5; i++) {
    pendingService.addPendingTransaction({
      sourceType: 'WHATSAPP',
      bankDisplayName: 'BCA',
      accountNameHint: `Account ${i + 1}`,
      counterParty: `Party ${i + 1}`,
      amount: 100000 * (i + 1),
      transactionType: 'EXPENSE',
      matchedAccountId: `acc-${i}`,
      matchedCategoryId: 'cat-001',
      note: `Transaction ${i + 1}`,
      recordDate: '2026-09-10',
    });
  }

  // Fail on calls 2 and 4 (tickets #2 and #4 will fail)
  walletMcp.setFailureOnCalls([2, 4], 'MCP rate limited');

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 'ALL',
  };

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      '[CRITICAL] Ticket #1 removed after success',
      pendingService.getPendingTransaction(1) === undefined
    );
    assertCondition(
      '[CRITICAL] Ticket #2 remains in queue after failure',
      pendingService.getPendingTransaction(2) !== undefined
    );
    assertCondition(
      '[CRITICAL] Ticket #3 removed after success',
      pendingService.getPendingTransaction(3) === undefined
    );
    assertCondition(
      '[CRITICAL] Ticket #4 remains in queue after failure',
      pendingService.getPendingTransaction(4) !== undefined
    );
    assertCondition(
      '[CRITICAL] Ticket #5 removed after success',
      pendingService.getPendingTransaction(5) === undefined
    );
    assertCondition(
      '[CRITICAL] 3 transactions removed, 2 remain in queue',
      pendingService.getAllPendingTransactions().length === 2
    );
    assertCondition(
      'User notified of partial success',
      messaging.messages.length === 1 && 
      messaging.messages[0].content.includes('Sebagian transaksi berhasil')
    );
  })();
}

// ============================================================
// TEST SUITE 8: Edge Case - Transfer Partial Failure
// ============================================================
console.log('\n--- TEST SUITE 8: Edge Case - Transfer Partial Failure ---');

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

  // Add regular expense transaction
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Checking',
    counterParty: 'Shop',
    amount: 100000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-1',
    matchedCategoryId: 'cat-001',
    note: 'Shopping',
    recordDate: '2026-09-10',
  });

  // Add transfer (creates 2 records)
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'Mandiri',
    accountNameHint: 'Savings',
    counterParty: 'Friend',
    amount: 500000,
    transactionType: 'TRANSFER',
    matchedAccountId: 'acc-2',
    matchedDestinationAccountId: 'acc-3',
    note: 'Transfer to friend',
    recordDate: '2026-09-10',
  });

  // Fail on call 2 (transfer submission will fail)
  walletMcp.setFailureOnCalls([2], 'Network timeout during transfer');

  const confirmIntent: PendingConfirmationIntent = {
    actionType: 'CONFIRM',
    targetScope: 'ALL',
  };

  (async () => {
    await handler.handlePendingAction(createMockEvent(), confirmIntent, Date.now());

    assertCondition(
      'Regular expense removed after success',
      pendingService.getPendingTransaction(1) === undefined
    );
    assertCondition(
      '[CRITICAL] Transfer remains in queue after failure',
      pendingService.getPendingTransaction(2) !== undefined
    );
    assertCondition(
      'Only 1 transaction remains pending (the transfer)',
      pendingService.getAllPendingTransactions().length === 1
    );
  })();
}
console.log(`\n${'='.repeat(50)}`);
console.log(`Total Tests: ${totalTestsCount} | Passed: ${passedTestsCount} | Failed: ${totalTestsCount - passedTestsCount}`);
console.log(`${'='.repeat(50)}`);

if (passedTestsCount === totalTestsCount) {
  console.log('[SUCCESS] All pending transaction integrity tests passed!');
  process.exit(0);
} else {
  console.error(`[FAILURE] ${totalTestsCount - passedTestsCount} test(s) failed.`);
  process.exit(1);
}
