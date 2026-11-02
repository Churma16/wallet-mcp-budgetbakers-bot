import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { WhatsappMessagingAdapter } from '../src/gateway/whatsapp.js';

describe('WhatsappMessagingAdapter socket hardening and typing presence', () => {
  const dummySessionDirectory = './test_auth_session';
  const dummyPhoneNumber = '6281234567890';
  const dummyCallback = async () => {};

  describe('makeWASocket hardened configuration', () => {
    it('statically enforces hardened options in source file', () => {
      const adapterSourceFilePath = path.resolve('src/gateway/whatsapp.ts');
      const adapterFileContent = fs.readFileSync(adapterSourceFilePath, 'utf-8');

      expect(adapterFileContent).toContain('generateHighQualityLinkPreview: false');
      expect(adapterFileContent).toContain('syncFullHistory: false');
      expect(adapterFileContent).toContain('shouldSyncHistoryMessage: () => false');
      expect(adapterFileContent).toContain('markOnlineOnConnect: false');
      expect(adapterFileContent).toContain('getMessage: async () => undefined');
    });
  });

  describe('typing presence debouncing lifecycle', () => {
    it('manages typing presence debouncing, cooldown, pause, and lifecycle cleanup', async () => {
      const dispatchedPresenceEvents: Array<{ action: string; jid: string; timestamp: number }> = [];

      const mockSocket = {
        sendPresenceUpdate: async (action: string, jid: string) => {
          dispatchedPresenceEvents.push({ action, jid, timestamp: Date.now() });
        },
        ev: { removeAllListeners: () => {} },
        end: () => {},
      };

      const cooldownPeriodMs = 200;
      const adapter = new WhatsappMessagingAdapter(
        dummySessionDirectory,
        dummyPhoneNumber,
        dummyCallback,
        {
          typingPresenceCooldownMs: cooldownPeriodMs,
        }
      );

      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      // Initial sendTypingPresence dispatches immediately
      await adapter.sendTypingPresence('user-1@s.whatsapp.net');
      expect(dispatchedPresenceEvents).toHaveLength(1);
      expect(adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net')).toBeDefined();

      // Rapid successive calls within cooldown period are debounced / dropped
      await adapter.sendTypingPresence('user-1@s.whatsapp.net');
      await adapter.sendTypingPresence('user-1@s.whatsapp.net');
      expect(dispatchedPresenceEvents).toHaveLength(1);

      // Presence dispatches again after cooldown period elapses
      await new Promise(resolve => setTimeout(resolve, cooldownPeriodMs + 50));
      await adapter.sendTypingPresence('user-1@s.whatsapp.net');
      expect(dispatchedPresenceEvents).toHaveLength(2);

      // clearTypingPresence is never blocked by cooldown and always sends 'paused'
      await adapter.clearTypingPresence('user-1@s.whatsapp.net');
      expect(dispatchedPresenceEvents).toHaveLength(3);
      expect(dispatchedPresenceEvents[2].action).toBe('paused');

      // stopConnection cleans up and resets timestamp map
      await adapter.sendTypingPresence('user-1@s.whatsapp.net');
      expect(adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net')).toBeDefined();
      await adapter.stopConnection();
      expect(adapter.getLastTypingPresenceTimestamp('user-1@s.whatsapp.net')).toBeUndefined();
    });
  });

  describe('typing presence edge cases', () => {
    it('isolates cooldown per JID so different users are not throttled together', async () => {
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
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      await adapter.sendTypingPresence('user-a@s.whatsapp.net');
      expect(presenceEvents).toHaveLength(1);

      await adapter.sendTypingPresence('user-b@s.whatsapp.net');
      expect(presenceEvents).toHaveLength(2);
      expect(presenceEvents[1].jid).toBe('user-b@s.whatsapp.net');
    });

    it('does not commit timestamp to cooldown map when socket dispatch fails', async () => {
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
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      await adapter.sendTypingPresence('error-user@s.whatsapp.net');
      expect(adapter.getLastTypingPresenceTimestamp('error-user@s.whatsapp.net')).toBeUndefined();

      shouldFail = false;
      await adapter.sendTypingPresence('error-user@s.whatsapp.net');
      expect(adapter.getLastTypingPresenceTimestamp('error-user@s.whatsapp.net')).toBeDefined();
    });

    it('clears cooldown timestamp when paused so next presence sends immediately', async () => {
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
        { typingPresenceCooldownMs: 10000 }
      );
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      await adapter.sendTypingPresence('chat-x@s.whatsapp.net');
      expect(presenceEvents).toHaveLength(1);

      await adapter.clearTypingPresence('chat-x@s.whatsapp.net');
      expect(adapter.getLastTypingPresenceTimestamp('chat-x@s.whatsapp.net')).toBeUndefined();

      await adapter.sendTypingPresence('chat-x@s.whatsapp.net');
      expect(presenceEvents).toHaveLength(3);
      expect(presenceEvents[2].action).toBe('composing');
    });

    it('dispatches all presence updates without suppression when cooldown is 0', async () => {
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
        { typingPresenceCooldownMs: 0 }
      );
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      await adapter.sendTypingPresence('user-zero@s.whatsapp.net');
      await adapter.sendTypingPresence('user-zero@s.whatsapp.net');
      await adapter.sendTypingPresence('user-zero@s.whatsapp.net');

      expect(presenceDispatchCount).toBe(3);
    });

    it('returns early without invoking socket or crashing when JID is empty or whitespace', async () => {
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
      (adapter as unknown as { socketInstance: typeof mockSocket }).socketInstance = mockSocket;

      await adapter.sendTypingPresence('');
      await adapter.sendTypingPresence('   ');
      await adapter.clearTypingPresence('');
      await adapter.clearTypingPresence('   ');

      expect(socketCalled).toBe(false);
    });
  });
});
