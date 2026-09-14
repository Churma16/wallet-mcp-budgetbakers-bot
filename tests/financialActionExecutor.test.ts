import assert from 'node:assert';
import { FinancialActionExecutor } from '../src/services/financialActionExecutor.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { UserMessageHandler } from '../src/handlers/userMessageHandler.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/index.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { TransactionSummaryService } from '../src/services/transactionSummaryService.js';
import {
  WalletAccountItem,
  WalletBudgetProgressItem,
  TransactionHistoryPage,
  TransactionSummaryResult,
} from '../src/types/walletTypes.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import { applicationLogger } from '../src/utils/logger.js';

console.log('[TEST] Starting Unified Financial Action Execution Paths Tests (Issue #107)...');

interface SentMessageRecord {
  readonly channel: string;
  readonly chatIdentifier: string;
  readonly message: string;
}

function createMockGateway() {
  const dispatchedMessages: SentMessageRecord[] = [];
  return {
    dispatchedMessages,
    sendMessage: async (channel: string, chatIdentifier: string, message: string): Promise<void> => {
      dispatchedMessages.push({ channel, chatIdentifier, message });
    },
    sendTypingPresence: async (): Promise<void> => {},
    clearTypingPresence: async (): Promise<void> => {},
  };
}

function createMockIncomingEvent(textPayload: string): IncomingUserMessageEvent {
  return {
    channel: 'whatsapp',
    senderIdentifier: 'user-phone-12345',
    chatIdentifier: '12345@s.whatsapp.net',
    messageType: 'text',
    textPayload,
    rawMessageTimestamp: new Date('2026-09-12T10:00:00.000Z'),
  };
}

const mockSampleAccounts: WalletAccountItem[] = [
  { id: 'account-1', name: 'BCA Utama', balance: 5000000, currency: 'IDR' },
  { id: 'account-2', name: 'Jago Tabungan', balance: 1500000, currency: 'IDR' },
];

const mockSampleBudgets: WalletBudgetProgressItem[] = [
  {
    id: 'budget-1',
    name: 'Makan & Minum',
    amount: 2000000,
    spent: 850000,
    remaining: 1150000,
    percentage: 42.5,
    currency: 'IDR',
  },
];

// -----------------------------------------------------------------------------
// Suite 1: FinancialActionExecutor Direct Unit Execution
// -----------------------------------------------------------------------------
console.log('\n[Suite 1] Testing FinancialActionExecutor Direct Execution...');
{
  setActiveLanguage('id');
  const mockGateway = createMockGateway();

  let refreshAccountsCalled = false;
  const mockWalletCache = {
    refreshAccounts: async (): Promise<WalletAccountItem[]> => {
      refreshAccountsCalled = true;
      return mockSampleAccounts;
    },
    getAccounts: (): WalletAccountItem[] => mockSampleAccounts,
    getCategories: () => [],
  };

  let fetchBudgetsCalled = false;
  const mockWalletMcpClient = {
    fetchBudgets: async (): Promise<WalletBudgetProgressItem[]> => {
      fetchBudgetsCalled = true;
      return mockSampleBudgets;
    },
  };

  const executor = new FinancialActionExecutor(
    mockWalletMcpClient as any,
    mockWalletCache as any,
    mockGateway as any
  );

  const incomingEvent = createMockIncomingEvent('cek saldo');

  // 1.1 executeCheckBalance
  await executor.executeCheckBalance(incomingEvent, {
    processingStartTimestamp: Date.now(),
    routingSource: 'fast-path',
  });
  assert.strictEqual(refreshAccountsCalled, true, 'WalletCache.refreshAccounts should have been called');
  assert.strictEqual(mockGateway.dispatchedMessages.length, 1, 'Should dispatch exactly 1 balance message');
  assert.ok(mockGateway.dispatchedMessages[0].message.includes('BCA Utama'), 'Dispatched balance message should contain account name');
  assert.ok(mockGateway.dispatchedMessages[0].message.includes('5.000.000'), 'Dispatched balance message should contain formatted balance');

  // 1.2 executeCheckBudget
  await executor.executeCheckBudget(incomingEvent, {
    processingStartTimestamp: Date.now(),
    routingSource: 'fast-path',
  });
  assert.strictEqual(fetchBudgetsCalled, true, 'WalletMcpClient.fetchBudgets should have been called');
  assert.strictEqual(mockGateway.dispatchedMessages.length, 2, 'Should dispatch budget message');
  assert.ok(mockGateway.dispatchedMessages[1].message.includes('Makan & Minum'), 'Dispatched budget message should contain budget name');

  // 1.3 executeHelpMenu
  await executor.executeHelpMenu(incomingEvent, {
    processingStartTimestamp: Date.now(),
    routingSource: 'fast-path',
  });
  assert.strictEqual(mockGateway.dispatchedMessages.length, 3, 'Should dispatch help menu message');
  assert.ok(mockGateway.dispatchedMessages[2].message.includes('saldo'), 'Help menu should mention commands');
  console.log('  [PASS] Direct execution of balance, budget, and help passed');
}

// -----------------------------------------------------------------------------
// Suite 2: FastPathHandler Delegation to Shared Executor
// -----------------------------------------------------------------------------
console.log('\n[Suite 2] Testing FastPathHandler Delegation to FinancialActionExecutor...');
{
  setActiveLanguage('id');
  const mockGateway = createMockGateway();

  let executedActions: string[] = [];
  const mockExecutor = {
    executeCheckBalance: async () => {
      executedActions.push('CHECK_BALANCE');
    },
    executeCheckBudget: async () => {
      executedActions.push('CHECK_BUDGET');
    },
    executeTransactionHistory: async () => {
      executedActions.push('TRANSACTION_HISTORY');
    },
    executeTransactionSummary: async () => {
      executedActions.push('TRANSACTION_SUMMARY');
    },
    executeHelpMenu: async () => {
      executedActions.push('HELP_MENU');
    },
  } as unknown as FinancialActionExecutor;

  const fastPathHandler = new FastPathHandler(
    {} as any,
    {} as any,
    mockGateway as any,
    undefined,
    undefined,
    mockExecutor
  );

  const testEvent = createMockIncomingEvent('saldo');

  const balanceHandled = await fastPathHandler.handleFastPath(testEvent, 'CHECK_BALANCE', Date.now());
  assert.strictEqual(balanceHandled, true);
  assert.deepStrictEqual(executedActions, ['CHECK_BALANCE'], 'FastPathHandler should delegate CHECK_BALANCE to executor');

  executedActions = [];
  const budgetHandled = await fastPathHandler.handleFastPath(testEvent, 'CHECK_BUDGET', Date.now());
  assert.strictEqual(budgetHandled, true);
  assert.deepStrictEqual(executedActions, ['CHECK_BUDGET'], 'FastPathHandler should delegate CHECK_BUDGET to executor');

  executedActions = [];
  const helpHandled = await fastPathHandler.handleFastPath(testEvent, 'HELP_MENU', Date.now());
  assert.strictEqual(helpHandled, true);
  assert.deepStrictEqual(executedActions, ['HELP_MENU'], 'FastPathHandler should delegate HELP_MENU to executor');

  executedActions = [];
  const historyHandled = await fastPathHandler.handleFastPath(testEvent, 'TRANSACTION_HISTORY' as any, Date.now());
  assert.strictEqual(historyHandled, true);
  assert.deepStrictEqual(executedActions, ['TRANSACTION_HISTORY'], 'FastPathHandler should delegate TRANSACTION_HISTORY to executor');

  console.log('  [PASS] FastPathHandler delegates all actions to FinancialActionExecutor');
}

// -----------------------------------------------------------------------------
// Suite 3: UserMessageHandler (AI-Path) Delegation to Shared Executor
// -----------------------------------------------------------------------------
console.log('\n[Suite 3] Testing UserMessageHandler (AI-Path) Delegation...');
{
  setActiveLanguage('id');
  const mockGateway = createMockGateway();

  let executedAiActions: string[] = [];
  const mockExecutor = {
    executeCheckBalance: async () => {
      executedAiActions.push('CHECK_BALANCE');
    },
    executeCheckBudget: async () => {
      executedAiActions.push('CHECK_BUDGET');
    },
  } as unknown as FinancialActionExecutor;

  let configuredAiAction: string = 'CHECK_BALANCE';
  const mockAiProvider = {
    providerName: 'mock-ai',
    processTextMessage: async () => ({
      action: configuredAiAction,
      explanation: 'Action recognized by AI',
    }),
  };

  const mockPendingManager = {
    hasPendingTransactions: () => false,
  };

  const mockWalletCache = {
    getAccounts: () => mockSampleAccounts,
    getCategories: () => [],
    refreshAccounts: async () => mockSampleAccounts,
  };

  const mockFastPath = {
    handleFastPath: async () => false,
  };

  const userMessageHandler = new UserMessageHandler(
    mockGateway as any,
    mockPendingManager as any,
    {} as any,
    mockFastPath as any,
    mockAiProvider as any,
    mockWalletCache as any,
    {} as any,
    mockExecutor
  );

  // 3.1 AI returns CHECK_BALANCE
  configuredAiAction = 'CHECK_BALANCE';
  const balanceEvent = createMockIncomingEvent('tolong tampilkan saldo rekening saya');
  await userMessageHandler.handleIncomingUserMessage(balanceEvent);
  assert.deepStrictEqual(executedAiActions, ['CHECK_BALANCE'], 'UserMessageHandler should delegate AI CHECK_BALANCE to executor');

  // 3.2 AI returns CHECK_BUDGET
  executedAiActions = [];
  configuredAiAction = 'CHECK_BUDGET';
  const budgetEvent = createMockIncomingEvent('berapa sisa budget bulan ini');
  await userMessageHandler.handleIncomingUserMessage(budgetEvent);
  assert.deepStrictEqual(executedAiActions, ['CHECK_BUDGET'], 'UserMessageHandler should delegate AI CHECK_BUDGET to executor');

  console.log('  [PASS] UserMessageHandler delegates AI CHECK_BALANCE and CHECK_BUDGET to FinancialActionExecutor');
}

// Cover the issue #148 deferred-category authority boundary through the
// existing legacy runner so Sonar receives granular TypeScript source maps.
{
  const categories = [{ id: 'cat-health', name: 'Kesehatan' }];
  let aiResponse: any = {
    action: 'TRANSACTION_HISTORY',
    queryOptions: { categoryId: 'cat-health' },
  };
  const executedContexts: any[] = [];
  const mockGateway = createMockGateway();
  const registry = {
    hasHandler: () => true,
    execute: async (context: any) => {
      executedContexts.push(context);
    },
  };
  const handler = new UserMessageHandler(
    mockGateway as any,
    { hasPendingTransactions: () => false } as any,
    {} as any,
    { handleFastPath: async () => false } as any,
    {
      providerName: 'mock-ai',
      processTextMessage: async () => aiResponse,
    } as any,
    {
      getAccounts: () => [],
      getCategories: () => categories,
    } as any,
    {} as any,
    {} as any,
    {} as any,
    registry as any
  );

  await handler.handleIncomingUserMessage(createMockIncomingEvent('riwayat beli obat bulan lalu'));
  assert.strictEqual(executedContexts.length, 1);
  assert.deepStrictEqual(executedContexts[0].queryOptions, {
    limit: undefined,
    page: undefined,
    sort: 'newest',
    datePeriod: 'last_month',
    categoryId: 'cat-health',
  });

  for (const rejectedResponse of [
    { action: 'TRANSACTION_HISTORY', queryOptions: {}, explanation: 'Kategori belum jelas.' },
    { action: 'CHECK_BALANCE', explanation: 'Action switch rejected.' },
    { action: 'CHECK_BUDGET', explanation: 'Action switch rejected.' },
    {
      action: 'CREATE_RECORD',
      records: [{ accountId: 'Cash', amount: 25_000, note: 'beli obat' }],
      explanation: 'Action switch rejected.',
    },
  ]) {
    aiResponse = rejectedResponse;
    await handler.handleIncomingUserMessage(createMockIncomingEvent('riwayat beli obat'));
  }
  assert.strictEqual(executedContexts.length, 1, 'Deferred history must not execute without a category or after an action switch');

  aiResponse = {
    action: 'CREATE_RECORD',
    records: [{ accountId: 'Cash', amount: Number.POSITIVE_INFINITY, note: 'invalid' }],
  };
  const messageCountBeforeInvalidProposal = mockGateway.dispatchedMessages.length;
  await handler.handleIncomingUserMessage(createMockIncomingEvent('catat transaksi invalid'));
  assert.strictEqual(executedContexts.length, 1, 'Rejected transaction proposal must not execute');
  assert.strictEqual(
    mockGateway.dispatchedMessages.length,
    messageCountBeforeInvalidProposal + 1,
    'Rejected transaction proposal should return validation guidance'
  );

  const missingHandler = new UserMessageHandler(
    mockGateway as any,
    { hasPendingTransactions: () => false } as any,
    {} as any,
    { handleFastPath: async () => false } as any,
    {
      providerName: 'mock-ai',
      processTextMessage: async () => ({
        action: 'TRANSACTION_HISTORY',
        queryOptions: { categoryId: 'cat-health' },
      }),
    } as any,
    {
      getAccounts: () => [],
      getCategories: () => categories,
    } as any,
    {} as any,
    {} as any,
    {} as any,
    { hasHandler: () => false, execute: async () => undefined } as any
  );
  await missingHandler.handleIncomingUserMessage(createMockIncomingEvent('riwayat beli obat'));
}

// -----------------------------------------------------------------------------
// Suite 4: End-to-End Equivalence Between Fast-Path and AI Routes
// -----------------------------------------------------------------------------
console.log('\n[Suite 4] Testing End-to-End Equivalence Between Fast-Path and AI-Routed Outputs...');
{
  setActiveLanguage('id');

  const fastPathGateway = createMockGateway();
  const aiPathGateway = createMockGateway();

  const sharedWalletCache = {
    refreshAccounts: async (): Promise<WalletAccountItem[]> => mockSampleAccounts,
    getAccounts: (): WalletAccountItem[] => mockSampleAccounts,
    getCategories: () => [],
  };

  const sharedWalletMcpClient = {
    fetchBudgets: async (): Promise<WalletBudgetProgressItem[]> => mockSampleBudgets,
  };

  // Shared executor instances bound to respective gateways
  const fastPathExecutor = new FinancialActionExecutor(
    sharedWalletMcpClient as any,
    sharedWalletCache as any,
    fastPathGateway as any
  );

  const aiPathExecutor = new FinancialActionExecutor(
    sharedWalletMcpClient as any,
    sharedWalletCache as any,
    aiPathGateway as any
  );

  const fastPathHandler = new FastPathHandler(
    sharedWalletMcpClient as any,
    sharedWalletCache as any,
    fastPathGateway as any,
    undefined,
    undefined,
    fastPathExecutor
  );

  let currentAiDecision: string = 'CHECK_BALANCE';
  const aiProvider = {
    providerName: 'mock-gemini',
    processTextMessage: async () => ({
      action: currentAiDecision,
      explanation: 'Decision made',
    }),
  };

  const userMessageHandler = new UserMessageHandler(
    aiPathGateway as any,
    { hasPendingTransactions: () => false } as any,
    {} as any,
    { handleFastPath: async () => false } as any,
    aiProvider as any,
    sharedWalletCache as any,
    sharedWalletMcpClient as any,
    aiPathExecutor
  );

  // 4.1 Balance Equivalence:
  const balanceEvent = createMockIncomingEvent('saldo');
  await fastPathHandler.handleFastPath(balanceEvent, 'CHECK_BALANCE', Date.now());

  currentAiDecision = 'CHECK_BALANCE';
  await userMessageHandler.handleIncomingUserMessage(balanceEvent);

  assert.strictEqual(fastPathGateway.dispatchedMessages.length, 1);
  assert.strictEqual(aiPathGateway.dispatchedMessages.length, 1);
  assert.strictEqual(
    fastPathGateway.dispatchedMessages[0].message,
    aiPathGateway.dispatchedMessages[0].message,
    'Dispatched balance message from Fast-Path and AI-Path must be completely identical'
  );

  // 4.2 Budget Equivalence:
  const budgetEvent = createMockIncomingEvent('budget');
  await fastPathHandler.handleFastPath(budgetEvent, 'CHECK_BUDGET', Date.now());

  currentAiDecision = 'CHECK_BUDGET';
  await userMessageHandler.handleIncomingUserMessage(budgetEvent);

  assert.strictEqual(fastPathGateway.dispatchedMessages.length, 2);
  assert.strictEqual(aiPathGateway.dispatchedMessages.length, 2);
  assert.strictEqual(
    fastPathGateway.dispatchedMessages[1].message,
    aiPathGateway.dispatchedMessages[1].message,
    'Dispatched budget message from Fast-Path and AI-Path must be completely identical'
  );

  console.log('  [PASS] Output equivalence verified: both routes produce identical human messages');
}

// -----------------------------------------------------------------------------
// Suite 5: Fallback Start Timestamp Resolution Without Context (Review Feedback)
// -----------------------------------------------------------------------------
console.log('\n[Suite 5] Testing Fallback Start Timestamp Resolution When Context Is Omitted...');
{
  setActiveLanguage('id');

  const capturedSuccessLogs: string[] = [];
  const originalSuccessLogger = applicationLogger.success;
  applicationLogger.success = (logMessage: string, ...rest: unknown[]) => {
    capturedSuccessLogs.push(logMessage);
    originalSuccessLogger(logMessage, ...rest);
  };

  try {
    const artificialOperationDelayMs = 25;
    // Date.now() has millisecond granularity and timers can appear 1-2ms short on CI runners.
    // A 5ms tolerance still proves the fallback timestamp is captured before the awaited work;
    // a timestamp captured after the operation would report approximately 0ms.
    const minimumExpectedDurationMs = artificialOperationDelayMs - 5;

    const mockGatewayWithDelay = {
      sendMessage: async (_channel: string, _chatId: string, _msg: string): Promise<void> => {
        await new Promise(resolve => setTimeout(resolve, artificialOperationDelayMs));
      },
    };

    const mockWalletCache = {
      refreshAccounts: async (): Promise<WalletAccountItem[]> => {
        await new Promise(resolve => setTimeout(resolve, artificialOperationDelayMs));
        return mockSampleAccounts;
      },
    };

    const mockWalletMcpClient = {
      fetchBudgets: async (): Promise<WalletBudgetProgressItem[]> => {
        await new Promise(resolve => setTimeout(resolve, artificialOperationDelayMs));
        return mockSampleBudgets;
      },
    };

    const executor = new FinancialActionExecutor(
      mockWalletMcpClient as any,
      mockWalletCache as any,
      mockGatewayWithDelay as any
    );

    const testEvent = createMockIncomingEvent('test');

    // 5.1 executeCheckBalance without context
    capturedSuccessLogs.length = 0;
    await executor.executeCheckBalance(testEvent);
    assert.strictEqual(capturedSuccessLogs.length, 1);
    const balanceDurationMatch = capturedSuccessLogs[0].match(/\((\d+)ms\)/);
    assert.ok(balanceDurationMatch, 'Balance success log should contain duration in ms');
    const balanceDuration = Number(balanceDurationMatch[1]);
    assert.ok(
      balanceDuration >= minimumExpectedDurationMs,
      `Balance duration (${balanceDuration}ms) should include the awaited work (minimum ${minimumExpectedDurationMs}ms)`
    );

    // 5.2 executeCheckBudget without context
    capturedSuccessLogs.length = 0;
    await executor.executeCheckBudget(testEvent);
    assert.strictEqual(capturedSuccessLogs.length, 1);
    const budgetDurationMatch = capturedSuccessLogs[0].match(/\((\d+)ms\)/);
    assert.ok(budgetDurationMatch, 'Budget success log should contain duration in ms');
    const budgetDuration = Number(budgetDurationMatch[1]);
    assert.ok(
      budgetDuration >= minimumExpectedDurationMs,
      `Budget duration (${budgetDuration}ms) should include the awaited work (minimum ${minimumExpectedDurationMs}ms)`
    );

    // 5.3 executeHelpMenu without context
    capturedSuccessLogs.length = 0;
    await executor.executeHelpMenu(testEvent);
    assert.strictEqual(capturedSuccessLogs.length, 1);
    const helpDurationMatch = capturedSuccessLogs[0].match(/\((\d+)ms\)/);
    assert.ok(helpDurationMatch, 'Help success log should contain duration in ms');
    const helpDuration = Number(helpDurationMatch[1]);
    assert.ok(
      helpDuration >= minimumExpectedDurationMs,
      `Help duration (${helpDuration}ms) should include the awaited work (minimum ${minimumExpectedDurationMs}ms)`
    );

    console.log('  [PASS] All executor methods establish fallback timestamp before work begins');
  } finally {
    applicationLogger.success = originalSuccessLogger;
  }
}

console.log('\n[SUCCESS] All Unified Financial Action Execution Tests Passed Cleanly!');
