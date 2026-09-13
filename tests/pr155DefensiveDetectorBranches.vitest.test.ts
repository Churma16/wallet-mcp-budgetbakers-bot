import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectReconciliationAction } from '../src/utils/fastPathIntentDetector.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PR #155 reconciliation parser defensive branches', () => {
  it.each([
    ['sudah ada 31', 'sudah\\s+ada'],
    ['belum ada 31', 'belum\\s+ada'],
    ['sudah 31', 'sudah|ada|exists?'],
    ['belum 31', '^(?:belum)'],
  ] as const)('fails closed when a regex match unexpectedly lacks its ticket capture: %s', (input, marker) => {
    const originalMatch = String.prototype.match;
    vi.spyOn(String.prototype, 'match').mockImplementation(function (regexp: string | RegExp) {
      if (regexp instanceof RegExp && regexp.source.includes(marker)) {
        return [String(this)] as RegExpMatchArray;
      }
      return originalMatch.call(String(this), regexp);
    });

    expect(detectReconciliationAction(input)).toBeNull();
  });

  it.each([
    'sudah ada 31',
    'belum ada 31',
    'sudah 31',
    'belum 31',
  ])('fails closed if defensive integer parsing returns NaN for %s', input => {
    vi.spyOn(Number, 'parseInt').mockReturnValue(Number.NaN);
    expect(detectReconciliationAction(input)).toBeNull();
  });

  it.each([
    'sudah ada 0',
    'belum ada 0',
    'sudah 0',
    'belum 0',
  ])('covers the parsed-but-non-positive defensive branch for %s', input => {
    expect(detectReconciliationAction(input)).toBeNull();
  });
});
