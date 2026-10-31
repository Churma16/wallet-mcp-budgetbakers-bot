import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  MessagingGatewayService,
  TelegramMessagingAdapter,
  ConsoleMessagingAdapter,
  WhatsappMessagingAdapter,
  MessageIdTracker,
  WhatsappOutboundMessageQueue,
  WhatsappPresenceManager,
  WhatsappConnectionResilience,
  WhatsappInboundMessageProcessor,
  convertWhatsAppMarkupToTelegramHtml,
  formatBytesToMegabytes,
  formatBytesToMegabytesDisplay,
  isMediaSizeExceeded,
  isMediaPayloadSizeLimitExceeded,
  getChannelDisplayName,
  formatMediaTooLargeMessage,
  formatMediaDownloadFailedMessage,
  rejectOversizedMedia,
  handleMediaDownloadFailure,
  MessagingAdapter,
} from '../src/gateway/index.js';

describe('Gateway Domain Coverage Gate', () => {
  describe('TelegramMessagingAdapter Coverage', () => {
    it('handles sendTextMessage success and fallbacks', async () => {
      const adapter = new TelegramMessagingAdapter('123:test-token', '12345', vi.fn());
      const mockSendMessage = vi.fn().mockResolvedValue({});
      (adapter as any).botInstance = {
        api: {
          sendMessage: mockSendMessage,
        },
      };

      // 1. Success with HTML formatting
      await adapter.sendTextMessage('12345', 'Hello *World*');
      expect(mockSendMessage).toHaveBeenCalledWith('12345', 'Hello <b>World</b>', { parse_mode: 'HTML' });

      // 2. HTML parse error falls back to plain text
      mockSendMessage.mockRejectedValueOnce(new Error('HTML parse error')).mockResolvedValueOnce({});
      await adapter.sendTextMessage('12345', 'Perbandingan: <tag>');
      expect(mockSendMessage).toHaveBeenCalledTimes(3);

      // 3. Both HTML and fallback fail throws error
      mockSendMessage
        .mockRejectedValueOnce(new Error('HTML parse error'))
        .mockRejectedValueOnce(new Error('Network error'));
      await expect(adapter.sendTextMessage('12345', 'Fail message')).rejects.toThrow('Network error');

      // 4. Bot instance not initialized throws error
      (adapter as any).botInstance = null;
      await expect(adapter.sendTextMessage('12345', 'Hello')).rejects.toThrow('Telegram bot is not initialized');
    });

    it('handles sendTypingPresence and clearTypingPresence', async () => {
      const adapter = new TelegramMessagingAdapter('123:test-token', '12345', vi.fn());
      
      // When botInstance is null
      (adapter as any).botInstance = null;
      await adapter.sendTypingPresence('12345');
      await adapter.clearTypingPresence('12345');

      // When botInstance is present
      const mockSendChatAction = vi.fn().mockResolvedValue({});
      (adapter as any).botInstance = {
        api: {
          sendChatAction: mockSendChatAction,
        },
      };

      await adapter.sendTypingPresence('12345');
      expect(mockSendChatAction).toHaveBeenCalledWith('12345', 'typing');

      // When sendChatAction throws error, it logs warning and does not rethrow
      mockSendChatAction.mockRejectedValueOnce(new Error('Action failed'));
      await expect(adapter.sendTypingPresence('12345')).resolves.not.toThrow();
    });

    it('handles sendBroadcastNotification', async () => {
      // 1. Without normalized allowed user ID
      const unconfiguredAdapter = new TelegramMessagingAdapter('123:test-token', '', vi.fn());
      await unconfiguredAdapter.sendBroadcastNotification('Notice');

      // 2. With normalized allowed user ID
      const configuredAdapter = new TelegramMessagingAdapter('123:test-token', '99999', vi.fn());
      const sendSpy = vi.spyOn(configuredAdapter, 'sendTextMessage').mockResolvedValue();
      await configuredAdapter.sendBroadcastNotification('Alert message');
      expect(sendSpy).toHaveBeenCalledWith('99999', 'Alert message');
    });

    it('handles stopConnection cleanly', async () => {
      const adapter = new TelegramMessagingAdapter('123:test-token', '12345', vi.fn());
      
      // When not running and no botInstance
      await adapter.stopConnection();

      // When running and botInstance throws during stop
      (adapter as any).isRunning = true;
      (adapter as any).botInstance = {
        stop: vi.fn().mockRejectedValue(new Error('Stop failed')),
      };
      await expect(adapter.stopConnection()).resolves.not.toThrow();
      expect((adapter as any).isRunning).toBe(false);
      expect((adapter as any).botInstance).toBeNull();
    });

    it('exercises global error handler in setupBotHandlers', () => {
      const adapter = new TelegramMessagingAdapter('123:test-token', '12345', vi.fn());
      let catchHandler: ((err: any) => void) | undefined;
      const mockBot: any = {
        use: vi.fn(),
        on: vi.fn(),
        catch: vi.fn(fn => {
          catchHandler = fn;
        }),
      };

      adapter.setupBotHandlers(mockBot);
      expect(catchHandler).toBeDefined();

      // Trigger bot.catch with Error
      expect(() => catchHandler!({ message: 'Telegram unhandled', name: 'Error' })).not.toThrow();
      // Trigger bot.catch with non-Error
      expect(() => catchHandler!({ message: 'String error' })).not.toThrow();
    });

    it('handles markup conversion edge cases', () => {
      expect(convertWhatsAppMarkupToTelegramHtml('')).toBe('');
      expect(convertWhatsAppMarkupToTelegramHtml('Normal text')).toBe('Normal text');
      expect(convertWhatsAppMarkupToTelegramHtml('```pre code``` and `inline`')).toContain('<pre>pre code</pre>');
      expect(convertWhatsAppMarkupToTelegramHtml('~strikethrough~')).toBe('<s>strikethrough</s>');
    });
  });

  describe('MessagingGatewayService Coverage', () => {
    it('covers channel registration and state query branches', () => {
      const service = new MessagingGatewayService({
        maxBackgroundReconnectAttempts: 5,
        backgroundReconnectBaseDelayMs: 2000,
        backgroundReconnectMaxDelayMs: 30000,
      });

      expect(service.getMaxBackgroundReconnectAttempts()).toBe(5);
      expect(service.getBackgroundReconnectBaseDelayMs()).toBe(2000);
      expect(service.getBackgroundReconnectMaxDelayMs()).toBe(30000);

      const mockAdapter: MessagingAdapter = {
        channelName: 'console',
        startConnection: vi.fn().mockResolvedValue(undefined),
        sendTextMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendBroadcastNotification: vi.fn().mockResolvedValue(undefined),
      };

      service.registerAdapter(mockAdapter);
      // Registering duplicate triggers warning branch
      service.registerAdapter(mockAdapter);

      expect(service.getAdapter('console')).toBe(mockAdapter);
      expect(service.getAdapter('whatsapp')).toBeUndefined();
      expect(service.getAdapterState('whatsapp')).toBe('idle');

      expect(service.getConnectedChannels()).toEqual([]);
      expect(service.getReconnectingChannels()).toEqual([]);
      expect(service.getFailedChannels()).toEqual([]);
      expect(service.hasActiveReconnectTimer('console')).toBe(false);
    });

    it('handles broadcastNotification without connected channels and with failures', async () => {
      const service = new MessagingGatewayService();

      // 1. No connected channels
      await service.broadcastNotification('Test notification');

      // 2. Connected channels where one fails
      const failingAdapter: MessagingAdapter = {
        channelName: 'whatsapp',
        startConnection: vi.fn().mockResolvedValue(undefined),
        sendTextMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendBroadcastNotification: vi.fn().mockRejectedValue(new Error('Broadcast failed')),
      };
      service.registerAdapter(failingAdapter);
      (service as any).adapterStateMap.set('whatsapp', 'connected');

      await expect(service.broadcastNotification('Broadcast')).resolves.not.toThrow();
    });

    it('handles sendMessage errors and state checks', async () => {
      const service = new MessagingGatewayService();

      // Channel not registered
      await expect(service.sendMessage('telegram', '123', 'Hi')).rejects.toThrow(
        "adapter for channel 'telegram' is not registered"
      );

      const mockAdapter: MessagingAdapter = {
        channelName: 'console',
        startConnection: vi.fn().mockResolvedValue(undefined),
        sendTextMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendBroadcastNotification: vi.fn().mockResolvedValue(undefined),
      };
      service.registerAdapter(mockAdapter);

      // Channel registered but idle
      await expect(service.sendMessage('console', '123', 'Hi')).rejects.toThrow(
        "channel 'console' is not connected (current state: idle)"
      );

      // Presence methods when disconnected
      await service.sendTypingPresence('console', '123');
      await service.clearTypingPresence('console', '123');

      // Presence methods when connected
      (service as any).adapterStateMap.set('console', 'connected');
      await service.sendTypingPresence('console', '123');
      expect(mockAdapter.sendTypingPresence).toHaveBeenCalledWith('123');
      await service.clearTypingPresence('console', '123');
      expect(mockAdapter.clearTypingPresence).toHaveBeenCalledWith('123');
    });

    it('handles stopAll with failing adapters', async () => {
      const service = new MessagingGatewayService();
      const mockFailingStop: MessagingAdapter = {
        channelName: 'whatsapp',
        startConnection: vi.fn().mockResolvedValue(undefined),
        stopConnection: vi.fn().mockRejectedValue(new Error('Stop failed')),
        sendTextMessage: vi.fn().mockResolvedValue(undefined),
        sendTypingPresence: vi.fn().mockResolvedValue(undefined),
        clearTypingPresence: vi.fn().mockResolvedValue(undefined),
        sendBroadcastNotification: vi.fn().mockResolvedValue(undefined),
      };

      service.registerAdapter(mockFailingStop);
      await expect(service.stopAll()).resolves.not.toThrow();
      expect(service.getAdapterState('whatsapp')).toBe('idle');
    });

    it('startAll throws when no adapters registered', async () => {
      const emptyService = new MessagingGatewayService();
      await expect(emptyService.startAll()).rejects.toThrow('No messaging adapters registered to start');
    });
  });

  describe('ConsoleMessagingAdapter Coverage', () => {
    it('covers getters, presence, and shutdown states', async () => {
      const inputStream = new PassThrough();
      const outputStream = new PassThrough();
      let exited = false;

      const adapter = new ConsoleMessagingAdapter(vi.fn(), {
        inputStream,
        outputStream,
        senderIdentifier: 'user_1',
        chatIdentifier: 'chat_1',
        onExitRequested: () => {
          exited = true;
        },
      });

      expect(adapter.getSenderIdentifier()).toBe('user_1');
      expect(adapter.getChatIdentifier()).toBe('chat_1');
      expect(adapter.getConnectionState()).toBe('idle');
      expect(adapter.getPendingTaskCount()).toBe(0);

      await adapter.sendTypingPresence('chat_1');
      await adapter.clearTypingPresence('chat_1');

      // stopConnection when not running
      await adapter.stopConnection();

      // Start and test shutdown branches
      await adapter.startConnection();
      expect(adapter.getConnectionState()).toBe('connected');

      // sendBroadcastNotification delegates to sendTextMessage
      await adapter.sendBroadcastNotification('Broadcast to console');

      // Enter empty line
      inputStream.write('\n');

      // Enter exit command
      inputStream.write('exit\n');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(exited).toBe(true);

      await adapter.stopConnection();
    });
  });

  describe('MediaPolicy Coverage', () => {
    it('handles boundary and non-finite numbers', () => {
      expect(formatBytesToMegabytes(-1)).toBe(0);
      expect(formatBytesToMegabytes(NaN)).toBe(0);
      expect(formatBytesToMegabytesDisplay(0)).toBe('0.0');
      expect(formatBytesToMegabytesDisplay(NaN)).toBe('0.0');

      expect(isMediaSizeExceeded(0, 100)).toBe(false);
      expect(isMediaSizeExceeded(-10, 100)).toBe(false);
      expect(isMediaSizeExceeded(NaN, 100)).toBe(false);

      expect(isMediaPayloadSizeLimitExceeded(null)).toBe(false);
      expect(isMediaPayloadSizeLimitExceeded({ code: 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded({ message: 'Request maxContentLength exceeded' })).toBe(true);
      expect(isMediaPayloadSizeLimitExceeded('other error')).toBe(false);

      expect(getChannelDisplayName('')).toBe('');
      expect(getChannelDisplayName('unknown_channel')).toBe('unknown_channel');
      expect(getChannelDisplayName('whatsapp')).toBe('WhatsApp');
      expect(getChannelDisplayName('telegram')).toBe('Telegram');
      expect(getChannelDisplayName('console')).toBe('Console');

      expect(formatMediaTooLargeMessage(10 * 1024 * 1024)).toBeDefined();
      expect(formatMediaDownloadFailedMessage('telegram')).toBeDefined();
    });

    it('rejects oversized media without actualBytes and handles download failures', async () => {
      const mockSend = vi.fn().mockResolvedValue(undefined);

      // rejectOversizedMedia without actualBytes
      await rejectOversizedMedia({
        channel: 'telegram',
        chatIdentifier: '123',
        senderIdentifier: 'user',
        maxMediaDownloadBytes: 5 * 1024 * 1024,
        rejectionStage: 'download_stream',
        sendTextMessage: mockSend,
      });
      expect(mockSend).toHaveBeenCalled();

      // handleMediaDownloadFailure with string error and no redactToken
      await handleMediaDownloadFailure({
        channel: 'whatsapp',
        chatIdentifier: '123',
        senderIdentifier: 'user',
        downloadError: 'Plain error string',
        sendTextMessage: mockSend,
      });
      expect(mockSend).toHaveBeenCalledTimes(2);

      // handleMediaDownloadFailure with Error and redactToken
      await handleMediaDownloadFailure({
        channel: 'telegram',
        chatIdentifier: '123',
        senderIdentifier: 'user',
        downloadError: new Error('Token secret123 in message'),
        sendTextMessage: mockSend,
        redactToken: 'secret123',
      });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });
  });

  describe('WhatsApp Component Coverage', () => {
    it('exercises MessageIdTracker duplicate and eviction branches', () => {
      const tracker = new MessageIdTracker(3);
      tracker.record('id1');
      tracker.record('id1'); // Duplicate no-op
      tracker.record('id2');
      tracker.record('id3');
      tracker.record('id4'); // Evicts id1

      expect(tracker.has('id1')).toBe(false);
      expect(tracker.has('id4')).toBe(true);
      tracker.clear();
      expect(tracker.has('id4')).toBe(false);
    });

    it('exercises WhatsappOutboundMessageQueue stop and error branches', async () => {
      let connected = true;
      const queue = new WhatsappOutboundMessageQueue(0, () => connected);

      expect(queue.length).toBe(0);
      queue.resume();

      // Enqueue when disconnected rejects
      connected = false;
      await expect(queue.enqueue(async () => {})).rejects.toThrow('WhatsApp socket is not connected');

      // Enqueue then stop rejects pending
      connected = true;
      let taskPromise: Promise<void> | undefined;
      const blockingTask = () => new Promise<void>(resolve => setTimeout(resolve, 50));
      void queue.enqueue(blockingTask);
      taskPromise = queue.enqueue(async () => {});
      queue.stop();
      await expect(taskPromise).rejects.toThrow('WhatsApp adapter was stopped');
    });

    it('exercises WhatsappPresenceManager cooldown and empty jid', async () => {
      const mockSocket: any = {
        sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
      };
      const manager = new WhatsappPresenceManager(() => mockSocket, 1000);

      expect(manager.getCooldownMilliseconds()).toBe(1000);

      // Empty jid is no-op
      await manager.sendTyping('');
      await manager.clearTyping('');
      expect(mockSocket.sendPresenceUpdate).not.toHaveBeenCalled();

      // Valid jid
      await manager.sendTyping('chat1');
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith('composing', 'chat1');
      expect(manager.getLastTypingTimestamp('chat1')).toBeDefined();

      // Within cooldown is no-op
      mockSocket.sendPresenceUpdate.mockClear();
      await manager.sendTyping('chat1');
      expect(mockSocket.sendPresenceUpdate).not.toHaveBeenCalled();

      // Clear typing
      await manager.clearTyping('chat1');
      expect(mockSocket.sendPresenceUpdate).toHaveBeenCalledWith('paused', 'chat1');

      // Reset
      manager.reset();
      expect(manager.getLastTypingTimestamp('chat1')).toBeUndefined();
    });

    it('exercises WhatsappConnectionResilience manual connection and status codes', () => {
      const resilience = new WhatsappConnectionResilience('./test_session', vi.fn(), 3, 60);

      expect(resilience.failureCount).toBe(0);
      expect(resilience.isCircuitOpen).toBe(false);
      expect(resilience.hasActiveReconnect).toBe(false);
      expect(resilience.reconnectTimeout).toBeNull();

      resilience.prepareManualConnection();
      resilience.markConnected();
      resilience.reset();
      resilience.stop();

      // Status 440 connectionReplaced trips circuit breaker
      resilience.handleClose(440, new Error('Replaced'));
      expect(resilience.isCircuitOpen).toBe(true);

      // Reset
      resilience.reset();

      // Status 515 restartRequired schedules fast-track
      resilience.handleClose(515, new Error('Restart required'));
      expect(resilience.hasActiveReconnect).toBe(true);
      resilience.stop();

      // Status 500 badSession purges credentials
      resilience.handleClose(500, new Error('Bad session'));
      expect(resilience.failureCount).toBe(1);
      resilience.stop();
    });

    it('exercises WhatsappInboundMessageProcessor authorization and self checks', () => {
      const processor = new WhatsappInboundMessageProcessor(
        '6281234567890',
        vi.fn(),
        () => null,
        new MessageIdTracker(),
        1024 * 1024,
        vi.fn()
      );

      expect(processor.isTargetingSelf('6281234567890@s.whatsapp.net')).toBe(true);
      expect(processor.isTargetingSelf('6289999999999@s.whatsapp.net')).toBe(false);

      expect(processor.isAuthorizedSender('6281234567890@s.whatsapp.net', false)).toBe(true);
      expect(processor.isAuthorizedSender('6289999999999@s.whatsapp.net', false)).toBe(false);
      // Unsupported domain
      expect(processor.isAuthorizedSender('6281234567890@unknown.net', false)).toBe(false);
    });

    it('exercises WhatsappMessagingAdapter unconfigured broadcast', async () => {
      const unconfiguredAdapter = new WhatsappMessagingAdapter('./test_session', '', vi.fn());
      await unconfiguredAdapter.sendBroadcastNotification('Test message');

      const configuredAdapter = new WhatsappMessagingAdapter('./test_session', '6281234567890', vi.fn());
      expect(configuredAdapter.getMaxMediaDownloadBytes()).toBe(10 * 1024 * 1024);
      expect(configuredAdapter.getConsecutiveFailureCount()).toBe(0);
      expect(configuredAdapter.getCircuitBreakerStatus()).toBe(false);
      expect(configuredAdapter.getOutboundQueueLength()).toBe(0);
      expect(configuredAdapter.getLastTypingPresenceTimestamp('chat')).toBeUndefined();
      expect(configuredAdapter.getTypingPresenceCooldownMilliseconds()).toBe(2500);
      expect(configuredAdapter.calculateBackoffDelayMilliseconds(0)).toBeGreaterThan(0);

      await configuredAdapter.sendTypingPresence('chat');
      await configuredAdapter.clearTypingPresence('chat');

      const sendSpy = vi.spyOn(configuredAdapter, 'sendTextMessage').mockResolvedValue();
      await configuredAdapter.sendBroadcastNotification('Alert');
      expect(sendSpy).toHaveBeenCalledWith('6281234567890@s.whatsapp.net', 'Alert');

      // stopConnection when socket is null
      await configuredAdapter.stopConnection();
    });
  });
});
