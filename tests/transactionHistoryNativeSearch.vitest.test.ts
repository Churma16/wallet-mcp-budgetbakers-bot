import { describe, expect, it, vi } from 'vitest';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  MAX_TRANSACTION_HISTORY_LIMIT,
  MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST,
} from '../src/services/walletMcpService.js';
import { TransactionHistoryService } from '../src/services/transactionHistoryService.js';
import { WalletCacheService } from '../src/services/walletCacheService.js';
import { FastPathHandler } from '../src/handlers/fastPathHandler.js';
import { createTestFastPathHandler } from './fixtures/compositionFixtures.js';
import { detectFastPathAction } from '../src/utils/fastPathIntentDetector.js';
import { formatTransactionHistoryMessage } from '../src/utils/humanResponseFormatter.js';
import { setActiveLanguage } from '../src/i18n/index.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletRecordItem,
  TransactionHistoryPage,
} from '../src/types/walletTypes.js';

// ============================================================================
// Provenance Fixtures: Captured directly from live BudgetBakers Wallet MCP server
// (https://mcp.wallet.budgetbakers.com) via tools/list and get_records probe
// ============================================================================

/**
 * Exact declaration of `get_records` from live BudgetBakers Wallet MCP server tools/list.
 * Notice: upstream contains `counterParty` and `note` (with contains-i. prefixes),
 * but DOES NOT have a cross-field `query` parameter.
 */
const LIVE_UPSTREAM_GET_RECORDS_TOOL_DECLARATION = {
  name: 'get_records',
  description: 'Retrieve transaction records with pagination, sorting, and rich filtering.',
  inputFields: [
    { name: 'accountId', required: false, types: ['null', 'array', 'string'], description: 'Filter by account ID.' },
    { name: 'recordDate', required: false, types: ['null', 'array'], description: 'Timestamp-range filter.' },
    { name: 'categoryId', required: false, types: ['null', 'array'], description: 'Filter by category ID.' },
    { name: 'categoryGroup', required: false, types: ['null', 'string'], description: 'Filter by category group slug.' },
    { name: 'labelId', required: false, types: ['null', 'string'], description: 'Filter by label ID.' },
    { name: 'recordType', required: false, types: ['null', 'string'], description: 'Filter by record type.' },
    { name: 'isTransfer', required: false, types: ['null', 'boolean'], description: 'Filter by transfer state.' },
    { name: 'transferId', required: false, types: ['null', 'array'], description: 'Filter by transfer identity.' },
    { name: 'source', required: false, types: ['null', 'array'], description: 'Filter by creation source.' },
    { name: 'recordState', required: false, types: ['null', 'array'], description: 'Filter by record state.' },
    { name: 'amount', required: false, types: ['null', 'array'], description: 'Range filter on record own-currency amount.' },
    { name: 'createdAt', required: false, types: ['null', 'array'], description: 'Timestamp-range filter.' },
    { name: 'updatedAt', required: false, types: ['null', 'array'], description: 'Timestamp-range filter.' },
    {
      name: 'note',
      required: false,
      types: ['null', 'string'],
      description: "Text filter. Prefix with eq., contains., or contains-i. (case-insensitive substring). Example: 'contains-i.inv'",
    },
    {
      name: 'counterParty',
      required: false,
      types: ['null', 'string'],
      description: "Text filter. Prefix with eq., contains., or contains-i. (case-insensitive substring). Example: 'contains-i.inv'",
    },
    { name: 'limit', required: false, types: ['null', 'integer'] },
    { name: 'offset', required: false, types: ['null', 'integer'] },
    { name: 'sortBy', required: false, types: ['null', 'array'], description: 'Sort fields.' },
    { name: 'convertTo', required: false, types: ['null', 'string'], description: 'Convert record amounts to this currency.' },
  ],
  isApplicationSupported: true,
  hasOutputSchema: true,
};

/**
 * Real transaction records captured from live BudgetBakers Wallet MCP server response,
 * with personal identifiers, driver names, and addresses obfuscated.
 */
const LIVE_PROVENANCE_RECORDS: any[] = [
  {
    id: 'r0000000-0000-4000-8000-000000000001',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    accountName: 'BCA Utama',
    amount: -38500,
    currency: 'IDR',
    recordDate: '2026-09-15T10:14:00Z',
    recordType: 'expense',
    counterParty: 'GoRide',
    note: 'GoRide Comfort dari Stasiun Gambir ke Kantor Sudirman',
    category: {
      id: 'c0000000-0000-4000-8000-000000000002',
      name: 'Ojol',
      color: '#78909c',
      group: { id: 'transportation', name: 'Transportation' },
    },
  },
  {
    id: 'r0000000-0000-4000-8000-000000000002',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    accountName: 'BCA Utama',
    amount: -21000,
    currency: 'IDR',
    recordDate: '2026-09-15T05:30:00Z',
    recordType: 'expense',
    counterParty: 'Bliblimart Sarana Jaya',
    note: 'Offline Store - Bakwan Sayur [1pcs], Offline Store - NASI UDUK + TELUR',
    category: {
      id: 'c0000000-0000-4000-8000-000000000001',
      name: 'Makan Nafsu',
      color: '#ff3d00',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
  },
  {
    id: 'r0000000-0000-4000-8000-000000000003',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    accountName: 'BCA Utama',
    amount: -29000,
    currency: 'IDR',
    recordDate: '2026-09-14T14:20:00Z',
    recordType: 'expense',
    counterParty: 'Grab',
    note: 'Bike Standard dari Stasiun Senen ke Gedung Perkantoran',
    category: {
      id: 'c0000000-0000-4000-8000-000000000002',
      name: 'Ojol',
      color: '#78909c',
      group: { id: 'transportation', name: 'Transportation' },
    },
  },
  {
    id: 'r0000000-0000-4000-8000-000000000004',
    accountId: 'a0000000-0000-4000-8000-000000000002',
    accountName: 'Cash Dompet',
    amount: -5000,
    currency: 'IDR',
    recordDate: '2026-09-14T09:00:00Z',
    recordType: 'expense',
    note: 'Bakwan',
    category: {
      id: 'c0000000-0000-4000-8000-000000000003',
      name: 'Snacks',
      color: '#ff3d00',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
  },
  {
    id: 'r0000000-0000-4000-8000-000000000005',
    accountId: 'a0000000-0000-4000-8000-000000000001',
    accountName: 'BCA Utama',
    amount: -49500,
    currency: 'IDR',
    recordDate: '2026-09-13T12:00:00Z',
    recordType: 'expense',
    note: 'Makan nafsu - Super Deals: UNO Combo 2, Extra Saus Sambal',
    category: {
      id: 'c0000000-0000-4000-8000-000000000001',
      name: 'Makan Nafsu',
      color: '#ff3d00',
      group: { id: 'food_and_drinks', name: 'Food & Drinks' },
    },
  },
];

describe('native Wallet MCP text search and compatibility shim (Issue #162)', () => {
  const cachedAccounts: WalletAccountItem[] = [
    { id: 'a0000000-0000-4000-8000-000000000001', name: 'BCA Utama', currency: 'IDR' },
    { id: 'a0000000-0000-4000-8000-000000000002', name: 'Cash Dompet', currency: 'IDR' },
  ];

  const cachedCategories: WalletCategoryItem[] = [
    { id: 'c0000000-0000-4000-8000-000000000001', name: 'Makan Nafsu', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
    { id: 'c0000000-0000-4000-8000-000000000002', name: 'Ojol', group: { id: 'transportation', name: 'Transportation' } },
    { id: 'c0000000-0000-4000-8000-000000000003', name: 'Snacks', group: { id: 'food_and_drinks', name: 'Food & Drinks' } },
  ];

  const REFERENCE_DATE = new Date('2026-09-16T12:00:00Z');

  function createMockWalletCacheService(): WalletCacheService {
    return {
      getAccounts: () => cachedAccounts,
      getCategories: () => cachedCategories,
      getLabels: () => [],
      getBudgets: () => [],
      refreshCache: async () => {},
      isCacheValid: () => true,
    } as unknown as WalletCacheService;
  }

  function createHarness(options: {
    mockHandler?: (toolName: string, args: Record<string, unknown>) => Promise<any>;
    defaultResponse?: any;
  } = {}) {
    const client = new WalletMcpClientService('https://mcp.wallet.budgetbakers.com', 'mock-token');
    const capturedCalls: Array<{ toolName: string; args: Record<string, unknown> }> = [];

    client.callMcpTool = vi.fn().mockImplementation(async <T>(toolName: string, args: Record<string, unknown> = {}): Promise<T> => {
      capturedCalls.push({ toolName, args });
      if (options.mockHandler) {
        return await options.mockHandler(toolName, args);
      }
      return (options.defaultResponse ?? { records: LIVE_PROVENANCE_RECORDS, total: LIVE_PROVENANCE_RECORDS.length }) as T;
    });

    const cacheService = createMockWalletCacheService();
    const historyService = new TransactionHistoryService(client, cacheService);

    return { client, capturedCalls, cacheService, historyService };
  }

  // ==========================================================================
  // 1. Upstream Contract & Tool Schema Verification
  // ==========================================================================
  describe('Upstream Wallet MCP Tool Schema & Provenance Characterization', () => {
    it('verifies that get_records provides field filters counterParty and note, but lacks cross-field query', () => {
      const inputFieldNames = LIVE_UPSTREAM_GET_RECORDS_TOOL_DECLARATION.inputFields.map(f => f.name);

      // Proven upstream fact: counterParty and note exist
      expect(inputFieldNames).toContain('counterParty');
      expect(inputFieldNames).toContain('note');

      // Proven upstream gap: generic multi-field 'query' does NOT exist
      expect(inputFieldNames).not.toContain('query');

      // Check field filter syntax documentation
      const counterPartyField = LIVE_UPSTREAM_GET_RECORDS_TOOL_DECLARATION.inputFields.find(f => f.name === 'counterParty');
      expect(counterPartyField?.description).toContain('contains-i.');

      const noteField = LIVE_UPSTREAM_GET_RECORDS_TOOL_DECLARATION.inputFields.find(f => f.name === 'note');
      expect(noteField?.description).toContain('contains-i.');
    });

    it('handles upstream error when unsupported query argument is rejected by server', async () => {
      const { historyService } = createHarness({
        mockHandler: async () => {
          // Exactly matches the protocol rejection observed when passing query to 2026-07-28 server
          throw new WalletMcpRequestError(
            '[error] Wallet MCP SDK INVALID_RESULT: Invalid result for tools/call: missing required resultType',
            'UNKNOWN'
          );
        },
      });

      // Forward-compatibility test: when searchScanFallback is false, query is sent upstream
      await expect(
        historyService.getTransactionHistory({ searchQuery: 'GoRide', searchScanFallback: false })
      ).rejects.toThrow(/missing required resultType/);
    });
  });

  // ==========================================================================
  // 2. Native Field-Level Filtering (counterParty & note)
  // ==========================================================================
  describe('Native Field-Level Filtering via counterParty and note', () => {
    it('dispatches native counterParty filter with contains-i. prefix without local scan loop', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [LIVE_PROVENANCE_RECORDS[0]], total: 1 },
      });

      const result = await client.fetchRecords({ counterParty: 'GoRide' });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');
      expect(capturedCalls[0].args.counterParty).toBe('contains-i.GoRide');
      expect(result.records).toHaveLength(1);
      expect(result.records[0].counterParty).toBe('GoRide');
    });

    it('dispatches native note filter with contains-i. prefix without local scan loop', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [LIVE_PROVENANCE_RECORDS[3]], total: 1 },
      });

      const result = await client.fetchRecords({ note: 'Bakwan' });

      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].toolName).toBe('get_records');
      expect(capturedCalls[0].args.note).toBe('contains-i.Bakwan');
      expect(result.records).toHaveLength(1);
      expect(result.records[0].note).toBe('Bakwan');
    });

    it('preserves existing operator prefix if already provided (e.g. eq. or contains.)', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      await client.fetchRecords({ counterParty: 'eq.Grab', note: 'contains.Bakwan' });

      expect(capturedCalls[0].args.counterParty).toBe('eq.Grab');
      expect(capturedCalls[0].args.note).toBe('contains.Bakwan');
    });

    it('preserves contains-i. and contains. operator prefix for counterParty and note', async () => {
      const { client, capturedCalls } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      await client.fetchRecords({ counterParty: 'contains-i.Grab', note: 'eq.Coffee' });
      expect(capturedCalls[0].args.counterParty).toBe('contains-i.Grab');
      expect(capturedCalls[0].args.note).toBe('eq.Coffee');

      await client.fetchRecords({ counterParty: 'contains.Gojek', note: 'contains-i.Lunch' });
      expect(capturedCalls[1].args.counterParty).toBe('contains.Gojek');
      expect(capturedCalls[1].args.note).toBe('contains-i.Lunch');
    });
  });

  // ==========================================================================
  // 3. Documented Compatibility Shim for Multi-Field searchQuery (Decision Rule)
  // ==========================================================================
  describe('Documented Compatibility Shim for Multi-Field searchQuery', () => {
    it('matches merchant/counterParty case-insensitively and partially', async () => {
      const { client } = createHarness();

      // Full term
      const resFull = await client.fetchRecords({ searchQuery: 'GoRide' });
      expect(resFull.records).toHaveLength(1);
      expect(resFull.records[0].counterParty).toBe('GoRide');

      // Lowercase
      const resLower = await client.fetchRecords({ searchQuery: 'goride' });
      expect(resLower.records).toHaveLength(1);
      expect(resLower.records[0].counterParty).toBe('GoRide');

      // Uppercase
      const resUpper = await client.fetchRecords({ searchQuery: 'GORIDE' });
      expect(resUpper.records).toHaveLength(1);
      expect(resUpper.records[0].counterParty).toBe('GoRide');

      // Partial
      const resPartial = await client.fetchRecords({ searchQuery: 'Blibli' });
      expect(resPartial.records).toHaveLength(1);
      expect(resPartial.records[0].counterParty).toBe('Bliblimart Sarana Jaya');
    });

    it('matches note text case-insensitively and across multi-word queries', async () => {
      const { client } = createHarness();

      // Note exact word
      const resWord = await client.fetchRecords({ searchQuery: 'Bakwan' });
      // Matches both the pure note 'Bakwan' and 'Offline Store - Bakwan Sayur...'
      expect(resWord.records.length).toBeGreaterThanOrEqual(2);

      // Multi-word phrase in note
      const resPhrase = await client.fetchRecords({ searchQuery: 'nasi uduk' });
      expect(resPhrase.records).toHaveLength(1);
      expect(resPhrase.records[0].note).toContain('NASI UDUK');

      // Multi-word phrase across words
      const resCombo = await client.fetchRecords({ searchQuery: 'super deals' });
      expect(resCombo.records).toHaveLength(1);
      expect(resCombo.records[0].note).toContain('Super Deals');
    });

    it('handles non-existent search query gracefully returning empty records', async () => {
      const { client } = createHarness();

      const result = await client.fetchRecords({ searchQuery: 'NON_EXISTENT_MERCHANT_999' });
      expect(result.records).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('composes search query with account and category filters', async () => {
      const { historyService, capturedCalls } = createHarness({
        mockHandler: async (_tool, args) => {
          let records = [...LIVE_PROVENANCE_RECORDS];
          if (args.accountId) {
            records = records.filter(r => r.accountId === args.accountId);
          }
          if (args.categoryId && Array.isArray(args.categoryId)) {
            records = records.filter(r => args.categoryId.includes(r.category?.id));
          }
          return { records, total: records.length };
        },
      });

      const result = await historyService.getTransactionHistory(
        {
          searchQuery: 'Bakwan',
          accountName: 'BCA Utama',
          categoryName: 'Makan Nafsu',
        },
        REFERENCE_DATE
      );

      // Dispatched call includes structured account and category filters
      expect(capturedCalls[0].args.accountId).toBe('a0000000-0000-4000-8000-000000000001');
      expect(capturedCalls[0].args.categoryId).toEqual(['c0000000-0000-4000-8000-000000000001']);
      expect(result.records).toHaveLength(1);
      expect(result.records[0].note).toContain('Bakwan Sayur');
    });

    it('composes search query with multi-category filters from Issue #160', async () => {
      const { client, capturedCalls } = createHarness();

      await client.fetchRecords({
        searchQuery: 'Grab',
        categoryId: ['c0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000001'],
      });

      expect(capturedCalls[0].args.categoryId).toEqual([
        'c0000000-0000-4000-8000-000000000002',
        'c0000000-0000-4000-8000-000000000001',
      ]);
    });

    it('composes search query with category group filter', async () => {
      const { client, capturedCalls } = createHarness();

      await client.fetchRecords({
        searchQuery: 'GoRide',
        categoryGroup: 'transportation',
      });

      expect(capturedCalls[0].args.categoryGroup).toBe('transportation');
    });

    it('does not attach unsupported query field to the upstream payload on default fallback path', async () => {
      const { client, capturedCalls } = createHarness();

      await client.fetchRecords({ searchQuery: 'GoRide' });

      // The shim must not dispatch the 'query' field upstream because the server rejects it.
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args).not.toHaveProperty('query');
    });

    it('attaches query field to the upstream payload when searchScanFallback is explicitly false', async () => {
      const { client, capturedCalls } = createHarness();

      await client.fetchRecords({ searchQuery: 'GoRide', searchScanFallback: false });

      // When explicitly bypassing the shim, the query field must be passed upstream.
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0].args.query).toBe('GoRide');
    });

    it('bounds search scanning within MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST', async () => {
      let scanCallCount = 0;
      const { client } = createHarness({
        mockHandler: async (_tool, args) => {
          scanCallCount++;
          const offset = Number(args.offset || 0);
          return {
            records: [
              {
                id: `rec-${offset}`,
                accountId: 'acc-1',
                amount: -1000,
                currency: 'IDR',
                recordDate: '2026-09-15T00:00:00Z',
                recordType: 'expense',
                counterParty: 'Irrelevant Merchant',
              },
            ],
            nextOffset: offset + 10,
          };
        },
      });

      const result = await client.fetchRecords({ searchQuery: 'Needle in haystack', limit: 10 });

      // Must not exceed max scan budget
      expect(scanCallCount).toBeLessThanOrEqual(MAX_TRANSACTION_SEARCH_SCAN_CALLS_PER_REQUEST);
      expect(result.records).toHaveLength(0);
      expect(result.unresolvedFilters?.[0].reason).toBe('UNRESOLVED');
    });

    it('purges expired entries from transactionSearchScanCache based on TTL', async () => {
      const { client } = createHarness();

      const expiredKey = JSON.stringify({ searchQuery: 'stale-query' });
      (client as any).transactionSearchScanCache.set(expiredKey, {
        matchedRecords: [],
        seenMatchedRecordIds: new Set<string>(),
        nextOffset: 0,
        exhausted: false,
        updatedAt: Date.now() - 300_000,
      });

      expect((client as any).transactionSearchScanCache.has(expiredKey)).toBe(true);

      await client.fetchRecords({ searchQuery: 'GoRide' });

      expect((client as any).transactionSearchScanCache.has(expiredKey)).toBe(false);
    });

    it('evicts oldest cache entry when transactionSearchScanCache reaches maximum capacity', async () => {
      const { client } = createHarness();
      const maxCapacity = (client as any).maxTransactionSearchScanCacheEntries;

      for (let i = 0; i < maxCapacity; i++) {
        (client as any).transactionSearchScanCache.set(`seed-cache-key-${i}`, {
          matchedRecords: [],
          seenMatchedRecordIds: new Set<string>(),
          nextOffset: 0,
          exhausted: false,
          updatedAt: Date.now(),
        });
      }

      expect((client as any).transactionSearchScanCache.size).toBe(maxCapacity);
      expect((client as any).transactionSearchScanCache.has('seed-cache-key-0')).toBe(true);

      await client.fetchRecords({ searchQuery: 'UniqueNewSearchQuery' });

      expect((client as any).transactionSearchScanCache.has('seed-cache-key-0')).toBe(false);
    });

    it('exhausts search scan when upstream returns an empty records array', async () => {
      const { client } = createHarness({
        defaultResponse: { records: [], total: 0 },
      });

      const page = await client.fetchRecords({ searchQuery: 'NonExistent' });
      expect(page.records).toHaveLength(0);
      expect(page.total).toBe(0);
      expect(page.hasMore).toBe(false);
    });

    it('deduplicates records with matching IDs across scan chunks', async () => {
      let callIndex = 0;
      const { client } = createHarness({
        mockHandler: async () => {
          callIndex++;
          if (callIndex === 1) {
            return {
              records: [LIVE_PROVENANCE_RECORDS[0]],
              nextOffset: 1,
            };
          }
          return {
            records: [LIVE_PROVENANCE_RECORDS[0]],
            nextOffset: null,
          };
        },
      });

      const page = await client.fetchRecords({ searchQuery: 'GoRide', limit: 10 });
      expect(page.records).toHaveLength(1);
      expect(page.records[0].id).toBe(LIVE_PROVENANCE_RECORDS[0].id);
    });

    it('resolves nextScanOffset via total count when nextOffset is not returned explicitly', async () => {
      let callCount = 0;
      const { client } = createHarness({
        mockHandler: async (_tool, args) => {
          callCount++;
          const offset = Number(args.offset || 0);
          if (offset === 0) {
            return {
              records: [LIVE_PROVENANCE_RECORDS[0]],
              total: 2,
            };
          }
          return {
            records: [LIVE_PROVENANCE_RECORDS[2]],
            total: 2,
            nextOffset: null,
          };
        },
      });

      const page = await client.fetchRecords({ searchQuery: 'GoRide', limit: 10 });
      expect(callCount).toBe(2);
      expect(page.records).toHaveLength(1);
      expect(page.hasMore).toBe(false);
    });

    it('resolves nextScanOffset when raw response is an array matching scan limit', async () => {
      let callCount = 0;
      const { client } = createHarness({
        mockHandler: async (_tool, args) => {
          callCount++;
          const offset = Number(args.offset || 0);
          if (offset === 0) {
            return [
              {
                id: 'chunk-raw-0',
                accountId: 'acc-1',
                amount: -1000,
                currency: 'IDR',
                recordDate: '2026-09-15T00:00:00Z',
                recordType: 'expense',
                counterParty: 'TargetRawMerchant',
              },
              {
                id: 'chunk-raw-1',
                accountId: 'acc-1',
                amount: -1000,
                currency: 'IDR',
                recordDate: '2026-09-15T00:00:00Z',
                recordType: 'expense',
                counterParty: 'OtherMerchant',
              },
            ];
          }
          return [];
        },
      });

      const page = await client.fetchRecords({ searchQuery: 'TargetRawMerchant', limit: 2 });
      expect(callCount).toBe(2);
      expect(page.records).toHaveLength(1);
    });

    it('throws WalletMcpRequestError when search pagination fails forward progress', async () => {
      const { client } = createHarness({
        mockHandler: async () => ({
          records: [LIVE_PROVENANCE_RECORDS[0]],
          nextOffset: 0,
        }),
      });

      await expect(
        client.fetchRecords({ searchQuery: 'GoRide' })
      ).rejects.toThrow(/Wallet MCP search pagination did not make forward progress/);
    });

    it('sets continuationUnknown: true when scan budget is reached with complete page but no lookahead', async () => {
      let callIndex = 0;
      const { client } = createHarness({
        mockHandler: async () => {
          callIndex++;
          return {
            records: [
              {
                id: `rec-scan-budget-${callIndex}`,
                accountId: 'acc-1',
                amount: -1000,
                currency: 'IDR',
                recordDate: '2026-09-15T00:00:00Z',
                recordType: 'expense',
                counterParty: 'BudgetTargetMerchant',
              },
            ],
            nextOffset: callIndex,
          };
        },
      });

      const page = await client.fetchRecords({ searchQuery: 'BudgetTargetMerchant', limit: 5 });
      expect(page.records).toHaveLength(5);
      expect(page.continuationUnknown).toBe(true);
      expect(page.hasMore).toBe(false);
    });
  });

  // ==========================================================================
  // 3b. Native get_records Pagination Boundaries (Without Search Query)
  // ==========================================================================
  describe('Native get_records Pagination Boundaries (Without Search Query)', () => {
    it('handles explicit null nextOffset as terminal page with hasMore: false', async () => {
      const { client } = createHarness({
        defaultResponse: { records: [LIVE_PROVENANCE_RECORDS[0]], nextOffset: null },
      });

      const page = await client.fetchRecords({ limit: 10 });
      expect(page.hasMore).toBe(false);
      expect(page.nextOffset).toBeNull();
      expect(page.records).toHaveLength(1);
    });

    it('infers hasMore and nextOffset when records length equals limit without explicit total or nextOffset', async () => {
      const { client } = createHarness({
        defaultResponse: { records: [LIVE_PROVENANCE_RECORDS[0], LIVE_PROVENANCE_RECORDS[1]] },
      });

      const page = await client.fetchRecords({ limit: 2, offset: 0 });
      expect(page.hasMore).toBe(true);
      expect(page.nextOffset).toBe(2);
      expect(page.records).toHaveLength(2);
    });
  });

  // ==========================================================================
  // 4. Response Metadata Retention (_meta.rateLimit & agentHints)
  // ==========================================================================
  describe('Response Metadata Retention (_meta.rateLimit & agentHints)', () => {
    it('retains rateLimit and agentHints from get_records tool response', async () => {
      const client = new WalletMcpClientService('https://mcp.wallet.budgetbakers.com', 'mock-token');

      (client as any).responseMetadataByOperation.set('get_records', {
        rateLimit: {
          limit: 120,
          remaining: 95,
          resetAt: '2026-09-16T18:00:00Z',
          retryAfterMilliseconds: 0,
        },
        agentHints: [
          {
            type: 'index_freshness',
            severity: 'info',
            text: 'Live search index synchronized',
          },
        ],
      });

      const metadata = client.getLastResponseMetadata('get_records');

      expect(metadata).toBeDefined();
      expect(metadata?.rateLimit?.remaining).toBe(95);
      expect(metadata?.rateLimit?.limit).toBe(120);
      expect(metadata?.agentHints).toHaveLength(1);
      expect(metadata?.agentHints?.[0].type).toBe('index_freshness');
    });
  });

  // ==========================================================================
  // 5. Fast-Path Intent Routing & Localized UX
  // ==========================================================================
  describe('Fast-Path Intent Routing & Localized UX', () => {
    it('detects search queries in Indonesian and English via fastPathIntentDetector', () => {
      const idSearch = detectFastPathAction('cari goride');
      expect((idSearch as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((idSearch as any)?.options.searchQuery).toBe('goride');

      const enSearch = detectFastPathAction('search grab');
      expect((enSearch as any)?.type).toBe('TRANSACTION_HISTORY');
      expect((enSearch as any)?.options.searchQuery).toBe('grab');

      const quotedSearch = detectFastPathAction('cari "Bakwan Sayur"');
      expect((quotedSearch as any)?.options.searchQuery).toBe('Bakwan Sayur');
    });

    it('keeps transaction creation routing strictly separate from search queries', () => {
      expect(detectFastPathAction('beli bensin 25rb')).toBeNull();
      expect(detectFastPathAction('makan siang 35000')).toBeNull();
      expect(detectFastPathAction('transfer 50000 ke bca')).toBeNull();
    });

    it('formats empty search results with clear localized messaging', () => {
      const emptyPage: TransactionHistoryPage = {
        records: [],
        total: 0,
        limit: 10,
        offset: 0,
        page: 1,
        totalPages: 0,
        nextOffset: null,
        hasMore: false,
        sort: 'newest',
        appliedFilters: { searchQuery: 'Resto Tidak Ada' },
      };

      setActiveLanguage('id');
      const formattedId = formatTransactionHistoryMessage(emptyPage);
      expect(formattedId).toContain('Belum ada transaksi yang cocok dengan filter [Cari: "Resto Tidak Ada"]');

      setActiveLanguage('en');
      const formattedEn = formatTransactionHistoryMessage(emptyPage);
      expect(formattedEn).toContain('No transactions match the filter [Search: "Resto Tidak Ada"]');
    });

    it('executes end-to-end fast path dispatch for search queries', async () => {
      setActiveLanguage('id');
      const { client, cacheService, historyService } = createHarness();

      const sentMessages: string[] = [];
      const mockGateway = {
        sendMessage: async (_channel: string, _chatId: string, message: string) => {
          sentMessages.push(message);
        },
      } as any;

      const fastPathHandler = createTestFastPathHandler({
        walletMcpClient: client,
        walletCacheService: cacheService,
        messagingGateway: mockGateway,
        transactionHistoryService: historyService,
      });
      const incomingEvent = {
        channel: 'whatsapp' as const,
        chatIdentifier: '628123456789@s.whatsapp.net',
        senderIdentifier: '628123456789',
        messageType: 'text' as const,
        textPayload: 'cari goride',
        rawMessageTimestamp: new Date(),
      };

      const matchedAction = detectFastPathAction('cari goride');
      const handled = await fastPathHandler.handleFastPath(incomingEvent, matchedAction, Date.now());

      expect(handled).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('Cari: "goride"');
      expect(sentMessages[0]).toContain('GoRide');
    });
  });

  // ==========================================================================
  // 6. Live Server Verification (Guarded by WALLET_MCP_ACCESS_TOKEN; skipped in CI)
  // ==========================================================================
  describe.runIf(Boolean(process.env.WALLET_MCP_ACCESS_TOKEN))(
    'Live Wallet MCP Server Verification (explicit / non-CI)',
    () => {
      it('confirms live get_records tool schema lacks query but includes counterParty and note', async () => {
        const baseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
        const token = process.env.WALLET_MCP_ACCESS_TOKEN!;
        const client = new WalletMcpClientService(baseUrl, token);
        try {
          const tools = await client.listTools();
          const getRecords = tools.find(t => t.name === 'get_records');
          expect(getRecords).toBeDefined();
          const fieldNames = getRecords!.inputFields.map(f => f.name);
          expect(fieldNames).toContain('counterParty');
          expect(fieldNames).toContain('note');
          expect(fieldNames).not.toContain('query');
        } finally {
          await client.close();
        }
      });

      it('verifies baseline get_records fetch succeeds on live server', async () => {
        const baseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
        const token = process.env.WALLET_MCP_ACCESS_TOKEN!;
        const client = new WalletMcpClientService(baseUrl, token);
        try {
          const result = await client.fetchRecords({ limit: 5 });
          expect(result.records.length).toBeGreaterThan(0);
          expect(result.total).toBeGreaterThan(0);
        } finally {
          await client.close();
        }
      });

      it('verifies default searchQuery scan path executes without rejection on live server', async () => {
        const baseUrl = process.env.WALLET_MCP_BASE_URL || 'https://mcp.wallet.budgetbakers.com';
        const token = process.env.WALLET_MCP_ACCESS_TOKEN!;
        const client = new WalletMcpClientService(baseUrl, token);
        try {
          // This must not fail with 'missing required resultType' / INVALID_RESULT from the MCP SDK,
          // which happens if the unsupported 'query' parameter is accidentally sent upstream.
          const result = await client.fetchRecords({ searchQuery: 'a', limit: 2 });
          // We don't assert length > 0 because a specific account might have no matches for "a",
          // but reaching here proves the upstream payload was accepted.
          expect(result).toHaveProperty('records');
        } finally {
          await client.close();
        }
      });
    }
  );
});
