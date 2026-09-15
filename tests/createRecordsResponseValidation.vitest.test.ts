import { describe, it, expect, vi } from 'vitest';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  isWalletMcpDefinitiveFailure,
  isWalletMcpDispatchOutcomeUnknown,
} from '../src/services/walletMcpService.js';
import { CreateRecordInputPayload, WalletCreateRecordsResponse } from '../src/types/walletTypes.js';

describe('Wallet MCP create_records Response Validation (Issue #146)', () => {
  const dummyBaseUrl = 'https://example.invalid';
  const dummyToken = 'test-token';

  const sampleRecord: CreateRecordInputPayload = {
    accountId: 'Gopay',
    amount: -54200,
    currency: 'IDR',
    recordDate: '2026-09-13T08:26:18',
    note: 'Belanja Xpress Klik Indomaret',
    counterParty: 'Indomaret',
  };

  function createClientWithToolResponse(toolResponse: unknown): WalletMcpClientService {
    const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
    vi.spyOn(client, 'callMcpTool').mockResolvedValue(toolResponse);
    return client;
  }

  describe('Production Reproduction (False-Negative Fix)', () => {
    it('accepts current-format full success response with clientErrors=0, serverErrors=0, documentsWritten=1', async () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const productionSuccessPayload: WalletCreateRecordsResponse = {
        results: [
          {
            id: '794a1c1d-481a-4a8f-9681-e07f418a1506',
            inputIndex: 0,
            success: true,
            record: {
              accountName: 'Gopay',
              amount: {
                currencyCode: 'IDR',
                value: -54200,
              },
              counterParty: 'Indomaret',
              note: 'Belanja Xpress Klik Indomaret',
              recordState: 'cleared',
              recordType: 'expense',
              source: 'mcp',
            },
          },
        ],
        summary: {
          clientErrors: 0,
          documentsWritten: 1,
          serverErrors: 0,
          succeeded: 1,
          total: 1,
        },
      };

      const result = client.validateCreateRecordsResponse(productionSuccessPayload, 1);
      expect(result).toBeDefined();
      expect(result.summary?.succeeded).toBe(1);
      expect(result.summary?.documentsWritten).toBe(1);
      expect(result.results?.[0]?.success).toBe(true);
    });

    it('end-to-end createRecords succeeds with production MCP response shape', async () => {
      const productionMcpResponse = {
        results: [
          {
            id: '794a1c1d-481a-4a8f-9681-e07f418a1506',
            inputIndex: 0,
            success: true,
            record: {
              accountName: 'Gopay',
              amount: { currencyCode: 'IDR', value: -54200 },
              counterParty: 'Indomaret',
              note: 'Belanja Xpress Klik Indomaret',
              recordState: 'cleared',
              recordType: 'expense',
              source: 'mcp',
            },
          },
        ],
        summary: {
          clientErrors: 0,
          documentsWritten: 1,
          serverErrors: 0,
          succeeded: 1,
          total: 1,
        },
      };

      const client = createClientWithToolResponse(productionMcpResponse);
      const result = await client.createRecords([sampleRecord]);

      expect(result.summary?.succeeded).toBe(1);
      expect(result.summary?.documentsWritten).toBe(1);
      expect(result.results?.[0]?.id).toBe('794a1c1d-481a-4a8f-9681-e07f418a1506');
    });
  });

  describe('Multi-Record Full Success', () => {
    it('accepts multi-record batch write when all evidence is consistent', async () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const multiRecordSuccessPayload: WalletCreateRecordsResponse = {
        results: [
          { id: 'rec-1', inputIndex: 0, success: true },
          { id: 'rec-2', inputIndex: 1, success: true },
        ],
        summary: {
          total: 2,
          succeeded: 2,
          clientErrors: 0,
          serverErrors: 0,
          documentsWritten: 2,
        },
      };

      const result = client.validateCreateRecordsResponse(multiRecordSuccessPayload, 2);
      expect(result.summary?.succeeded).toBe(2);
      expect(result.summary?.documentsWritten).toBe(2);
      expect(result.results?.length).toBe(2);
    });
  });

  describe('Explicit Failures & Outcome Classification', () => {
    it('classifies current-format explicit client failure as DEFINITIVE_FAILURE', async () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const clientFailurePayload: WalletCreateRecordsResponse = {
        results: [
          {
            inputIndex: 0,
            success: false,
            errorType: 'client_error',
            error: "category '12' is a system category and cannot be assigned directly (field: categoryId)",
          },
        ],
        summary: {
          total: 1,
          succeeded: 0,
          clientErrors: 1,
          serverErrors: 0,
          documentsWritten: 0,
        },
      };

      let thrownError: unknown;
      try {
        client.validateCreateRecordsResponse(clientFailurePayload, 1);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(WalletMcpRequestError);
      const requestError = thrownError as WalletMcpRequestError;
      expect(requestError.dispatchOutcome).toBe('DEFINITIVE_FAILURE');
      expect(isWalletMcpDefinitiveFailure(requestError)).toBe(true);
      expect(isWalletMcpDispatchOutcomeUnknown(requestError)).toBe(false);
      expect(requestError.message).toContain('rejected 1 record(s)');
      expect(requestError.message).toContain('system category');
    });

    it('classifies current-format explicit server failure as UNKNOWN to prevent unsafe retries', async () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const serverFailurePayload: WalletCreateRecordsResponse = {
        results: [
          {
            inputIndex: 0,
            success: false,
            errorType: 'server_error',
            error: 'Upstream BudgetBakers API returned 500 Internal Server Error',
          },
        ],
        summary: {
          total: 1,
          succeeded: 0,
          clientErrors: 0,
          serverErrors: 1,
          documentsWritten: 0,
        },
      };

      let thrownError: unknown;
      try {
        client.validateCreateRecordsResponse(serverFailurePayload, 1);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(WalletMcpRequestError);
      const requestError = thrownError as WalletMcpRequestError;
      expect(requestError.dispatchOutcome).toBe('UNKNOWN');
      expect(isWalletMcpDispatchOutcomeUnknown(requestError)).toBe(true);
      expect(isWalletMcpDefinitiveFailure(requestError)).toBe(false);
      expect(requestError.message).toContain('rejected 1 record(s)');
      expect(requestError.message).toContain('Upstream BudgetBakers API');
    });

    it('classifies mixed success/failure as UNKNOWN and never acknowledges it as full success', async () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const mixedPayload: WalletCreateRecordsResponse = {
        results: [
          { id: 'rec-1', inputIndex: 0, success: true },
          {
            inputIndex: 1,
            success: false,
            errorType: 'client_error',
            error: 'Invalid category for record 2',
          },
        ],
        summary: {
          total: 2,
          succeeded: 1,
          clientErrors: 1,
          serverErrors: 0,
          documentsWritten: 1,
        },
      };

      let thrownError: unknown;
      try {
        client.validateCreateRecordsResponse(mixedPayload, 2);
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(WalletMcpRequestError);
      const requestError = thrownError as WalletMcpRequestError;
      // Because partial documents were written (documentsWritten=1, succeeded=1), the batch cannot be retried safely
      expect(requestError.dispatchOutcome).toBe('UNKNOWN');
      expect(requestError.message).toContain('rejected 1 record(s)');
      expect(requestError.message).toContain('Invalid category for record 2');
    });
  });

  describe('Contradictory & Mismatched Evidence', () => {
    it('rejects contradictory summary vs per-record results as UNKNOWN', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const contradictoryPayload: WalletCreateRecordsResponse = {
        results: [{ id: 'rec-1', inputIndex: 0, success: false, error: 'failed' }],
        summary: {
          total: 1,
          succeeded: 1,
          clientErrors: 0,
          serverErrors: 0,
          documentsWritten: 1,
        },
      };

      expect(() => client.validateCreateRecordsResponse(contradictoryPayload, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('inconsistent summary and per-record results'),
        })
      );
    });

    it('rejects unexpected number of per-record results as UNKNOWN', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const mismatchedResultsCountPayload: WalletCreateRecordsResponse = {
        results: [
          { id: 'rec-1', success: true },
          { id: 'rec-2', success: true },
        ],
        summary: {
          total: 2,
          succeeded: 1,
          clientErrors: 0,
          serverErrors: 0,
          documentsWritten: 1,
        },
      };

      expect(() => client.validateCreateRecordsResponse(mismatchedResultsCountPayload, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('uncorrelated per-record results'),
        })
      );
    });

    it('rejects mismatched documentsWritten when it contradicts positive success evidence', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const mismatchedDocumentsWrittenPayload: WalletCreateRecordsResponse = {
        results: [{ id: 'rec-1', inputIndex: 0, success: true }],
        summary: {
          total: 1,
          succeeded: 1,
          clientErrors: 0,
          serverErrors: 0,
          documentsWritten: 0, // Contradicts succeeded=1
        },
      };

      expect(() => client.validateCreateRecordsResponse(mismatchedDocumentsWrittenPayload, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('invalid or mismatched summary'),
        })
      );
    });

    it('rejects malformed error counters where only one error counter is provided', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const partialErrorSummary: WalletCreateRecordsResponse = {
        summary: {
          total: 1,
          succeeded: 1,
          clientErrors: 0,
          // serverErrors is missing
          documentsWritten: 1,
        },
      };

      expect(() => client.validateCreateRecordsResponse(partialErrorSummary, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('invalid or mismatched summary'),
        })
      );
    });

    it('rejects contradictory error sums where failed !== clientErrors + serverErrors', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const conflictingErrorSummary: WalletCreateRecordsResponse = {
        summary: {
          total: 2,
          succeeded: 1,
          failed: 2, // Contradicts clientErrors (1) + serverErrors (0) = 1
          clientErrors: 1,
          serverErrors: 0,
        },
      };

      expect(() => client.validateCreateRecordsResponse(conflictingErrorSummary, 2)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('invalid or mismatched summary'),
        })
      );
    });
  });

  describe('Backward Compatibility (Legacy Contract)', () => {
    it('accepts legacy summary with total, succeeded, and failed=0', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const legacySuccessPayload: WalletCreateRecordsResponse = {
        summary: {
          total: 1,
          succeeded: 1,
          failed: 0,
        },
      };

      const result = client.validateCreateRecordsResponse(legacySuccessPayload, 1);
      expect(result.summary?.succeeded).toBe(1);
    });

    it('classifies legacy summary with failed > 0 as DEFINITIVE_FAILURE', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const legacyFailurePayload: WalletCreateRecordsResponse = {
        summary: {
          total: 1,
          succeeded: 0,
          failed: 1,
        },
        results: [{ inputIndex: 0, success: false, error: 'Invalid currency' }],
      };

      expect(() => client.validateCreateRecordsResponse(legacyFailurePayload, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'DEFINITIVE_FAILURE',
          message: expect.stringContaining('rejected 1 record(s): Invalid currency'),
        })
      );
    });
  });

  describe('Unverifiable & Missing Evidence', () => {
    it('rejects null, non-object, and empty responses as UNKNOWN', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);

      expect(() => client.validateCreateRecordsResponse(null, 1)).toThrow(
        expect.objectContaining({ dispatchOutcome: 'UNKNOWN' })
      );
      expect(() => client.validateCreateRecordsResponse(undefined, 1)).toThrow(
        expect.objectContaining({ dispatchOutcome: 'UNKNOWN' })
      );
      expect(() => client.validateCreateRecordsResponse('random-string', 1)).toThrow(
        expect.objectContaining({ dispatchOutcome: 'UNKNOWN' })
      );
      expect(() => client.validateCreateRecordsResponse([], 1)).toThrow(
        expect.objectContaining({ dispatchOutcome: 'UNKNOWN' })
      );
      expect(() => client.validateCreateRecordsResponse({}, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('returned no recognized success evidence'),
        })
      );
    });

    it('rejects responses with incomplete summary that provide no failure counters, results, or documentsWritten', () => {
      const client = new WalletMcpClientService(dummyBaseUrl, dummyToken);
      const incompleteSummary: WalletCreateRecordsResponse = {
        summary: {
          total: 1,
          succeeded: 1,
        },
      };

      expect(() => client.validateCreateRecordsResponse(incompleteSummary, 1)).toThrow(
        expect.objectContaining({
          dispatchOutcome: 'UNKNOWN',
          message: expect.stringContaining('did not provide positive evidence'),
        })
      );
    });
  });
});
