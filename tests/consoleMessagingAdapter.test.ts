import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { ConsoleMessagingAdapter } from '../src/services/messaging/consoleAdapter.js';
import { MessagingGatewayService } from '../src/services/messaging/messagingGatewayService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';
import {
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createBaseConfiguration(
  overrides?: Partial<ApplicationEnvironmentConfiguration>
): ApplicationEnvironmentConfiguration {
  return {
    aiProvider: 'gemini',
    aiProviders: ['gemini'],
    aiApiKey: '',
    aiBaseUrl: '',
    aiModel: 'gemini-3.6-flash',
    aiFallbackModels: [],
    aiRequestTimeoutMilliseconds: 20000,
    geminiApiKey: 'test-gemini-key',
    geminiModel: 'gemini-3.6-flash',
    geminiFallbackModels: [],
    geminiRequestTimeoutMilliseconds: 20000,
    walletMcpBaseUrl: 'https://mcp.wallet.budgetbakers.com',
    walletMcpAccessToken: 'test-wallet-token',
    allowedPhoneNumber: '',
    whatsappSessionPath: './test_session',
    telegramBotToken: '',
    telegramAllowedUserId: '',
    enabledMessengerChannels: ['console'],
    logRetentionDays: 7,
    emailSyncEnabled: false,
    emailImapHost: 'imap.gmail.com',
    emailImapPort: 993,
    emailImapUser: '',
    emailImapPassword: '',
    emailLookbackMinutes: 10,
    appLanguage: 'id',
    defaultCurrency: 'IDR',
    appTimezone: 'Asia/Jakarta',
    whatsappMaxReconnectAttempts: 6,
    whatsappReconnectMaxBackoffSeconds: 300,
    whatsappMessageQueueIntervalMs: 1000,
    whatsappTypingPresenceCooldownMs: 2500,
    telegramMaxStartupAttempts: 5,
    telegramStartupRetryDelayMs: 2000,
    maxMediaDownloadMb: 10,
    categoryContextFilePath: 'config/category-context.json',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TEST GROUP 1: Adapter Initialization and Defaults
// ---------------------------------------------------------------------------
test('CMA-1: Adapter Initialization & Defaults', () => {
  const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
  const adapter = new ConsoleMessagingAdapter(dummyCallback);

  assert.strictEqual(adapter.channelName, 'console');
  assert.strictEqual(adapter.getConnectionState(), 'idle');
  assert.strictEqual(adapter.getSenderIdentifier(), 'console_user');
  assert.strictEqual(adapter.getChatIdentifier(), 'console');

  const customAdapter = new ConsoleMessagingAdapter(dummyCallback, {
    senderIdentifier: 'custom_admin',
    chatIdentifier: 'custom_terminal',
    promptPrefix: 'CLI> ',
  });
  assert.strictEqual(customAdapter.getSenderIdentifier(), 'custom_admin');
  assert.strictEqual(customAdapter.getChatIdentifier(), 'custom_terminal');
});

// ---------------------------------------------------------------------------
// TEST GROUP 2: Lifecycle (startConnection & stopConnection)
// ---------------------------------------------------------------------------
test('CMA-2: Adapter Lifecycle', async () => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let capturedOutput = '';
  outputStream.on('data', chunk => {
    capturedOutput += chunk.toString();
  });

  const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
  const adapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream,
    outputStream,
  });

  assert.strictEqual(adapter.getConnectionState(), 'idle');

  await adapter.startConnection();
  assert.strictEqual(adapter.getConnectionState(), 'connected');
  assert.ok(capturedOutput.includes('Console messaging adapter active'));

  await adapter.stopConnection();
  assert.strictEqual(adapter.getConnectionState(), 'idle');
});

// ---------------------------------------------------------------------------
// TEST GROUP 3: Message Ingestion & Event Dispatching
// ---------------------------------------------------------------------------
test('CMA-3: Inbound Message Processing', async () => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  const receivedEvents: IncomingUserMessageEvent[] = [];

  const onUserMessageReceived = async (event: IncomingUserMessageEvent): Promise<void> => {
    receivedEvents.push(event);
  };

  const adapter = new ConsoleMessagingAdapter(onUserMessageReceived, {
    inputStream,
    outputStream,
  });

  await adapter.startConnection();

  // Send valid input line
  inputStream.write('beli kopi starbucks 50rb\n');
  await delay(50);

  assert.strictEqual(receivedEvents.length, 1);
  assert.strictEqual(receivedEvents[0]?.channel, 'console');
  assert.strictEqual(receivedEvents[0]?.senderIdentifier, 'console_user');
  assert.strictEqual(receivedEvents[0]?.chatIdentifier, 'console');
  assert.strictEqual(receivedEvents[0]?.messageType, 'text');
  assert.strictEqual(receivedEvents[0]?.textPayload, 'beli kopi starbucks 50rb');

  // Empty and whitespace lines should be ignored
  inputStream.write('\n');
  inputStream.write('   \t  \n');
  await delay(50);
  assert.strictEqual(receivedEvents.length, 1);

  // Send another line with surrounding whitespace
  inputStream.write('   cek saldo   \n');
  await delay(50);
  assert.strictEqual(receivedEvents.length, 2);
  assert.strictEqual(receivedEvents[1]?.textPayload, 'cek saldo');

  await adapter.stopConnection();
});

// ---------------------------------------------------------------------------
// TEST GROUP 4: Outbound Messaging & Presence
// ---------------------------------------------------------------------------
test('CMA-4: Outbound Messaging & Presence', async () => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let capturedOutput = '';
  outputStream.on('data', chunk => {
    capturedOutput += chunk.toString();
  });

  const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
  const adapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream,
    outputStream,
  });

  await adapter.startConnection();
  capturedOutput = '';

  await adapter.sendTextMessage('console', 'Transaksi sebesar Rp 50.000 berhasil dicatat.');
  assert.ok(capturedOutput.includes('Transaksi sebesar Rp 50.000 berhasil dicatat.'));

  capturedOutput = '';
  await adapter.sendBroadcastNotification('Pengingat sinkronisasi email berhasil.');
  assert.ok(capturedOutput.includes('Pengingat sinkronisasi email berhasil.'));

  // Typing presence methods should execute cleanly without throwing
  let presenceFailed = false;
  try {
    await adapter.sendTypingPresence('console');
    await adapter.clearTypingPresence('console');
  } catch {
    presenceFailed = true;
  }
  assert.strictEqual(presenceFailed, false);

  await adapter.stopConnection();
});

// ---------------------------------------------------------------------------
// TEST GROUP 5: Interactive Exit Commands & Stream Termination
// ---------------------------------------------------------------------------
test('CMA-5: Interactive Exit Commands & Stream Termination', async () => {
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let exitCallbackCalled = false;

  const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
  const adapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream,
    outputStream,
    onExitRequested: () => {
      exitCallbackCalled = true;
    },
  });

  await adapter.startConnection();

  // Type 'exit'
  inputStream.write('exit\n');
  await delay(50);

  assert.strictEqual(exitCallbackCalled, true);
  assert.strictEqual(adapter.getConnectionState(), 'idle');

  // Test with 'quit' on a second instance
  const quitInputStream = new PassThrough();
  const quitOutputStream = new PassThrough();
  let quitCallbackCalled = false;

  const quitAdapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream: quitInputStream,
    outputStream: quitOutputStream,
    onExitRequested: () => {
      quitCallbackCalled = true;
    },
  });

  await quitAdapter.startConnection();
  quitInputStream.write('QUIT\n');
  await delay(50);

  assert.strictEqual(quitCallbackCalled, true);
  assert.strictEqual(quitAdapter.getConnectionState(), 'idle');

  // Test stream EOF/close
  const closeInputStream = new PassThrough();
  const closeOutputStream = new PassThrough();
  let closeCallbackCalled = false;

  const closeAdapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream: closeInputStream,
    outputStream: closeOutputStream,
    onExitRequested: () => {
      closeCallbackCalled = true;
    },
  });

  await closeAdapter.startConnection();
  closeInputStream.end();
  await delay(50);

  assert.strictEqual(closeCallbackCalled, true);
  assert.strictEqual(closeAdapter.getConnectionState(), 'idle');
});

// ---------------------------------------------------------------------------
// TEST GROUP 6: MessagingGatewayService Integration
// ---------------------------------------------------------------------------
test('CMA-6: MessagingGatewayService Integration', async () => {
  const gateway = new MessagingGatewayService();
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();
  let capturedOutput = '';
  outputStream.on('data', chunk => {
    capturedOutput += chunk.toString();
  });

  const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
  const adapter = new ConsoleMessagingAdapter(dummyCallback, {
    inputStream,
    outputStream,
  });

  gateway.registerAdapter(adapter);

  assert.ok(gateway.getActiveChannels().includes('console'));
  assert.strictEqual(gateway.getAdapterState('console'), 'idle');

  await gateway.startAll();
  assert.strictEqual(gateway.isChannelConnected('console'), true);
  assert.ok(gateway.getConnectedChannels().includes('console'));

  capturedOutput = '';
  await gateway.sendMessage('console', 'console', 'Pesan lewat gateway.');
  assert.ok(capturedOutput.includes('Pesan lewat gateway.'));

  capturedOutput = '';
  await gateway.broadcastNotification('Notifikasi broadcast lewat gateway.');
  assert.ok(capturedOutput.includes('Notifikasi broadcast lewat gateway.'));

  await gateway.stopAll();
  assert.strictEqual(gateway.getAdapterState('console'), 'idle');
  assert.strictEqual(adapter.getConnectionState(), 'idle');
});

// ---------------------------------------------------------------------------
// TEST GROUP 7: Configuration & Startup Validation (Issue #16 AC)
// ---------------------------------------------------------------------------
test('CMA-7: Configuration & Startup Validation (Issue #16 AC)', () => {
  // 7.1 Console-only mode without WhatsApp or Telegram credentials
  const consoleOnlyConfig = createBaseConfiguration({
    enabledMessengerChannels: ['console'],
    allowedPhoneNumber: '',
    telegramBotToken: '',
    telegramAllowedUserId: '',
  });

  const validationResult = validateApplicationConfiguration(consoleOnlyConfig);
  assert.strictEqual(validationResult.isValid, true);
  assert.strictEqual(validationResult.errors.length, 0);

  // 7.2 No channels enabled -> must fail validation
  const noChannelsConfig = createBaseConfiguration({
    enabledMessengerChannels: [],
  });
  const noChannelsResult = validateApplicationConfiguration(noChannelsConfig);
  assert.strictEqual(noChannelsResult.isValid, false);
  const hasChannelsError = noChannelsResult.errors.some(error => error.variableName === 'ENABLED_MESSENGER_CHANNELS');
  assert.strictEqual(hasChannelsError, true);

  // 7.3 WhatsApp enabled without phone number, but console enabled
  const mixedConfig = createBaseConfiguration({
    enabledMessengerChannels: ['whatsapp', 'console'],
    allowedPhoneNumber: '',
  });
  const mixedResult = validateApplicationConfiguration(mixedConfig);
  assert.strictEqual(mixedResult.isValid, false);
  const hasPhoneError = mixedResult.errors.some(error => error.variableName === 'ALLOWED_PHONE_NUMBER');
  assert.strictEqual(hasPhoneError, true);
  const hasAllChannelsError = mixedResult.errors.some(error => error.variableName === 'CHANNELS');
  assert.strictEqual(hasAllChannelsError, false);
});

// ---------------------------------------------------------------------------
// TEST GROUP 8: Inbound Serialization & Drain Before Shutdown (PR #104 Review Finding)
// ---------------------------------------------------------------------------
test('CMA-8: Message Serialization & Draining on Exit/Shutdown', async () => {
  // 8.1 Sequential Non-Overlapping Execution of Multiple Pasted Lines
  const inputStream = new PassThrough();
  const outputStream = new PassThrough();

  let activeCallbackCount = 0;
  let maxConcurrentCallbacks = 0;
  const executionOrder: string[] = [];

  const onUserMessageReceived = async (event: IncomingUserMessageEvent): Promise<void> => {
    activeCallbackCount++;
    maxConcurrentCallbacks = Math.max(maxConcurrentCallbacks, activeCallbackCount);

    // Simulate async AI/MCP processing duration
    await delay(60);

    executionOrder.push(event.textPayload || '');
    activeCallbackCount--;
  };

  const adapter = new ConsoleMessagingAdapter(onUserMessageReceived, {
    inputStream,
    outputStream,
  });

  await adapter.startConnection();

  // Send two lines in rapid succession (simulating pasting multiple lines)
  inputStream.write('line_1_beli_makan\n');
  inputStream.write('line_2_beli_minum\n');

  // Allow both tasks to completely drain
  await delay(180);

  assert.strictEqual(maxConcurrentCallbacks, 1, 'Callbacks must never overlap concurrently');
  assert.deepStrictEqual(executionOrder, ['line_1_beli_makan', 'line_2_beli_minum']);

  await adapter.stopConnection();

  // 8.2 Deliberately Blocked Callback Followed Immediately By 'exit'
  const blockedInputStream = new PassThrough();
  const blockedOutputStream = new PassThrough();

  let resolveBlockedCallback: (() => void) | null = null;
  let firstCallbackStarted = false;
  let firstCallbackCompleted = false;
  let exitRequested = false;

  const onBlockedMessageReceived = async (_event: IncomingUserMessageEvent): Promise<void> => {
    firstCallbackStarted = true;
    await new Promise<void>(resolve => {
      resolveBlockedCallback = resolve;
    });
    firstCallbackCompleted = true;
  };

  const drainAdapter = new ConsoleMessagingAdapter(onBlockedMessageReceived, {
    inputStream: blockedInputStream,
    outputStream: blockedOutputStream,
    onExitRequested: () => {
      exitRequested = true;
    },
  });

  await drainAdapter.startConnection();

  // Send normal message followed immediately by 'exit'
  blockedInputStream.write('catat_pengeluaran_penting\n');
  await delay(30);

  assert.strictEqual(firstCallbackStarted, true, 'First callback should be active and blocked');

  // Send 'exit' while callback is still blocked
  blockedInputStream.write('exit\n');
  await delay(50);

  // onExitRequested must NOT be called while the first callback is still in progress
  assert.strictEqual(exitRequested, false, 'onExitRequested must not be called while in-flight task is unresolved');
  assert.strictEqual(firstCallbackCompleted, false, 'First callback is still in-flight');

  // Now resolve the blocked callback
  resolveBlockedCallback!();
  await delay(50);

  // Both should now be finished cleanly in order
  assert.strictEqual(firstCallbackCompleted, true, 'First callback finished cleanly');
  assert.strictEqual(exitRequested, true, 'onExitRequested called only after in-flight callback resolved');
  assert.strictEqual(drainAdapter.getConnectionState(), 'idle', 'Adapter state is idle after exit drain');

  // 8.3 External stopConnection() drains currently in-flight work before completing
  const stopInputStream = new PassThrough();
  const stopOutputStream = new PassThrough();

  let resolveStopCallback: (() => void) | null = null;
  let stopTaskCompleted = false;

  const onStopBlockedMessage = async (_event: IncomingUserMessageEvent): Promise<void> => {
    await new Promise<void>(resolve => {
      resolveStopCallback = resolve;
    });
    stopTaskCompleted = true;
  };

  const externalStopAdapter = new ConsoleMessagingAdapter(onStopBlockedMessage, {
    inputStream: stopInputStream,
    outputStream: stopOutputStream,
  });

  await externalStopAdapter.startConnection();
  stopInputStream.write('long_running_financial_op\n');
  await delay(30);

  // Trigger stopConnection while operation is pending
  let stopConnectionFinished = false;
  const stopPromise = externalStopAdapter.stopConnection().then(() => {
    stopConnectionFinished = true;
  });

  await delay(50);
  assert.strictEqual(stopConnectionFinished, false, 'stopConnection must wait for in-flight operation to finish');

  // Release the pending operation
  resolveStopCallback!();
  await stopPromise;

  assert.strictEqual(stopTaskCompleted, true, 'In-flight operation completed before stopConnection returned');
  assert.strictEqual(stopConnectionFinished, true, 'stopConnection successfully finished after drain');
  assert.strictEqual(externalStopAdapter.getConnectionState(), 'idle');
});
