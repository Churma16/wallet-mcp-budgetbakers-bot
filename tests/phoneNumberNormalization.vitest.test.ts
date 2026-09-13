import { afterEach, describe, expect, it } from 'vitest';
import {
  loadEnvironmentConfiguration,
  normalizePhoneNumber,
} from '../src/config/environmentConfig.js';

interface NormalizationCase {
  readonly name: string;
  readonly rawNumber: string;
  readonly expectedDigits: string;
  readonly defaultCurrency?: string;
  readonly appTimezone?: string;
  readonly appLanguage?: string;
}

interface RejectionCase {
  readonly name: string;
  readonly rawNumber: string;
  readonly expectedMessageSubstring: string;
  readonly defaultCurrency?: string;
  readonly appTimezone?: string;
  readonly appLanguage?: string;
}

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('normalizePhoneNumber', () => {
  describe('global non-digit sanitization', () => {
    it.each<NormalizationCase>([
      {
        name: 'strips formatting from a US number',
        rawNumber: '+1 (415) 555-2671',
        expectedDigits: '14155552671',
      },
      {
        name: 'strips formatting from a UK number',
        rawNumber: '+44 7911 123456',
        expectedDigits: '447911123456',
      },
      {
        name: 'strips formatting from a Singapore number',
        rawNumber: '+65 9123 4567',
        expectedDigits: '6591234567',
      },
      {
        name: 'strips formatting from an Indonesian number',
        rawNumber: '+62 812-3456-7890',
        expectedDigits: '6281234567890',
      },
      {
        name: 'strips parentheses and dots',
        rawNumber: '(+1) 415.555.2671',
        expectedDigits: '14155552671',
      },
      {
        name: 'removes a parenthesized UK trunk zero',
        rawNumber: '+44 (0) 7911 123456',
        expectedDigits: '447911123456',
      },
      {
        name: 'removes a parenthesized Australian trunk zero',
        rawNumber: '+61 (0) 412 345 678',
        expectedDigits: '61412345678',
      },
      {
        name: 'removes a parenthesized Indonesian trunk zero',
        rawNumber: '+62 (0812) 3456-7890',
        expectedDigits: '6281234567890',
      },
    ])('$name', ({ rawNumber, expectedDigits, defaultCurrency, appTimezone, appLanguage }) => {
      expect(
        normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone, appLanguage)
      ).toBe(expectedDigits);
    });
  });

  describe('already normalized E.164 numbers', () => {
    it.each<NormalizationCase>([
      { name: 'preserves US digits', rawNumber: '14155552671', expectedDigits: '14155552671' },
      { name: 'preserves UK digits', rawNumber: '447911123456', expectedDigits: '447911123456' },
      { name: 'preserves Singapore digits', rawNumber: '6591234567', expectedDigits: '6591234567' },
      { name: 'preserves Indonesian digits', rawNumber: '6281234567890', expectedDigits: '6281234567890' },
      {
        name: 'strips a WhatsApp JID suffix before sanitization',
        rawNumber: '6281234567890@s.whatsapp.net',
        expectedDigits: '6281234567890',
      },
      {
        name: 'strips an arbitrary domain suffix before sanitization',
        rawNumber: '6281234567890@c.us',
        expectedDigits: '6281234567890',
      },
    ])('$name', ({ rawNumber, expectedDigits, defaultCurrency, appTimezone, appLanguage }) => {
      expect(
        normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone, appLanguage)
      ).toBe(expectedDigits);
    });
  });

  describe('Indonesian domestic trunk conversion', () => {
    it.each<NormalizationCase>([
      {
        name: 'uses IDR currency context for 08 to 628 conversion',
        rawNumber: '0812-3456-7890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'IDR',
      },
      {
        name: 'uses Asia/Jakarta timezone context for 08 to 628 conversion',
        rawNumber: '081234567890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'USD',
        appTimezone: 'Asia/Jakarta',
      },
      {
        name: 'uses IDR and Jakarta context for formatted 08 input',
        rawNumber: '08 12 3456 7890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'IDR',
        appTimezone: 'Asia/Jakarta',
      },
      {
        name: 'uses Asia/Makassar timezone context for 08 to 628 conversion',
        rawNumber: '081234567890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'USD',
        appTimezone: 'Asia/Makassar',
      },
      {
        name: 'uses Asia/Jayapura timezone context for 08 to 628 conversion',
        rawNumber: '081234567890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'USD',
        appTimezone: 'Asia/Jayapura',
      },
      {
        name: 'uses Asia/Pontianak timezone context for 08 to 628 conversion',
        rawNumber: '081234567890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'USD',
        appTimezone: 'Asia/Pontianak',
      },
      {
        name: 'uses Indonesian language context for 08 to 628 conversion',
        rawNumber: '081234567890',
        expectedDigits: '6281234567890',
        defaultCurrency: 'USD',
        appTimezone: 'America/New_York',
        appLanguage: 'id',
      },
    ])('$name', ({ rawNumber, expectedDigits, defaultCurrency, appTimezone, appLanguage }) => {
      expect(
        normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone, appLanguage)
      ).toBe(expectedDigits);
    });
  });

  describe('domestic trunk prefix rejection', () => {
    it.each<RejectionCase>([
      {
        name: 'rejects a UK 07 prefix outside Indonesian context',
        rawNumber: '07911 123456',
        defaultCurrency: 'GBP',
        appTimezone: 'Europe/London',
        expectedMessageSubstring: 'cannot start with',
      },
      {
        name: 'rejects an Australian 04 prefix outside Indonesian context',
        rawNumber: '0412 345 678',
        defaultCurrency: 'AUD',
        appTimezone: 'Australia/Sydney',
        expectedMessageSubstring: 'cannot start with',
      },
      {
        name: 'rejects an Indonesian 08 prefix outside Indonesian context',
        rawNumber: '081234567890',
        defaultCurrency: 'USD',
        appTimezone: 'America/New_York',
        expectedMessageSubstring: 'cannot start with',
      },
      {
        name: 'rejects an unresolvable 01 prefix',
        rawNumber: '0151 1234567',
        defaultCurrency: 'EUR',
        appTimezone: 'Europe/Berlin',
        expectedMessageSubstring: 'E.164',
      },
      {
        name: 'rejects a leading zero without regional context',
        rawNumber: '081234567890',
        expectedMessageSubstring: 'cannot start with',
      },
      {
        name: 'does not treat English response language as Indonesian context',
        rawNumber: '081234567890',
        defaultCurrency: 'USD',
        appTimezone: 'America/New_York',
        appLanguage: 'en',
        expectedMessageSubstring: 'cannot start with',
      },
    ])('$name', ({ rawNumber, expectedMessageSubstring, defaultCurrency, appTimezone, appLanguage }) => {
      expect(() =>
        normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone, appLanguage)
      ).toThrow(expectedMessageSubstring);
    });
  });

  describe('ITU-T E.164 length constraints', () => {
    it.each<NormalizationCase>([
      { name: 'accepts the seven-digit minimum', rawNumber: '1234567', expectedDigits: '1234567' },
      {
        name: 'accepts the fifteen-digit maximum',
        rawNumber: '123456789012345',
        expectedDigits: '123456789012345',
      },
    ])('$name', ({ rawNumber, expectedDigits }) => {
      expect(normalizePhoneNumber(rawNumber)).toBe(expectedDigits);
    });

    it.each<RejectionCase>([
      {
        name: 'rejects six digits below the E.164 minimum',
        rawNumber: '123456',
        defaultCurrency: 'USD',
        appTimezone: 'America/New_York',
        expectedMessageSubstring: '7 and 15 digits',
      },
      {
        name: 'rejects sixteen digits above the E.164 maximum',
        rawNumber: '1234567890123456',
        defaultCurrency: 'USD',
        appTimezone: 'America/New_York',
        expectedMessageSubstring: '7 and 15 digits',
      },
    ])('$name', ({ rawNumber, expectedMessageSubstring, defaultCurrency, appTimezone }) => {
      expect(() => normalizePhoneNumber(rawNumber, defaultCurrency, appTimezone)).toThrow(
        expectedMessageSubstring
      );
    });
  });

  describe('empty input handling', () => {
    it.each<NormalizationCase>([
      { name: 'returns empty for an empty string', rawNumber: '', expectedDigits: '' },
      { name: 'returns empty for whitespace-only input', rawNumber: '   ', expectedDigits: '' },
    ])('$name', ({ rawNumber, expectedDigits }) => {
      expect(normalizePhoneNumber(rawNumber)).toBe(expectedDigits);
    });
  });

  describe('actionable error messages', () => {
    it('includes international examples for leading-zero errors', () => {
      expect(() => normalizePhoneNumber('07911 123456', 'GBP', 'Europe/London')).toThrow(
        '6281234567890 for ID'
      );
    });

    it('explains the ITU-T E.164 constraint for invalid lengths', () => {
      expect(() => normalizePhoneNumber('123456', 'USD', 'America/New_York')).toThrow(
        'comply with the ITU-T E.164 standard'
      );
    });
  });
});

describe('loadEnvironmentConfiguration numeric parsing', () => {
  it('parses custom numeric environment values', () => {
    process.env.GEMINI_TIMEOUT_SECONDS = '35';
    process.env.AI_TIMEOUT_SECONDS = '45';
    process.env.LOG_RETENTION_DAYS = '14';
    process.env.EMAIL_IMAP_PORT = '995';
    process.env.EMAIL_LOOKBACK_MINUTES = '15';
    process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS = '8';
    process.env.WHATSAPP_RECONNECT_MAX_BACKOFF_SECONDS = '600';
    process.env.WHATSAPP_MESSAGE_QUEUE_INTERVAL_MS = '2000';
    process.env.WHATSAPP_TYPING_PRESENCE_COOLDOWN_MS = '3000';
    process.env.TELEGRAM_MAX_STARTUP_ATTEMPTS = '7';
    process.env.TELEGRAM_STARTUP_RETRY_DELAY_MS = '2500';
    process.env.MAX_MEDIA_DOWNLOAD_MB = '25';
    process.env.ALLOWED_PHONE_NUMBER = '628123456789';

    const configuration = loadEnvironmentConfiguration();

    expect(configuration.geminiRequestTimeoutMilliseconds).toBe(35000);
    expect(configuration.aiRequestTimeoutMilliseconds).toBe(45000);
    expect(configuration.logRetentionDays).toBe(14);
    expect(configuration.emailImapPort).toBe(995);
    expect(configuration.emailLookbackMinutes).toBe(15);
    expect(configuration.whatsappMaxReconnectAttempts).toBe(8);
    expect(configuration.whatsappReconnectMaxBackoffSeconds).toBe(600);
    expect(configuration.whatsappMessageQueueIntervalMs).toBe(2000);
    expect(configuration.whatsappTypingPresenceCooldownMs).toBe(3000);
    expect(configuration.telegramMaxStartupAttempts).toBe(7);
    expect(configuration.telegramStartupRetryDelayMs).toBe(2500);
    expect(configuration.maxMediaDownloadMb).toBe(25);
  });

  it('falls back safely when numeric environment values are invalid', () => {
    process.env.WHATSAPP_TYPING_PRESENCE_COOLDOWN_MS = 'invalid-number';
    process.env.MAX_MEDIA_DOWNLOAD_MB = 'invalid-mb';
    process.env.GEMINI_TIMEOUT_SECONDS = 'invalid';
    process.env.LOG_RETENTION_DAYS = 'invalid';
    process.env.EMAIL_IMAP_PORT = 'invalid';
    process.env.EMAIL_LOOKBACK_MINUTES = 'invalid';
    process.env.WHATSAPP_MAX_RECONNECT_ATTEMPTS = 'invalid';
    process.env.WHATSAPP_RECONNECT_MAX_BACKOFF_SECONDS = 'invalid';
    process.env.WHATSAPP_MESSAGE_QUEUE_INTERVAL_MS = 'invalid';
    process.env.TELEGRAM_MAX_STARTUP_ATTEMPTS = 'invalid';
    process.env.TELEGRAM_STARTUP_RETRY_DELAY_MS = 'invalid';
    process.env.ALLOWED_PHONE_NUMBER = '628123456789';

    const configuration = loadEnvironmentConfiguration();

    expect(configuration.whatsappTypingPresenceCooldownMs).toBe(2500);
    expect(configuration.maxMediaDownloadMb).toBe(10);
    expect(configuration.geminiRequestTimeoutMilliseconds).toBe(20000);
    expect(configuration.logRetentionDays).toBe(7);
    expect(configuration.emailImapPort).toBe(993);
    expect(configuration.emailLookbackMinutes).toBe(10);
    expect(configuration.whatsappMaxReconnectAttempts).toBe(6);
    expect(configuration.whatsappReconnectMaxBackoffSeconds).toBe(300);
    expect(configuration.whatsappMessageQueueIntervalMs).toBe(1000);
    expect(configuration.telegramMaxStartupAttempts).toBe(5);
    expect(configuration.telegramStartupRetryDelayMs).toBe(2000);
  });
});
