import { MessagingGatewayService } from '../src/gateway/coordinator.js';
import { describe, expect, it } from 'vitest';
import {
  MessagingAdapter,
  SupportedMessengerChannel,
} from '../src/gateway/types.js';

class MockMessagingAdapter implements MessagingAdapter {
  public startCallCount = 0;
  public stopCallCount = 0;
  public sentMessages: Array<{ targetChatIdentifier: string; messageText: string }> = [];
  public broadcastMessages: string[] = [];

  constructor(
    public readonly channelName: SupportedMessengerChannel,
    public shouldFailStart = false,
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

describe('MessagingGatewayService lifecycle and resilience', () => {
  describe('adapter registration and initial state', () => {
    it('initializes registered adapters in idle state with empty connected channels', () => {
      const gateway = new MessagingGatewayService();
      const whatsappMock = new MockMessagingAdapter('whatsapp');
      const telegramMock = new MockMessagingAdapter('telegram');

      gateway.registerAdapter(whatsappMock);
      gateway.registerAdapter(telegramMock);

      expect(gateway.getActiveChannels()).toHaveLength(2);
      expect(gateway.getAdapterState('whatsapp')).toBe('idle');
      expect(gateway.getAdapterState('telegram')).toBe('idle');
      expect(gateway.getConnectedChannels()).toHaveLength(0);
    });
  });

  describe('partial startup failure and degraded mode', () => {
    it('starts available adapters without rejecting when at least one adapter succeeds', async () => {
      const gateway = new MessagingGatewayService({
        maxBackgroundReconnectAttempts: 3,
        backgroundReconnectBaseDelayMs: 20,
        backgroundReconnectMaxDelayMs: 100,
      });

      const healthyWhatsApp = new MockMessagingAdapter('whatsapp', false);
      const brokenTelegram = new MockMessagingAdapter('telegram', true, new Error('getaddrinfo EAI_AGAIN'));

      gateway.registerAdapter(healthyWhatsApp);
      gateway.registerAdapter(brokenTelegram);

      await expect(gateway.startAll()).resolves.toBeUndefined();

      expect(gateway.isChannelConnected('whatsapp')).toBe(true);
      expect(gateway.getAdapterState('telegram')).toBe('reconnecting');
      expect(gateway.getConnectedChannels()).toEqual(['whatsapp']);
      expect(gateway.hasActiveReconnectTimer('telegram')).toBe(true);

      await gateway.sendMessage('whatsapp', '6281234567890', 'Hello WhatsApp!');
      expect(healthyWhatsApp.sentMessages).toHaveLength(1);

      await expect(
        gateway.sendMessage('telegram', '123456', 'Hello Telegram!')
      ).rejects.toThrow(/not connected/);

      await gateway.stopAll();
    });
  });

  describe('total startup failure', () => {
    it('throws fatal error and marks adapters as failed when all adapters fail to start', async () => {
      const gateway = new MessagingGatewayService();
      const brokenWhatsApp = new MockMessagingAdapter('whatsapp', true, new Error('WhatsApp network offline'));
      const brokenTelegram = new MockMessagingAdapter('telegram', true, new Error('Telegram token invalid'));

      gateway.registerAdapter(brokenWhatsApp);
      gateway.registerAdapter(brokenTelegram);

      await expect(gateway.startAll()).rejects.toThrow(/All registered messaging adapters failed/);

      expect(gateway.getAdapterState('whatsapp')).toBe('failed');
      expect(gateway.getAdapterState('telegram')).toBe('failed');
      expect(gateway.getConnectedChannels()).toHaveLength(0);

      await gateway.stopAll();
    });
  });

  describe('background reconnection recovery', () => {
    it('reconnects failed adapters in background when connectivity is restored', async () => {
      const gateway = new MessagingGatewayService({
        maxBackgroundReconnectAttempts: 5,
        backgroundReconnectBaseDelayMs: 30,
        backgroundReconnectMaxDelayMs: 100,
      });

      const healthyWhatsApp = new MockMessagingAdapter('whatsapp', false);
      const recoveringTelegram = new MockMessagingAdapter('telegram', true, new Error('Temporary DNS failure'));

      gateway.registerAdapter(healthyWhatsApp);
      gateway.registerAdapter(recoveringTelegram);

      await gateway.startAll();
      expect(gateway.getAdapterState('telegram')).toBe('reconnecting');

      // Simulate recovery: Telegram network comes back online
      recoveringTelegram.shouldFailStart = false;

      // Poll until Telegram background reconnection finishes
      const pollStartTime = Date.now();
      while (!gateway.isChannelConnected('telegram') && Date.now() - pollStartTime < 1500) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      expect(gateway.isChannelConnected('telegram')).toBe(true);
      expect(gateway.getConnectedChannels()).toHaveLength(2);

      await gateway.sendMessage('telegram', '123456', 'Welcome back Telegram!');
      expect(recoveringTelegram.sentMessages).toHaveLength(1);

      await gateway.stopAll();
    });
  });

  describe('broadcast notification filtering', () => {
    it('routes broadcasts only to connected channels and skips disconnected channels', async () => {
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

      await gateway.broadcastNotification('Notification for active channels');
      expect(activeWhatsApp.broadcastMessages).toHaveLength(1);
      expect(offlineTelegram.broadcastMessages).toHaveLength(0);

      await gateway.stopAll();
    });
  });

  describe('graceful shutdown lifecycle', () => {
    it('cancels background reconnect timers, stops all adapters, and resets states to idle', async () => {
      const gateway = new MessagingGatewayService({
        maxBackgroundReconnectAttempts: 5,
        backgroundReconnectBaseDelayMs: 10000,
        backgroundReconnectMaxDelayMs: 60000,
      });

      const activeWhatsApp = new MockMessagingAdapter('whatsapp', false);
      const offlineTelegram = new MockMessagingAdapter('telegram', true);

      gateway.registerAdapter(activeWhatsApp);
      gateway.registerAdapter(offlineTelegram);

      await gateway.startAll();
      expect(gateway.hasActiveReconnectTimer('telegram')).toBe(true);

      await gateway.stopAll();
      expect(gateway.hasActiveReconnectTimer('telegram')).toBe(false);
      expect(activeWhatsApp.stopCallCount).toBe(1);
      expect(offlineTelegram.stopCallCount).toBe(1);
      expect(gateway.getAdapterState('whatsapp')).toBe('idle');
      expect(gateway.getAdapterState('telegram')).toBe('idle');
    });
  });
});
