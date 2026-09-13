import { describe, expect, it } from 'vitest';
import { redactSensitiveData, sanitizeLogArgument } from '../src/utils/logger.js';

describe('logger redaction', () => {
  it.each([
    {
      name: 'redacts a standalone Telegram bot token',
      input: 'Failed to connect: 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
      expectedSubstrings: ['[REDACTED_TELEGRAM_TOKEN]'],
      forbiddenSubstrings: ['1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'],
    },
    {
      name: 'redacts a Telegram bot token within a URL',
      input: 'Request failed for https://api.telegram.org/file/bot1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789/photos/file_0.jpg',
      expectedSubstrings: ['https://api.telegram.org/file/[REDACTED_TELEGRAM_TOKEN]/photos/file_0.jpg'],
      forbiddenSubstrings: ['1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'],
    },
    {
      name: 'redacts a Bearer authorization token',
      input: 'Headers: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.doNotLeakThis',
      expectedSubstrings: ['Bearer [REDACTED_TOKEN]'],
      forbiddenSubstrings: ['doNotLeakThis'],
    },
    {
      name: 'redacts key-value credentials in log strings',
      input: 'Config: access_token="secret_value_123", password=supersecret, token: my_secret_token',
      expectedSubstrings: ['access_token="[REDACTED]"', 'password=[REDACTED]', 'token: [REDACTED]'],
      forbiddenSubstrings: ['secret_value_123', 'supersecret', 'my_secret_token'],
    },
  ])('$name', ({ input, expectedSubstrings, forbiddenSubstrings }) => {
    const redactedOutput = redactSensitiveData(input);

    for (const expectedSubstring of expectedSubstrings) {
      expect(redactedOutput).toContain(expectedSubstring);
    }

    for (const forbiddenSubstring of forbiddenSubstrings) {
      expect(redactedOutput).not.toContain(forbiddenSubstring);
    }
  });

  it('sanitizes sensitive data inside Error objects', () => {
    const sensitiveError = new Error(
      'HTTP 401: Invalid token 1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'
    );

    const sanitizedError = sanitizeLogArgument(sensitiveError) as Error;

    expect(sanitizedError.message).toContain('[REDACTED_TELEGRAM_TOKEN]');
    expect(sanitizedError.message).not.toContain(
      '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'
    );
  });

  it('sanitizes sensitive data inside nested objects', () => {
    const sensitivePayload = {
      auth: {
        telegramToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789',
        password: 'plain_password',
      },
      status: 'ok',
    };

    const sanitizedPayload = sanitizeLogArgument(sensitivePayload) as typeof sensitivePayload;

    expect(JSON.stringify(sanitizedPayload)).not.toContain(
      '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz123456789'
    );
  });

  it('escapes regular-expression metacharacters in literal version strings', () => {
    const specialVersionString = '1.0.0-rc.1+build(2)[foo]*bar?\\baz$qux^test';
    const escapedVersion = specialVersionString.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
    const testRegex = new RegExp(`^${escapedVersion}$`);

    expect(testRegex.test(specialVersionString)).toBe(true);
  });
});
