import { MessagingGatewayService } from '../src/services/messaging/messagingGatewayService.js';
import {
  MessagingAdapter,
  SupportedMessengerChannel,
} from '../src/services/messaging/types.js';

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

class MockMessagingAdapter implements MessagingAdapter {
  public startCallCount: number = 0;
  public stopCallCount: number = 0;
  public sentMessages: Array<{ targetChatIdentifier: string; messageText: string }> = [];
  public broadcastMessages: string[] = [];

  constructor(
    public readonly channelName: SupportedMessengerChannel,
    public shouldFailStart: boolean = false,
    public failureError: Error = new Error('Simulated adapter failure')
  ) {}

  public async startConnection(): Promise<void> {
    this.startCallCount++;
    if (this.shouldFailStart) {
      throw this.failureError;
    }
  }

  public async stopConnection(): Promise<void> {
    this.stopCallCount++;
  }

  public async sendTextMessage(targetChatIdentifier: string, messageText: string): Promise<void> {
    this.sentMessages.push({ targetChatIdentifier, messageText });
  }

  public async sendTypingPresence(_targetChatIdentifier: string): Promise<void> {}
  public async clearTypingPresence(_targetChatIdentifier: string): Promise<void> {}

  public async sendBroadcastNotification(messageText: string): Promise<void> {
    this.broadcastMessages.push(messageText);
  }
}

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running Messaging Gateway Resilience & Partial Startup Test Suite');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // TEST GROUP 1: Registration and Initial State
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Registration & State Queries');
  {
    const gateway = new MessagingGatewayService();
    const whatsappMock = new MockMessagingAdapter('whatsapp');
    const telegramMock = new MockMessagingAdapter('telegram');

    gateway.registerAdapter(whatsappMock);
    gateway.registerAdapter(telegramMock);

    assertCondition('GW-1.1: Registered channels count is 2', gateway.getActiveChannels().length === 2);
    assertCondition('GW-1.2: Initial state of WhatsApp is idle', gateway.getAdapterState('whatsapp') === 'idle');
    assertCondition('GW-1.3: Initial state of Telegram is idle', gateway.getAdapterState('telegram') === 'idle');
    assertCondition('GW-1.4: Connected channels is initially empty', gateway.getConnectedChannels().length === 0);
  }

  // ----------------------------------------------------
  // TEST GROUP 2: Partial Startup Failure (Degraded Mode)
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Partial Startup Failure & Degraded Mode');
  {
    const gateway = new MessagingGatewayService({
      maxBackgroundReconnectAttempts: 3,
      backgroundReconnectBaseDelayMs: 20, // Short delay for test
      backgroundReconnectMaxDelayMs: 100,
    });

    const healthyWhatsApp = new MockMessagingAdapter('whatsapp', false);
    const brokenTelegram = new MockMessagingAdapter('telegram', true, new Error('getaddrinfo EAI_AGAIN'));

    gateway.registerAdapter(healthyWhatsApp);
    gateway.registerAdapter(brokenTelegram);

    // startAll() MUST NOT throw when at least one adapter succeeds
    let errorThrown: unknown = null;
    try {
      await gateway.startAll();
    } catch (error) {
      errorThrown = error;
    }

    assertCondition('GW-2.1: startAll() does NOT reject when one adapter fails and one succeeds', errorThrown === null);
    assertCondition('GW-2.2: Healthy WhatsApp adapter is connected', gateway.isChannelConnected('whatsapp') === true);
    assertCondition('GW-2.3: Broken Telegram adapter is in reconnecting state', gateway.getAdapterState('telegram') === 'reconnecting');
    assertCondition('GW-2.4: Connected channels array contains only WhatsApp', gateway.getConnectedChannels().length === 1 && gateway.getConnectedChannels()[0] === 'whatsapp');
    assertCondition('GW-2.5: Telegram has an active background reconnect timer scheduled', gateway.hasActiveReconnectTimer('telegram') === true);

    // Message dispatch to healthy channel succeeds
    await gateway.sendMessage('whatsapp', '6281234567890', 'Hello WhatsApp!');
    assertCondition('GW-2.6: Dispatched message to connected WhatsApp adapter', healthyWhatsApp.sentMessages.length === 1);

    // Message dispatch to reconnecting channel rejects
    let sendError: unknown = null;
    try {
      await gateway.sendMessage('telegram', '123456', 'Hello Telegram!');
    } catch (error) {
      sendError = error;
    }
    assertCondition('GW-2.7: Sending to reconnecting Telegram adapter throws descriptive error', sendError instanceof Error && sendError.message.includes('not connected'));

    await gateway.stopAll();
  }

  // ----------------------------------------------------
  // TEST GROUP 3: Complete Startup Failure
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Total Startup Failure (All Channels Dead)');
  {
    const gateway = new MessagingGatewayService();
    const brokenWhatsApp = new MockMessagingAdapter('whatsapp', true, new Error('WhatsApp network offline'));
    const brokenTelegram = new MockMessagingAdapter('telegram', true, new Error('Telegram token invalid'));

    gateway.registerAdapter(brokenWhatsApp);
    gateway.registerAdapter(brokenTelegram);

    let fatalErrorCaught: unknown = null;
    try {
      await gateway.startAll();
    } catch (error) {
      fatalErrorCaught = error;
    }

    assertCondition('GW-3.1: startAll() throws fatal error when ALL adapters fail', fatalErrorCaught instanceof Error && fatalErrorCaught.message.includes('All registered messaging adapters failed'));
    assertCondition('GW-3.2: WhatsApp state marked as failed', gateway.getAdapterState('whatsapp') === 'failed');
    assertCondition('GW-3.3: Telegram state marked as failed', gateway.getAdapterState('telegram') === 'failed');
    assertCondition('GW-3.4: Connected channels is empty', gateway.getConnectedChannels().length === 0);

    await gateway.stopAll();
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Background Reconnection Recovery
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Background Reconnection Recovery');
  {
    const gateway = new MessagingGatewayService({
      maxBackgroundReconnectAttempts: 5,
      backgroundReconnectBaseDelayMs: 30, // 30ms for quick recovery
      backgroundReconnectMaxDelayMs: 100,
    });

    const healthyWhatsApp = new MockMessagingAdapter('whatsapp', false);
    const recoveringTelegram = new MockMessagingAdapter('telegram', true, new Error('Temporary DNS failure'));

    gateway.registerAdapter(healthyWhatsApp);
    gateway.registerAdapter(recoveringTelegram);

    await gateway.startAll();
    assertCondition('GW-4.1: Telegram initially failed and in reconnecting state', gateway.getAdapterState('telegram') === 'reconnecting');

    // Simulate recovery: Telegram network comes back online
    recoveringTelegram.shouldFailStart = false;

    // Wait for background reconnection to complete (poll up to 1500ms)
    const pollStartTime = Date.now();
    while (!gateway.isChannelConnected('telegram') && Date.now() - pollStartTime < 1500) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    assertCondition('GW-4.2: Telegram successfully recovered via background reconnection', gateway.isChannelConnected('telegram') === true);
    assertCondition('GW-4.3: Both WhatsApp and Telegram are now connected', gateway.getConnectedChannels().length === 2);
    assertCondition('GW-4.4: Telegram can now receive messages after recovery', gateway.isChannelConnected('telegram') === true);

    await gateway.sendMessage('telegram', '123456', 'Welcome back Telegram!');
    assertCondition('GW-4.5: Dispatched message to recovered Telegram adapter', recoveringTelegram.sentMessages.length === 1);

    await gateway.stopAll();

  }

  // ----------------------------------------------------
  // TEST GROUP 5: Broadcast Notification Filtering
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 5] Broadcast Notification Isolation');
  {
    const gateway = new MessagingGatewayService({
      maxBackgroundReconnectAttempts: 2,
      backgroundReconnectBaseDelayMs: 500,
      backgroundReconnectMaxDelayMs: 1000,
    });

    const activeWhatsApp = new MockMessagingAdapter('whatsapp', false);
    const offlineTelegram = new MockMessagingAdapter('telegram', true);

    gateway.registerAdapter(activeWhatsApp);
    gateway.registerAdapter(offlineTelegram);

    await gateway.startAll();

    // Broadcast should only reach connected WhatsApp, not offline Telegram
    await gateway.broadcastNotification('Notification for active channels');
    assertCondition('GW-5.1: Broadcast reached connected WhatsApp', activeWhatsApp.broadcastMessages.length === 1);
    assertCondition('GW-5.2: Broadcast skipped disconnected Telegram', offlineTelegram.broadcastMessages.length === 0);

    await gateway.stopAll();
  }

  // ----------------------------------------------------
  // TEST GROUP 6: Graceful Shutdown
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 6] Graceful Shutdown Lifecycle');
  {
    const gateway = new MessagingGatewayService({
      maxBackgroundReconnectAttempts: 5,
      backgroundReconnectBaseDelayMs: 10000, // Long delay
      backgroundReconnectMaxDelayMs: 60000,
    });

    const activeWhatsApp = new MockMessagingAdapter('whatsapp', false);
    const offlineTelegram = new MockMessagingAdapter('telegram', true);

    gateway.registerAdapter(activeWhatsApp);
    gateway.registerAdapter(offlineTelegram);

    await gateway.startAll();
    assertCondition('GW-6.1: Active reconnect timer exists for Telegram before stop', gateway.hasActiveReconnectTimer('telegram') === true);

    await gateway.stopAll();
    assertCondition('GW-6.2: stopAll() cancels background reconnect timer', gateway.hasActiveReconnectTimer('telegram') === false);
    assertCondition('GW-6.3: WhatsApp stopConnection called', activeWhatsApp.stopCallCount === 1);
    assertCondition('GW-6.4: Telegram stopConnection called', offlineTelegram.stopCallCount === 1);
    assertCondition('GW-6.5: WhatsApp state reset to idle', gateway.getAdapterState('whatsapp') === 'idle');
    assertCondition('GW-6.6: Telegram state reset to idle', gateway.getAdapterState('telegram') === 'idle');
  }

  // ----------------------------------------------------
  // Summary
  // ----------------------------------------------------
  console.log('\n====================================================');
  console.log(`[TEST SUMMARY] Total: ${testStatistics.totalCount} | Passed: ${testStatistics.passedCount} | Failed: ${testStatistics.failedCount}`);
  console.log('====================================================');

  if (testStatistics.failedCount > 0) {
    process.exit(1);
  } else {
    console.log('[SUCCESS] All Messaging Gateway resilience test cases passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
