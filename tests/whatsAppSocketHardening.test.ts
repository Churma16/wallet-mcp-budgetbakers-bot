import fs from 'fs';
import path from 'path';
import { WhatsappMessagingAdapter } from '../src/services/messaging/whatsappAdapter.js';

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
  console.log('[INFO] Running WhatsApp Socket Hardening & Typing Presence Test Suite (11 Test Cases)');
  console.log('====================================================\n');

  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';
  const dummyCallback = async () => {};

  // ----------------------------------------------------
  // TH-6: Static Verification of makeWASocket Hardened Options
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Baileys makeWASocket Hardened Configuration');
  {
    const adapterSourceFilePath = path.resolve('src/services/messaging/whatsappAdapter.ts');
    const adapterFileContent = fs.readFileSync(adapterSourceFilePath, 'utf-8');

    assertCondition(
      'TH-6.1: makeWASocket explicitly sets generateHighQualityLinkPreview: false',
      adapterFileContent.includes('generateHighQualityLinkPreview: false')
    );
    assertCondition(
      'TH-6.2: makeWASocket explicitly sets syncFullHistory: false',
      adapterFileContent.includes('syncFullHistory: false')
    );
    assertCondition(
      'TH-6.3: makeWASocket explicitly sets shouldSyncHistoryMessage: () => false',
      adapterFileContent.includes('shouldSyncHistoryMessage: () => false')
    );
    assertCondition(
      'TH-6.4: makeWASocket explicitly sets markOnlineOnConnect: false',
      adapterFileContent.includes('markOnlineOnConnect: false')
    );
    assertCondition(
      'TH-6.5: makeWASocket provides defensive getMessage callback',
      adapterFileContent.includes('getMessage: async () => undefined')
    );
  }

  // ----------------------------------------------------
  // TH-1, TH-2, TH-3, TH-4, TH-5: Core Typing Presence Lifecycle
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Typing Presence Debouncing Lifecycle');
  {
    const dispatchedPresenceEvents: Array<{ action: string; jid: string; timestamp: number }> = [];

    const mockSocket = {
      sendPresenceUpdate: async (action: string, jid: string) => {
        dispatchedPresenceEvents.push({ action, jid, timestamp: Date.now() });
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const cooldownPeriodMs = 200; // Fast cooldown for test execution
    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      {
        typingPresenceCooldownMs: cooldownPeriodMs,
      }
    );

    (adapter as any).socketInstance = mockSocket;

    // TH-1: Initial sendTypingPresence dispatches immediately
    await adapter.sendTypingPresence('user-1@s.whatsapp.net');
    assertCondition('TH-1.1: Initial typing presence dispatched', dispatchedPresenceEvents.length === 1);
    assertCondition(
      'TH-1.2: Timestamp recorded in cooldown map',
      adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net') !== undefined
    );

    // TH-2: Rapid successive calls within cooldown period are debounced / dropped
    await adapter.sendTypingPresence('user-1@s.whatsapp.net');
    await adapter.sendTypingPresence('user-1@s.whatsapp.net');
    assertCondition(
      'TH-2.1: Rapid successive presence calls suppressed within cooldown',
      dispatchedPresenceEvents.length === 1,
      `Actual events count: ${dispatchedPresenceEvents.length}`
    );

    // TH-3: Presence dispatches again after cooldown period elapses
    await new Promise(resolve => setTimeout(resolve, cooldownPeriodMs + 50));
    await adapter.sendTypingPresence('user-1@s.whatsapp.net');
    assertCondition(
      'TH-3.1: Presence dispatched after cooldown elapses',
      dispatchedPresenceEvents.length === 2,
      `Actual events count: ${dispatchedPresenceEvents.length}`
    );

    // TH-4: clearTypingPresence is never blocked by cooldown and always sends 'paused'
    await adapter.clearTypingPresence('user-1@s.whatsapp.net');
    assertCondition(
      'TH-4.1: clearTypingPresence dispatches paused immediately',
      dispatchedPresenceEvents.length === 3 && dispatchedPresenceEvents[2].action === 'paused'
    );

    // TH-5: stopConnection cleans up and resets timestamp map
    await adapter.sendTypingPresence('user-1@s.whatsapp.net');
    assertCondition(
      'TH-5.1: Presence timestamp present before stop',
      adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net') !== undefined
    );
    await adapter.stopConnection();
    assertCondition(
      'TH-5.2: stopConnection clears presence timestamp map',
      adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net') === undefined
    );
  }

  // ----------------------------------------------------
  // EC-1 through EC-5: Edge Cases
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Edge Cases (EC-1 through EC-5)');

  // EC-1: Per-JID Cooldown Isolation
  {
    const presenceEvents: Array<{ action: string; jid: string }> = [];
    const mockSocket = {
      sendPresenceUpdate: async (action: string, jid: string) => {
        presenceEvents.push({ action, jid });
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      { typingPresenceCooldownMs: 1000 }
    );
    (adapter as any).socketInstance = mockSocket;

    // Trigger User A
    await adapter.sendTypingPresence('user-a@s.whatsapp.net');
    assertCondition('EC-1.1: User A presence dispatched', presenceEvents.length === 1);

    // Trigger User B immediately while User A cooldown is active
    await adapter.sendTypingPresence('user-b@s.whatsapp.net');
    assertCondition(
      'EC-1.2: User B presence dispatched without being throttled by User A',
      presenceEvents.length === 2 && presenceEvents[1].jid === 'user-b@s.whatsapp.net'
    );
  }

  // EC-2: Timestamp Not Committed on Error
  {
    let shouldFail = true;
    const mockSocket = {
      sendPresenceUpdate: async () => {
        if (shouldFail) {
          throw new Error('Network Socket Disrupted');
        }
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      { typingPresenceCooldownMs: 5000 }
    );
    (adapter as any).socketInstance = mockSocket;

    // Call when socket throws
    await adapter.sendTypingPresence('error-user@s.whatsapp.net');
    assertCondition(
      'EC-2.1: Failed dispatch does not commit timestamp to cooldown map',
      adapter.getLastTypingPresenceTimestamp('error-user@s.whatsapp.net') === undefined
    );

    // Next call succeeds immediately without being blocked by previous failed attempt
    shouldFail = false;
    await adapter.sendTypingPresence('error-user@s.whatsapp.net');
    assertCondition(
      'EC-2.2: Next call dispatches and commits timestamp upon success',
      adapter.getLastTypingPresenceTimestamp('error-user@s.whatsapp.net') !== undefined
    );
  }

  // EC-3: clearTypingPresence Resets Timestamp
  {
    const presenceEvents: Array<{ action: string; jid: string }> = [];
    const mockSocket = {
      sendPresenceUpdate: async (action: string, jid: string) => {
        presenceEvents.push({ action, jid });
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      { typingPresenceCooldownMs: 10000 } // Long 10-second cooldown
    );
    (adapter as any).socketInstance = mockSocket;

    // Send first typing presence
    await adapter.sendTypingPresence('chat-x@s.whatsapp.net');
    assertCondition('EC-3.1: First typing presence sent', presenceEvents.length === 1);

    // Clear presence when done processing
    await adapter.clearTypingPresence('chat-x@s.whatsapp.net');
    assertCondition(
      'EC-3.2: Cooldown map entry deleted on pause',
      adapter.getLastTypingPresenceTimestamp('chat-x@s.whatsapp.net') === undefined
    );

    // Rapid second incoming message from user sends typing presence immediately despite long cooldown
    await adapter.sendTypingPresence('chat-x@s.whatsapp.net');
    assertCondition(
      'EC-3.3: Subsequent typing presence dispatches immediately after previous pause',
      presenceEvents.length === 3 && presenceEvents[2].action === 'composing'
    );
  }

  // EC-4: Zero Cooldown Configuration Support
  {
    let presenceDispatchCount = 0;
    const mockSocket = {
      sendPresenceUpdate: async () => {
        presenceDispatchCount++;
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      { typingPresenceCooldownMs: 0 } // Explicitly disabled cooldown
    );
    (adapter as any).socketInstance = mockSocket;

    await adapter.sendTypingPresence('user-zero@s.whatsapp.net');
    await adapter.sendTypingPresence('user-zero@s.whatsapp.net');
    await adapter.sendTypingPresence('user-zero@s.whatsapp.net');

    assertCondition(
      'EC-4.1: With cooldownMs = 0, all presence updates dispatch without suppression',
      presenceDispatchCount === 3,
      `Actual dispatches: ${presenceDispatchCount}`
    );
  }

  // EC-5: Falsy / Empty JID Guard
  {
    let socketCalled = false;
    const mockSocket = {
      sendPresenceUpdate: async () => {
        socketCalled = true;
      },
      ev: { removeAllListeners: () => {} },
      end: () => {},
    };

    const adapter = new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback
    );
    (adapter as any).socketInstance = mockSocket;

    await adapter.sendTypingPresence('');
    await adapter.sendTypingPresence('   ');
    await adapter.clearTypingPresence('');
    await adapter.clearTypingPresence('   ');

    assertCondition(
      'EC-5.1: Empty or whitespace JID calls return early without invoking socket or crashing',
      socketCalled === false
    );
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
    console.log('[SUCCESS] All 11 WhatsApp socket hardening & typing presence test cases passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
