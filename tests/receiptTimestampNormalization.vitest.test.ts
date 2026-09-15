import { describe, it, expect, afterEach, vi } from 'vitest';
import { normalizeTransactionRecordDate } from '../src/utils/recordDateNormalizer.js';
import { validateAndSanitizeFinancialRecords } from '../src/utils/recordValidator.js';
import {
  setRuntimeApplicationConfig,
  resetRuntimeApplicationConfig,
  getRuntimeApplicationConfig,
} from '../src/config/applicationConfig.js';
import {
  buildReceiptSystemInstruction,
} from '../src/services/ai/aiPromptBuilder.js';
import {
  prepareReceiptPrompt,
  postProcessReceiptVisionResponse,
} from '../src/services/ai/aiProviderWorkflow.js';
import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../src/types/walletTypes.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';

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

    it('normalizes timezone-less morning receipt 2026-09-13T08:26:18 in Asia/Jakarta to 2026-09-13T01:26:18.000Z without false prompt-echo rewriting', () => {
      const normalizedMorningReceipt = normalizeTransactionRecordDate(
        '2026-09-13T08:26:18',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      // Legitimate morning receipt at 08:26:18 WIB must resolve to 01:26:18.000Z
      // and NOT be falsely rewritten to the 15:26:18 WIB (08:26:18.209Z) reference instant
      expect(normalizedMorningReceipt).toBe('2026-09-13T01:26:18.000Z');
      expect(normalizedMorningReceipt).not.toBe('2026-09-13T08:26:18.209Z');
    });

    it('preserves reference instant when receipt has no printed time and model outputs referenceInstant.toISOString()', () => {
      const normalizedNoTime = normalizeTransactionRecordDate(
        referenceInstantUtc.toISOString(),
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedNoTime).toBe('2026-09-13T08:26:18.209Z');
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

    it('safely parses formats with explicit timezone indicators (GMT, UTC)', () => {
      const normalizedRfc = normalizeTransactionRecordDate(
        'Sun, 13 Sep 2026 15:26:18 GMT',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedRfc).toBe('2026-09-13T15:26:18.000Z');
    });

    it('falls back to referenceInstant when explicit offset format is unparseable', () => {
      const invalidExplicitOffset = normalizeTransactionRecordDate(
        '2026-99-99T99:99:99+07:00',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(invalidExplicitOffset).toBe('2026-09-13T08:26:18.209Z');
    });

    it('falls back to referenceInstant when explicit timezone indicator text is unparseable', () => {
      const invalidExplicitTz = normalizeTransactionRecordDate(
        'invalid timestamp with GMT',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(invalidExplicitTz).toBe('2026-09-13T08:26:18.209Z');
    });

    it('correctly parses timezone-less datetime with omitted seconds and with milliseconds', () => {
      const withoutSeconds = normalizeTransactionRecordDate(
        '2026-09-13T15:26',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(withoutSeconds).toBe('2026-09-13T08:26:00.000Z');

      const withMilliseconds = normalizeTransactionRecordDate(
        '2026-09-13T15:26:18.123',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(withMilliseconds).toBe('2026-09-13T08:26:18.123Z');
    });

    it('deterministically falls back to referenceInstant for non-canonical timezone-less formats without host-TZ leakage', () => {
      const normalizedNonCanonical = normalizeTransactionRecordDate(
        '09/13/2026 15:26:18',
        referenceInstantUtc,
        applicationTimezoneJakarta
      );
      expect(normalizedNonCanonical).toBe('2026-09-13T08:26:18.209Z');
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

  describe('Cross-DST Transition Safety (America/New_York)', () => {
    // Reference instant in July (EDT, UTC-04:00)
    const referenceInstantJulyEdt = new Date('2026-07-15T16:00:00.000Z'); // 12:00 EDT
    const timezoneNewYork = 'America/New_York';

    it('resolves winter receipt timestamp using winter standard time offset (EST, UTC-05:00)', () => {
      // Receipt from January (EST, UTC-05:00) printed as 14:30:00 local
      const resolvedWinterUtc = normalizeTransactionRecordDate(
        '2026-01-15T14:30:00',
        referenceInstantJulyEdt,
        timezoneNewYork
      );
      // 14:30 EST + 5h = 19:30:00.000Z
      expect(resolvedWinterUtc).toBe('2026-01-15T19:30:00.000Z');
    });

    it('resolves summer receipt timestamp using daylight saving time offset (EDT, UTC-04:00)', () => {
      // Receipt from July (EDT, UTC-04:00) printed as 14:30:00 local
      const resolvedSummerUtc = normalizeTransactionRecordDate(
        '2026-07-10T14:30:00',
        referenceInstantJulyEdt,
        timezoneNewYork
      );
      // 14:30 EDT + 4h = 18:30:00.000Z
      expect(resolvedSummerUtc).toBe('2026-07-10T18:30:00.000Z');
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

        // 3. Morning receipt local wall-clock (not rewritten by echo heuristic)
        const morningResult = normalizeTransactionRecordDate(
          '2026-09-13T08:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(morningResult).toBe('2026-09-13T01:26:18.000Z');

        // 4. Missing timestamp
        const missingResult = normalizeTransactionRecordDate(
          undefined,
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(missingResult).toBe('2026-09-13T08:26:18.209Z');

        // 5. Non-canonical timezone-less slash format (must not leak host TZ)
        const nonCanonicalResult = normalizeTransactionRecordDate(
          '09/13/2026 15:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(nonCanonicalResult).toBe('2026-09-13T08:26:18.209Z');

        // 5b. Non-canonical hyphen-separated date format (must not match timezone regex or leak host TZ)
        const hyphenDateResult = normalizeTransactionRecordDate(
          '09-13-2026 15:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(hyphenDateResult).toBe('2026-09-13T08:26:18.209Z');

        const hyphenDayFirstResult = normalizeTransactionRecordDate(
          '13-09-2026 15:26:18',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(hyphenDayFirstResult).toBe('2026-09-13T08:26:18.209Z');

        // 5c. Non-canonical hyphen-separated date-only format (must not match timezone regex or leak host TZ)
        const hyphenDateOnlyResult = normalizeTransactionRecordDate(
          '09-13-2026',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(hyphenDateOnlyResult).toBe('2026-09-13T08:26:18.209Z');

        const hyphenDayFirstDateOnlyResult = normalizeTransactionRecordDate(
          '13-09-2026',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(hyphenDayFirstDateOnlyResult).toBe('2026-09-13T08:26:18.209Z');

        // 6. Explicit timezone indicator format
        const explicitTzResult = normalizeTransactionRecordDate(
          'Sun, 13 Sep 2026 15:26:18 GMT',
          referenceInstantUtc,
          applicationTimezoneJakarta
        );
        expect(explicitTzResult).toBe('2026-09-13T15:26:18.000Z');
      });
    }
  });

  describe('Integration with validateAndSanitizeFinancialRecords', () => {
    it('sanitizes receipt record when model returns referenceInstant without 7-hour backward shift', () => {
      const recordsToValidate: CreateRecordInputPayload[] = [
        {
          accountId: 'Gopay',
          categoryId: 'cat-groceries',
          amount: -54200,
          currency: 'IDR',
          recordDate: referenceInstantUtc.toISOString(),
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
      expect(sanitizedRecord.recordDate).toBe('2026-09-13T08:26:18.209Z');
      expect(sanitizedRecord.amount).toBe(-54200);
      expect(sanitizedRecord.accountId).toBe('acc-gopay');
    });

    it('sanitizes morning receipt 08:26:18 local to 01:26:18.000Z without rewriting to reference instant', () => {
      const recordsToValidate: CreateRecordInputPayload[] = [
        {
          accountId: 'Gopay',
          categoryId: 'cat-groceries',
          amount: -25000,
          currency: 'IDR',
          recordDate: '2026-09-13T08:26:18', // Morning printed receipt time
          note: 'Sarapan pagi',
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
      expect(sanitizedRecord.recordDate).toBe('2026-09-13T01:26:18.000Z');
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

    it('handles nonexistent DST wall-clock times in recordDate by flagging validation error via RangeError catch', () => {
      setRuntimeApplicationConfig({
        ...getRuntimeApplicationConfig(),
        appTimezone: 'America/New_York',
      });
      try {
        // In America/New_York on 2026-03-08, 02:00 jumps to 03:00.
        // 02:30:00 does not exist.
        const recordsToValidate: CreateRecordInputPayload[] = [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -50000,
            currency: 'IDR',
            recordDate: '2026-03-08T02:30:00',
            note: 'DST gap transaction',
          },
        ];

        const validationResult = validateAndSanitizeFinancialRecords(
          recordsToValidate,
          mockAccounts,
          mockCategories,
          undefined,
          referenceInstantUtc
        );

        expect(validationResult.isValid).toBe(false);
        expect(validationResult.validationErrors).toHaveLength(1);
        expect(validationResult.validationErrors[0]).toContain(
          'Waktu transaksi tidak valid pada timezone America/New_York'
        );
      } finally {
        resetRuntimeApplicationConfig();
      }
    });

    it('handles nonexistent DST wall-clock times in contextual user message by flagging validation error', () => {
      setRuntimeApplicationConfig({
        ...getRuntimeApplicationConfig(),
        appTimezone: 'America/New_York',
      });
      try {
        // Nonexistent time in America/New_York on 2026-03-08: 02:30:00
        const recordsToValidate: CreateRecordInputPayload[] = [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -50000,
            currency: 'IDR',
            note: 'Transaksi gap',
          },
        ];

        const validationResult = validateAndSanitizeFinancialRecords(
          recordsToValidate,
          mockAccounts,
          mockCategories,
          'tadi subuh jam 2.30',
          new Date('2026-03-08T15:00:00.000Z')
        );

        expect(validationResult.isValid).toBe(false);
        expect(validationResult.validationErrors).toHaveLength(1);
        expect(validationResult.validationErrors[0]).toContain(
          'Waktu transaksi tidak valid pada timezone America/New_York'
        );
      } finally {
        resetRuntimeApplicationConfig();
      }
    });
  });

  describe('Prompt Builder Directives for Vision Models', () => {
    it('buildReceiptSystemInstruction instructs local ISO output without offset and DST-safe resolution', () => {
      const instruction = buildReceiptSystemInstruction(
        mockAccounts,
        mockCategories,
        '2026-09-13',
        applicationTimezoneJakarta,
        referenceInstantUtc
      );

      expect(instruction).toContain('RECEIPT DATE, TIME & TIMEZONE RESOLUTION:');
      expect(instruction).toContain('output as a local ISO timestamp without timezone offset');
      expect(instruction).toContain('Never apply the request-time offset across DST date boundaries');
      expect(instruction).toContain('omit "recordDate" or set "recordDate": null');
      expect(instruction).toContain('NEVER invent, copy, or manufacture a clock time');
      expect(instruction).not.toContain('YYYY-MM-DDTHH:mm:ss+07:00');
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

  describe('End-to-End Pipeline Verification with postProcessReceiptVisionResponse', () => {
    it('handles receipt with omitted recordDate by applying referenceInstant downstream', () => {
      const modelJsonOutput = JSON.stringify({
        action: 'CREATE_RECORD',
        records: [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -35000,
            currency: 'IDR',
            note: 'Receipt with omitted recordDate',
            counterParty: 'Indomaret',
          },
        ],
        explanation: 'Extracted receipt with no printed timestamp',
      });

      const parsedIntent = postProcessReceiptVisionResponse(
        {
          responseText: modelJsonOutput,
          tokenUsage: { promptTokens: 100, candidatesTokens: 50, totalTokens: 150 },
        },
        'Gemini'
      );

      expect(parsedIntent.action).toBe('CREATE_RECORD');
      expect(parsedIntent.records).toHaveLength(1);
      expect(parsedIntent.records![0].recordDate).toBeUndefined();

      const validationResult = validateAndSanitizeFinancialRecords(
        parsedIntent.records as CreateRecordInputPayload[],
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.sanitizedRecords).toHaveLength(1);
      expect(validationResult.sanitizedRecords[0].recordDate).toBe('2026-09-13T08:26:18.209Z');
      expect(validationResult.sanitizedRecords[0].amount).toBe(-35000);
      expect(validationResult.sanitizedRecords[0].accountId).toBe('acc-gopay');
    });

    it('handles receipt with null recordDate by applying referenceInstant downstream', () => {
      const modelJsonOutput = JSON.stringify({
        action: 'CREATE_RECORD',
        records: [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -45000,
            currency: 'IDR',
            recordDate: null,
            note: 'Receipt with null recordDate',
            counterParty: 'Indomaret',
          },
        ],
        explanation: 'Extracted receipt with null timestamp',
      });

      const parsedIntent = postProcessReceiptVisionResponse(
        {
          responseText: modelJsonOutput,
          tokenUsage: { promptTokens: 100, candidatesTokens: 50, totalTokens: 150 },
        },
        'Gemini'
      );

      expect(parsedIntent.action).toBe('CREATE_RECORD');
      expect(parsedIntent.records).toHaveLength(1);
      expect(parsedIntent.records![0].recordDate).toBeUndefined();

      const validationResult = validateAndSanitizeFinancialRecords(
        parsedIntent.records as CreateRecordInputPayload[],
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.sanitizedRecords).toHaveLength(1);
      expect(validationResult.sanitizedRecords[0].recordDate).toBe('2026-09-13T08:26:18.209Z');
    });

    it('handles receipt with printed local time 15:26:18 by resolving to UTC 08:26:18.000Z', () => {
      const modelJsonOutput = JSON.stringify({
        action: 'CREATE_RECORD',
        records: [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -54200,
            currency: 'IDR',
            recordDate: '2026-09-13T15:26:18',
            note: 'Afternoon receipt',
            counterParty: 'Indomaret',
          },
        ],
        explanation: 'Receipt with printed afternoon time',
      });

      const parsedIntent = postProcessReceiptVisionResponse(
        {
          responseText: modelJsonOutput,
          tokenUsage: { promptTokens: 100, candidatesTokens: 50, totalTokens: 150 },
        },
        'Gemini'
      );

      expect(parsedIntent.records![0].recordDate).toBe('2026-09-13T15:26:18');

      const validationResult = validateAndSanitizeFinancialRecords(
        parsedIntent.records as CreateRecordInputPayload[],
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.sanitizedRecords[0].recordDate).toBe('2026-09-13T08:26:18.000Z');
    });

    it('handles receipt with printed morning time 08:26:18 by resolving to UTC 01:26:18.000Z', () => {
      const modelJsonOutput = JSON.stringify({
        action: 'CREATE_RECORD',
        records: [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -25000,
            currency: 'IDR',
            recordDate: '2026-09-13T08:26:18',
            note: 'Breakfast receipt',
            counterParty: 'Kantin',
          },
        ],
        explanation: 'Morning receipt with printed time',
      });

      const parsedIntent = postProcessReceiptVisionResponse(
        {
          responseText: modelJsonOutput,
          tokenUsage: { promptTokens: 100, candidatesTokens: 50, totalTokens: 150 },
        },
        'Gemini'
      );

      expect(parsedIntent.records![0].recordDate).toBe('2026-09-13T08:26:18');

      const validationResult = validateAndSanitizeFinancialRecords(
        parsedIntent.records as CreateRecordInputPayload[],
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.sanitizedRecords[0].recordDate).toBe('2026-09-13T01:26:18.000Z');
    });

    it('handles receipt with 07:00:00 WIB (midnight UTC) and preserves exact 00:00:00.000Z in create_records dispatch payload', async () => {
      const modelJsonOutput = JSON.stringify({
        action: 'CREATE_RECORD',
        records: [
          {
            accountId: 'Gopay',
            categoryId: 'cat-groceries',
            amount: -35000,
            currency: 'IDR',
            recordDate: '2026-09-13T07:00:00',
            note: 'Morning transaction at 7 AM WIB',
            counterParty: 'Indomaret',
          },
        ],
        explanation: 'Receipt with printed 07:00:00 WIB time',
      });

      const parsedIntent = postProcessReceiptVisionResponse(
        {
          responseText: modelJsonOutput,
          tokenUsage: { promptTokens: 100, candidatesTokens: 50, totalTokens: 150 },
        },
        'Gemini'
      );

      expect(parsedIntent.records![0].recordDate).toBe('2026-09-13T07:00:00');

      const validationResult = validateAndSanitizeFinancialRecords(
        parsedIntent.records as CreateRecordInputPayload[],
        mockAccounts,
        mockCategories,
        undefined,
        referenceInstantUtc
      );

      expect(validationResult.isValid).toBe(true);
      expect(validationResult.sanitizedRecords).toHaveLength(1);
      expect(validationResult.sanitizedRecords[0].recordDate).toBe('2026-09-13T00:00:00.000Z');

      // Verify that WalletMcpClientService dispatch preserves the exact 00:00:00.000Z instant
      const walletMcpClient = new WalletMcpClientService('https://example.invalid', 'test-token');
      const toolCallSpy = vi.spyOn(walletMcpClient, 'callMcpTool').mockResolvedValue({
        summary: { total: 1, succeeded: 1, failed: 0, documentsWritten: 1 },
        results: [{ inputIndex: 0, success: true, id: 'mock-rec-id' }],
      } as any);

      await walletMcpClient.createRecords(validationResult.sanitizedRecords);

      expect(toolCallSpy).toHaveBeenCalledTimes(1);
      const [calledToolName, calledArguments] = toolCallSpy.mock.calls[0];
      expect(calledToolName).toBe('create_records');
      const dispatchedRecords = (calledArguments as any).records;
      expect(dispatchedRecords).toHaveLength(1);
      expect(dispatchedRecords[0].recordDate).toBe('2026-09-13T00:00:00.000Z');
    });
  });
});
