import { describe, expect, it, vi, beforeEach } from 'vitest';
import makeWASocket, {
  DisconnectReason,
  type proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { WhatsappMessagingAdapter } from '../src/gateway/whatsapp.js';

vi.mock('@whiskeysockets/baileys', async importOriginal => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return {
    ...actual,
    default: vi.fn(() => ({
      end: vi.fn(),
      ev: {
        on: vi.fn(),
        removeAllListeners: vi.fn(),
      },
      user: { id: '6281234567890:1@s.whatsapp.net' },
    })),
    useMultiFileAuthState: vi.fn(async () => ({
      saveCreds: vi.fn(),
      state: { creds: {}, keys: {} },
    })),
  };
});

describe('WhatsappMessagingAdapter resilience and safeguards', () => {
  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';
  const dummyCallback = async () => {};

  function createTestAdapter(overrides?: Record<string, unknown>): WhatsappMessagingAdapter {
    return new WhatsappMessagingAdapter(
      dummySessionDirectory,
      dummyPhoneNumber,
      dummyCallback,
      {
        maxReconnectAttempts: 6,
        maxBackoffSeconds: 300,
        messageQueueIntervalMs: 50,
        maxMediaDownloadBytes: 5 * 1024 * 1024,
        ...overrides,
      }
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('configuration and defaults', () => {
    it('sets default max media download bytes and respects custom overrides', () => {
      const defaultAdapter = new WhatsappMessagingAdapter(dummySessionDirectory, dummyPhoneNumber, dummyCallback);
      const customAdapter = createTestAdapter({ maxMediaDownloadBytes: 5 * 1024 * 1024 });

      expect(defaultAdapter.getMaxMediaDownloadBytes()).toBe(10 * 1024 * 1024);
      expect(customAdapter.getMaxMediaDownloadBytes()).toBe(5 * 1024 * 1024);
    });
  });

  describe('exponential backoff math and jitter bounds', () => {
    const adapter = createTestAdapter();

    it('calculates attempt 0 delay within expected bounds (5500 - 7500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(0);
      expect(delay).toBeGreaterThanOrEqual(5500);
      expect(delay).toBeLessThanOrEqual(7500);
    });

    it('calculates attempt 1 delay within expected bounds (10500 - 12500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(1);
      expect(delay).toBeGreaterThanOrEqual(10500);
      expect(delay).toBeLessThanOrEqual(12500);
    });

    it('calculates attempt 2 delay within expected bounds (20500 - 22500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(2);
      expect(delay).toBeGreaterThanOrEqual(20500);
      expect(delay).toBeLessThanOrEqual(22500);
    });

    it('caps high attempt delay at maxBackoffSeconds plus jitter', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(10);
      expect(delay).toBeGreaterThanOrEqual(300500);
      expect(delay).toBeLessThanOrEqual(302500);
    });
  });

  describe('circuit breaker lifecycle', () => {
    it('increments failure counter, trips at threshold, and resets on success', () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      for (let failureIndex = 1; failureIndex <= 5; failureIndex++) {
        adapter.handleConnectionClose(DisconnectReason.connectionLost, new Error('Simulated Connection Lost'));
      }

      expect(adapter.getConsecutiveFailureCount()).toBe(5);
      expect(adapter.getCircuitBreakerStatus()).toBe(false);

      // 6th failure hits threshold
      adapter.handleConnectionClose(DisconnectReason.connectionLost, new Error('Simulated Connection Lost'));
      expect(adapter.getCircuitBreakerStatus()).toBe(true);
      expect(adapter.getConsecutiveFailureCount()).toBe(6);

      // Reset on successful connection
      adapter.resetSafeguardsState();
      expect(adapter.getConsecutiveFailureCount()).toBe(0);
      expect(adapter.getCircuitBreakerStatus()).toBe(false);
    });
  });

  describe('granular status code dispatcher', () => {
    it('aborts immediately and trips circuit breaker on DisconnectReason.connectionReplaced (440)', () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      adapter.handleConnectionClose(DisconnectReason.connectionReplaced, new Error('Stream Errored (conflict)'));
      expect(adapter.getCircuitBreakerStatus()).toBe(true);
      expect(adapter.getConsecutiveFailureCount()).toBe(0);
    });

    it('fast-tracks DisconnectReason.restartRequired (515) without incrementing failure counter or tripping breaker', async () => {
      vi.useFakeTimers();
      try {
        const adapter = createTestAdapter();
        adapter.resetSafeguardsState();

        adapter.handleConnectionClose(DisconnectReason.restartRequired, new Error('Restart Required'));
        expect(adapter.getConsecutiveFailureCount()).toBe(0);
        expect(adapter.getCircuitBreakerStatus()).toBe(false);
        expect((adapter as unknown as { activeReconnectTimeout: unknown }).activeReconnectTimeout).not.toBeNull();

        await adapter.stopConnection();
        expect((adapter as unknown as { activeReconnectTimeout: unknown }).activeReconnectTimeout).toBeNull();

        await vi.runAllTimersAsync();
        expect(vi.mocked(makeWASocket).mock.calls).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('concurrency and mutex locks', () => {
    it('skips concurrent startConnection executions when isConnectingOrReconnecting is true', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      (adapter as unknown as { isConnectingOrReconnecting: boolean }).isConnectingOrReconnecting = true;

      await expect(adapter.startConnection(false)).resolves.toBeUndefined();

      (adapter as unknown as { isConnectingOrReconnecting: boolean }).isConnectingOrReconnecting = false;
    });
  });

  describe('outbound message queue throttling', () => {
    it('dispatches burst messages in FIFO order honoring queue interval throttling', async () => {
      const adapter = createTestAdapter();
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

      (adapter as unknown as { socketInstance: typeof simulatedSocketInstance | null }).socketInstance = simulatedSocketInstance;

      const message1Promise = adapter.sendTextMessage('test-chat-1', 'Message 1');
      const message2Promise = adapter.sendTextMessage('test-chat-2', 'Message 2');
      const message3Promise = adapter.sendTextMessage('test-chat-3', 'Message 3');

      await Promise.all([message1Promise, message2Promise, message3Promise]);

      expect(dispatchTimestamps).toHaveLength(3);
      const intervalBetween1And2 = dispatchTimestamps[1] - dispatchTimestamps[0];
      const intervalBetween2And3 = dispatchTimestamps[2] - dispatchTimestamps[1];

      expect(intervalBetween1And2).toBeGreaterThanOrEqual(45);
      expect(intervalBetween2And3).toBeGreaterThanOrEqual(45);

      (adapter as unknown as { socketInstance: typeof simulatedSocketInstance | null }).socketInstance = null;
    });
  });

  describe('lifecycle stop cleanup', () => {
    it('clears active reconnection timers when stopConnection is called', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();
      adapter.handleConnectionClose(DisconnectReason.timedOut, new Error('Timeout'));

      expect((adapter as unknown as { activeReconnectTimeout: unknown }).activeReconnectTimeout).not.toBeNull();

      await adapter.stopConnection();
      expect((adapter as unknown as { activeReconnectTimeout: unknown }).activeReconnectTimeout).toBeNull();
    });
  });

  describe('edge cases and error conditions', () => {
    it('handles undefined and custom status codes gracefully as standard failures', () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      adapter.handleConnectionClose(undefined, 'Unrecognized Network Error');
      expect(adapter.getConsecutiveFailureCount()).toBe(1);

      adapter.handleConnectionClose(599, 'Custom Upstream Gateway Drop');
      expect(adapter.getConsecutiveFailureCount()).toBe(2);
    });

    it('rejects outbound messages immediately when socket is disconnected', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();
      (adapter as unknown as { socketInstance: unknown }).socketInstance = null;

      await expect(
        adapter.sendTextMessage('dummy-chat', 'Hello while disconnected')
      ).rejects.toThrow(/WhatsApp socket is not connected/);
    });

    it('rejects failing message promises individually without stalling the queue', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

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

      (adapter as unknown as { socketInstance: typeof mockSocket | null }).socketInstance = mockSocket;

      const failingItemPromise = adapter.sendTextMessage('failing-chat', 'Will fail');
      const succeedingItemPromise = adapter.sendTextMessage('good-chat', 'Will succeed');

      await expect(failingItemPromise).rejects.toThrow(/Simulated Baileys Transport Error/);
      await expect(succeedingItemPromise).resolves.toBeUndefined();

      (adapter as unknown as { socketInstance: typeof mockSocket | null }).socketInstance = null;
    });

    it('drains and rejects pending queue tasks when stopConnection is called', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      const slowSocket = {
        sendMessage: async () => {
          await new Promise(res => setTimeout(res, 500));
          return { key: { id: 'DELAYED' } };
        },
        ev: { removeAllListeners: () => {} },
        end: () => {},
      };

      (adapter as unknown as { socketInstance: typeof slowSocket | null }).socketInstance = slowSocket;

      adapter.sendTextMessage('queued-chat-1', 'Item 1 in-flight').catch(() => {});
      const task2Promise = adapter.sendTextMessage('queued-chat-2', 'Item 2 pending in queue');

      await adapter.stopConnection();

      await expect(task2Promise).rejects.toThrow(/WhatsApp adapter was stopped/);
      expect(adapter.getOutboundQueueLength()).toBe(0);
    });

    it('resets tripped circuit breaker and failure counters upon manual startConnection', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      for (let count = 1; count <= 6; count++) {
        adapter.handleConnectionClose(DisconnectReason.timedOut, 'Timeout');
      }
      expect(adapter.getCircuitBreakerStatus()).toBe(true);

      await adapter.startConnection(true);

      expect(vi.mocked(useMultiFileAuthState)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(makeWASocket)).toHaveBeenCalledTimes(1);
      expect(adapter.getConsecutiveFailureCount()).toBe(0);
      expect(adapter.getCircuitBreakerStatus()).toBe(false);
    });

    it('trips circuit breaker on repeated logout after session purge', async () => {
      const adapter = createTestAdapter();
      adapter.resetSafeguardsState();

      adapter.handleConnectionClose(DisconnectReason.loggedOut, 'First Logout');
      expect(adapter.getCircuitBreakerStatus()).toBe(false);

      adapter.handleConnectionClose(DisconnectReason.loggedOut, 'Second Logout (Device Banned or Unlinked Repeatedly)');
      expect(adapter.getCircuitBreakerStatus()).toBe(true);
      expect(adapter.getConsecutiveFailureCount()).toBe(1);

      await adapter.stopConnection();
    });
  });

  describe('whitelist inbound authorization gates (fail-closed)', () => {
    it('drops inbound messages when phone allowlist is empty', async () => {
      let receivedCallback = false;
      const emptyPhoneAdapter = new WhatsappMessagingAdapter(dummySessionDirectory, '', async () => {
        receivedCallback = true;
      });

      expect(emptyPhoneAdapter.isAuthorizedSender('6281234567890@s.whatsapp.net', false)).toBe(false);

      const externalMessage: proto.IWebMessageInfo = {
        key: {
          remoteJid: '62899998888@s.whatsapp.net',
          fromMe: false,
          id: 'MSG_FAILCLOSED_001',
        },
        message: {
          conversation: 'Beli bensin 50000',
        },
      };

      await emptyPhoneAdapter.processIncomingMessages([externalMessage]);
      expect(receivedCallback).toBe(false);
    });

    it('authorizes matching phone numbers and self-messages while rejecting unauthorized senders', async () => {
      let receivedCallback = false;
      const whitelistedAdapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        async () => {
          receivedCallback = true;
        }
      );

      expect(whitelistedAdapter.isAuthorizedSender(`${dummyPhoneNumber}@s.whatsapp.net`, false)).toBe(true);
      expect(whitelistedAdapter.isAuthorizedSender('62899998888@s.whatsapp.net', false)).toBe(false);
      expect(whitelistedAdapter.isAuthorizedSender('62899998888@s.whatsapp.net', true)).toBe(true);

      // Inbound message from whitelisted sender dispatches to callback
      const whitelistedMessage: proto.IWebMessageInfo = {
        key: {
          remoteJid: `${dummyPhoneNumber}@s.whatsapp.net`,
          fromMe: false,
          id: 'MSG_WHITELISTED_001',
        },
        message: {
          conversation: 'Makan siang 35000',
        },
      };
      await whitelistedAdapter.processIncomingMessages([whitelistedMessage]);
      expect(receivedCallback).toBe(true);

      // Inbound message from unauthorized sender is dropped
      receivedCallback = false;
      const unauthorizedMessage: proto.IWebMessageInfo = {
        key: {
          remoteJid: '62899998888@s.whatsapp.net',
          fromMe: false,
          id: 'MSG_UNAUTHORIZED_001',
        },
        message: {
          conversation: 'Transfer 500000',
        },
      };
      await whitelistedAdapter.processIncomingMessages([unauthorizedMessage]);
      expect(receivedCallback).toBe(false);
    });
  });
});
