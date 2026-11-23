import { describe, it, expect, vi } from 'vitest';
import { resolveRecordDateEdit } from '../src/wallet/records/recordDateEditResolver.js';
import type { FinancialAiProvider } from '../src/brain/types.js';

describe('recordDateEditResolver', () => {
  // Reference date: Monday, Nov 23, 2026, 17:00:00 Asia/Jakarta (UTC 2026-11-23T10:00:00.000Z)
  const referenceDate = new Date('2026-11-23T10:00:00.000Z');
  // Existing transaction date: Friday, Nov 20, 2026, 15:30:00 Asia/Jakarta (UTC 2026-11-20T08:30:00.000Z)
  const existingIso = '2026-11-20T08:30:00.000Z';
  const timezone = 'Asia/Jakarta';

  describe('Deterministic Fallback: Clock Time Only (TIME_ONLY)', () => {
    it('updates clock time to 14:00 while preserving existing calendar date (2026-11-20)', async () => {
      const result = await resolveRecordDateEdit('14:00', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('TIME_ONLY');
      expect(result?.source).toBe('DETERMINISTIC');
      // 14:00 in Asia/Jakarta (UTC+7) -> 07:00 UTC on 2026-11-20
      expect(result?.resolvedUtcIso).toBe('2026-11-20T07:00:00.000Z');
    });

    it('updates clock time using Indonesian period phrase (jam 2 siang)', async () => {
      const result = await resolveRecordDateEdit('jam 2 siang', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('TIME_ONLY');
      expect(result?.resolvedUtcIso).toBe('2026-11-20T07:00:00.000Z');
    });

    it('supports dot-separated time format (15.45)', async () => {
      const result = await resolveRecordDateEdit('15.45', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('TIME_ONLY');
      // 15:45 Asia/Jakarta -> 08:45 UTC on 2026-11-20
      expect(result?.resolvedUtcIso).toBe('2026-11-20T08:45:00.000Z');
    });
  });

  describe('Deterministic Fallback: Calendar Date Only (DATE_ONLY)', () => {
    it('updates date to yesterday while preserving existing clock time (15:30)', async () => {
      const result = await resolveRecordDateEdit('kemarin', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('DATE_ONLY');
      expect(result?.source).toBe('DETERMINISTIC');
      // Yesterday relative to 2026-11-23 is 2026-11-22
      // Preserved clock time: 15:30 -> 08:30 UTC on 2026-11-22
      expect(result?.resolvedUtcIso).toBe('2026-11-22T08:30:00.000Z');
    });

    it('updates date using explicit ISO format (2026-11-15) preserving clock time', async () => {
      const result = await resolveRecordDateEdit('2026-11-15', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('DATE_ONLY');
      expect(result?.resolvedUtcIso).toBe('2026-11-15T08:30:00.000Z');
    });

    it('updates date using Indonesian text month (18 nov) preserving clock time', async () => {
      const result = await resolveRecordDateEdit('18 nov', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('DATE_ONLY');
      expect(result?.resolvedUtcIso).toBe('2026-11-18T08:30:00.000Z');
    });

    it('updates date using slash format (12/11/2026) preserving clock time', async () => {
      const result = await resolveRecordDateEdit('12/11/2026', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('DATE_ONLY');
      expect(result?.resolvedUtcIso).toBe('2026-11-12T08:30:00.000Z');
    });
  });

  describe('Deterministic Fallback: Both Date and Time (BOTH)', () => {
    it('updates both date and time (kemarin jam 10 pagi)', async () => {
      const result = await resolveRecordDateEdit('kemarin jam 10 pagi', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('BOTH');
      // Yesterday: 2026-11-22, 10:00 Asia/Jakarta -> 03:00 UTC
      expect(result?.resolvedUtcIso).toBe('2026-11-22T03:00:00.000Z');
    });

    it('updates both date and time (2026-11-19 14:00)', async () => {
      const result = await resolveRecordDateEdit('2026-11-19 14:00', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('BOTH');
      // 2026-11-19 14:00 Asia/Jakarta -> 07:00 UTC
      expect(result?.resolvedUtcIso).toBe('2026-11-19T07:00:00.000Z');
    });

    it('updates both date and time using period token (tadi pagi)', async () => {
      const result = await resolveRecordDateEdit('tadi pagi', existingIso, {
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.changeScope).toBe('BOTH');
      // Today: 2026-11-23, pagi: 08:00 Asia/Jakarta -> 01:00 UTC
      expect(result?.resolvedUtcIso).toBe('2026-11-23T01:00:00.000Z');
    });
  });

  describe('AI Provider Integration', () => {
    it('uses AI provider proposal when available and valid', async () => {
      const mockAiProvider: FinancialAiProvider = {
        providerName: 'mock-ai',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        interpretRecordDateEdit: vi.fn(async () => ({
          resolvedUtcIso: '2026-11-22T12:00:00.000Z',
          changeScope: 'BOTH' as const,
        })),
      };

      const result = await resolveRecordDateEdit('kemarin siang dikit', existingIso, {
        aiProvider: mockAiProvider,
        referenceDate,
        timezone,
      });

      expect(result).toEqual({
        resolvedUtcIso: '2026-11-22T12:00:00.000Z',
        changeScope: 'BOTH',
        source: 'AI',
      });
      expect(mockAiProvider.interpretRecordDateEdit).toHaveBeenCalledWith(
        'kemarin siang dikit',
        existingIso,
        referenceDate,
        timezone
      );
    });

    it('falls back to deterministic resolver when AI provider throws an error', async () => {
      const mockAiProvider: FinancialAiProvider = {
        providerName: 'failing-ai',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        interpretRecordDateEdit: vi.fn(async () => {
          throw new Error('AI rate limit exceeded');
        }),
      };

      const result = await resolveRecordDateEdit('14:00', existingIso, {
        aiProvider: mockAiProvider,
        referenceDate,
        timezone,
      });

      expect(result).not.toBeUndefined();
      expect(result?.source).toBe('DETERMINISTIC');
      expect(result?.resolvedUtcIso).toBe('2026-11-20T07:00:00.000Z');
    });
  });

  describe('Edge cases and unrecognized inputs', () => {
    it('returns undefined for empty or whitespace-only input', async () => {
      expect(await resolveRecordDateEdit('', existingIso)).toBeUndefined();
      expect(await resolveRecordDateEdit('   ', existingIso)).toBeUndefined();
    });

    it('returns undefined for gibberish text', async () => {
      expect(await resolveRecordDateEdit('asdfghjklqwerty', existingIso)).toBeUndefined();
    });
  });
});
