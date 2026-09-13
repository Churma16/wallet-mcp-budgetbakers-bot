import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeTransactionRecordDate } from '../src/utils/recordDateNormalizer.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import {
  buildReceiptExtractionPrompt,
  buildReceiptSystemInstruction,
} from '../src/services/ai/aiPromptBuilder.js';
import { prepareReceiptPrompt } from '../src/services/ai/aiProviderWorkflow.js';
import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../src/types/walletTypes.js';

describe('Receipt Timestamp Normalization & Timezone Preservation (Issue #147)', () => {
  const referenceInstantUtc = new Date('2026-09-13T08:26:18.209Z');
  const applicationTimezoneJakarta = 'Asia/Jakarta'; // UTC+7

  const mockAccounts: WalletAccountItem[] = [
    {
      id: 'acc-gopay',
      name: 'Gopay',
      currency: 'IDR',
      accountType: 'CurrentAccount',
    },
    {
      id: 'acc-cash',
      name: 'Cash',
      currency: 'IDR',
      accountType: 'Cash',
    },
  ];

  const mockCategories: WalletCategoryItem[] = [
    { id: 'cat-groceries', name: 'Groceries' },
  ];

  describe('Direct Normalizer Tests (normalizeTransactionRecordDate)', () => {
    it('preserves request reference instant when recordDate is undefined or empty', () => {
      const normalizedUndefined = normalizeTransactionRecordDate(
        undefined,
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedUndefined).toBe('2026-09-13T08:26:18.209Z');

      const normalizedEmpty = normalizeTransactionRecordDate(
        '',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedEmpty).toBe('2026-09-13T08:26:18.209Z');

      const normalizedWhitespace = normalizeTransactionRecordDate(
        '   ',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedWhitespace).toBe('2026-09-13T08:26:18.209Z');
    });

    it('normalizes explicit ISO with offset 2026-09-13T15:26:18+07:00 to 2026-09-13T08:26:18.000Z', () => {
      const normalizedWithOffset = normalizeTransactionRecordDate(
        '2026-09-13T15:26:18+07:00',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedWithOffset).toBe('2026-09-13T08:26:18.000Z');
    });

    it('normalizes explicit UTC ISO 2026-09-13T08:26:18Z preserving exact instant', () => {
      const normalizedUtc = normalizeTransactionRecordDate(
        '2026-09-13T08:26:18Z',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedUtc).toBe('2026-09-13T08:26:18.000Z');
    });

    it('normalizes timezone-less receipt-local 2026-09-13T15:26:18 in Asia/Jakarta exactly once to 2026-09-13T08:26:18.000Z (preserving seconds)', () => {
      const normalizedReceiptLocal = normalizeTransactionRecordDate(
        '2026-09-13T15:26:18',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      // 15:26:18 local in Asia/Jakarta (UTC+7) -> 08:26:18 UTC, preserving seconds
      expect(normalizedReceiptLocal).toBe('2026-09-13T08:26:18.000Z');
    });

    it('prevents 7-hour backward shift when vision returns timezone-less output matching UTC reference instant (production reproduction)', () => {
      // In production, referenceInstant was 2026-09-13T08:26:18.209Z (15:26 WIB).
      // Gemini Vision echoed the UTC prompt timestamp without 'Z': "2026-09-13T08:26:18".
      // Previous buggy behavior subtracted 7 hours: 08:26 - 7h = 01:26:00Z (storing 08:26 WIB instead of 15:26 WIB).
      // Fixed behavior must recognize the UTC prompt echo and preserve the 08:26:18 UTC instant.
      const normalizedAiEcho = normalizeTransactionRecordDate(
        '2026-09-13T08:26:18',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedAiEcho).not.toBe('2026-09-13T01:26:00.000Z');
      expect(normalizedAiEcho).not.toBe('2026-09-13T01:26:18.000Z');
      expect(normalizedAiEcho).toBe('2026-09-13T08:26:18.209Z');
    });

    it('handles date-only receipt for today without gaining an unintended 7-hour shift', () => {
      // Reference instant is 2026-09-13 15:26 WIB. Receipt date is today: 2026-09-13.
      const normalizedDateOnlyToday = normalizeTransactionRecordDate(
        '2026-09-13',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      // Preserves today's reference instant
      expect(normalizedDateOnlyToday).toBe('2026-09-13T08:26:18.209Z');
    });

    it('handles date-only receipt for a past date by resolving to midday local time, preventing date rollovers', () => {
      // Past receipt from 2026-09-10 without printed time.
      const normalizedPastDate = normalizeTransactionRecordDate(
        '2026-09-10',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      // Midday (12:00:00) in Asia/Jakarta (+07:00) is 05:00:00.000Z on 2026-09-10.
      // Notice: date remains 2026-09-10 in both UTC and Asia/Jakarta, avoiding midnight boundary shifts.
      expect(normalizedPastDate).toBe('2026-09-10T05:00:00.000Z');
    });

    it('handles space-separated datetime and non-colon offset formats cleanly', () => {
      const spaceSeparated = normalizeTransactionRecordDate(
        '2026-09-13 15:26:18+07:00',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(spaceSeparated).toBe('2026-09-13T08:26:18.000Z');

      const nonColonOffset = normalizeTransactionRecordDate(
        '2026-09-13T15:26:18+0700',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(nonColonOffset).toBe('2026-09-13T08:26:18.000Z');
    });

    it('falls back safely to referenceInstant when given completely unparseable string', () => {
      const normalizedGarbage = normalizeTransactionRecordDate(
        'not-a-valid-date',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedGarbage).toBe('2026-09-13T08:26:18.209Z');
    });
  });

  describe('Host-Timezone Independence Verification', () => {
    const originalTimezone = process.env.TZ;

    afterEach(() => {
      if (originalTimezone !== undefined) {
        process.env.TZ = originalTimezone;
      } else {
        delete process.env.TZ;
      }
    });

    const testTimezones = ['UTC', 'America/New_York', 'Asia/Tokyo', 'Europe/London', 'Asia/Jakarta'];

    for (const hostTz of testTimezones) {
      it(`produces identical results when host process.env.TZ is ${hostTz}`, () => {
        process.env.TZ = hostTz;

        // 1. Explicit offset
        const explicitResult = normalizeTransactionRecordDate(
          '2026-09-13T15:26:18+07:00',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(explicitResult).toBe('2026-09-13T08:26:18.000Z');

        // 2. Receipt local wall-clock
        const localResult = normalizeTransactionRecordDate(
          '2026-09-13T15:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(localResult).toBe('2026-09-13T08:26:18.000Z');

        // 3. Prompt UTC echo (production bug case)
        const echoResult = normalizeTransactionRecordDate(
          '2026-09-13T08:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(echoResult).toBe('2026-09-13T08:26:18.209Z');

        // 4. Missing timestamp
        const missingResult = normalizeTransactionRecordDate(
          undefined,
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(missingResult).toBe('2026-09-13T08:26:18.209Z');
      });
    }
  });

  describe('Integration with validateAndSanitizeFinancialRecords', () => {
    it('sanitizes production reproduction record without 7-hour backward shift', () => {
      const recordsToValidate: CreateRecordInputPayload[] = [
        {
          accountId: 'Gopay',
          categoryId: 'cat-groceries',
          amount: -54200,
          currency: 'IDR',
          recordDate: '2026-09-13T08:26:18', // Ambiguous timezone-less echo from vision
          note: 'Belanja Xpress Klik Indomaret',
          counterParty: 'Indomaret',
        },
      ];

      const validationResult = validateAndSanitizeFinancialRecords(
        recordsToValidate,
        mockAccounts,
        mockCategories,
        undefined, // no contextual user message
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.validationErrors).toEqual([]);
      expect(validationResult.sanitizedRecords).toHaveLength(1);

      const sanitizedRecord = validationResult.sanitizedRecords[0];
      // Must NOT be shifted backward to 01:26:00.000Z
      expect(sanitizedRecord.recordDate).not.toBe('2026-09-13T01:26:00.000Z');
      expect(sanitizedRecord.recordDate).toBe('2026-09-13T08:26:18.209Z');
      expect(sanitizedRecord.amount).toBe(-54200);
      expect(sanitizedRecord.accountId).toBe('acc-gopay');
    });

    it('sanitizes receipt-local wall-clock 15:26:18 to 08:26:18.000Z preserving seconds', () => {
      const recordsToValidate: CreateRecordInputPayload[] = [
        {
          accountId: 'Gopay',
          categoryId: 'cat-groceries',
          amount: -54200,
          currency: 'IDR',
          recordDate: '2026-09-13T15:26:18', // Local printed receipt time
          note: 'Belanja Indomaret',
        },
      ];

      const validationResult = validateAndSanitizeFinancialRecords(
        recordsToValidate,
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      const sanitizedRecord = validationResult.sanitizedRecords[0];
      expect(sanitizedRecord.recordDate).toBe('2026-09-13T08:26:18.000Z');
    });

    it('does not regress text-created transactions with relative time expressions', () => {
      const recordsToValidate: CreateRecordInputPayload[] = [
        {
          accountId: 'Cash',
          amount: -25000,
          currency: 'IDR',
          note: 'Makan siang kemaren jam 1 siang',
        },
      ];

      const validationResult = validateAndSanitizeFinancialRecords(
        recordsToValidate,
        mockAccounts,
        mockCategories,
        'Makan siang kemaren jam 1 siang',
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      const sanitizedRecord = validationResult.sanitizedRecords[0];
      // 13:00 on 2026-09-12 in Asia/Jakarta (UTC+7) is 06:00:00.000Z UTC
      expect(sanitizedRecord.recordDate).toBe('2026-09-12T06:00:00.000Z');
    });
  });

  describe('Prompt Builder Directives for Vision Models', () => {
    it('buildReceiptSystemInstruction instructs explicit offset or Z and forbids timezone-less output', () => {
      const instruction = buildReceiptSystemInstruction(
        mockAccounts,
        mockCategories,
        '2026-09-13',
        applicationTimezoneJakarta,
        referenceInstantUtc
      );

      expect(instruction).toContain('RECEIPT DATE, TIME & TIMEZONE RESOLUTION:');
      expect(instruction).toContain('MUST be an explicit ISO 8601 string with timezone offset or "Z"');
      expect(instruction).toContain('NEVER output a timezone-less datetime string');
      expect(instruction).toContain('use the current transaction timestamp: 2026-09-13T08:26:18.209Z');
    });

    it('prepareReceiptPrompt injects local time anchor and current transaction timestamp into promptText', () => {
      const prepared = prepareReceiptPrompt(
        'image/jpeg',
        1024,
        'Makan siang',
        mockAccounts,
        mockCategories,
        referenceInstantUtc
      );

      expect(prepared.promptText).toContain('[Current Transaction Timestamp: 2026-09-13T08:26:18.209Z |');
      expect(prepared.promptText).toContain('15:26');
      expect(prepared.promptText).toContain('Asia/Jakarta');
    });
  });
});
