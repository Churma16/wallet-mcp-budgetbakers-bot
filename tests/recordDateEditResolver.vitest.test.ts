import { describe, it, expect, vi } from 'vitest';
import { resolveRecordDateEdit } from '../src/wallet/records/recordDateEditResolver.js';
import type { FinancialAiProvider } from '../src/brain/types.js';
import { buildDateEditPrompt, parseDateEditResponse } from '../src/brain/prompts/prompts.js';
import { englishDictionary } from '../src/i18n/locales/en.js';
import { indonesianDictionary } from '../src/i18n/locales/id.js';

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

  describe('Prompt Generation and Response Parsing', () => {
    it('builds a secure date edit prompt with grounded local time anchor', () => {
      const { systemInstruction, promptText } = buildDateEditPrompt(
        'jam 2 siang',
        existingIso,
        referenceDate,
        timezone
      );

      expect(systemInstruction).toContain('TIME_ONLY');
      expect(systemInstruction).toContain('DATE_ONLY');
      expect(systemInstruction).toContain('Asia/Jakarta');
      expect(promptText).toContain('jam 2 siang');
    });

    it('handles invalid existingDateIso in buildDateEditPrompt gracefully', () => {
      const { systemInstruction } = buildDateEditPrompt(
        '14:00',
        'invalid-date-iso',
        referenceDate,
        timezone
      );

      expect(systemInstruction).toContain('Asia/Jakarta');
    });

    it('parses valid json response from AI with targetUtcIso', () => {
      const parsed = parseDateEditResponse(
        JSON.stringify({
          targetUtcIso: '2026-11-20T07:00:00.000Z',
          changeScope: 'TIME_ONLY',
        })
      );

      expect(parsed).toEqual({
        resolvedUtcIso: '2026-11-20T07:00:00.000Z',
        changeScope: 'TIME_ONLY',
      });
    });

    it('parses markdown-fenced json response from AI', () => {
      const parsed = parseDateEditResponse(
        '```json\n{"targetUtcIso": "2026-11-22T08:30:00.000Z", "changeScope": "DATE_ONLY"}\n```'
      );

      expect(parsed).toEqual({
        resolvedUtcIso: '2026-11-22T08:30:00.000Z',
        changeScope: 'DATE_ONLY',
      });
    });

    it('returns null for empty, null, or invalid json responses', () => {
      expect(parseDateEditResponse(null)).toBeNull();
      expect(parseDateEditResponse('')).toBeNull();
      expect(parseDateEditResponse('not-json')).toBeNull();
      expect(parseDateEditResponse(JSON.stringify({ targetUtcIso: 'not-a-date' }))).toBeNull();
    });
  });

  describe('FallbackAiProvider Integration', () => {
    it('delegates interpretRecordDateEdit to active provider in FallbackAiProvider', async () => {
      const { FallbackAiProvider } = await import('../src/brain/index.js');
      const mockProvider: FinancialAiProvider = {
        providerName: 'primary',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
        interpretRecordDateEdit: vi.fn(async () => ({
          resolvedUtcIso: '2026-11-20T07:00:00.000Z',
          changeScope: 'TIME_ONLY',
        })),
      };

      const fallback = new FallbackAiProvider([mockProvider]);
      const result = await fallback.interpretRecordDateEdit('14:00', existingIso, referenceDate, timezone);

      expect(result).toEqual({
        resolvedUtcIso: '2026-11-20T07:00:00.000Z',
        changeScope: 'TIME_ONLY',
      });
      expect(mockProvider.interpretRecordDateEdit).toHaveBeenCalled();
    });

    it('throws error when active provider does not implement interpretRecordDateEdit', async () => {
      const { FallbackAiProvider } = await import('../src/brain/index.js');
      const mockProvider: FinancialAiProvider = {
        providerName: 'no-edit-provider',
        processTextMessage: vi.fn(),
        processImageMessage: vi.fn(),
        processEmailTransactionMessage: vi.fn(),
      };

      const fallback = new FallbackAiProvider([mockProvider]);
      await expect(
        fallback.interpretRecordDateEdit('14:00', existingIso, referenceDate, timezone)
      ).rejects.toThrow("Provider 'no-edit-provider' does not implement interpretRecordDateEdit.");
    });
  });

  describe('Gemini and OpenAI Provider interpretRecordDateEdit Integration', () => {
    it('executes GeminiAiProvider.interpretRecordDateEdit successfully', async () => {
      const { GeminiAiProvider } = await import('../src/brain/providers/geminiProvider.js');
      const mockGenerateContent = vi.fn().mockResolvedValue({
        text: JSON.stringify({ targetUtcIso: '2026-11-20T07:00:00.000Z', changeScope: 'TIME_ONLY' }),
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
      });

      const provider = new GeminiAiProvider('mock-key', 'gemini-3.5-flash-lite', []);
      (provider as any).googleGenAiClient = {
        models: {
          generateContent: mockGenerateContent,
        },
      };

      const result = await provider.interpretRecordDateEdit('14:00', existingIso, referenceDate, timezone);

      expect(result?.resolvedUtcIso).toBe('2026-11-20T07:00:00.000Z');
      expect(result?.changeScope).toBe('TIME_ONLY');
      expect(mockGenerateContent).toHaveBeenCalled();
    });

    it('executes OpenAiCompatibleAiProvider.interpretRecordDateEdit successfully', async () => {
      const { OpenAiCompatibleAiProvider } = await import('../src/brain/providers/openAiProvider.js');
      const mockHttpClient: any = {
        post: vi.fn().mockResolvedValue({
          data: {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    targetUtcIso: '2026-11-22T08:30:00.000Z',
                    changeScope: 'DATE_ONLY',
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
          },
        }),
      };

      const provider = new OpenAiCompatibleAiProvider({
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'test-key',
        primaryModelName: 'gpt-4o-mini',
        timeoutMilliseconds: 5000,
      });
      (provider as any).httpClient = mockHttpClient;

      const result = await provider.interpretRecordDateEdit('kemarin', existingIso, referenceDate, timezone);

      expect(result?.resolvedUtcIso).toBe('2026-11-22T08:30:00.000Z');
      expect(result?.changeScope).toBe('DATE_ONLY');
      expect(mockHttpClient.post).toHaveBeenCalled();
    });
  });

  describe('Dictionary Localization', () => {
    it('formats recordEditInvalidDate in English and Indonesian', () => {
      expect(englishDictionary.errors.recordEditInvalidDate('foo')).toBe(
        '⚠️ Date or time format "foo" was not recognized.'
      );
      expect(indonesianDictionary.errors.recordEditInvalidDate('foo')).toBe(
        '⚠️ Format tanggal atau waktu "foo" tidak dikenali.'
      );
    });
  });
});
