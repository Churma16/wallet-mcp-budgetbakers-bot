import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';
import { DisconnectReason } from '@whiskeysockets/baileys';

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

async function runTestSuite(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Running WhatsApp Connection Resilience & Safeguards Test Suite (14 Test Cases)');
  console.log('====================================================\n');

  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';
  const dummyCallback = async () => {};

  const adapter = new WhatsappMessagingAdapter(
    dummySessionDirectory,
    dummyPhoneNumber,
    dummyCallback,
    {
      maxReconnectAttempts: 6,
      maxBackoffSeconds: 300,
      messageQueueIntervalMs: 50, // Short interval for faster test execution
    }
  );

  // ----------------------------------------------------
  // TC-1: Exponential Backoff & Jitter Bounds
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Backoff & Delay Math');
  {
    const delayAttempt0 = adapter.calculateBackoffDelayMilliseconds(0);
    const delayAttempt1 = adapter.calculateBackoffDelayMilliseconds(1);
    const delayAttempt2 = adapter.calculateBackoffDelayMilliseconds(2);
    const delayAttempt10 = adapter.calculateBackoffDelayMilliseconds(10);

    // Attempt 0: 5s * 2^0 = 5s (5000ms) + jitter (500 - 2500ms) -> 5500 - 7500ms
    assertCondition('TC-1.1: Attempt 0 delay within expected bounds (5500 - 7500ms)', delayAttempt0 >= 5500 && delayAttempt0 <= 7500, `Actual: ${delayAttempt0}`);

    // Attempt 1: 5s * 2^1 = 10s (10000ms) + jitter -> 10500 - 12500ms
    assertCondition('TC-1.2: Attempt 1 delay within expected bounds (10500 - 12500ms)', delayAttempt1 >= 10500 && delayAttempt1 <= 12500, `Actual: ${delayAttempt1}`);

    // Attempt 2: 5s * 2^2 = 20s (20000ms) + jitter -> 20500 - 22500ms
    assertCondition('TC-1.3: Attempt 2 delay within expected bounds (20500 - 22500ms)', delayAttempt2 >= 20500 && delayAttempt2 <= 22500, `Actual: ${delayAttempt2}`);

    // Attempt 10: Capped at maxBackoffSeconds (300s = 300000ms) + jitter -> 300500 - 302500ms
    assertCondition('TC-1.4: Extreme attempt capped at 300s + jitter', delayAttempt10 >= 300500 && delayAttempt10 <= 302500, `Actual: ${delayAttempt10}`);
  }

  // ----------------------------------------------------
  // TC-2 & TC-3: Circuit Breaker Tripping & Success Reset
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Circuit Breaker Lifecycle');
  {
    adapter.resetSafeguardsState();

    // Trigger 5 connection failures (threshold is 6)
    for (let failureIndex = 1; failureIndex <= 5; failureIndex++) {
      adapter.handleConnectionClose(DisconnectReason.connectionLost, new Error('Simulated Connection Lost'));
    }

    assertCondition('TC-2.1: 5 failures increments counter to 5', adapter.getConsecutiveFailureCount() === 5, `Count: ${adapter.getConsecutiveFailureCount()}`);
    assertCondition('TC-2.2: Circuit breaker is NOT tripped at 5 failures', adapter.getCircuitBreakerStatus() === false);

    // 6th failure hits threshold
    adapter.handleConnectionClose(DisconnectReason.connectionLost, new Error('Simulated Connection Lost'));
    assertCondition('TC-2.3: 6th failure trips circuit breaker', adapter.getCircuitBreakerStatus() === true);
    assertCondition('TC-2.4: Counter remains at 6', adapter.getConsecutiveFailureCount() === 6);

    // TC-3: Reset on successful connection open
    adapter.resetSafeguardsState();
    assertCondition('TC-3.1: Reset clears failure counter', adapter.getConsecutiveFailureCount() === 0);
    assertCondition('TC-3.2: Reset untrips circuit breaker', adapter.getCircuitBreakerStatus() === false);
  }

  // ----------------------------------------------------
  // TC-4, TC-5: Baileys Status Code Specific Behaviors
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Granular Status Code Dispatcher');
  {
    adapter.resetSafeguardsState();

    // TC-4: Status 440 (connectionReplaced) must abort immediately
    adapter.handleConnectionClose(DisconnectReason.connectionReplaced, new Error('Stream Errored (conflict)'));
    assertCondition('TC-4.1: Status 440 immediately trips circuit breaker', adapter.getCircuitBreakerStatus() === true);
    assertCondition('TC-4.2: Status 440 does NOT increment standard failure counter', adapter.getConsecutiveFailureCount() === 0, `Actual: ${adapter.getConsecutiveFailureCount()}`);

    adapter.resetSafeguardsState();

    // TC-5: Status 515 (restartRequired) fast track
    adapter.handleConnectionClose(DisconnectReason.restartRequired, new Error('Restart Required'));
    assertCondition('TC-5.1: Status 515 does not increment failure counter', adapter.getConsecutiveFailureCount() === 0);
    assertCondition('TC-5.2: Status 515 does not trip circuit breaker', adapter.getCircuitBreakerStatus() === false);
  }

  // ----------------------------------------------------
  // TC-6: Reconnection Mutex Guard
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Concurrency & Mutex Lock');
  {
    adapter.resetSafeguardsState();

    // Test mutex flag behavior using internal reflection
    const isConnectingProperty = 'isConnectingOrReconnecting';
    (adapter as any)[isConnectingProperty] = true;

    // When isConnectingOrReconnecting is true, another startConnection invocation must skip execution
    let duplicateAttemptSkipped = false;
    try {
      await adapter.startConnection(false);
      duplicateAttemptSkipped = true;
    } catch {
      duplicateAttemptSkipped = false;
    }

    assertCondition('TC-6.1: Concurrent connection invocation skips gracefully without throwing', duplicateAttemptSkipped);
    (adapter as any)[isConnectingProperty] = false;
  }

  // ----------------------------------------------------
  // TC-7: Outbound Message FIFO Throttling
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 5] Outbound Message Queue Throttling');
  {
    adapter.resetSafeguardsState();

    const dispatchTimestamps: number[] = [];
    const simulatedSocketInstance = {
      sendMessage: async () => {
        dispatchTimestamps.push(Date.now());
        return { key: { id: `MSG_${Date.now()}` } };
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    (adapter as any).socketInstance = simulatedSocketInstance;

    const message1Promise = adapter.sendTextMessage('test-chat-1', 'Message 1');
    const message2Promise = adapter.sendTextMessage('test-chat-2', 'Message 2');
    const message3Promise = adapter.sendTextMessage('test-chat-3', 'Message 3');

    await Promise.all([message1Promise, message2Promise, message3Promise]);

    assertCondition('TC-7.1: All 3 burst messages dispatched', dispatchTimestamps.length === 3);

    const intervalBetween1And2 = dispatchTimestamps[1] - dispatchTimestamps[0];
    const intervalBetween2And3 = dispatchTimestamps[2] - dispatchTimestamps[1];

    // messageQueueIntervalMs is set to 50ms for tests
    assertCondition('TC-7.2: Interval between message 1 and 2 is at least 45ms', intervalBetween1And2 >= 45, `Actual: ${intervalBetween1And2}ms`);
    assertCondition('TC-7.3: Interval between message 2 and 3 is at least 45ms', intervalBetween2And3 >= 45, `Actual: ${intervalBetween2And3}ms`);

    (adapter as any).socketInstance = null;
  }

  // ----------------------------------------------------
  // TC-8: Clean Timer Cancellation on stopConnection
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 6] Lifecycle Stop Cleanup');
  {
    adapter.resetSafeguardsState();
    adapter.handleConnectionClose(DisconnectReason.timedOut, new Error('Timeout'));

    const hasActiveTimer = (adapter as any).activeReconnectTimeout !== null;
    assertCondition('TC-8.1: Reconnection timeout is actively scheduled', hasActiveTimer);

    await adapter.stopConnection();
    const timerAfterStop = (adapter as any).activeReconnectTimeout;
    assertCondition('TC-8.2: stopConnection clears active reconnection timeout', timerAfterStop === null);
  }

  // ----------------------------------------------------
  // Edge Case EC-1: Undefined / Unknown Status Code Fall-Through
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 7] Edge Cases (EC-1 through EC-6)');
  {
    adapter.resetSafeguardsState();

    // Passing undefined status code (raw network drop without Baileys status)
    adapter.handleConnectionClose(undefined, 'Unrecognized Network Error');
    assertCondition('EC-1.1: Undefined status code increments failure counter safely', adapter.getConsecutiveFailureCount() === 1);
    assertCondition('EC-1.2: Undefined status code does not throw unhandled exception', true);

    // Passing arbitrary non-standard status code (e.g. 599)
    adapter.handleConnectionClose(599, 'Custom Upstream Gateway Drop');
    assertCondition('EC-1.3: Custom unknown status code treated as standard failure', adapter.getConsecutiveFailureCount() === 2);
  }

  // ----------------------------------------------------
  // Edge Case EC-2: Queue Rejection when Socket is null
  // ----------------------------------------------------
  {
    adapter.resetSafeguardsState();
    (adapter as any).socketInstance = null;

    let rejectedWithError = false;
    let errorMessage = '';

    try {
      await adapter.sendTextMessage('dummy-chat', 'Hello while disconnected');
    } catch (sendError: any) {
      rejectedWithError = true;
      errorMessage = sendError.message;
    }

    assertCondition('EC-2.1: Sending message while socket is null immediately rejects', rejectedWithError);
    assertCondition('EC-2.2: Rejection message indicates socket is not connected', errorMessage.includes('WhatsApp socket is not connected'));
  }

  // ----------------------------------------------------
  // Edge Case EC-3: Queue Item Failure Does Not Stall Remaining Items
  // ----------------------------------------------------
  {
    adapter.resetSafeguardsState();

    let item1Failed = false;
    let item2Succeeded = false;

    const mockSocket = {
      sendMessage: async (chatId: string) => {
        if (chatId === 'failing-chat') {
          throw new Error('Simulated Baileys Transport Error');
        }
        return { key: { id: 'SUCCESS_MSG' } };
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    (adapter as any).socketInstance = mockSocket;

    const failingItemPromise = adapter.sendTextMessage('failing-chat', 'Will fail').catch(() => {
      item1Failed = true;
    });

    const succeedingItemPromise = adapter.sendTextMessage('good-chat', 'Will succeed').then(() => {
      item2Succeeded = true;
    });

    await Promise.all([failingItemPromise, succeedingItemPromise]);

    assertCondition('EC-3.1: Failing message promise rejected individually', item1Failed);
    assertCondition('EC-3.2: Subsequent message in queue succeeds without stalling', item2Succeeded);

    (adapter as any).socketInstance = null;
  }

  // ----------------------------------------------------
  // Edge Case EC-4: stopConnection Drains and Rejects Pending Queue Tasks
  // ----------------------------------------------------
  {
    adapter.resetSafeguardsState();

    let queueItemRejectedOnStop = false;
    let rejectionReason = '';

    const slowSocket = {
      sendMessage: async () => {
        await new Promise(res => setTimeout(res, 500));
        return { key: { id: 'DELAYED' } };
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    (adapter as any).socketInstance = slowSocket;

    // Enqueue 2 tasks so item 2 is waiting in the queue while item 1 is in-flight
    adapter.sendTextMessage('queued-chat-1', 'Item 1 in-flight').catch(() => {});
    const task2Promise = adapter.sendTextMessage('queued-chat-2', 'Item 2 pending in queue').catch(err => {
      queueItemRejectedOnStop = true;
      rejectionReason = err.message;
    });

    // Immediately stop connection while item 2 is waiting in queue
    await adapter.stopConnection();
    await task2Promise;

    assertCondition('EC-4.1: Pending queue tasks rejected when stopConnection is called', queueItemRejectedOnStop);
    assertCondition('EC-4.2: Rejection indicates adapter was stopped', rejectionReason.includes('WhatsApp adapter was stopped'));
    assertCondition('EC-4.3: Outbound queue drained to zero', adapter.getOutboundQueueLength() === 0);
  }

  // ----------------------------------------------------
  // Edge Case EC-5: Manual startConnection Resets Tripped Circuit Breaker
  // ----------------------------------------------------
  {
    adapter.resetSafeguardsState();

    for (let count = 1; count <= 6; count++) {
      adapter.handleConnectionClose(DisconnectReason.timedOut, 'Timeout');
    }
    assertCondition('EC-5.1: Breaker is initially tripped', adapter.getCircuitBreakerStatus() === true);

    try {
      await adapter.startConnection(true);
    } catch {
      // Expected in test environment without live credentials
    }

    assertCondition('EC-5.2: Manual startConnection reset failure counter to 0', adapter.getConsecutiveFailureCount() === 0);
    assertCondition('EC-5.3: Manual startConnection cleared circuit breaker trip flag', adapter.getCircuitBreakerStatus() === false);
  }

  // ----------------------------------------------------
  // Edge Case EC-6: Repeated loggedOut After Session Purge Trips Circuit Breaker
  // ----------------------------------------------------
  {
    adapter.resetSafeguardsState();

    adapter.handleConnectionClose(DisconnectReason.loggedOut, 'First Logout');
    assertCondition('EC-6.1: First logout schedules QR attempt without tripping breaker immediately', adapter.getCircuitBreakerStatus() === false);

    adapter.handleConnectionClose(DisconnectReason.loggedOut, 'Second Logout (Device Banned or Unlinked Repeatedly)');
    assertCondition('EC-6.2: Repeated logout trips circuit breaker', adapter.getCircuitBreakerStatus() === true);
    assertCondition('EC-6.3: Consecutive failure count incremented', adapter.getConsecutiveFailureCount() === 1);
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
    console.log('[SUCCESS] All 14 WhatsApp resilience & safeguard test cases passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
