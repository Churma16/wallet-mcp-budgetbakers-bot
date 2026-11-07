import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ModelFallbackProgressTracker } from '../src/core/modelFallbackProgressTracker.js';
import { MessagingGatewayService } from '../src/gateway/coordinator.js';
import { SupportedMessengerChannel } from '../src/gateway/types.js';
import { ModelFallbackEvent } from '../src/brain/types.js';

describe('ModelFallbackProgressTracker', () => {
  let mockGateway: {
    sendMessage: ReturnType<typeof vi.fn>;
    editMessage: ReturnType<typeof vi.fn>;
    deleteMessage: ReturnType<typeof vi.fn>;
    sendTypingPresence: ReturnType<typeof vi.fn>;
  };

  const channel: SupportedMessengerChannel = 'telegram';
  const chatIdentifier = '123456789';

  beforeEach(() => {
    vi.useFakeTimers();
    mockGateway = {
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'status-msg-1' }),
      editMessage: vi.fn().mockResolvedValue(true),
      deleteMessage: vi.fn().mockResolvedValue(true),
      sendTypingPresence: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('remains completely quiet in fast path (< grace period)', async () => {
    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
      gracePeriodMs: 2500,
    });

    tracker.start();

    // Fast-forward 1000ms (fast path)
    vi.advanceTimersByTime(1000);

    // AI finished successfully, cleanup invoked
    await tracker.cleanup();

    // Advance beyond grace period to ensure timer was truly cancelled
    vi.advanceTimersByTime(2000);

    expect(mockGateway.sendMessage).not.toHaveBeenCalled();
    expect(mockGateway.deleteMessage).not.toHaveBeenCalled();
    expect(mockGateway.editMessage).not.toHaveBeenCalled();
  });

  it('dispatches initial plain-language status bubble showing primary model when grace period expires', async () => {
    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
      primaryModel: 'gemini-3.5-flash-lite',
      gracePeriodMs: 2000,
    });

    tracker.start();

    // Fast-forward past grace period
    await vi.advanceTimersByTimeAsync(2001);

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      channel,
      chatIdentifier,
      expect.stringContaining('gemini-3.5-flash-lite')
    );
    expect(tracker.getStatusMessageId()).toBe('status-msg-1');

    // On cleanup, the status bubble should be cleanly deleted
    await tracker.cleanup();
    expect(mockGateway.deleteMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.deleteMessage).toHaveBeenCalledWith(channel, chatIdentifier, 'status-msg-1');
  });

  it('dispatches fallback status message with next candidate model when fallback occurs before grace period', async () => {
    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
      gracePeriodMs: 3000,
    });

    tracker.start();

    // Fallback occurs at 500ms
    vi.advanceTimersByTime(500);

    const fallbackEvent: ModelFallbackEvent = {
      currentModel: 'gemini-3.5-flash-lite',
      nextModel: 'gemini-3.6-flash',
      attemptIndex: 1,
      totalCandidates: 3,
      reason: 'Rate limit 429',
    };

    await tracker.handleFallback(fallbackEvent);

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      channel,
      chatIdentifier,
      expect.stringContaining('gemini-3.6-flash')
    );
    expect(mockGateway.sendTypingPresence).toHaveBeenCalledWith(channel, chatIdentifier);

    // Further timer advance does NOT trigger a second message
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);

    // Cleanup deletes message
    await tracker.cleanup();
    expect(mockGateway.deleteMessage).toHaveBeenCalledWith(channel, chatIdentifier, 'status-msg-1');
  });

  it('edits status bubble in-place showing next candidate model on subsequent fallback retries', async () => {
    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
    });

    // 1st fallback: sends initial bubble with model-b
    await tracker.handleFallback({
      currentModel: 'model-a',
      nextModel: 'model-b',
      attemptIndex: 1,
      totalCandidates: 3,
    });

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.sendMessage).toHaveBeenCalledWith(
      channel,
      chatIdentifier,
      expect.stringContaining('model-b')
    );
    expect(mockGateway.editMessage).not.toHaveBeenCalled();

    // 2nd fallback: edits in-place to model-c
    await tracker.handleFallback({
      currentModel: 'model-b',
      nextModel: 'model-c',
      attemptIndex: 2,
      totalCandidates: 3,
    });

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.editMessage).toHaveBeenCalledTimes(1);
    expect(mockGateway.editMessage).toHaveBeenCalledWith(
      channel,
      chatIdentifier,
      'status-msg-1',
      expect.stringContaining('model-c')
    );

    await tracker.cleanup();
    expect(mockGateway.deleteMessage).toHaveBeenCalledWith(channel, chatIdentifier, 'status-msg-1');
  });

  it('supports custom string and function message formatters', async () => {
    const customTracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
      primaryModel: 'custom-primary',
      initialMessage: (m) => `Initial: ${m}`,
      cyclingMessage: (m) => `Cycling: ${m}`,
      gracePeriodMs: 1000,
    });

    customTracker.start();
    await vi.advanceTimersByTimeAsync(1001);

    expect(mockGateway.sendMessage).toHaveBeenCalledWith(channel, chatIdentifier, 'Initial: custom-primary');

    await customTracker.handleFallback({
      currentModel: 'custom-primary',
      nextModel: 'custom-next',
      attemptIndex: 1,
      totalCandidates: 2,
    });

    expect(mockGateway.editMessage).toHaveBeenCalledWith(
      channel,
      chatIdentifier,
      'status-msg-1',
      'Cycling: custom-next'
    );
  });

  it('handles race condition where cleanup is called while sendMessage is in flight', async () => {
    let resolveSend: (val: any) => void = () => {};
    const delayedSendPromise = new Promise(resolve => {
      resolveSend = resolve;
    });

    mockGateway.sendMessage.mockReturnValueOnce(delayedSendPromise);

    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
      gracePeriodMs: 1000,
    });

    tracker.start();

    // Trigger timer
    await vi.advanceTimersByTimeAsync(1001);

    expect(mockGateway.sendMessage).toHaveBeenCalledTimes(1);

    // AI finished and cleanup is called BEFORE sendMessage resolved
    const cleanupPromise = tracker.cleanup();

    // Now sendMessage resolves with messageId
    resolveSend({ messageId: 'status-race-msg' });
    await delayedSendPromise;
    await cleanupPromise;

    // Must delete the orphaned message immediately
    expect(mockGateway.deleteMessage).toHaveBeenCalledWith(channel, chatIdentifier, 'status-race-msg');
  });

  it('tolerates errors during sendMessage, editMessage, and deleteMessage gracefully without throwing', async () => {
    mockGateway.sendMessage.mockRejectedValueOnce(new Error('Network error'));
    mockGateway.editMessage.mockRejectedValueOnce(new Error('Edit rejected'));
    mockGateway.deleteMessage.mockRejectedValueOnce(new Error('Delete error'));

    const tracker = new ModelFallbackProgressTracker({
      gateway: mockGateway as unknown as MessagingGatewayService,
      channel,
      chatIdentifier,
    });

    // Should not throw even when sendMessage rejects
    await expect(
      tracker.handleFallback({
        currentModel: 'm1',
        nextModel: 'm2',
        attemptIndex: 1,
        totalCandidates: 2,
      })
    ).resolves.not.toThrow();

    // Cleanup should not throw even if deleteMessage rejects
    await expect(tracker.cleanup()).resolves.not.toThrow();
  });
});
