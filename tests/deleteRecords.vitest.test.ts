import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  callDeleteDocuments,
  WALLET_MCP_TOOL_NAMES,
  WALLET_MCP_ALLOWED_TOOL_NAMES,
  WalletMcpRequestError,
  validateDeleteRecordsResponse,
  deleteRecords,
  WalletMcpClient,
  type WalletToolCaller,
} from '../src/wallet/index.js';

describe('delete_documents tool wrappers and validation', () => {
  it('registers delete_documents in tool names and allowed tool names', () => {
    expect(WALLET_MCP_TOOL_NAMES.DELETE_DOCUMENTS).toBe('delete_documents');
    expect(WALLET_MCP_ALLOWED_TOOL_NAMES).toContain('delete_documents');
  });

  describe('callDeleteDocuments', () => {
    it('dispatches delete_documents with serialized arguments', async () => {
      const mockCaller: WalletToolCaller = {
        callMcpTool: vi.fn().mockResolvedValue({
          summary: { total: 1, succeeded: 1 },
          results: [{ id: 'rec-123', success: true }],
        }),
      };

      const result = await callDeleteDocuments(mockCaller, {
        type: 'records',
        ids: ['rec-123'],
      });

      expect(mockCaller.callMcpTool).toHaveBeenCalledWith('delete_documents', {
        documentType: 'records',
        ids: ['rec-123'],
      });
      expect(result).toEqual({
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-123', success: true }],
      });
    });
  });

  describe('validateDeleteRecordsResponse', () => {
    it('throws when response is null or not an object', () => {
      expect(() => validateDeleteRecordsResponse(null, 1)).toThrow(WalletMcpRequestError);
      expect(() => validateDeleteRecordsResponse('string', 1)).toThrow(WalletMcpRequestError);
      expect(() => validateDeleteRecordsResponse([], 1)).toThrow(WalletMcpRequestError);
    });

    it('throws when neither summary nor results exist', () => {
      expect(() => validateDeleteRecordsResponse({}, 1)).toThrow(
        /returned no recognized success evidence/
      );
    });

    it('validates successful deletion with summary and results', () => {
      const response = {
        summary: { total: 2, succeeded: 2 },
        results: [
          { id: 'rec-1', success: true },
          { id: 'rec-2', success: true },
        ],
      };

      const validated = validateDeleteRecordsResponse(response, 2);
      expect(validated).toEqual(response);
    });

    it('throws definitive failure when item fails with client error', () => {
      const response = {
        summary: { total: 1, succeeded: 0, clientErrors: 1, failed: 1 },
        results: [
          { id: 'rec-1', success: false, error: 'Document not found', errorType: 'client_error' },
        ],
      };

      expect(() => validateDeleteRecordsResponse(response, 1)).toThrow(
        /rejected deletion of 1 record\(s\): Document not found/
      );
    });

    it('throws unknown failure outcome when server error occurs', () => {
      const response = {
        summary: { total: 1, succeeded: 0, serverErrors: 1, failed: 1 },
        results: [
          { id: 'rec-1', success: false, error: 'Internal database error', errorType: 'server_error' },
        ],
      };

      try {
        validateDeleteRecordsResponse(response, 1);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(WalletMcpRequestError);
        expect((err as WalletMcpRequestError).dispatchOutcome).toBe('UNKNOWN');
      }
    });
  });
});

describe('deleteRecords service logic', () => {
  let mockClient: WalletToolCaller;

  beforeEach(() => {
    mockClient = {
      callMcpTool: vi.fn(),
    };
  });

  it('rejects with referential validation error if no valid record IDs provided', async () => {
    await expect(deleteRecords(mockClient, [])).rejects.toThrow(
      /Referential validation error: No valid record IDs provided/
    );
    await expect(deleteRecords(mockClient, ['   ', ''])).rejects.toThrow(
      /Referential validation error: No valid record IDs provided/
    );
    expect(mockClient.callMcpTool).not.toHaveBeenCalled();
  });

  it('rejects if more than 20 IDs provided', async () => {
    const twentyOneIds = Array.from({ length: 21 }, (_, i) => `rec-${i}`);
    await expect(deleteRecords(mockClient, twentyOneIds)).rejects.toThrow(
      /Maximum 20 record IDs allowed per deletion request/
    );
    expect(mockClient.callMcpTool).not.toHaveBeenCalled();
  });

  it('deletes single record successfully', async () => {
    vi.mocked(mockClient.callMcpTool).mockResolvedValueOnce({
      summary: { total: 1, succeeded: 1 },
      results: [{ id: 'rec-100', success: true }],
    });

    const result = await deleteRecords(mockClient, 'rec-100');

    expect(mockClient.callMcpTool).toHaveBeenCalledWith('delete_documents', {
      documentType: 'records',
      ids: ['rec-100'],
    });
    expect(result.summary?.succeeded).toBe(1);
  });

  it('deduplicates multiple record IDs', async () => {
    vi.mocked(mockClient.callMcpTool).mockResolvedValueOnce({
      summary: { total: 2, succeeded: 2 },
      results: [
        { id: 'rec-1', success: true },
        { id: 'rec-2', success: true },
      ],
    });

    const result = await deleteRecords(mockClient, ['rec-1', 'rec-2', 'rec-1', '  rec-2  ']);

    expect(mockClient.callMcpTool).toHaveBeenCalledWith('delete_documents', {
      documentType: 'records',
      ids: ['rec-1', 'rec-2'],
    });
    expect(result.summary?.succeeded).toBe(2);
  });

  it('atomically retries paired transfer deletion when upstream error names missing leg UUID', async () => {
    const leg1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const leg2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

    // First call throws paired transfer error mentioning partner leg UUID
    vi.mocked(mockClient.callMcpTool)
      .mockRejectedValueOnce(
        new Error(
          `Paired transfer records delete as a pair: both IDs must be in the same request, missing partner leg: ${leg2}`
        )
      )
      // Second call (retry with both legs) succeeds
      .mockResolvedValueOnce({
        summary: { total: 2, succeeded: 2 },
        results: [
          { id: leg1, success: true },
          { id: leg2, success: true },
        ],
      });

    const result = await deleteRecords(mockClient, leg1);

    expect(mockClient.callMcpTool).toHaveBeenCalledTimes(2);
    expect(mockClient.callMcpTool).toHaveBeenNthCalledWith(1, 'delete_documents', {
      documentType: 'records',
      ids: [leg1],
    });
    expect(mockClient.callMcpTool).toHaveBeenNthCalledWith(2, 'delete_documents', {
      documentType: 'records',
      ids: [leg1, leg2],
    });
    expect(result.summary?.succeeded).toBe(2);
  });

  it('atomically retries when requested record ID precedes partner ID in error text', async () => {
    const leg1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const leg2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

    // Upstream error mentions target record leg1 first, followed by companion leg2
    vi.mocked(mockClient.callMcpTool)
      .mockRejectedValueOnce(
        new Error(
          `Record ${leg1} is part of a paired transfer and cannot be deleted without companion record ${leg2}`
        )
      )
      .mockResolvedValueOnce({
        summary: { total: 2, succeeded: 2 },
        results: [
          { id: leg1, success: true },
          { id: leg2, success: true },
        ],
      });

    const result = await deleteRecords(mockClient, leg1);

    expect(mockClient.callMcpTool).toHaveBeenCalledTimes(2);
    expect(mockClient.callMcpTool).toHaveBeenNthCalledWith(2, 'delete_documents', {
      documentType: 'records',
      ids: [leg1, leg2],
    });
    expect(result.summary?.succeeded).toBe(2);
  });

  it('atomically retries paired transfer deletion when result item contains partner leg UUID', async () => {
    const leg1 = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const leg2 = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';

    // First call returns unthrown result with paired error
    vi.mocked(mockClient.callMcpTool)
      .mockResolvedValueOnce({
        summary: { total: 1, succeeded: 0, failed: 1 },
        results: [
          {
            id: leg1,
            success: false,
            error: `Paired transfer record requires companion ID ${leg2}`,
          },
        ],
      })
      // Second call succeeds
      .mockResolvedValueOnce({
        summary: { total: 2, succeeded: 2 },
        results: [
          { id: leg1, success: true },
          { id: leg2, success: true },
        ],
      });

    const result = await deleteRecords(mockClient, leg1);

    expect(mockClient.callMcpTool).toHaveBeenCalledTimes(2);
    expect(mockClient.callMcpTool).toHaveBeenNthCalledWith(2, 'delete_documents', {
      documentType: 'records',
      ids: [leg1, leg2],
    });
    expect(result.summary?.succeeded).toBe(2);
  });

  it('propagates error when non-paired failure occurs without partner UUID', async () => {
    vi.mocked(mockClient.callMcpTool).mockRejectedValueOnce(
      new Error('Database connectivity timeout')
    );

    await expect(deleteRecords(mockClient, 'rec-999')).rejects.toThrow(
      /Database connectivity timeout/
    );
    expect(mockClient.callMcpTool).toHaveBeenCalledTimes(1);
  });

  it('WalletMcpClient delegates deleteRecords and callDeleteDocuments', async () => {
    const client = new WalletMcpClient('http://localhost:8080', 'mock-token');
    const spy = vi.spyOn(client, 'callMcpTool').mockResolvedValue({
      summary: { total: 1, succeeded: 1 },
      results: [{ id: 'rec-1', success: true }],
    });

    const deleteDocsResult = await client.callDeleteDocuments({
      type: 'records',
      ids: ['rec-1'],
    });
    expect(deleteDocsResult).toBeDefined();
    expect(spy).toHaveBeenCalledWith('delete_documents', {
      documentType: 'records',
      ids: ['rec-1'],
    });

    const deleteRecordsResult = await client.deleteRecords(['rec-1']);
    expect(deleteRecordsResult.summary?.succeeded).toBe(1);
  });
});
