import { describe, it, expect, vi } from 'vitest';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  isWalletMcpDefinitiveFailure,
  isWalletMcpDispatchOutcomeUnknown,
} from '../src/wallet/index.js';
import { validatePatchRecordsResponse } from '../src/wallet/records/recordValidation.js';
import type { WalletPatchRecordsResponse } from '../src/wallet/types.js';

describe('Wallet MCP patch_records Response Validation', () => {
  const dummyBaseUrl = 'https://example.invalid';
  const dummyToken = 'test-token';

  it('validates successful single patch response with matching summary and results', () => {
    const successPayload: WalletPatchRecordsResponse = {
      summary: { total: 1, succeeded: 1 },
      results: [{ id: 'rec-1', inputIndex: 0, success: true }],
    };

    const validated = validatePatchRecordsResponse(successPayload, 1);
    expect(validated.summary?.succeeded).toBe(1);
    expect(validated.results?.[0]?.success).toBe(true);
  });

  it('validates successful batch patch response', () => {
    const batchPayload: WalletPatchRecordsResponse = {
      summary: { total: 2, succeeded: 2, failed: 0 },
      results: [
        { id: 'rec-1', inputIndex: 0, success: true },
        { id: 'rec-2', inputIndex: 1, success: true },
      ],
    };

    const validated = validatePatchRecordsResponse(batchPayload, 2);
    expect(validated.summary?.succeeded).toBe(2);
    expect(validated.results).toHaveLength(2);
  });

  it('accepts summary-only positive evidence when results array is omitted', () => {
    const summaryOnlyPayload: WalletPatchRecordsResponse = {
      summary: { total: 1, succeeded: 1 },
    };

    const validated = validatePatchRecordsResponse(summaryOnlyPayload, 1);
    expect(validated.summary?.succeeded).toBe(1);
  });

  it('accepts results-only positive evidence when summary is omitted', () => {
    const resultsOnlyPayload: WalletPatchRecordsResponse = {
      results: [{ id: 'rec-1', inputIndex: 0, success: true }],
    };

    const validated = validatePatchRecordsResponse(resultsOnlyPayload, 1);
    expect(validated.results?.[0]?.success).toBe(true);
  });

  it('rejects ghost / record not found failure with DEFINITIVE_FAILURE dispatch outcome', () => {
    const ghostPayload: WalletPatchRecordsResponse = {
      summary: { total: 1, succeeded: 0, failed: 1, clientErrors: 1 },
      results: [
        {
          id: '321f074f-62e6-4319-a34e-f02d82723731',
          inputIndex: 0,
          success: false,
          error: 'record not found (field: id)',
          errorType: 'client_error',
        },
      ],
    };

    try {
      validatePatchRecordsResponse(ghostPayload, 1);
      expect.unreachable('Should have thrown WalletMcpRequestError');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletMcpRequestError);
      const reqErr = err as WalletMcpRequestError;
      expect(reqErr.message).toContain('record not found');
      expect(isWalletMcpDefinitiveFailure(reqErr)).toBe(true);
    }
  });

  it('marks server error failure with UNKNOWN dispatch outcome', () => {
    const serverErrorPayload: WalletPatchRecordsResponse = {
      summary: { total: 1, succeeded: 0, failed: 1, serverErrors: 1 },
      results: [
        {
          id: 'rec-1',
          inputIndex: 0,
          success: false,
          error: 'Database locked',
          errorType: 'server_error',
        },
      ],
    };

    try {
      validatePatchRecordsResponse(serverErrorPayload, 1);
      expect.unreachable('Should have thrown WalletMcpRequestError');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletMcpRequestError);
      const reqErr = err as WalletMcpRequestError;
      expect(isWalletMcpDispatchOutcomeUnknown(reqErr)).toBe(true);
    }
  });

  it('marks partial success failure with UNKNOWN dispatch outcome', () => {
    const mixedPayload: WalletPatchRecordsResponse = {
      summary: { total: 2, succeeded: 1, failed: 1, clientErrors: 1 },
      results: [
        { id: 'rec-1', inputIndex: 0, success: true },
        { id: 'rec-2', inputIndex: 1, success: false, error: 'invalid category' },
      ],
    };

    try {
      validatePatchRecordsResponse(mixedPayload, 2);
      expect.unreachable('Should have thrown WalletMcpRequestError');
    } catch (err) {
      expect(err).toBeInstanceOf(WalletMcpRequestError);
      const reqErr = err as WalletMcpRequestError;
      expect(isWalletMcpDispatchOutcomeUnknown(reqErr)).toBe(true);
    }
  });

  it('rejects invalid or unverifiable responses (null, string, array, empty)', () => {
    expect(() => validatePatchRecordsResponse(null, 1)).toThrow(WalletMcpRequestError);
    expect(() => validatePatchRecordsResponse(undefined, 1)).toThrow(WalletMcpRequestError);
    expect(() => validatePatchRecordsResponse('ok', 1)).toThrow(WalletMcpRequestError);
    expect(() => validatePatchRecordsResponse([], 1)).toThrow(WalletMcpRequestError);
    expect(() => validatePatchRecordsResponse({}, 1)).toThrow(WalletMcpRequestError);
  });

  it('rejects inconsistent summary totals and negative values', () => {
    expect(() =>
      validatePatchRecordsResponse({ summary: { total: -1, succeeded: 1 } }, 1)
    ).toThrow(/invalid or mismatched summary/);

    expect(() =>
      validatePatchRecordsResponse({ summary: { total: 2, succeeded: 1 } }, 1)
    ).toThrow(/invalid or mismatched summary/);

    expect(() =>
      validatePatchRecordsResponse(
        { summary: { total: 1, succeeded: 1, failed: 2 } },
        1
      )
    ).toThrow(/invalid or mismatched summary/);
  });

  it('rejects mismatched summary and results counts', () => {
    expect(() =>
      validatePatchRecordsResponse(
        {
          summary: { total: 1, succeeded: 1 },
          results: [{ id: 'rec-1', success: false }],
        },
        1
      )
    ).toThrow(/inconsistent summary/);
  });

  it('rejects invalid per-record results shapes', () => {
    expect(() =>
      validatePatchRecordsResponse(
        {
          results: [{ id: 'rec-1', success: 'yes' as any }],
        },
        1
      )
    ).toThrow(/invalid per-record results/);

    expect(() =>
      validatePatchRecordsResponse(
        {
          results: [],
        },
        1
      )
    ).toThrow(/unexpected number of per-record results/);
  });

  it('is accessible via WalletMcpClientService.validatePatchRecordsResponse', () => {
    const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
    const result = client.validatePatchRecordsResponse(
      { summary: { total: 1, succeeded: 1 }, results: [{ id: 'rec-1', success: true }] },
      1
    );
    expect(result.summary?.succeeded).toBe(1);
  });
});
