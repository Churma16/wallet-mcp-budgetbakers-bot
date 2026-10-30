import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WalletCacheService,
  DEFAULT_METADATA_CACHE_DURATION_MS,
} from '../src/services/walletCacheService.js';
import { WalletMcpClientService } from '../src/services/walletMcpService.js';
import {
  WalletAccountItem,
  WalletCategoryItem,
  WalletLabelItem,
} from '../src/types/walletTypes.js';

const MOCK_ACCOUNTS: WalletAccountItem[] = [
  {
    id: 'acc-1',
    name: 'BCA Checking',
    currency: 'IDR',
    balance: 5000000,
    accountType: 'checking',
    bankAccountNumber: '1234567890',
    isBankSynced: true,
  },
  {
    id: 'acc-2',
    name: 'Cash Wallet',
    currency: 'IDR',
    balance: 250000,
    accountType: 'cash',
    isBankSynced: false,
  },
];

const MOCK_CATEGORIES: WalletCategoryItem[] = [
  {
    id: 'cat-food',
    name: 'Food & Drinks',
    group: { id: 'grp-living', name: 'Living' },
    isAssignable: true,
  },
  {
    id: 'cat-transport',
    name: 'Transportation',
    group: { id: 'grp-living', name: 'Living' },
    isAssignable: true,
  },
];

const MOCK_LABELS: WalletLabelItem[] = [
  {
    id: 'lbl-1',
    name: 'tax-deductible',
    color: '#ff0000',
  },
  {
    id: 'lbl-2',
    name: 'reimbursable',
    color: '#00ff00',
  },
];

describe('Wallet Metadata Cache Consolidation (Issue #182)', () => {
  let mockClient: WalletMcpClientService;

  beforeEach(() => {
    vi.useFakeTimers();
    mockClient = new WalletMcpClientService('https://wallet.example.com', 'test-token');
    vi.spyOn(mockClient, 'fetchAccounts').mockResolvedValue([...MOCK_ACCOUNTS]);
    vi.spyOn(mockClient, 'fetchCategories').mockResolvedValue([...MOCK_CATEGORIES]);
    vi.spyOn(mockClient, 'fetchLabels').mockResolvedValue([...MOCK_LABELS]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('WalletCacheService per-domain freshness isolation', () => {
    it('refreshAccounts updates accounts timestamp without marking categories or labels fresh', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      expect(cache.isAccountsFresh()).toBe(false);
      expect(cache.isCategoriesFresh()).toBe(false);
      expect(cache.isLabelsFresh()).toBe(false);

      const accounts = await cache.refreshAccounts();

      expect(accounts).toHaveLength(2);
      expect(cache.getAccounts()).toHaveLength(2);
      expect(cache.getAccountsTimestamp()).toBe(currentTime);
      expect(cache.isAccountsFresh()).toBe(true);

      // Crucial invariant: other domains remain stale
      expect(cache.getCategoriesTimestamp()).toBe(0);
      expect(cache.isCategoriesFresh()).toBe(false);
      expect(cache.getLabelsTimestamp()).toBe(0);
      expect(cache.isLabelsFresh()).toBe(false);
      expect(cache.isLabelsLoaded()).toBe(false);
    });

    it('refreshCategories updates categories timestamp without marking accounts or labels fresh', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      const categories = await cache.refreshCategories();

      expect(categories).toHaveLength(2);
      expect(cache.getCategories()).toHaveLength(2);
      expect(cache.getCategoriesTimestamp()).toBe(currentTime);
      expect(cache.isCategoriesFresh()).toBe(true);

      // Accounts and labels remain unrefreshed
      expect(cache.getAccountsTimestamp()).toBe(0);
      expect(cache.isAccountsFresh()).toBe(false);
      expect(cache.getLabelsTimestamp()).toBe(0);
      expect(cache.isLabelsFresh()).toBe(false);
    });

    it('refreshLabels updates labels timestamp and isLabelsLoaded without marking accounts or categories fresh', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      const labels = await cache.refreshLabels();

      expect(labels).toHaveLength(2);
      expect(cache.getLabels()).toHaveLength(2);
      expect(cache.isLabelsLoaded()).toBe(true);
      expect(cache.getLabelsTimestamp()).toBe(currentTime);
      expect(cache.isLabelsFresh()).toBe(true);

      // Accounts and categories remain unrefreshed
      expect(cache.getAccountsTimestamp()).toBe(0);
      expect(cache.isAccountsFresh()).toBe(false);
      expect(cache.getCategoriesTimestamp()).toBe(0);
      expect(cache.isCategoriesFresh()).toBe(false);
    });

    it('initialize records all three timestamps when all upstream tool calls succeed', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();

      expect(cache.getAccounts()).toHaveLength(2);
      expect(cache.getCategories()).toHaveLength(2);
      expect(cache.getLabels()).toHaveLength(2);
      expect(cache.isLabelsLoaded()).toBe(true);

      expect(cache.getAccountsTimestamp()).toBe(currentTime);
      expect(cache.getCategoriesTimestamp()).toBe(currentTime);
      expect(cache.getLabelsTimestamp()).toBe(currentTime);

      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);
    });

    it('initialize handles partial failure gracefully without polluting failed domain timestamp', async () => {
      vi.spyOn(mockClient, 'fetchLabels').mockRejectedValueOnce(new Error('Labels service unavailable'));
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();

      expect(cache.getAccounts()).toHaveLength(2);
      expect(cache.getCategories()).toHaveLength(2);
      expect(cache.getLabels()).toHaveLength(0);
      expect(cache.isLabelsLoaded()).toBe(false);

      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(false);
      expect(cache.getLabelsTimestamp()).toBe(0);
    });
  });

  describe('TTL expiration and selective invalidation', () => {
    it('respects custom cacheDurationMilliseconds', async () => {
      const customTtlMs = 60_000; // 1 minute
      const cache = new WalletCacheService(mockClient, { cacheDurationMilliseconds: customTtlMs });
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.refreshAccounts();
      expect(cache.isAccountsFresh(currentTime)).toBe(true);
      expect(cache.isAccountsFresh(currentTime + 59_000)).toBe(true);
      expect(cache.isAccountsFresh(currentTime + 60_000)).toBe(true);
      expect(cache.isAccountsFresh(currentTime + 60_001)).toBe(false);
    });

    it('defaults to 30 minutes cache duration when not specified', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.refreshAccounts();
      expect(cache.isAccountsFresh(currentTime + DEFAULT_METADATA_CACHE_DURATION_MS)).toBe(true);
      expect(cache.isAccountsFresh(currentTime + DEFAULT_METADATA_CACHE_DURATION_MS + 1)).toBe(false);
    });

    it('invalidateAccounts marks accounts stale without affecting categories or labels', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);

      cache.invalidateAccounts();

      expect(cache.isAccountsFresh()).toBe(false);
      expect(cache.getAccountsTimestamp()).toBe(0);
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);
      // Data remains in memory for stale read if needed
      expect(cache.getAccounts()).toHaveLength(2);
    });

    it('invalidateAll resets all three domain timestamps', async () => {
      const cache = new WalletCacheService(mockClient);
      await cache.initialize();

      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);

      cache.invalidateAll();

      expect(cache.isAccountsFresh()).toBe(false);
      expect(cache.isCategoriesFresh()).toBe(false);
      expect(cache.isLabelsFresh()).toBe(false);
      expect(cache.getAccountsTimestamp()).toBe(0);
      expect(cache.getCategoriesTimestamp()).toBe(0);
      expect(cache.getLabelsTimestamp()).toBe(0);
    });
  });

  describe('On-demand fetching (getOrFetch)', () => {
    it('getOrFetchAccounts returns cached data without calling upstream client when fresh', async () => {
      const cache = new WalletCacheService(mockClient);
      await cache.refreshAccounts();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      const accounts = await cache.getOrFetchAccounts();
      expect(accounts).toHaveLength(2);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);
    });

    it('getOrFetchAccounts calls upstream client when stale', async () => {
      const cache = new WalletCacheService(mockClient, { cacheDurationMilliseconds: 5000 });
      const startTime = 1_700_000_000_000;
      vi.setSystemTime(startTime);

      await cache.refreshAccounts();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      // Advance time beyond TTL
      vi.setSystemTime(startTime + 6000);
      const accounts = await cache.getOrFetchAccounts();

      expect(accounts).toHaveLength(2);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(2);
    });

    it('getOrFetchAccounts calls upstream client when forceRefresh is true regardless of TTL', async () => {
      const cache = new WalletCacheService(mockClient);
      await cache.refreshAccounts();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      await cache.getOrFetchAccounts(true);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(2);
    });

    it('getOrFetchCategories and getOrFetchLabels fetch on-demand when empty or stale', async () => {
      const cache = new WalletCacheService(mockClient);

      const categories = await cache.getOrFetchCategories();
      expect(categories).toHaveLength(2);
      expect(mockClient.fetchCategories).toHaveBeenCalledTimes(1);

      const labels = await cache.getOrFetchLabels();
      expect(labels).toHaveLength(2);
      expect(mockClient.fetchLabels).toHaveBeenCalledTimes(1);

      // Subsequent call when fresh does not call upstream again
      await cache.getOrFetchCategories();
      await cache.getOrFetchLabels();
      expect(mockClient.fetchCategories).toHaveBeenCalledTimes(1);
      expect(mockClient.fetchLabels).toHaveBeenCalledTimes(1);
    });
  });

  describe('WalletLabelResolver & label addition cache integration', () => {
    it('addLabelToCache marks labels as loaded and fresh, and finds label by exact and case-insensitive hashtag', () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      expect(cache.isLabelsLoaded()).toBe(false);

      const newLabel: WalletLabelItem = {
        id: 'lbl-3',
        name: 'Project-Alpha',
        color: '#0000ff',
      };
      cache.addLabelToCache(newLabel);

      expect(cache.isLabelsLoaded()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);
      expect(cache.getLabelsTimestamp()).toBe(currentTime);
      expect(cache.getLabels()).toHaveLength(1);

      // Case-insensitive lookup with hashtag prefix stripped
      expect(cache.findLabelByName('project-alpha')).toEqual(newLabel);
      expect(cache.findLabelByName('#PROJECT-ALPHA')).toEqual(newLabel);
      expect(cache.findLabelById('lbl-3')).toEqual(newLabel);
    });
  });

  describe('WalletMcpClientService pure transport decoupling', () => {
    it('fetchAccounts dispatches to callMcpTool every time and does not hold onto old cached arrays', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      let toolCallCount = 0;

      vi.spyOn(client, 'callMcpTool').mockImplementation(async (toolName) => {
        toolCallCount++;
        return [
          {
            id: `acc-${toolCallCount}`,
            name: `Account ${toolCallCount}`,
            currency: 'IDR',
            balance: toolCallCount * 1000,
          },
        ];
      });

      const firstCallResult = await client.fetchAccounts();
      expect(firstCallResult[0].id).toBe('acc-1');
      expect(toolCallCount).toBe(1);

      // In the old design, call #2 would return acc-1 from local cachedAccountList.
      // In the new decoupled design, client always delegates to callMcpTool!
      const secondCallResult = await client.fetchAccounts();
      expect(secondCallResult[0].id).toBe('acc-2');
      expect(toolCallCount).toBe(2);
    });

    it('fetchCategories dispatches to callMcpTool every time and does not hold onto old cached arrays', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      let toolCallCount = 0;

      vi.spyOn(client, 'callMcpTool').mockImplementation(async (toolName) => {
        toolCallCount++;
        return [
          {
            id: `cat-${toolCallCount}`,
            name: `Category ${toolCallCount}`,
          },
        ];
      });

      const firstCallResult = await client.fetchCategories();
      expect(firstCallResult[0].id).toBe('cat-1');
      expect(toolCallCount).toBe(1);

      const secondCallResult = await client.fetchCategories();
      expect(secondCallResult[0].id).toBe('cat-2');
      expect(toolCallCount).toBe(2);
    });

    it('fetchLabels dispatches to callMcpTool every time and does not hold onto old cached arrays', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      let toolCallCount = 0;

      vi.spyOn(client, 'callMcpTool').mockImplementation(async (toolName) => {
        toolCallCount++;
        return [
          {
            id: `lbl-${toolCallCount}`,
            name: `label-${toolCallCount}`,
          },
        ];
      });

      const firstCallResult = await client.fetchLabels();
      expect(firstCallResult[0].id).toBe('lbl-1');
      expect(toolCallCount).toBe(1);

      const secondCallResult = await client.fetchLabels();
      expect(secondCallResult[0].id).toBe('lbl-2');
      expect(toolCallCount).toBe(2);
    });

    it('createLabel calls tool directly and returns normalized item without mutating internal client arrays', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      vi.spyOn(client, 'callMcpTool').mockResolvedValueOnce({
        label: {
          id: 'lbl-created-1',
          name: 'travel-2026',
          color: '#abcdef',
        },
      });

      const createdLabel = await client.createLabel('#travel-2026');
      expect(createdLabel).toEqual({
        id: 'lbl-created-1',
        name: 'travel-2026',
        color: '#abcdef',
        icon: undefined,
      });

      // Verification that no cachedAccountList/cachedLabelList fields exist on client instance
      expect((client as any).cachedLabelList).toBeUndefined();
      expect((client as any).cachedAccountList).toBeUndefined();
      expect((client as any).cachedCategoryList).toBeUndefined();
    });
  });
});
