import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve('tsx/cli');

interface TestSuiteDefinition {
  readonly filePath: string;
  readonly description: string;
}

interface TestSuiteExecutionResult {
  readonly suite: TestSuiteDefinition;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly output: string;
}

const OFFLINE_TEST_SUITES: readonly TestSuiteDefinition[] = [
  { filePath: 'tests/bankEmailRules.test.ts', description: 'Bank email parsing rules, currency parser & confirmation intent detector' },
  { filePath: 'tests/emailSenderDomainValidation.test.ts', description: 'Bank email sender domain spoofing & malformed angle-bracket rejection' },
  { filePath: 'tests/budgetParsing.test.ts', description: 'Budget schema normalization & closed budget filtering' },
  { filePath: 'tests/emailListenerPersistence.test.ts', description: 'Email transactional dedup persistence & downstream failure recovery (Issue #75)' },
  { filePath: 'tests/fallbackAiProvider.test.ts', description: 'Fallback AI provider cascading failover & error classification' },
  { filePath: 'tests/humanResponseFormatter.test.ts', description: 'Human-facing WhatsApp message formatting & localized responses' },
  { filePath: 'tests/loggerRedaction.test.ts', description: 'Logger credential redaction for tokens, passwords, and secrets' },
  { filePath: 'tests/loggerSanitizer.test.ts', description: 'Logger PAN and bank account number masking & circular reference safety' },
  { filePath: 'tests/mediaDownloadLimits.test.ts', description: 'Media buffer size exhaustion safeguards & stream constraints' },
  { filePath: 'tests/messageFormatHelper.test.ts', description: 'WhatsApp-to-Telegram markup conversion & text sanitization' },
  { filePath: 'tests/messagingGatewayResilience.test.ts', description: 'Multi-adapter gateway lifecycle, degraded mode & background reconnection' },
  { filePath: 'tests/accountClarificationDraft.test.ts', description: 'Pending account clarification drafts and safe finalization (Issue #81)' },
  { filePath: 'tests/accountClarificationUnknownDismissal.test.ts', description: 'UNKNOWN clarification reconciliation and ticket-specific safe dismissal (Issue #81)' },
  { filePath: 'tests/accountClarificationPendingRouting.test.ts', description: 'Ticket-specific standard pending commands bypass unrelated clarification drafts (Issue #81)' },
  { filePath: 'tests/pendingActionHandler.test.ts', description: 'Pending transaction data integrity & MCP failure recovery (Issue #72)' },
  { filePath: 'tests/phoneNumberNormalization.test.ts', description: 'International E.164 phone normalization, domestic prefix detection & Indonesian 08 conversion' },
  { filePath: 'tests/receiptOcrPrompt.test.ts', description: 'Receipt vision OCR system instructions, timezone offset & QRIS rules' },
  { filePath: 'tests/recordValidator.test.ts', description: 'Deterministic account resolution & fail-closed ambiguity handling (Issue #73)' },
  { filePath: 'tests/responseDictionary.test.ts', description: 'Multi-language dictionary resolution & missing token fallbacks' },
  { filePath: 'tests/telegramSafeguards.test.ts', description: 'Telegram rate limiting & unauthorized user whitelist gates' },
  { filePath: 'tests/whatsappSafeguards.test.ts', description: 'WhatsApp exponential backoff, circuit breaker & ban safeguards' },
  { filePath: 'tests/whatsappSocketHardening.test.ts', description: 'WhatsApp Baileys socket options & typing presence debouncing' },
];

const isVerboseMode = process.argv.includes('--verbose') || process.argv.includes('-v');

async function executeSingleSuite(suite: TestSuiteDefinition, suiteIndex: number, totalSuites: number): Promise<TestSuiteExecutionResult> {
  const startTime = Date.now();
  const targetScriptPath = path.resolve(process.cwd(), suite.filePath);

  console.log(`[RUN] [${suiteIndex + 1}/${totalSuites}] ${suite.filePath} - ${suite.description}`);

  return new Promise<TestSuiteExecutionResult>((resolve) => {
    let capturedOutput = '';

    const childProcess = spawn(process.execPath, [tsxCliPath, targetScriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, CI: process.env.CI || 'true' },
    });

    childProcess.stdout.on('data', (chunk: Buffer) => {
      const textChunk = chunk.toString();
      capturedOutput += textChunk;
      if (isVerboseMode) {
        process.stdout.write(textChunk);
      }
    });

    childProcess.stderr.on('data', (chunk: Buffer) => {
      const textChunk = chunk.toString();
      capturedOutput += textChunk;
      if (isVerboseMode) {
        process.stderr.write(textChunk);
      }
    });

    childProcess.on('error', (error: Error) => {
      const durationMs = Date.now() - startTime;
      capturedOutput += `\n[ERROR] Failed to spawn process: ${error.message}\n`;
      console.error(`  [FAIL] ${suite.filePath} (${durationMs}ms) - Process spawn failed: ${error.message}`);
      resolve({
        suite,
        passed: false,
        durationMs,
        exitCode: 1,
        output: capturedOutput,
      });
    });

    childProcess.on('close', (exitCode: number | null) => {
      const durationMs = Date.now() - startTime;
      const isPassed = exitCode === 0;

      if (isPassed) {
        console.log(`  [PASS] ${suite.filePath} (${durationMs}ms)`);
      } else {
        console.error(`  [FAIL] ${suite.filePath} (${durationMs}ms) with exit code ${exitCode}`);
        if (!isVerboseMode) {
          console.error('\n--- Test Failure Output ---');
          console.error(capturedOutput.trim());
          console.error('--- End Failure Output ---\n');
        }
      }

      resolve({
        suite,
        passed: isPassed,
        durationMs,
        exitCode,
        output: capturedOutput,
      });
    });
  });
}

async function runAllOfflineSuites(): Promise<void> {
  const suiteStartTime = Date.now();

  console.log('================================================================');
  console.log('[INFO] Starting Unified Offline Test Runner');
  console.log(`[INFO] Registered Suites: ${OFFLINE_TEST_SUITES.length} hermetic suites`);
  console.log(`[INFO] Verbose Output:    ${isVerboseMode ? 'ENABLED' : 'DISABLED (use --verbose to view all sub-logs)'}`);
  console.log('================================================================\n');

  const executionResults: TestSuiteExecutionResult[] = [];

  for (let index = 0; index < OFFLINE_TEST_SUITES.length; index++) {
    const currentSuite = OFFLINE_TEST_SUITES[index];
    const result = await executeSingleSuite(currentSuite, index, OFFLINE_TEST_SUITES.length);
    executionResults.push(result);
  }

  const totalDurationMs = Date.now() - suiteStartTime;
  const passedCount = executionResults.filter(r => r.passed).length;
  const failedCount = executionResults.filter(r => !r.passed).length;

  console.log('\n================================================================');
  console.log('[TEST SUMMARY] Execution Breakdown');
  console.log('================================================================');

  for (const item of executionResults) {
    const statusTag = item.passed ? '[PASS]' : '[FAIL]';
    const durationFormatted = `${(item.durationMs / 1000).toFixed(2)}s`.padStart(6);
    console.log(`${statusTag} ${durationFormatted} | ${item.suite.filePath}`);
  }

  console.log('----------------------------------------------------------------');
  console.log(`Total Suites: ${executionResults.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
  console.log(`Total Elapsed Time: ${(totalDurationMs / 1000).toFixed(2)}s`);
  console.log('================================================================');

  if (failedCount === 0) {
    console.log('[SUCCESS] All offline test suites passed cleanly!\n');
    process.exit(0);
  } else {
    console.error(`[ERROR] ${failedCount} test suite(s) failed. See details above.\n`);
    process.exit(1);
  }
}

runAllOfflineSuites().catch((error: unknown) => {
  console.error('[FATAL] Unhandled exception in test runner:', error);
  process.exit(1);
});
