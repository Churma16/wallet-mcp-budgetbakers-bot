import { describe, expect, it } from 'vitest';
import { parseFinancialAmount, parseFinancialAmountString } from '../src/brain/index.js';

describe('parseFinancialAmount guard clauses & branch normalization', () => {
  it('parses single dot in IDR context as thousands separator', () => {
    expect(parseFinancialAmount('Rp10.079')?.amount).toBe(10079);
    expect(parseFinancialAmount('Rp15.100')?.amount).toBe(15100);
    // Non-3 trailing digits in IDR dot notation is invalid
    expect(parseFinancialAmount('Rp10.5')).toBeNull();
  });

  it('parses single dot in decimal currency context as decimal separator', () => {
    expect(parseFinancialAmount('$10.50', 'USD')?.amount).toBe(10.5);
    expect(parseFinancialAmount('$10.5', 'USD')?.amount).toBe(10.5);
    // 3 trailing digits in decimal currency is ambiguous
    expect(parseFinancialAmount('$10.500', 'USD')).toBeNull();
  });

  it('parses single dot with no currency as decimal when 1-2 trailing digits', () => {
    expect(parseFinancialAmount('10.50')?.amount).toBe(10.5);
    expect(parseFinancialAmount('10.5')?.amount).toBe(10.5);
    expect(parseFinancialAmount('10.500')).toBeNull();
  });

  it('parses single comma in IDR context as decimal separator', () => {
    expect(parseFinancialAmount('Rp50,50')?.amount).toBe(50.5);
    expect(parseFinancialAmount('Rp50,5')?.amount).toBe(50.5);
    expect(parseFinancialAmount('Rp50,500')).toBeNull();
  });

  it('parses single comma in decimal currency context as thousands separator', () => {
    expect(parseFinancialAmount('$1,234', 'USD')?.amount).toBe(1234);
    expect(parseFinancialAmount('$10,50', 'USD')).toBeNull();
  });

  it('rejects ambiguous single comma without currency context', () => {
    expect(parseFinancialAmount('10,50')).toBeNull();
  });

  it('parses multiple separators correctly', () => {
    expect(parseFinancialAmount('1.500.000')?.amount).toBe(1500000);
    expect(parseFinancialAmount('1,500,000')?.amount).toBe(1500000);
    expect(parseFinancialAmount('1,234.50')?.amount).toBe(1234.5);
    expect(parseFinancialAmount('1.234,50')?.amount).toBe(1234.5);
  });

  it('convenience wrapper returns numeric amount or null', () => {
    expect(parseFinancialAmountString('Rp25.000')).toBe(25000);
    expect(parseFinancialAmountString('invalid')).toBeNull();
  });
});
