import { GrammyError, HttpError } from 'grammy';
import { TelegramMessagingAdapter } from '../src/services/messaging/telegramAdapter.js';

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
  console.log('[INFO] Running Telegram Connection Resilience & Safeguards Test Suite');
  console.log('====================================================\n');

  const dummyToken = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ';
  const dummyUserId = '123456789';
  const dummyCallback = async () => {};

  // ----------------------------------------------------
  // TEST GROUP 1: Configuration & Default Values
  // ----------------------------------------------------
  console.log('[TEST GROUP 1] Configuration & Default Values');
  {
    const defaultAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);
    assertCondition('TG-1.1: Default maxStartupAttempts is 5', defaultAdapter.getMaxStartupAttempts() === 5);
    assertCondition('TG-1.2: Default startupRetryBaseDelayMs is 2000', defaultAdapter.getStartupRetryBaseDelayMs() === 2000);
    assertCondition('TG-1.3: Default startupRetryMaxDelayMs is 15000', defaultAdapter.getStartupRetryMaxDelayMs() === 15000);
    assertCondition('TG-1.4: Initial connection state is idle', defaultAdapter.getConnectionState() === 'idle');
    assertCondition('TG-1.8: Default maxMediaDownloadBytes is 10 MB (10485760 bytes)', defaultAdapter.getMaxMediaDownloadBytes() === 10 * 1024 * 1024);

    const customAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
      maxStartupAttempts: 8,
      startupRetryBaseDelayMs: 1000,
      startupRetryMaxDelayMs: 30000,
      maxMediaDownloadBytes: 5 * 1024 * 1024,
    });
    assertCondition('TG-1.5: Custom maxStartupAttempts is respected', customAdapter.getMaxStartupAttempts() === 8);
    assertCondition('TG-1.6: Custom startupRetryBaseDelayMs is respected', customAdapter.getStartupRetryBaseDelayMs() === 1000);
    assertCondition('TG-1.7: Custom startupRetryMaxDelayMs is respected', customAdapter.getStartupRetryMaxDelayMs() === 30000);
    assertCondition('TG-1.9: Custom maxMediaDownloadBytes is respected', customAdapter.getMaxMediaDownloadBytes() === 5 * 1024 * 1024);
  }

  // ----------------------------------------------------
  // TEST GROUP 2: Backoff Delay Math & Jitter Bounds
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 2] Backoff Delay Math & Jitter Bounds');
  {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
      maxStartupAttempts: 5,
      startupRetryBaseDelayMs: 2000,
      startupRetryMaxDelayMs: 15000,
    });

    const delayAttempt0 = adapter.calculateBackoffDelayMilliseconds(0);
    const delayAttempt1 = adapter.calculateBackoffDelayMilliseconds(1);
    const delayAttempt2 = adapter.calculateBackoffDelayMilliseconds(2);
    const delayAttempt5 = adapter.calculateBackoffDelayMilliseconds(5);

    // Attempt 0: 2000 * 2^0 = 2000 + jitter (500-1500ms) -> 2500 - 3500ms
    assertCondition(
      'TG-2.1: Attempt 0 delay within expected bounds (2500 - 3500ms)',
      delayAttempt0 >= 2500 && delayAttempt0 <= 3500,
      `Actual: ${delayAttempt0}`
    );

    // Attempt 1: 2000 * 2^1 = 4000 + jitter (500-1500ms) -> 4500 - 5500ms
    assertCondition(
      'TG-2.2: Attempt 1 delay within expected bounds (4500 - 5500ms)',
      delayAttempt1 >= 4500 && delayAttempt1 <= 5500,
      `Actual: ${delayAttempt1}`
    );

    // Attempt 2: 2000 * 2^2 = 8000 + jitter (500-1500ms) -> 8500 - 9500ms
    assertCondition(
      'TG-2.3: Attempt 2 delay within expected bounds (8500 - 9500ms)',
      delayAttempt2 >= 8500 && delayAttempt2 <= 9500,
      `Actual: ${delayAttempt2}`
    );

    // Attempt 5: bounded by max (15000) + jitter (500-1500ms) -> 15500 - 16500ms
    assertCondition(
      'TG-2.4: High attempt delay is properly capped at max delay + jitter (15500 - 16500ms)',
      delayAttempt5 >= 15500 && delayAttempt5 <= 16500,
      `Actual: ${delayAttempt5}`
    );
  }

  // ----------------------------------------------------
  // TEST GROUP 3: Error Classification (Transient vs Permanent)
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 3] Transient vs Permanent Error Classification');
  {
    const adapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback);

    // Grammy HttpError (network level failure)
    const httpError = new HttpError('Network request for getMe failed', new Error('getaddrinfo EAI_AGAIN'));
    assertCondition('TG-3.1: Grammy HttpError is retryable', adapter.isRetryableNetworkError(httpError) === true);

    // GrammyError 401 Unauthorized (invalid token) -> NEVER retry
    const unauthorizedError = new GrammyError(
      'Unauthorized',
      { ok: false, error_code: 401, description: 'Unauthorized' },
      'getMe',
      {}
    );
    assertCondition('TG-3.2: GrammyError 401 Unauthorized is NOT retryable', adapter.isRetryableNetworkError(unauthorizedError) === false);

    // GrammyError 404 Not Found -> NEVER retry
    const notFoundError = new GrammyError(
      'Not Found',
      { ok: false, error_code: 404, description: 'Not Found' },
      'getMe',
      {}
    );
    assertCondition('TG-3.3: GrammyError 404 Not Found is NOT retryable', adapter.isRetryableNetworkError(notFoundError) === false);

    // GrammyError 429 Too Many Requests -> RETRYABLE
    const rateLimitError = new GrammyError(
      'Too Many Requests',
      { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5' },
      'getMe',
      {}
    );
    assertCondition('TG-3.4: GrammyError 429 Rate Limited is retryable', adapter.isRetryableNetworkError(rateLimitError) === true);

    // GrammyError 502 Bad Gateway -> RETRYABLE
    const badGatewayError = new GrammyError(
      'Bad Gateway',
      { ok: false, error_code: 502, description: 'Bad Gateway' },
      'getMe',
      {}
    );
    assertCondition('TG-3.5: GrammyError 502 Bad Gateway is retryable', adapter.isRetryableNetworkError(badGatewayError) === true);

    // Node network error codes
    const econnresetError = Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
    assertCondition('TG-3.6: ECONNRESET error code is retryable', adapter.isRetryableNetworkError(econnresetError) === true);

    const etimedoutError = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
    assertCondition('TG-3.7: ETIMEDOUT error code is retryable', adapter.isRetryableNetworkError(etimedoutError) === true);

    const eaiAgainError = Object.assign(new Error('DNS lookup temporary failure'), { code: 'EAI_AGAIN' });
    assertCondition('TG-3.8: EAI_AGAIN error code is retryable', adapter.isRetryableNetworkError(eaiAgainError) === true);

    const enotfoundError = Object.assign(new Error('DNS lookup host not found'), { code: 'ENOTFOUND' });
    assertCondition('TG-3.9: ENOTFOUND error code is retryable', adapter.isRetryableNetworkError(enotfoundError) === true);

    // Message substring fallback
    const networkMessageError = new Error("HttpError: Network request for 'getMe' failed!");
    assertCondition('TG-3.10: Error with Network request substring is retryable', adapter.isRetryableNetworkError(networkMessageError) === true);

    // Non-retryable standard errors
    const typeError = new TypeError('Cannot read property of undefined');
    assertCondition('TG-3.11: TypeError is NOT retryable', adapter.isRetryableNetworkError(typeError) === false);

    assertCondition('TG-3.12: Null error is NOT retryable', adapter.isRetryableNetworkError(null) === false);
  }

  // ----------------------------------------------------
  // TEST GROUP 4: Retry Execution Loop
  // ----------------------------------------------------
  console.log('\n[TEST GROUP 4] Retry Execution Loop (executeWithStartupRetry)');
  {
    // Fast adapter with 10ms base delay for instant test execution
    const fastAdapter = new TelegramMessagingAdapter(dummyToken, dummyUserId, dummyCallback, {
      maxStartupAttempts: 3,
      startupRetryBaseDelayMs: 10,
      startupRetryMaxDelayMs: 50,
    });

    // 1. Success on first try
    let attemptCounter1 = 0;
    const result1 = await fastAdapter.executeWithStartupRetry(async () => {
      attemptCounter1++;
      return { botId: 12345 };
    }, 'Test Operation 1');
    assertCondition('TG-4.1: Operation succeeds on first attempt', result1.botId === 12345 && attemptCounter1 === 1);

    // 2. Success on 3rd attempt after 2 transient failures
    let attemptCounter2 = 0;
    const result2 = await fastAdapter.executeWithStartupRetry(async () => {
      attemptCounter2++;
      if (attemptCounter2 < 3) {
        throw Object.assign(new Error('DNS failure'), { code: 'EAI_AGAIN' });
      }
      return { botId: 99999 };
    }, 'Test Operation 2');
    assertCondition('TG-4.2: Operation recovers and succeeds after transient failures', result2.botId === 99999 && attemptCounter2 === 3);

    // 3. Immediate failure on non-retryable 401 error
    let attemptCounter3 = 0;
    let errorCaught3: unknown = null;
    try {
      await fastAdapter.executeWithStartupRetry(async () => {
        attemptCounter3++;
        throw new GrammyError(
          'Unauthorized',
          { ok: false, error_code: 401, description: 'Unauthorized' },
          'getMe',
          {}
        );
      }, 'Test Operation 3');
    } catch (error) {
      errorCaught3 = error;
    }
    assertCondition(
      'TG-4.3: Non-retryable 401 error terminates immediately without retrying',
      attemptCounter3 === 1 && errorCaught3 instanceof GrammyError && errorCaught3.error_code === 401
    );

    // 4. Exhaustion failure after max attempts
    let attemptCounter4 = 0;
    let errorCaught4: unknown = null;
    try {
      await fastAdapter.executeWithStartupRetry(async () => {
        attemptCounter4++;
        throw Object.assign(new Error('Continuous timeout'), { code: 'ETIMEDOUT' });
      }, 'Test Operation 4');
    } catch (error) {
      errorCaught4 = error;
    }
    assertCondition(
      'TG-4.4: Retry loop exhausts all attempts when transient error persists',
      attemptCounter4 === 3 && (errorCaught4 as { code?: string })?.code === 'ETIMEDOUT'
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
    console.log('[SUCCESS] All Telegram resilience & safeguard test cases passed!\n');
    process.exit(0);
  }
}

runTestSuite().catch(suiteError => {
  console.error(`[ERROR] Test suite execution failed: ${suiteError}`);
  process.exit(1);
});
