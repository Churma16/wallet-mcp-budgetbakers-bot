import { describe, expect, it } from 'vitest';
import { calculateExponentialBackoff } from '../src/utils/exponentialBackoff.js';
import { digitsOnly } from '../src/utils/digitNormalization.js';

describe('calculateExponentialBackoff', () => {
  it('scales the base delay exponentially and adds configured jitter', () => {
    expect(calculateExponentialBackoff({
      attempt: 1,
      baseMs: 2000,
      maxMs: 15000,
      jitterMinMs: 500,
      jitterMaxMs: 501,
    })).toBe(4500);
  });

  it('caps the exponential component before adding jitter', () => {
    expect(calculateExponentialBackoff({
      attempt: 10,
      baseMs: 5000,
      maxMs: 300000,
      jitterMinMs: 700,
      jitterMaxMs: 701,
    })).toBe(300700);
  });

  it('uses the configured jitter range', () => {
    for (let iteration = 0; iteration < 25; iteration++) {
      const delayMs = calculateExponentialBackoff({
        attempt: 0,
        baseMs: 1000,
        maxMs: 1000,
        jitterMinMs: 25,
        jitterMaxMs: 50,
      });

      expect(delayMs).toBeGreaterThanOrEqual(1025);
      expect(delayMs).toBeLessThan(1050);
    }
  });
});

describe('digitsOnly', () => {
  it.each([
    ['+62 (812) 345-6789', '628123456789'],
    ['5074-3187 7335', '507431877335'],
    ['123456789', '123456789'],
    ['abc-._', ''],
    ['', ''],
  ])('normalizes %j to %j', (input, expected) => {
    expect(digitsOnly(input)).toBe(expected);
  });
});
