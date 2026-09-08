import { redactSensitiveData, sanitizeLogArgument } from '../src/utils/logger.js';

function runLoggerRedactionTests(): void {
  console.log('[TEST] Starting Logger Redaction and Sanitization Tests');

  let allTestsPassed = true;

  const testCases = [
    {
      name: 'Redact standalone Telegram bot token',
      input: 'Failed to connect: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
      expectedSubstrings: ['[REDACTED_TELEGRAM_TOKEN]'],
      forbiddenSubstrings: ['1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'],
    },
    {
      name: 'Redact Telegram bot token within URL',
      input: 'Request failed for https://api.telegram.org/file/bot1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789/photos/file_0.jpg',
      expectedSubstrings: ['https://api.telegram.org/file/[REDACTED_TELEGRAM_TOKEN]/photos/file_0.jpg'],
      forbiddenSubstrings: ['1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'],
    },
    {
      name: 'Redact Bearer Authorization Token',
      input: 'Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis',
      expectedSubstrings: ['Bearer [REDACTED_TOKEN]'],
      forbiddenSubstrings: ['doNotLeakThis'],
    },
    {
      name: 'Redact key-value credentials in config or log strings',
      input: 'Config: access_token="secret_value_123", password=supersecret, token: my_secret_token',
      expectedSubstrings: ['access_token="[REDACTED]"', 'password=[REDACTED]', 'token: [REDACTED]'],
      forbiddenSubstrings: ['secret_value_123', 'supersecret', 'my_secret_token'],
    },
  ];

  for (const testCase of testCases) {
    const redactedOutput = redactSensitiveData(testCase.input);
    console.log(`\n[RUN] ${testCase.name}`);
    console.log(`Input:  ${testCase.input}`);
    console.log(`Output: ${redactedOutput}`);

    for (const expectedSubstring of testCase.expectedSubstrings) {
      if (!redactedOutput.includes(expectedSubstring)) {
        console.error(`[FAIL] Expected output to contain '${expectedSubstring}'`);
        allTestsPassed = false;
      }
    }

    for (const forbiddenSubstring of testCase.forbiddenSubstrings) {
      if (redactedOutput.includes(forbiddenSubstring)) {
        console.error(`[FAIL] Expected output to NOT contain '${forbiddenSubstring}'`);
        allTestsPassed = false;
      }
    }
  }

  // Test sanitizeLogArgument with Error object
  console.log('\n[RUN] Sanitize Error Object');
  const sensitiveError = new Error('HTTP 401: Invalid token 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789');
  const sanitizedError = sanitizeLogArgument(sensitiveError) as Error;

  if (sanitizedError.message.includes('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789')) {
    console.error('[FAIL] Error message was not sanitized');
    allTestsPassed = false;
  } else if (!sanitizedError.message.includes('[REDACTED_TELEGRAM_TOKEN]')) {
    console.error('[FAIL] Error message does not contain [REDACTED_TELEGRAM_TOKEN]');
    allTestsPassed = false;
  }

  // Test sanitizeLogArgument with nested object
  console.log('\n[RUN] Sanitize Nested Object');
  const sensitivePayload = {
    auth: {
      telegramToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
      password: 'plain_password',
    },
    status: 'ok',
  };
  const sanitizedPayload = sanitizeLogArgument(sensitivePayload) as typeof sensitivePayload;

  if (JSON.stringify(sanitizedPayload).includes('1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789')) {
    console.error('[FAIL] Nested object still contains telegram token');
    allTestsPassed = false;
  }

  // Test Regex Metacharacter Escaping for release notes
  console.log('\n[RUN] Regex Metacharacter Escaping');
  const specialVersionString = '1.0.0-rc.1+build(2)[foo]*bar?\\baz$qux^test';
  const escapedVersion = specialVersionString.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
  const testRegex = new RegExp(`^${escapedVersion}$`);

  if (!testRegex.test(specialVersionString)) {
    console.error('[FAIL] Regex failed to match literal string after escaping');
    allTestsPassed = false;
  } else {
    console.log('[PASS] Regex metacharacter escaping verified successfully');
  }

  if (!allTestsPassed) {
    console.error('\n[FAIL] Some logger redaction tests failed.');
    process.exit(1);
  }

  console.log('\n[PASS] All logger redaction tests passed successfully.');
}

runLoggerRedactionTests();
