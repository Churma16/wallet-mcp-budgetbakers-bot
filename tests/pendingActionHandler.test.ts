import { PendingActionHandler } from '../src/handlers/pendingActionHandler.js';
import { PendingTransactionService } from '../src/services/pendingTransactionService.js';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  isWalletMcpDispatchOutcomeUnknown,
} from '../src/services/walletMcpService.js';
import { CreateRecordInputPayload, WalletCreateRecordsResponse } from '../src/types/walletTypes.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { PendingConfirmationIntent } from '../src/utils/fastPathIntentDetector.js';

console.log('====================================================');
console.log('[test] Pending Transaction Data Integrity & MCP Failure Recovery (Issue #72)');
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

class MockWalletMcpClient {
  public readonly calls: CreateRecordInputPayload[][] = [];
  public delayMs = 0;
  private readonly failuresByCallNumber = new Map<number, Error>();

  setDefinitiveFailureOnCall(callNumber: number, errorMessage: string = 'MCP dispatch failed'): void {
    this.failuresByCallNumber.set(
      callNumber,
      new WalletMcpRequestError(errorMessage, 'DEFINITIVE_FAILURE')
    );
  }

  setUnknownFailureOnCall(callNumber: number, errorMessage: string = 'MCP response lost'): void {
    this.failuresByCallNumber.set(
      callNumber,
      new WalletMcpRequestError(errorMessage, 'UNKNOWN')
    );
  }

  setGenericFailureOnCall(callNumber: number, errorMessage: string = 'Unclassified response processing failure'): void {
    this.failuresByCallNumber.set(callNumber, new Error(errorMessage));
  }

  clearFailures(): void {
    this.failuresByCallNumber.clear();
  }

  async createRecords(records: CreateRecordInputPayload[]): Promise<WalletCreateRecordsResponse> {
    this.calls.push(records.map(record => ({ ...record })));
    const callNumber = this.calls.length;

    if (this.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.delayMs));
    }

    const configuredFailure = this.failuresByCallNumber.get(callNumber);
    if (configuredFailure) {
      throw configuredFailure;
    }

    return {
      summary: { total: records.length, succeeded: records.length, failed: 0 },
      results: records.map((_record, index) => ({ id: `record-${callNumber}-${index}`, success: true })),
    };
  }
}

class MockMessagingGateway {
  public readonly messages: Array<{ channel: string; chatId: string; content: string }> = [];

  async sendMessage(channel: string, chatId: string, content: string): Promise<void> {
    this.messages.push({ channel, chatId, content });
  }
}

function createMockEvent(messageId: string = 'msg-1'): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    chatIdentifier: '+1234567890',
    userId: 'user123',
    messageContent: 'ya',
    timestamp: new Date(),
    messageId,
  };
}

function addExpense(
  pendingService: PendingTransactionService,
  overrides: Partial<Parameters<PendingTransactionService['addPendingTransaction']>[0]> = {}
): void {
  pendingService.addPendingTransaction({
    sourceType: 'WHATSAPP',
    bankDisplayName: 'BCA',
    accountNameHint: 'Savings Account',
    counterParty: 'Merchant',
    amount: 125000,
    transactionType: 'EXPENSE',
    matchedAccountId: 'acc-source',
    matchedCategoryId: 'cat-food',
    note: 'Lunch',
    recordDate: '2026-09-10',
    ...overrides,
  });
}

function createHandler(
  pendingService: PendingTransactionService,
  walletMcp: MockWalletMcpClient,
  messaging: MockMessagingGateway,
  emailListenerGetter: () => any = () => null
): PendingActionHandler {
  return new PendingActionHandler(
    pendingService,
    walletMcp as any,
    messaging as any,
    emailListenerGetter
  );
}

const confirmTicketOne: PendingConfirmationIntent = {
  actionType: 'CONFIRM',
  targetScope: 1,
};

const confirmAll: PendingConfirmationIntent = {
  actionType: 'CONFIRM',
  targetScope: 'ALL',
};

async function expectWalletMcpRequestError(
  operation: () => Promise<unknown>,
  expectedOutcome: 'DEFINITIVE_FAILURE' | 'UNKNOWN'
): Promise<WalletMcpRequestError> {
  try {
    await operation();
  } catch (error) {
    assertCondition('Error is classified as WalletMcpRequestError', error instanceof WalletMcpRequestError);
    const typedError = error as WalletMcpRequestError;
    assertCondition(
      `Dispatch outcome is ${expectedOutcome}`,
      typedError.dispatchOutcome === expectedOutcome,
      `actual=${typedError.dispatchOutcome}`
    );
    return typedError;
  }

  throw new Error('[FAIL] Expected WalletMcpRequestError but operation succeeded');
}

function createWalletClientWithToolResult(toolResult: unknown): WalletMcpClientService {
  const client = new WalletMcpClientService('https://example.invalid', 'test-token');
  (client as any).httpClient.post = async () => ({
    data: {
      result: {
        structuredContent: toolResult,
      },
    },
  });
  return client;
}

const sampleRecord: CreateRecordInputPayload = {
  accountId: 'acc-1',
  amount: -1000,
  recordDate: '2026-09-10',
};

async function main(): Promise<void> {
  await runCase('Suite 1: single confirmation succeeds and removes the ticket', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    assertCondition('Ticket removed after confirmed MCP success', pendingService.getPendingTransaction(1) === undefined);
    assertCondition('Exactly one MCP call was made', walletMcp.calls.length === 1);
    assertCondition('Success response was sent to the user', messaging.messages.length === 1);
  });

  await runCase('Suite 2: bulk partial definitive failures keep only failed tickets retryable', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    for (let index = 0; index < 5; index++) {
      addExpense(pendingService, {
        accountNameHint: `Account ${index + 1}`,
        counterParty: `Merchant ${index + 1}`,
        amount: 100000 * (index + 1),
        matchedAccountId: `acc-${index + 1}`,
        note: `Transaction ${index + 1}`,
      });
    }

    walletMcp.setDefinitiveFailureOnCall(2, 'rate limited');
    walletMcp.setDefinitiveFailureOnCall(4, 'validation failed');

    await handler.handlePendingAction(createMockEvent(), confirmAll, Date.now());

    assertCondition('Five independent MCP calls were attempted', walletMcp.calls.length === 5);
    assertCondition('Successful ticket #1 removed', pendingService.getPendingTransaction(1) === undefined);
    assertCondition('Failed ticket #2 remains', pendingService.getPendingTransaction(2) !== undefined);
    assertCondition('Successful ticket #3 removed', pendingService.getPendingTransaction(3) === undefined);
    assertCondition('Failed ticket #4 remains', pendingService.getPendingTransaction(4) !== undefined);
    assertCondition('Successful ticket #5 removed', pendingService.getPendingTransaction(5) === undefined);
    assertCondition('Failed ticket #2 returned to PENDING', pendingService.getPendingTransactionState(2) === 'PENDING');
    assertCondition('Failed ticket #4 returned to PENDING', pendingService.getPendingTransactionState(4) === 'PENDING');
    assertCondition('Only two retryable tickets remain', pendingService.getAllPendingTransactions().length === 2);

    const retryMessage = messaging.messages[0].content;
    assertCondition('Bulk retry guidance targets ticket #2 explicitly', retryMessage.includes('"ya #2"'));
    assertCondition('Bulk retry guidance targets ticket #4 explicitly', retryMessage.includes('"ya #4"'));
    assertCondition('Bulk retry guidance does not suggest ambiguous bare ya', !retryMessage.includes('Ketik "ya"'));
  });

  await runCase('Suite 3: transfer resumes from the failed leg without duplicating the committed leg', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    pendingService.addPendingTransaction({
      sourceType: 'WHATSAPP',
      bankDisplayName: 'BCA',
      accountNameHint: 'Checking',
      counterParty: 'Savings',
      amount: 500000,
      transactionType: 'TRANSFER',
      destinationAccountNameHint: 'Savings',
      matchedAccountId: 'acc-source',
      matchedDestinationAccountId: 'acc-destination',
      note: 'Move to savings',
      recordDate: '2026-09-10',
    });

    walletMcp.setDefinitiveFailureOnCall(2, 'destination leg rejected');
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    assertCondition('Transfer remains pending after second-leg failure', pendingService.getPendingTransaction(1) !== undefined);
    assertCondition('Transfer returns to PENDING after definitive failure', pendingService.getPendingTransactionState(1) === 'PENDING');
    assertCondition('First transfer leg checkpoint persisted', pendingService.getCompletedRecordIndexes(1).join(',') === '0');
    assertCondition('Two transfer leg calls attempted initially', walletMcp.calls.length === 2);
    assertCondition('First call was source leg', walletMcp.calls[0][0].accountId === 'acc-source');
    assertCondition('Second call was destination leg', walletMcp.calls[1][0].accountId === 'acc-destination');

    walletMcp.clearFailures();
    await handler.handlePendingAction(createMockEvent('msg-retry'), confirmTicketOne, Date.now());

    assertCondition('Retry only dispatched one additional call', walletMcp.calls.length === 3);
    assertCondition('Retry dispatched only destination leg', walletMcp.calls[2][0].accountId === 'acc-destination');
    assertCondition('Transfer ticket removed after remaining leg succeeds', pendingService.getPendingTransaction(1) === undefined);
  });

  await runCase('Suite 4: ambiguous timeout becomes UNKNOWN and is not automatically retried', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setUnknownFailureOnCall(1, 'socket closed after request write');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    assertCondition('Ambiguous ticket remains for reconciliation', pendingService.getPendingTransaction(1) !== undefined);
    assertCondition('Ambiguous ticket is marked UNKNOWN', pendingService.getPendingTransactionState(1) === 'UNKNOWN');
    assertCondition('Unknown outcome helper recognizes the error type', isWalletMcpDispatchOutcomeUnknown(new WalletMcpRequestError('timeout', 'UNKNOWN')));
    assertCondition('User is warned that automatic retry is disabled', messaging.messages[0].content.includes('tidak akan dikirim ulang otomatis'));

    await handler.handlePendingAction(createMockEvent('msg-second-confirm'), confirmTicketOne, Date.now());
    assertCondition('Second confirmation did not redispatch UNKNOWN ticket', walletMcp.calls.length === 1);
  });

  await runCase('Suite 5: concurrent confirmations cannot double-dispatch one ticket', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.delayMs = 25;

    await Promise.all([
      handler.handlePendingAction(createMockEvent('msg-concurrent-1'), confirmTicketOne, Date.now()),
      handler.handlePendingAction(createMockEvent('msg-concurrent-2'), confirmTicketOne, Date.now()),
    ]);

    assertCondition('Only one concurrent MCP dispatch occurred', walletMcp.calls.length === 1);
    assertCondition('Ticket resolved once after successful dispatch', pendingService.getPendingTransaction(1) === undefined);
    assertCondition('Both confirmation attempts received deterministic responses', messaging.messages.length === 2);
  });

  await runCase('Suite 6: email reference is recorded only after the full transaction succeeds', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const recordedReferences: string[] = [];
    const emailListener = {
      recordProcessedTransaction: (_unused: unknown, referenceNumber?: string) => {
        if (referenceNumber) {
          recordedReferences.push(referenceNumber);
        }
      },
    };
    const handler = createHandler(pendingService, walletMcp, messaging, () => emailListener);

    pendingService.addPendingTransaction({
      sourceType: 'EMAIL',
      bankDisplayName: 'Mandiri',
      accountNameHint: 'Checking',
      counterParty: 'Savings',
      amount: 300000,
      transactionType: 'TRANSFER',
      destinationAccountNameHint: 'Savings',
      matchedAccountId: 'acc-source',
      matchedDestinationAccountId: 'acc-destination',
      note: 'Email transfer',
      recordDate: '2026-09-10',
      referenceNumber: 'REF-12345',
    });

    walletMcp.setDefinitiveFailureOnCall(2, 'second leg failed');
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());
    assertCondition('Email reference is not marked after partial transfer', recordedReferences.length === 0);

    walletMcp.clearFailures();
    await handler.handlePendingAction(createMockEvent('msg-email-retry'), confirmTicketOne, Date.now());
    assertCondition('Email reference marked once after full success', recordedReferences.join(',') === 'REF-12345');
  });

  await runCase('Suite 7: backend error details stay in logs and are not exposed to chat', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setDefinitiveFailureOnCall(1, 'internal host=db.internal token=secret-123');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    const chatMessage = messaging.messages[0].content;
    assertCondition('User receives sanitized retry guidance', chatMessage.includes('aman untuk dicoba lagi'));
    assertCondition('Internal hostname is not exposed', !chatMessage.includes('db.internal'));
    assertCondition('Backend token is not exposed', !chatMessage.includes('secret-123'));
  });

  await runCase('Suite 8: PROCESSING tickets cannot be cancelled concurrently', () => {
    const pendingService = new PendingTransactionService();
    addExpense(pendingService);

    const claimed = pendingService.claimPendingTransaction(1);
    assertCondition('Ticket can be claimed from PENDING', claimed?.ticketId === 1);
    assertCondition('Claim moves ticket to PROCESSING', pendingService.getPendingTransactionState(1) === 'PROCESSING');
    assertCondition('PROCESSING ticket cannot be rejected', pendingService.rejectPendingTransaction(1) === undefined);

    pendingService.releaseProcessingTransaction(1);
    assertCondition('Definitive failure can release ticket to PENDING', pendingService.getPendingTransactionState(1) === 'PENDING');

    const reclaimed = pendingService.claimLatestPendingTransaction();
    assertCondition('Released ticket can be claimed again', reclaimed?.ticketId === 1);
    pendingService.markPendingTransactionUnknown(1);
    assertCondition('UNKNOWN ticket cannot be claimed automatically', pendingService.claimPendingTransaction(1) === undefined);
    assertCondition('UNKNOWN ticket can be explicitly cancelled after reconciliation', pendingService.rejectPendingTransaction(1)?.ticketId === 1);
  });

  await runCase('Suite 9: create_records per-item rejection is treated as definitive failure', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    (client as any).httpClient.post = async () => ({
      data: {
        result: {
          structuredContent: {
            summary: { total: 1, succeeded: 0, failed: 1 },
            results: [{ success: false, error: 'invalid category' }],
          },
        },
      },
    });

    await expectWalletMcpRequestError(
      () => client.createRecords([sampleRecord]),
      'DEFINITIVE_FAILURE'
    );
  });

  await runCase('Suite 10: transport timeout is classified UNKNOWN', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    const timeoutError = Object.assign(new Error('request timed out'), {
      isAxiosError: true,
      code: 'ECONNABORTED',
    });
    (client as any).httpClient.post = async () => {
      throw timeoutError;
    };

    const error = await expectWalletMcpRequestError(
      () => client.createRecords([sampleRecord]),
      'UNKNOWN'
    );
    assertCondition('UNKNOWN helper recognizes real client transport error', isWalletMcpDispatchOutcomeUnknown(error));
  });

  await runCase('Suite 11: explicit HTTP 400 is definitive while HTTP 503 is ambiguous', async () => {
    const definitiveClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    const badRequestError = Object.assign(new Error('bad request'), {
      isAxiosError: true,
      response: { status: 400, data: { message: 'invalid payload' } },
    });
    (definitiveClient as any).httpClient.post = async () => {
      throw badRequestError;
    };

    await expectWalletMcpRequestError(
      () => definitiveClient.createRecords([sampleRecord]),
      'DEFINITIVE_FAILURE'
    );

    const ambiguousClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    const serviceUnavailableError = Object.assign(new Error('service unavailable'), {
      isAxiosError: true,
      response: { status: 503, data: { message: 'upstream unavailable' } },
    });
    (ambiguousClient as any).httpClient.post = async () => {
      throw serviceUnavailableError;
    };

    await expectWalletMcpRequestError(
      () => ambiguousClient.createRecords([sampleRecord]),
      'UNKNOWN'
    );
  });

  await runCase('Suite 12: create_records requires positive and internally consistent success evidence', async () => {
    const nullClient = createWalletClientWithToolResult(null);
    await expectWalletMcpRequestError(() => nullClient.createRecords([sampleRecord]), 'UNKNOWN');

    const emptyObjectClient = createWalletClientWithToolResult({});
    await expectWalletMcpRequestError(() => emptyObjectClient.createRecords([sampleRecord]), 'UNKNOWN');

    const plainTextClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    (plainTextClient as any).httpClient.post = async () => ({
      data: {
        result: {
          content: [{ type: 'text', text: 'created' }],
        },
      },
    });
    await expectWalletMcpRequestError(() => plainTextClient.createRecords([sampleRecord]), 'UNKNOWN');

    const mismatchedSummaryClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 0, failed: 0 },
    });
    await expectWalletMcpRequestError(() => mismatchedSummaryClient.createRecords([sampleRecord]), 'UNKNOWN');

    const inconsistentEvidenceClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, failed: 0 },
      results: [],
    });
    await expectWalletMcpRequestError(() => inconsistentEvidenceClient.createRecords([sampleRecord]), 'UNKNOWN');

    const summaryOnlySuccessClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, failed: 0 },
    });
    const summaryOnlyResult = await summaryOnlySuccessClient.createRecords([sampleRecord]);
    assertCondition('Complete success summary is accepted as positive evidence', summaryOnlyResult.summary?.succeeded === 1);

    const resultsOnlySuccessClient = createWalletClientWithToolResult({
      results: [{ id: 'record-1', success: true }],
    });
    const resultsOnlyResult = await resultsOnlySuccessClient.createRecords([sampleRecord]);
    assertCondition('Complete per-record results are accepted as positive evidence', resultsOnlyResult.results?.[0]?.success === true);
  });

  await runCase('Suite 13: generic unclassified handler errors become UNKNOWN instead of retryable', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setGenericFailureOnCall(1, 'generic post-dispatch parser failure');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    assertCondition('Generic error keeps ticket for reconciliation', pendingService.getPendingTransaction(1) !== undefined);
    assertCondition('Generic error is fail-safe classified UNKNOWN', pendingService.getPendingTransactionState(1) === 'UNKNOWN');
    assertCondition('Generic error is not presented as safely retryable', !messaging.messages[0].content.includes('aman untuk dicoba lagi'));
    assertCondition('User receives no-auto-retry guidance', messaging.messages[0].content.includes('tidak akan dikirim ulang otomatis'));

    await handler.handlePendingAction(createMockEvent('msg-generic-retry'), confirmTicketOne, Date.now());
    assertCondition('Generic UNKNOWN ticket is not redispatched', walletMcp.calls.length === 1);
  });

  console.log('\n====================================================');
  console.log(`[SUCCESS] ${passedCaseCount} test cases passed with ${assertionCount} assertions.`);
  console.log('====================================================');
}

main().catch((error: unknown) => {
  console.error('[FATAL] pendingActionHandler.test.ts failed:', error);
  process.exitCode = 1;
});
