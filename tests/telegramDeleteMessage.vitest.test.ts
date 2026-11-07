import { describe, expect, it, vi } from 'vitest';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';
import { MessagingGatewayService } from '../src/gateway/coordinator.js';

describe('deleteTextMessage functionality', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';
  const dummyCallback = async () => {};

  it('deletes message via telegram api when valid message id is provided', async () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
    const mockDelete = vi.fn().mockResolvedValue(true);

    (adapter as any).botInstance = {
      api: {
        deleteMessage: mockDelete,
      },
    };

    const success = await adapter.deleteTextMessage('123456789', '98765');
    expect(success).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith('123456789', 98765);
  });

  it('returns false when invalid non-numeric message id is provided', async () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
    (adapter as any).botInstance = {
      api: {
        deleteMessage: vi.fn(),
      },
    };

    const success = await adapter.deleteTextMessage('123456789', 'not-a-number');
    expect(success).toBe(false);
  });

  it('returns false without throwing when telegram deleteMessage rejects', async () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
    (adapter as any).botInstance = {
      api: {
        deleteMessage: vi.fn().mockRejectedValue(new Error('message to delete not found')),
      },
    };

    const success = await adapter.deleteTextMessage('123456789', '98765');
    expect(success).toBe(false);
  });

  it('delegates deleteMessage in MessagingGatewayService to registered adapter', async () => {
    const coordinator = new MessagingGatewayService();
    const mockAdapter = {
      channelName: 'telegram' as const,
      startConnection: vi.fn(),
      sendTextMessage: vi.fn(),
      sendTypingPresence: vi.fn(),
      clearTypingPresence: vi.fn(),
      sendBroadcastNotification: vi.fn(),
      deleteTextMessage: vi.fn().mockResolvedValue(true),
    };

    coordinator.registerAdapter(mockAdapter);

    const deleted = await coordinator.deleteMessage('telegram', '123456789', '444');
    expect(deleted).toBe(true);
    expect(mockAdapter.deleteTextMessage).toHaveBeenCalledWith('123456789', '444');
  });

  it('returns false in MessagingGatewayService if channel adapter has no deleteTextMessage', async () => {
    const coordinator = new MessagingGatewayService();
    const mockAdapter = {
      channelName: 'whatsapp' as const,
      startConnection: vi.fn(),
      sendTextMessage: vi.fn(),
      sendTypingPresence: vi.fn(),
      clearTypingPresence: vi.fn(),
      sendBroadcastNotification: vi.fn(),
    };

    coordinator.registerAdapter(mockAdapter);

    const deleted = await coordinator.deleteMessage('whatsapp', '123456789', '444');
    expect(deleted).toBe(false);
  });

  it('returns false from telegram adapter when botInstance is not initialized', async () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
    // botInstance remains null
    const success = await adapter.deleteTextMessage('123456789', '98765');
    expect(success).toBe(false);
  });

  it('handles deleteMessage adapter exception gracefully in coordinator', async () => {
    const coordinator = new MessagingGatewayService();
    const mockAdapter = {
      channelName: 'telegram' as const,
      startConnection: vi.fn(),
      sendTextMessage: vi.fn(),
      sendTypingPresence: vi.fn(),
      clearTypingPresence: vi.fn(),
      sendBroadcastNotification: vi.fn(),
      deleteTextMessage: vi.fn().mockRejectedValue(new Error('Network error')),
    };
    coordinator.registerAdapter(mockAdapter);
    const deleted = await coordinator.deleteMessage('telegram', '123456789', '444');
    expect(deleted).toBe(false);
  });

  it('implements deleteTextMessage on console adapter returning true', async () => {
    const { ConsoleMessagingAdapter } = await import('../src/gateway/console.js');
    const consoleAdapter = new ConsoleMessagingAdapter(async () => {});
    const deleted = await consoleAdapter.deleteTextMessage('console-chat', 'msg-1');
    expect(deleted).toBe(true);
  });
});
