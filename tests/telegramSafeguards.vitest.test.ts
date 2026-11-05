import { Context, GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { TelegramMessagingAdapter } from '../src/gateway/telegram.js';

describe('TelegramMessagingAdapter safeguards', () => {
  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';
  const dummyCallback = async () => {};

  describe('configuration and defaults', () => {
    it('initializes with default configuration values', () => {
      const defaultAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);

      expect(defaultAdapter.getMaxStartupAttempts()).toBe(5);
      expect(defaultAdapter.getStartupRetryBaseDelayMs()).toBe(2000);
      expect(defaultAdapter.getStartupRetryMaxDelayMs()).toBe(15000);
      expect(defaultAdapter.getConnectionState()).toBe('idle');
      expect(defaultAdapter.getMaxMediaDownloadBytes()).toBe(10 * 1024 * 1024);
    });

    it('respects custom configuration overrides', () => {
      const customAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
        maxStartupAttempts: 8,
        startupRetryBaseDelayMs: 1000,
        startupRetryMaxDelayMs: 30000,
        maxMediaDownloadBytes: 5 * 1024 * 1024,
      });

      expect(customAdapter.getMaxStartupAttempts()).toBe(8);
      expect(customAdapter.getStartupRetryBaseDelayMs()).toBe(1000);
      expect(customAdapter.getStartupRetryMaxDelayMs()).toBe(30000);
      expect(customAdapter.getMaxMediaDownloadBytes()).toBe(5 * 1024 * 1024);
    });
  });

  describe('backoff delay calculations', () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
      maxStartupAttempts: 5,
      startupRetryBaseDelayMs: 2000,
      startupRetryMaxDelayMs: 15000,
    });

    it('calculates attempt 0 delay within expected bounds (2500 - 3500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(0);
      expect(delay).toBeGreaterThanOrEqual(2500);
      expect(delay).toBeLessThanOrEqual(3500);
    });

    it('calculates attempt 1 delay within expected bounds (4500 - 5500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(1);
      expect(delay).toBeGreaterThanOrEqual(4500);
      expect(delay).toBeLessThanOrEqual(5500);
    });

    it('calculates attempt 2 delay within expected bounds (8500 - 9500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(2);
      expect(delay).toBeGreaterThanOrEqual(8500);
      expect(delay).toBeLessThanOrEqual(9500);
    });

    it('caps high attempt delay at max delay plus jitter (15500 - 16500ms)', () => {
      const delay = adapter.calculateBackoffDelayMilliseconds(5);
      expect(delay).toBeGreaterThanOrEqual(15500);
      expect(delay).toBeLessThanOrEqual(16500);
    });
  });

  describe('transient vs permanent error classification', () => {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);

    it.each([
      ['Grammy HttpError', new HttpError('Network request for getMe failed', new Error('getaddrinfo EAI_AGAIN')), true],
      ['GrammyError 401 Unauthorized', new GrammyError('Unauthorized', { ok: false, error_code: 401, description: 'Unauthorized' }, 'getMe', {}), false],
      ['GrammyError 404 Not Found', new GrammyError('Not Found', { ok: false, error_code: 404, description: 'Not Found' }, 'getMe', {}), false],
      ['GrammyError 429 Too Many Requests', new GrammyError('Too Many Requests', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' }, 'getMe', {}), true],
      ['GrammyError 502 Bad Gateway', new GrammyError('Bad Gateway', { ok: false, error_code: 502, description: 'Bad Gateway' }, 'getMe', {}), true],
      ['ECONNRESET system error code', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' }), true],
      ['ETIMEDOUT system error code', Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }), true],
      ['EAI_AGAIN system error code', Object.assign(new Error('DNS lookup temporary failure'), { code: 'EAI_AGAIN' }), true],
      ['ENOTFOUND system error code', Object.assign(new Error('DNS lookup host not found'), { code: 'ENOTFOUND' }), true],
      ['message substring fallback', new Error("HttpError: Network request for 'getMe' failed!"), true],
      ['standard TypeError', new TypeError('Cannot read property of undefined'), false],
      ['null error reference', null, false],
    ])('classifies %s as retryable=%s', (_description, error, expectedRetryable) => {
      expect(adapter.isRetryableNetworkError(error)).toBe(expectedRetryable);
    });
  });

  describe('startup retry execution loop', () => {
    it('executes successfully on the first attempt', async () => {
      const fastAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
        maxStartupAttempts: 3,
        startupRetryBaseDelayMs: 10,
        startupRetryMaxDelayMs: 50,
      });

      let attemptCount = 0;
      const result = await fastAdapter.executeWithStartupRetry(async () => {
        attemptCount++;
        return { botId: 12345 };
      }, 'Test Operation 1');

      expect(result).toEqual({ botId: 12345 });
      expect(attemptCount).toBe(1);
    });

    it('recovers and succeeds after transient failures', async () => {
      vi.useFakeTimers();
      try {
        const fastAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
          maxStartupAttempts: 3,
          startupRetryBaseDelayMs: 10,
          startupRetryMaxDelayMs: 50,
        });

        let attemptCount = 0;
        const retryPromise = fastAdapter.executeWithStartupRetry(async () => {
          attemptCount++;
          if (attemptCount < 3) {
            throw Object.assign(new Error('DNS failure'), { code: 'EAI_AGAIN' });
          }
          return { botId: 99999 };
        }, 'Test Operation 2');

        await vi.runAllTimersAsync();
        const result = await retryPromise;

        expect(result).toEqual({ botId: 99999 });
        expect(attemptCount).toBe(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('terminates immediately on non-retryable 401 error without retrying', async () => {
      const fastAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
        maxStartupAttempts: 3,
        startupRetryBaseDelayMs: 10,
        startupRetryMaxDelayMs: 50,
      });

      let attemptCount = 0;
      let caughtError: unknown = null;

      try {
        await fastAdapter.executeWithStartupRetry(async () => {
          attemptCount++;
          throw new GrammyError(
            'Unauthorized',
            { ok: false, error_code: 401, description: 'Unauthorized' },
            'getMe',
            {}
          );
        }, 'Test Operation 3');
      } catch (error) {
        caughtError = error;
      }

      expect(attemptCount).toBe(1);
      expect(caughtError).toBeInstanceOf(GrammyError);
      expect((caughtError as GrammyError).error_code).toBe(401);
    });

    it('exhausts all attempts when transient errors persist', async () => {
      vi.useFakeTimers();
      try {
        const fastAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
          maxStartupAttempts: 3,
          startupRetryBaseDelayMs: 10,
          startupRetryMaxDelayMs: 50,
        });

        let attemptCount = 0;
        let caughtError: unknown = null;

        const retryPromise = fastAdapter
          .executeWithStartupRetry(async () => {
            attemptCount++;
            throw Object.assign(new Error('Continuous timeout'), { code: 'ETIMEDOUT' });
          }, 'Test Operation 4')
          .catch(error => {
            caughtError = error;
          });

        await vi.runAllTimersAsync();
        await retryPromise;

        expect(attemptCount).toBe(3);
        expect((caughtError as { code?: string })?.code).toBe('ETIMEDOUT');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('whitelist authorization gates (fail-closed)', () => {
    it('rejects arbitrary senders when allowlist is missing', () => {
      const emptyAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '', dummyCallback);
      expect(emptyAllowlistAdapter.isAuthorizedSender('123456789')).toBe(false);
    });

    it('blocks inbound message middleware when allowlist is empty', async () => {
      const emptyAllowlistAdapter = new TelegramMessagingAdapter(dummyToken, '', dummyCallback);
      let nextInvoked = false;
      const mockContext: Partial<Context> = {
        from: { id: 123456789, is_bot: false, first_name: 'Attacker' },
      };

      await emptyAllowlistAdapter.handleInboundMiddleware(mockContext as Context, async () => {
        nextInvoked = true;
      });

      expect(nextInvoked).toBe(false);
    });

    it('authorizes whitelisted user ID and rejects unauthorized user ID', () => {
      const configuredAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);

      expect(configuredAdapter.isAuthorizedSender(dummyUserId)).toBe(true);
      expect(configuredAdapter.isAuthorizedSender('999999999')).toBe(false);
    });

    it('invokes next() in inbound middleware for whitelisted user ID', async () => {
      const configuredAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      let nextInvoked = false;
      const mockContext: Partial<Context> = {
        from: { id: Number(dummyUserId), is_bot: false, first_name: 'Owner' },
      };

      await configuredAdapter.handleInboundMiddleware(mockContext as Context, async () => {
        nextInvoked = true;
      });

      expect(nextInvoked).toBe(true);
    });

    it('blocks inbound middleware for unauthorized sender', async () => {
      const configuredAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      let nextInvoked = false;
      const mockContext: Partial<Context> = {
        from: { id: 999999999, is_bot: false, first_name: 'Stranger' },
      };

      await configuredAdapter.handleInboundMiddleware(mockContext as Context, async () => {
        nextInvoked = true;
      });

      expect(nextInvoked).toBe(false);
    });
  });

  describe('editTextMessage and editBroadcastNotification', () => {
    it('returns false when botInstance is not initialized or messageId is invalid', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      expect(await adapter.editTextMessage('123', 'invalid-id', 'test')).toBe(false);
      expect(await adapter.editBroadcastNotification('invalid-id', 'test')).toBe(false);
    });

    it('edits message successfully using botInstance.api.editMessageText', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      const mockEditMessageText = vi.fn().mockResolvedValue({});
      (adapter as any).botInstance = {
        api: {
          editMessageText: mockEditMessageText,
        },
      };

      const result = await adapter.editTextMessage('123456789', '42', '*Updated*');
      expect(result).toBe(true);
      expect(mockEditMessageText).toHaveBeenCalledWith(
        '123456789',
        42,
        '<b>Updated</b>',
        { parse_mode: 'HTML' }
      );
    });

    it('treats "message is not modified" error as success', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      (adapter as any).botInstance = {
        api: {
          editMessageText: vi.fn().mockRejectedValue(new Error('Bad Request: message is not modified')),
        },
      };

      const result = await adapter.editTextMessage('123456789', '42', 'Same');
      expect(result).toBe(true);
    });

    it('falls back to plain text edit when HTML edit fails', async () => {
      const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
      const mockEdit = vi
        .fn()
        .mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'))
        .mockResolvedValueOnce({});
      (adapter as any).botInstance = {
        api: {
          editMessageText: mockEdit,
        },
      };

      const result = await adapter.editTextMessage('123456789', '42', 'Text with <unclosed tag');
      expect(result).toBe(true);
      expect(mockEdit).toHaveBeenCalledTimes(2);
    });
  });
});
