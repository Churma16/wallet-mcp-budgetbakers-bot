import { PassThrough } from 'node:stream';
import { ConsoleMessagingAdapter } from '../src/services/messaging/consoleAdapter.js';
import { MessagingGatewayService } from '../src/services/messaging/messagingGatewayService.js';
import { IncomingUserMessageEvent } from '../src/services/messaging/types.js';
import {
  validateApplicationConfiguration,
  ApplicationEnvironmentConfiguration,
} from '../src/config/environmentConfig.js';

interface AssertionStatistics {
  totalCount: number;
  passedCount: number;
  failedCount: number;
}

const testStatistics: AssertionStatistics = {
  totalCount: 0,
  passedCount: 0,
  failedCount: 0,
};

function assertCondition(testCaseIdentifier: string, conditionMet: boolean, failureDetail?: string): void {
  testStatistics.totalCount++;
  if (conditionMet) {
    testStatistics.passedCount++;
    console.log(`  [PASS] ${testCaseIdentifier}`);
  } else {
    testStatistics.failedCount++;
    console.error(`  [FAIL] ${testCaseIdentifier}${failureDetail ? ` -> ${failureDetail}` : ''}`);
  }
}

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

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running Console Messaging Adapter Test Suite (Issue #16)');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // TEST GROUP 1: Adapter Initialization and Defaults
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Adapter Initialization & Defaults');
  {
    const dummyCallback = async (_event: IncomingUserMessageEvent): Promise<void> => {};
    const adapter = new ConsoleMessagingAdapter(dummyCallback);

    assertCondition('CMA-1.1: Channel name is "console"', adapter.channelName === 'console');
    assertCondition('CMA-1.2: Initial connection state is "idle"', adapter.getConnectionState() === 'idle');
    assertCondition('CMA-1.3: Default senderIdentifier is "console_user"', adapter.getSenderIdentifier() === 'console_user');
    assertCondition('CMA-1.4: Default chatIdentifier is "console"', adapter.getChatIdentifier() === 'console');

    const customAdapter = new ConsoleMessagingAdapter(dummyCallback, {
      senderIdentifier: 'custom_admin',
      chatIdentifier: 'custom_terminal',
      promptPrefix: 'CLI> ',
    });
    assertCondition('CMA-1.5: Custom senderIdentifier is respected', customAdapter.getSenderIdentifier() === 'custom_admin');
    assertCondition('CMA-1.6: Custom chatIdentifier is respected', customAdapter.getChatIdentifier() === 'custom_terminal');
  }

  // ----------------------------------------------------
  // TEST GROUP 2: Lifecycle (startConnection & stopConnection)
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Adapter Lifecycle');
  {
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

    assertCondition('CMA-2.1: Before start, state is "idle"', adapter.getConnectionState() === 'idle');

    await adapter.startConnection();
    assertCondition('CMA-2.2: After start, state is "connected"', adapter.getConnectionState() === 'connected');
    assertCondition(
      'CMA-2.3: Start banner is written to output',
      capturedOutput.includes('Console messaging adapter active')
    );

    await adapter.stopConnection();
    assertCondition('CMA-2.4: After stop, state returns to "idle"', adapter.getConnectionState() === 'idle');
  }

  // ----------------------------------------------------
  // TEST GROUP 3: Message Ingestion & Event Dispatching
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Inbound Message Processing');
  {
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

    assertCondition('CMA-3.1: Exactly 1 event received', receivedEvents.length === 1);
    assertCondition('CMA-3.2: Event channel is "console"', receivedEvents[0]?.channel === 'console');
    assertCondition('CMA-3.3: Event senderIdentifier is "console_user"', receivedEvents[0]?.senderIdentifier === 'console_user');
    assertCondition('CMA-3.4: Event chatIdentifier is "console"', receivedEvents[0]?.chatIdentifier === 'console');
    assertCondition('CMA-3.5: Event messageType is "text"', receivedEvents[0]?.messageType === 'text');
    assertCondition(
      'CMA-3.6: Event textPayload matches input text',
      receivedEvents[0]?.textPayload === 'beli kopi starbucks 50rb'
    );

    // Empty and whitespace lines should be ignored
    inputStream.write('\n');
    inputStream.write('   \t  \n');
    await delay(50);
    assertCondition('CMA-3.7: Blank lines are ignored (event count remains 1)', receivedEvents.length === 1);

    // Send another line with surrounding whitespace
    inputStream.write('   cek saldo   \n');
    await delay(50);
    assertCondition('CMA-3.8: Second message received', receivedEvents.length === 2);
    assertCondition('CMA-3.9: Text payload is trimmed', receivedEvents[1]?.textPayload === 'cek saldo');

    await adapter.stopConnection();
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Outbound Messaging & Presence
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Outbound Messaging & Presence');
  {
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
    assertCondition(
      'CMA-4.1: sendTextMessage writes text to outputStream',
      capturedOutput.includes('Transaksi sebesar Rp 50.000 berhasil dicatat.')
    );

    capturedOutput = '';
    await adapter.sendBroadcastNotification('Pengingat sinkronisasi email berhasil.');
    assertCondition(
      'CMA-4.2: sendBroadcastNotification writes notification to outputStream',
      capturedOutput.includes('Pengingat sinkronisasi email berhasil.')
    );

    // Typing presence methods should execute cleanly without throwing
    let presenceFailed = false;
    try {
      await adapter.sendTypingPresence('console');
      await adapter.clearTypingPresence('console');
    } catch {
      presenceFailed = true;
    }
    assertCondition('CMA-4.3: sendTypingPresence and clearTypingPresence complete cleanly', !presenceFailed);

    await adapter.stopConnection();
  }

  // ----------------------------------------------------
  // TEST GROUP 5: Interactive Exit & Stream Termination
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 5] Interactive Exit Commands & Stream Termination');
  {
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

    assertCondition('CMA-5.1: Typing "exit" triggers onExitRequested', exitCallbackCalled);
    assertCondition('CMA-5.2: Adapter state transitions to "idle" after exit', adapter.getConnectionState() === 'idle');

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

    assertCondition('CMA-5.3: Typing "QUIT" (case-insensitive) triggers onExitRequested', quitCallbackCalled);
    assertCondition('CMA-5.4: Adapter state transitions to "idle" after quit', quitAdapter.getConnectionState() === 'idle');

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

    assertCondition('CMA-5.5: Stream EOF triggers onExitRequested', closeCallbackCalled);
    assertCondition('CMA-5.6: Adapter state is "idle" after stream close', closeAdapter.getConnectionState() === 'idle');
  }

  // ----------------------------------------------------
  // TEST GROUP 6: MessagingGatewayService Integration
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 6] MessagingGatewayService Integration');
  {
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

    assertCondition('CMA-6.1: Console adapter is registered in gateway', gateway.getActiveChannels().includes('console'));
    assertCondition('CMA-6.2: Initial gateway state for console is idle', gateway.getAdapterState('console') === 'idle');

    await gateway.startAll();
    assertCondition('CMA-6.3: Gateway reports console is connected', gateway.isChannelConnected('console'));
    assertCondition('CMA-6.4: Console is in getConnectedChannels()', gateway.getConnectedChannels().includes('console'));

    capturedOutput = '';
    await gateway.sendMessage('console', 'console', 'Pesan lewat gateway.');
    assertCondition('CMA-6.5: gateway.sendMessage dispatches to console output', capturedOutput.includes('Pesan lewat gateway.'));

    capturedOutput = '';
    await gateway.broadcastNotification('Notifikasi broadcast lewat gateway.');
    assertCondition(
      'CMA-6.6: gateway.broadcastNotification reaches console adapter',
      capturedOutput.includes('Notifikasi broadcast lewat gateway.')
    );

    await gateway.stopAll();
    assertCondition('CMA-6.7: gateway.stopAll marks console as idle', gateway.getAdapterState('console') === 'idle');
    assertCondition('CMA-6.8: Adapter itself reports idle', adapter.getConnectionState() === 'idle');
  }

  // ----------------------------------------------------
  // TEST GROUP 7: Configuration & Startup Validation
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 7] Configuration & Startup Validation (Issue #16 AC)');
  {
    // 7.1 Console-only mode without WhatsApp or Telegram credentials
    const consoleOnlyConfig = createBaseConfiguration({
      enabledMessengerChannels: ['console'],
      allowedPhoneNumber: '',
      telegramBotToken: '',
      telegramAllowedUserId: '',
    });

    const validationResult = validateApplicationConfiguration(consoleOnlyConfig);
    assertCondition('CMA-7.1: Console-only configuration is valid', validationResult.isValid);
    assertCondition('CMA-7.2: Zero validation errors in console-only mode', validationResult.errors.length === 0);

    // 7.2 No channels enabled -> must fail validation
    const noChannelsConfig = createBaseConfiguration({
      enabledMessengerChannels: [],
    });
    const noChannelsResult = validateApplicationConfiguration(noChannelsConfig);
    assertCondition('CMA-7.3: Empty channels list fails validation', !noChannelsResult.isValid);
    const hasChannelsError = noChannelsResult.errors.some(error => error.variableName === 'ENABLED_MESSENGER_CHANNELS');
    assertCondition('CMA-7.4: Reports ENABLED_MESSENGER_CHANNELS error', hasChannelsError);

    // 7.3 WhatsApp enabled without phone number, but console enabled
    const mixedConfig = createBaseConfiguration({
      enabledMessengerChannels: ['whatsapp', 'console'],
      allowedPhoneNumber: '',
    });
    const mixedResult = validateApplicationConfiguration(mixedConfig);
    assertCondition('CMA-7.5: WhatsApp without phone still reports ALLOWED_PHONE_NUMBER error', !mixedResult.isValid);
    const hasPhoneError = mixedResult.errors.some(error => error.variableName === 'ALLOWED_PHONE_NUMBER');
    assertCondition('CMA-7.6: Specifically complains about ALLOWED_PHONE_NUMBER', hasPhoneError);
    // But CHANNELS error should NOT be triggered because console is valid
    const hasAllChannelsError = mixedResult.errors.some(error => error.variableName === 'CHANNELS');
    assertCondition('CMA-7.7: Does not claim all channels are invalid when console is present', !hasAllChannelsError);
  }

  // ----------------------------------------------------
  // TEST SUMMARY
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(`[TEST SUMMARY] Total: ${testStatistics.totalCount} | Passed: ${testStatistics.passedCount} | Failed: ${testStatistics.failedCount}`);
  console.log('====================================================\n');

  if (testStatistics.failedCount > 0) {
    process.exit(1);
  }
}

runTestSuite().catch(unhandledError => {
  console.error('[FATAL] Unhandled error in test suite:', unhandledError);
  process.exit(1);
});
