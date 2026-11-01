import { describe, it, expect, vi } from 'vitest';
import {
  type WalletToolCaller,
  callGetClientProfile,
  callGetAccounts,
  callGetCategories,
  callGetLabels,
  callCreateLabel,
  callGetBudgets,
  callGetRecords,
  callCreateRecords,
  callGetRecordsAggregation,
  extractRawArray,
  WALLET_MCP_TOOL_NAMES,
  WalletMcpClientService,
} from '../src/wallet/index.js';

describe('Wallet Typed MCP Tool Wrappers', () => {
  function createMockToolCaller(
    mockResponse: unknown = {}
  ): { caller: WalletToolCaller; mockCallMcpTool: ReturnType<typeof vi.fn> } {
    const mockCallMcpTool = vi.fn().mockResolvedValue(mockResponse);
    const caller: WalletToolCaller = {
      callMcpTool: mockCallMcpTool,
    };
    return { caller, mockCallMcpTool };
  }

  describe('callGetClientProfile', () => {
    it('dispatches get_client_profile tool name without arguments', async () => {
      const expectedResponse = {
        baseCurrency: 'IDR',
        syncState: 'SYNCED',
        grantedScopes: ['records:read', 'records:write'],
      };
      const { caller, mockCallMcpTool } = createMockToolCaller(expectedResponse);

      const result = await callGetClientProfile(caller);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_CLIENT_PROFILE
      );
      expect(result).toEqual(expectedResponse);
    });
  });

  describe('callGetAccounts', () => {
    it('dispatches get_accounts tool name and returns typed array response', async () => {
      const mockAccounts = [
        { id: 'acc-1', name: 'BCA Main', balance: 5000000, currency: 'IDR' },
      ];
      const { caller, mockCallMcpTool } = createMockToolCaller(mockAccounts);

      const result = await callGetAccounts(caller);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_ACCOUNTS
      );
      expect(result).toEqual(mockAccounts);
    });

    it('handles envelope response with accounts field', async () => {
      const mockEnvelope = {
        accounts: [{ id: 'acc-2', name: 'Mandiri Savings', balance: 1200000 }],
      };
      const { caller } = createMockToolCaller(mockEnvelope);

      const result = await callGetAccounts(caller);
      expect(result).toEqual(mockEnvelope);
      const extracted = extractRawArray(result, 'accounts', 'items');
      expect(extracted).toHaveLength(1);
      expect(extracted[0].id).toBe('acc-2');
    });
  });

  describe('callGetCategories', () => {
    it('dispatches get_categories tool name and returns typed category list', async () => {
      const mockCategories = [
        { id: 'cat-1', name: 'Food & Dining', color: '#ff0000' },
      ];
      const { caller, mockCallMcpTool } = createMockToolCaller(mockCategories);

      const result = await callGetCategories(caller);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_CATEGORIES
      );
      expect(result).toEqual(mockCategories);
    });
  });

  describe('callGetLabels', () => {
    it('dispatches get_labels tool name and returns typed label items', async () => {
      const mockLabels = [{ id: 'lbl-1', name: 'vacation' }];
      const { caller, mockCallMcpTool } = createMockToolCaller(mockLabels);

      const result = await callGetLabels(caller);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_LABELS
      );
      expect(result).toEqual(mockLabels);
    });
  });

  describe('callCreateLabel', () => {
    it('dispatches create_label tool name with serialized name argument', async () => {
      const mockLabel = { id: 'lbl-new', name: 'reimburse' };
      const { caller, mockCallMcpTool } = createMockToolCaller(mockLabel);

      const result = await callCreateLabel(caller, { name: 'reimburse' });

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.CREATE_LABEL,
        { name: 'reimburse' }
      );
      expect(result).toEqual(mockLabel);
    });
  });

  describe('callGetBudgets', () => {
    it('dispatches get_budgets tool name and returns typed budget array', async () => {
      const mockBudgets = [
        { id: 'bgt-1', name: 'Monthly Food', limit: 3000000, spent: 1500000 },
      ];
      const { caller, mockCallMcpTool } = createMockToolCaller(mockBudgets);

      const result = await callGetBudgets(caller);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_BUDGETS
      );
      expect(result).toEqual(mockBudgets);
    });
  });

  describe('callGetRecords', () => {
    it('dispatches get_records tool name omitting undefined fields', async () => {
      const mockRecords = [
        { id: 'rec-1', accountId: 'acc-1', amount: -25000, recordDate: '2026-10-31' },
      ];
      const { caller, mockCallMcpTool } = createMockToolCaller(mockRecords);

      const result = await callGetRecords(caller, {
        limit: 10,
        offset: 0,
        sortBy: ['-recordDate', '-createdAt'],
        accountId: 'acc-1',
        categoryGroup: undefined,
      });

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_RECORDS,
        {
          limit: 10,
          offset: 0,
          sortBy: ['-recordDate', '-createdAt'],
          accountId: 'acc-1',
        }
      );
      expect(result).toEqual(mockRecords);
    });
  });

  describe('callCreateRecords', () => {
    it('dispatches create_records tool name with sanitized records payload', async () => {
      const mockSuccessResult = {
        summary: { total: 1, succeeded: 1 },
        results: [{ id: 'rec-123', success: true }],
      };
      const { caller, mockCallMcpTool } = createMockToolCaller(mockSuccessResult);

      const recordsPayload = [
        {
          accountId: 'acc-1',
          amount: -50000,
          recordDate: '2026-10-31',
          categoryId: 'cat-1',
          note: 'Dinner',
        },
      ];

      const result = await callCreateRecords(caller, { records: recordsPayload });

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.CREATE_RECORDS,
        { records: recordsPayload }
      );
      expect(result).toEqual(mockSuccessResult);
    });
  });

  describe('callGetRecordsAggregation', () => {
    it('dispatches get_records_aggregation tool name with query payload', async () => {
      const mockAggregation = {
        results: [{ currency: 'IDR', recordType: 'expense', count: 5, 'amount:sum': -125000 }],
        limit: 1000,
        offset: 0,
      };
      const { caller, mockCallMcpTool } = createMockToolCaller(mockAggregation);

      const queryPayload = {
        groupBy: ['currency', 'recordType'] as const,
        compute: ['amount:sum'] as const,
        isTransfer: false,
      };

      const result = await callGetRecordsAggregation(caller, queryPayload);

      expect(mockCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION,
        queryPayload
      );
      expect(result).toEqual(mockAggregation);
    });
  });

  describe('extractRawArray utility', () => {
    it('returns array directly when given array input', () => {
      const items = [{ id: '1' }, { id: '2' }];
      expect(extractRawArray(items, 'items')).toBe(items);
    });

    it('extracts matching array by primary key from envelope', () => {
      const envelope = { accounts: [{ id: 'acc-1' }] };
      expect(extractRawArray(envelope, 'accounts', 'items')).toEqual([{ id: 'acc-1' }]);
    });

    it('extracts fallback key if primary key is not present', () => {
      const envelope = { items: [{ id: 'item-1' }] };
      expect(extractRawArray(envelope, 'records', 'items')).toEqual([{ id: 'item-1' }]);
    });

    it('returns empty array when input is null or non-object', () => {
      expect(extractRawArray(null, 'items')).toEqual([]);
      expect(extractRawArray(undefined, 'items')).toEqual([]);
      expect(extractRawArray('string', 'items')).toEqual([]);
      expect(extractRawArray(12345, 'items')).toEqual([]);
    });
  });

  describe('WalletMcpClient typed method delegation', () => {
    it('delegates typed operations through WalletMcpClient methods', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'dummy-token');
      const spyCallMcpTool = vi.spyOn(client, 'callMcpTool').mockResolvedValue([]);

      await client.callGetAccounts();
      expect(spyCallMcpTool).toHaveBeenCalledWith(WALLET_MCP_TOOL_NAMES.GET_ACCOUNTS);

      await client.callGetCategories();
      expect(spyCallMcpTool).toHaveBeenCalledWith(WALLET_MCP_TOOL_NAMES.GET_CATEGORIES);

      await client.callGetLabels();
      expect(spyCallMcpTool).toHaveBeenCalledWith(WALLET_MCP_TOOL_NAMES.GET_LABELS);

      await client.callGetBudgets();
      expect(spyCallMcpTool).toHaveBeenCalledWith(WALLET_MCP_TOOL_NAMES.GET_BUDGETS);

      await client.callCreateLabel({ name: 'coffee' });
      expect(spyCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.CREATE_LABEL,
        { name: 'coffee' }
      );

      await client.callGetRecords({ limit: 5 });
      expect(spyCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_RECORDS,
        { limit: 5 }
      );

      await client.callCreateRecords({ records: [] });
      expect(spyCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.CREATE_RECORDS,
        { records: [] }
      );

      await client.callGetRecordsAggregation({ groupBy: ['currency'] });
      expect(spyCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_RECORDS_AGGREGATION,
        { groupBy: ['currency'] }
      );

      await client.callGetClientProfile();
      expect(spyCallMcpTool).toHaveBeenCalledWith(
        WALLET_MCP_TOOL_NAMES.GET_CLIENT_PROFILE
      );
    });
  });
});
