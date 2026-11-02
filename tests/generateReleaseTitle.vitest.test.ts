import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  sanitizeTitle,
  extractReleaseSnippet,
  requestOpenRouterTitle,
  generateReleaseTitle
} from '../.github/scripts/generate-release-title.js';

describe('generate-release-title script', () => {
  let temporaryDirectory: string;

  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-release-title-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
    vi.restoreAllMocks();
  });

  describe('sanitizeTitle', () => {
    it('returns empty string for null, undefined, or non-string inputs', () => {
      expect(sanitizeTitle(null)).toBe('');
      expect(sanitizeTitle(undefined)).toBe('');
      expect(sanitizeTitle('')).toBe('');
      // @ts-expect-error test invalid type
      expect(sanitizeTitle(123)).toBe('');
    });

    it('strips markdown formatting and wrapping quotes', () => {
      const raw = '"**Add Multi-Currency Support**"';
      expect(sanitizeTitle(raw)).toBe('Add Multi-Currency Support');
    });

    it('removes common title prefixes and header markdown', () => {
      expect(sanitizeTitle('Title: Support Recurring Budgets')).toBe('Support Recurring Budgets');
      expect(sanitizeTitle('Release Title: Fix IMAP Idle')).toBe('Fix IMAP Idle');
      expect(sanitizeTitle('## Enhanced Email Reconciliation')).toBe('Enhanced Email Reconciliation');
      expect(sanitizeTitle('- Auto Categorization Engine')).toBe('Auto Categorization Engine');
    });

    it('strips prefixes even when wrapped in quotes (Finding 1 fix)', () => {
      expect(sanitizeTitle('"Release Title: Multi-Currency Engine"')).toBe('Multi-Currency Engine');
      expect(sanitizeTitle('\'Title: Fix Token Refresh\'')).toBe('Fix Token Refresh');
      expect(sanitizeTitle('“Headline: Realtime WhatsApp Stream”')).toBe('Realtime WhatsApp Stream');
    });

    it('strips <think>...</think> reasoning blocks before selecting the title line (Finding 2 fix)', () => {
      const reasoningOutput =
        '<think>\n' +
        'The user wants a concise title from the changelog.\n' +
        'Key feature: Interactive Category Selection.\n' +
        '</think>\n' +
        'Interactive Category Selection';

      expect(sanitizeTitle(reasoningOutput)).toBe('Interactive Category Selection');
    });

    it('handles unicode smart/curly quotes (Finding 3 fix)', () => {
      expect(sanitizeTitle('“Multi-Currency Exchange Rate Engine”')).toBe(
        'Multi-Currency Exchange Rate Engine'
      );
      expect(sanitizeTitle('‘Automated Bank Reconciliation’')).toBe(
        'Automated Bank Reconciliation'
      );
    });

    it('strips trailing punctuation', () => {
      expect(sanitizeTitle('New WhatsApp Interactive Buttons.')).toBe('New WhatsApp Interactive Buttons');
      expect(sanitizeTitle('Fix Token Expiration Timeout!')).toBe('Fix Token Expiration Timeout');
      expect(sanitizeTitle('Refactored Domain Core: ')).toBe('Refactored Domain Core');
    });

    it('strips emojis in compliance with repository rules', () => {
      const rawWithEmoji = '🚀 Support Multi-Currency [launch] & Auto Sync 💰';
      const result = sanitizeTitle(rawWithEmoji);
      expect(result).not.toContain('🚀');
      expect(result).not.toContain('💰');
      expect(result).toBe('Support Multi-Currency [launch] & Auto Sync');
    });

    it('selects the first non-empty line from multi-line output', () => {
      const multiLine = '\n\n  Fix Bank Webhook Retry Logic  \n\nSome explanation here';
      expect(sanitizeTitle(multiLine)).toBe('Fix Bank Webhook Retry Logic');
    });
  });

  describe('extractReleaseSnippet', () => {
    it('reads and truncates existing release notes file', () => {
      const notesFilePath = path.join(temporaryDirectory, 'release-notes.md');
      fs.writeFileSync(notesFilePath, '# Notes\n- feat: new feature added\n- fix: minor bugfix');

      const snippet = extractReleaseSnippet(notesFilePath, 20);
      expect(snippet.length).toBeLessThanOrEqual(20);
      expect(snippet).toBe('# Notes\n- feat: new ');
    });

    it('returns default fallback when file does not exist', () => {
      const nonExistentPath = path.join(temporaryDirectory, 'does-not-exist.md');
      const snippet = extractReleaseSnippet(nonExistentPath);
      expect(snippet).toBeTruthy();
    });
  });

  describe('requestOpenRouterTitle', () => {
    it('returns null if apiKey is missing', async () => {
      const result = await requestOpenRouterTitle({
        apiKey: '',
        changelogSnippet: 'some changelog'
      });
      expect(result).toBeNull();
    });

    it('successfully calls OpenRouter and parses sanitized title', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '"Multi-Currency Exchange Rate Engine"'
              }
            }
          ]
        })
      });

      const title = await requestOpenRouterTitle({
        apiKey: 'test-key',
        changelogSnippet: 'feat: add exchange rates',
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(title).toBe('Multi-Currency Exchange Rate Engine');
    });

    it('returns null gracefully on HTTP error status without throwing', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429
      });

      const title = await requestOpenRouterTitle({
        apiKey: 'test-key',
        changelogSnippet: 'feat: something',
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(title).toBeNull();
    });

    it('returns null gracefully on network failure or rejection', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));

      const title = await requestOpenRouterTitle({
        apiKey: 'test-key',
        changelogSnippet: 'feat: something',
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(title).toBeNull();
    });
  });

  describe('generateReleaseTitle', () => {
    it('formats title as "tagName - AI Title" when OpenRouter succeeds', async () => {
      const notesFilePath = path.join(temporaryDirectory, 'release-notes.md');
      const outputTitlePath = path.join(temporaryDirectory, 'release-title.txt');
      const githubEnvPath = path.join(temporaryDirectory, 'github_env.txt');

      fs.writeFileSync(notesFilePath, '- feat: add interactive category buttons');

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'Interactive Category Buttons and Selection'
              }
            }
          ]
        })
      });

      const releaseName = await generateReleaseTitle({
        apiKey: 'test-key',
        tagName: 'v2.1.0',
        notesFile: notesFilePath,
        outputTitleFile: outputTitlePath,
        githubEnvPath,
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(releaseName).toBe('v2.1.0 - Interactive Category Buttons and Selection');
      expect(fs.readFileSync(outputTitlePath, 'utf8')).toBe(
        'v2.1.0 - Interactive Category Buttons and Selection'
      );
      expect(fs.readFileSync(githubEnvPath, 'utf8')).toContain(
        'RELEASE_NAME=v2.1.0 - Interactive Category Buttons and Selection\n'
      );
    });

    it('deduplicates tag name if AI title already includes it (Finding 4 fix)', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'v2.1.0 - Interactive Category Buttons'
              }
            }
          ]
        })
      });

      const releaseName = await generateReleaseTitle({
        apiKey: 'test-key',
        tagName: 'v2.1.0',
        outputTitleFile: path.join(temporaryDirectory, 'dedup-title.txt'),
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(releaseName).toBe('v2.1.0 - Interactive Category Buttons');
    });

    it('falls back to tagName when apiKey is not provided', async () => {
      const outputTitlePath = path.join(temporaryDirectory, 'release-title.txt');
      const githubEnvPath = path.join(temporaryDirectory, 'github_env.txt');

      const releaseName = await generateReleaseTitle({
        apiKey: '',
        tagName: 'v2.1.0',
        outputTitleFile: outputTitlePath,
        githubEnvPath
      });

      expect(releaseName).toBe('v2.1.0');
      expect(fs.readFileSync(outputTitlePath, 'utf8')).toBe('v2.1.0');
      expect(fs.readFileSync(githubEnvPath, 'utf8')).toContain('RELEASE_NAME=v2.1.0\n');
    });

    it('falls back to tagName when OpenRouter returns an error', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500
      });

      const releaseName = await generateReleaseTitle({
        apiKey: 'test-key',
        tagName: 'v1.5.0',
        notesFile: path.join(temporaryDirectory, 'notes.md'),
        outputTitleFile: path.join(temporaryDirectory, 'title.txt'),
        fetchFn: mockFetch as unknown as typeof fetch
      });

      expect(releaseName).toBe('v1.5.0');
    });
  });
});
