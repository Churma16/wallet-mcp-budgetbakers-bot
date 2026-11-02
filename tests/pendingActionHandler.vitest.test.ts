import { PendingActionHandler } from '../src/core/handlers/pendingHandler.js';
import { PendingTransactionService } from '../src/core/pending.js';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  isWalletMcpDispatchOutcomeUnknown,
} from '../src/wallet/index.js';
import { CreateRecordInputPayload, WalletCreateRecordsResponse } from '../src/wallet/index.js';
import { IncomingUserMessageEvent } from '../src/gateway/index.js';
import { PendingConfirmationIntent } from '../src/brain/index.js';
import { describe, expect, it, vi } from 'vitest';




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
      results: records.map((_record, index) => ({ id: `record-${callNumber}-${index}`, inputIndex: index, success: true })),
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
    expect(error instanceof WalletMcpRequestError, 'Error is classified as WalletMcpRequestError').toBe(true);
    const typedError = error as WalletMcpRequestError;
    expect(typedError.dispatchOutcome === expectedOutcome, `${`Dispatch outcome is ${expectedOutcome}`} -> ${`actual=${typedError.dispatchOutcome}`}`).toBe(true);
    return typedError;
  }

  throw new Error('[FAIL] Expected WalletMcpRequestError but operation succeeded');
}

function createWalletClientWithToolResult(toolResult: unknown): WalletMcpClientService {
  const client = new WalletMcpClientService('https://example.invalid', 'test-token');
  vi.spyOn(client, 'callMcpTool').mockResolvedValue(toolResult as never);
  return client;
}

const sampleRecord: CreateRecordInputPayload = {
  accountId: 'acc-1',
  amount: -1000,
  recordDate: '2026-09-10',
};

describe('Pending Transaction Data Integrity and MCP Failure Recovery', () => {
  it('single confirmation succeeds and removes the ticket', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    expect(pendingService.getPendingTransaction(1) === undefined, 'Ticket removed after confirmed MCP success').toBe(true);
    expect(walletMcp.calls.length === 1, 'Exactly one MCP call was made').toBe(true);
    expect(messaging.messages.length === 1, 'Success response was sent to the user').toBe(true);
  });

  it('bulk partial definitive failures keep only failed tickets retryable', async () => {
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

    expect(walletMcp.calls.length === 5, 'Five independent MCP calls were attempted').toBe(true);
    expect(pendingService.getPendingTransaction(1) === undefined, 'Successful ticket #1 removed').toBe(true);
    expect(pendingService.getPendingTransaction(2) !== undefined, 'Failed ticket #2 remains').toBe(true);
    expect(pendingService.getPendingTransaction(3) === undefined, 'Successful ticket #3 removed').toBe(true);
    expect(pendingService.getPendingTransaction(4) !== undefined, 'Failed ticket #4 remains').toBe(true);
    expect(pendingService.getPendingTransaction(5) === undefined, 'Successful ticket #5 removed').toBe(true);
    expect(pendingService.getPendingTransactionState(2) === 'PENDING', 'Failed ticket #2 returned to PENDING').toBe(true);
    expect(pendingService.getPendingTransactionState(4) === 'PENDING', 'Failed ticket #4 returned to PENDING').toBe(true);
    expect(pendingService.getAllPendingTransactions().length === 2, 'Only two retryable tickets remain').toBe(true);

    const retryMessage = messaging.messages[0].content;
    expect(retryMessage.includes('"ya #2"'), 'Bulk retry guidance targets ticket #2 explicitly').toBe(true);
    expect(retryMessage.includes('"ya #4"'), 'Bulk retry guidance targets ticket #4 explicitly').toBe(true);
    expect(!retryMessage.includes('Ketik "ya"'), 'Bulk retry guidance does not suggest ambiguous bare ya').toBe(true);
  });

  it('transfer uses one native paired-transfer input', async () => {
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

    walletMcp.setDefinitiveFailureOnCall(1, 'transfer rejected');
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    expect(pendingService.getPendingTransaction(1) !== undefined, 'Transfer remains pending after definitive failure').toBe(true);
    expect(pendingService.getPendingTransactionState(1) === 'PENDING', 'Transfer returns to PENDING after definitive failure').toBe(true);
    expect(walletMcp.calls.length === 1, 'One native transfer call attempted initially').toBe(true);
    expect(walletMcp.calls[0][0].accountId === 'acc-source', 'Native transfer uses source account').toBe(true);
    expect(walletMcp.calls[0][0].transfer?.accountId === 'acc-destination', 'Native transfer targets destination account').toBe(true);
    expect(walletMcp.calls[0][0].transfer?.pairingMode === 'new', 'Native transfer requests a new pair').toBe(true);
    expect(walletMcp.calls[0][0].categoryId === undefined, 'Native transfer omits ordinary category').toBe(true);

    walletMcp.clearFailures();
    await handler.handlePendingAction(createMockEvent('msg-retry'), confirmTicketOne, Date.now());

    expect(walletMcp.calls.length === 2, 'Safe retry dispatched one logical transfer call').toBe(true);
    expect(pendingService.getPendingTransaction(1) === undefined, 'Transfer ticket removed after retry succeeds').toBe(true);
  });

  it('ambiguous timeout becomes UNKNOWN and is not automatically retried', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setUnknownFailureOnCall(1, 'socket closed after request write');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    expect(pendingService.getPendingTransaction(1) !== undefined, 'Ambiguous ticket remains for reconciliation').toBe(true);
    expect(pendingService.getPendingTransactionState(1) === 'UNKNOWN', 'Ambiguous ticket is marked UNKNOWN').toBe(true);
    expect(isWalletMcpDispatchOutcomeUnknown(new WalletMcpRequestError('timeout', 'UNKNOWN')), 'Unknown outcome helper recognizes the error type').toBe(true);
    expect(messaging.messages[0].content.includes('tidak akan dikirim ulang otomatis'), 'User is warned that automatic retry is disabled').toBe(true);

    await handler.handlePendingAction(createMockEvent('msg-second-confirm'), confirmTicketOne, Date.now());
    expect(walletMcp.calls.length === 1, 'Second confirmation did not redispatch UNKNOWN ticket').toBe(true);
  });

  it('concurrent confirmations cannot double-dispatch one ticket', async () => {
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

    expect(walletMcp.calls.length === 1, 'Only one concurrent MCP dispatch occurred').toBe(true);
    expect(pendingService.getPendingTransaction(1) === undefined, 'Ticket resolved once after successful dispatch').toBe(true);
    expect(messaging.messages.length === 2, 'Both confirmation attempts received deterministic responses').toBe(true);
  });

  it('email reference is recorded only after the native transfer succeeds', async () => {
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

    walletMcp.setDefinitiveFailureOnCall(1, 'native transfer rejected');
    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());
    expect(recordedReferences.length === 0, 'Email reference is not marked after rejected transfer').toBe(true);

    walletMcp.clearFailures();
    await handler.handlePendingAction(createMockEvent('msg-email-retry'), confirmTicketOne, Date.now());
    expect(recordedReferences.join(',') === 'REF-12345', 'Email reference marked once after full success').toBe(true);
  });

  it('backend error details stay in logs and are not exposed to chat', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setDefinitiveFailureOnCall(1, 'internal host=db.internal token=secret-123');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    const chatMessage = messaging.messages[0].content;
    expect(chatMessage.includes('aman untuk dicoba lagi'), 'User receives sanitized retry guidance').toBe(true);
    expect(!chatMessage.includes('db.internal'), 'Internal hostname is not exposed').toBe(true);
    expect(!chatMessage.includes('secret-123'), 'Backend token is not exposed').toBe(true);
  });

  it('PROCESSING and UNKNOWN tickets cannot be cancelled concurrently or before reconciliation', () => {
    const pendingService = new PendingTransactionService();
    addExpense(pendingService);

    const claimed = pendingService.claimPendingTransaction(1);
    expect(claimed?.ticketId === 1, 'Ticket can be claimed from PENDING').toBe(true);
    expect(pendingService.getPendingTransactionState(1) === 'PROCESSING', 'Claim moves ticket to PROCESSING').toBe(true);
    expect(pendingService.rejectPendingTransaction(1) === undefined, 'PROCESSING ticket cannot be rejected').toBe(true);

    pendingService.releaseProcessingTransaction(1);
    expect(pendingService.getPendingTransactionState(1) === 'PENDING', 'Definitive failure can release ticket to PENDING').toBe(true);

    const reclaimed = pendingService.claimLatestPendingTransaction();
    expect(reclaimed?.ticketId === 1, 'Released ticket can be claimed again').toBe(true);
    pendingService.markPendingTransactionUnknown(1);
    expect(pendingService.claimPendingTransaction(1) === undefined, 'UNKNOWN ticket cannot be claimed automatically').toBe(true);
    expect(pendingService.rejectPendingTransaction(1) === undefined, 'UNKNOWN ticket cannot be cancelled before reconciliation').toBe(true);
    expect(pendingService.getPendingTransactionState(1) === 'UNKNOWN', 'UNKNOWN ticket remains available for reconciliation').toBe(true);
  });

  it('create_records per-item rejection is treated as definitive failure', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(client, 'callMcpTool').mockResolvedValue({
      summary: { total: 1, succeeded: 0, failed: 1 },
      results: [{ inputIndex: 0, success: false, error: 'invalid category' }],
    });

    await expectWalletMcpRequestError(
      () => client.createRecords([sampleRecord]),
      'DEFINITIVE_FAILURE'
    );
  });

  it('transport timeout is classified UNKNOWN', async () => {
    const client = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(client, 'callMcpTool').mockRejectedValue(
      new WalletMcpRequestError('request timed out', 'UNKNOWN')
    );

    const error = await expectWalletMcpRequestError(
      () => client.createRecords([sampleRecord]),
      'UNKNOWN'
    );
    expect(isWalletMcpDispatchOutcomeUnknown(error), 'UNKNOWN helper recognizes real client transport error').toBe(true);
  });

  it('explicit HTTP 400 is definitive while HTTP 503 is ambiguous', async () => {
    const definitiveClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(definitiveClient, 'callMcpTool').mockRejectedValue(
      new WalletMcpRequestError('bad request', 'DEFINITIVE_FAILURE')
    );

    await expectWalletMcpRequestError(
      () => definitiveClient.createRecords([sampleRecord]),
      'DEFINITIVE_FAILURE'
    );

    const ambiguousClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(ambiguousClient, 'callMcpTool').mockRejectedValue(
      new WalletMcpRequestError('service unavailable', 'UNKNOWN')
    );

    await expectWalletMcpRequestError(
      () => ambiguousClient.createRecords([sampleRecord]),
      'UNKNOWN'
    );
  });

  it('create_records requires positive and internally consistent success evidence', async () => {
    const nullClient = createWalletClientWithToolResult(null);
    await expectWalletMcpRequestError(() => nullClient.createRecords([sampleRecord]), 'UNKNOWN');

    const emptyObjectClient = createWalletClientWithToolResult({});
    await expectWalletMcpRequestError(() => emptyObjectClient.createRecords([sampleRecord]), 'UNKNOWN');

    const plainTextClient = new WalletMcpClientService('https://example.invalid', 'test-token');
    vi.spyOn(plainTextClient, 'callMcpTool').mockResolvedValue('created');
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
    expect(summaryOnlyResult.summary?.succeeded === 1, 'Complete success summary is accepted as positive evidence').toBe(true);

    const resultsOnlySuccessClient = createWalletClientWithToolResult({
      results: [{ inputIndex: 0, id: 'record-1', success: true }],
    });
    const resultsOnlyResult = await resultsOnlySuccessClient.createRecords([sampleRecord]);
    expect(resultsOnlyResult.results?.[0]?.success === true, 'Complete per-record results are accepted as positive evidence').toBe(true);

    // Current-format full success (Issue #146)
    const currentFormatSuccessClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 1 },
      results: [{ inputIndex: 0, id: 'record-1', success: true }],
    });
    const currentFormatResult = await currentFormatSuccessClient.createRecords([sampleRecord]);
    expect(currentFormatResult.summary?.succeeded === 1, 'Current format success summary is accepted').toBe(true);

    // Current-format client error yields DEFINITIVE_FAILURE
    const currentClientErrorClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 0, clientErrors: 1, serverErrors: 0, documentsWritten: 0 },
      results: [{ inputIndex: 0, success: false, error: 'invalid category' }],
    });
    await expectWalletMcpRequestError(() => currentClientErrorClient.createRecords([sampleRecord]), 'DEFINITIVE_FAILURE');

    // Current-format server error yields UNKNOWN
    const currentServerErrorClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 0, clientErrors: 0, serverErrors: 1, documentsWritten: 0 },
      results: [{ inputIndex: 0, success: false, errorType: 'server_error', error: 'database error' }],
    });
    await expectWalletMcpRequestError(() => currentServerErrorClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Invalid optional field (negative integer)
    const negativeFieldClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: -1, serverErrors: 0 },
    });
    await expectWalletMcpRequestError(() => negativeFieldClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Incomplete error counters (clientErrors without serverErrors)
    const partialErrorClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0 },
    });
    await expectWalletMcpRequestError(() => partialErrorClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Conflicting failed vs clientErrors + serverErrors
    const conflictingErrorClient = createWalletClientWithToolResult({
      summary: { total: 2, succeeded: 1, failed: 2, clientErrors: 1, serverErrors: 0 },
    });
    await expectWalletMcpRequestError(() => conflictingErrorClient.createRecords([sampleRecord, sampleRecord]), 'UNKNOWN');

    // Mismatched documentsWritten with succeeded
    const mismatchedDocsClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 0 },
    });
    await expectWalletMcpRequestError(() => mismatchedDocsClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Inconsistent documentsWritten with per-record results
    const inconsistentDocsClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 0 },
      results: [{ inputIndex: 0, id: 'rec-1', success: true }],
    });
    await expectWalletMcpRequestError(() => inconsistentDocsClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Invalid result item shape (missing boolean success)
    const invalidResultShapeClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 1 },
      results: [{ id: 'rec-1' }],
    });
    await expectWalletMcpRequestError(() => invalidResultShapeClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Summary succeeded inconsistent with results success count
    const inconsistentSuccessCountClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1, clientErrors: 0, serverErrors: 0, documentsWritten: 1 },
      results: [{ inputIndex: 0, id: 'rec-1', success: false }],
    });
    await expectWalletMcpRequestError(() => inconsistentSuccessCountClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Summary error count inconsistent with results failure count
    const inconsistentErrorCountClient = createWalletClientWithToolResult({
      summary: { total: 2, succeeded: 1, clientErrors: 1, serverErrors: 0, documentsWritten: 1 },
      results: [
        { inputIndex: 0, id: 'rec-1', success: true },
        { inputIndex: 1, id: 'rec-2', success: true },
      ],
    });
    await expectWalletMcpRequestError(() => inconsistentErrorCountClient.createRecords([sampleRecord, sampleRecord]), 'UNKNOWN');

    // Summary-only failure without results array
    const summaryOnlyFailureClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 0, failed: 1 },
    });
    await expectWalletMcpRequestError(() => summaryOnlyFailureClient.createRecords([sampleRecord]), 'DEFINITIVE_FAILURE');

    // Incomplete summary without error fields, results, or documentsWritten
    const incompleteSummaryClient = createWalletClientWithToolResult({
      summary: { total: 1, succeeded: 1 },
    });
    await expectWalletMcpRequestError(() => incompleteSummaryClient.createRecords([sampleRecord]), 'UNKNOWN');

    // Mismatched summary total with expected record count
    const mismatchedTotalClient = createWalletClientWithToolResult({
      summary: { total: 2, succeeded: 1, failed: 1 },
    });
    await expectWalletMcpRequestError(() => mismatchedTotalClient.createRecords([sampleRecord]), 'UNKNOWN');
  });

  it('generic unclassified handler errors become UNKNOWN instead of retryable', async () => {
    const pendingService = new PendingTransactionService();
    const walletMcp = new MockWalletMcpClient();
    const messaging = new MockMessagingGateway();
    const handler = createHandler(pendingService, walletMcp, messaging);

    addExpense(pendingService);
    walletMcp.setGenericFailureOnCall(1, 'generic post-dispatch parser failure');

    await handler.handlePendingAction(createMockEvent(), confirmTicketOne, Date.now());

    expect(pendingService.getPendingTransaction(1) !== undefined, 'Generic error keeps ticket for reconciliation').toBe(true);
    expect(pendingService.getPendingTransactionState(1) === 'UNKNOWN', 'Generic error is fail-safe classified UNKNOWN').toBe(true);
    expect(!messaging.messages[0].content.includes('aman untuk dicoba lagi'), 'Generic error is not presented as safely retryable').toBe(true);
    expect(messaging.messages[0].content.includes('tidak akan dikirim ulang otomatis'), 'User receives no-auto-retry guidance').toBe(true);

    await handler.handlePendingAction(createMockEvent('msg-generic-retry'), confirmTicketOne, Date.now());
    expect(walletMcp.calls.length === 1, 'Generic UNKNOWN ticket is not redispatched').toBe(true);
  });

});
