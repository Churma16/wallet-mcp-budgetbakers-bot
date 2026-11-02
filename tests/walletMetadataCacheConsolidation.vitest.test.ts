import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WalletCacheService,
  DEFAULT_METADATA_CACHE_DURATION_MS,
  WalletMcpClientService,
  type WalletAccountItem,
  type WalletCategoryItem,
  type WalletLabelItem,
} from '../src/wallet/index.js';

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
      expect(cache.getAccountsLastUpdatedTimestamp()).toBe(currentTime);
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
      expect(cache.getCategoriesLastUpdatedTimestamp()).toBe(currentTime);
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
      expect(cache.getLabelsLastUpdatedTimestamp()).toBe(currentTime);
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
      vi.spyOn(mockClient, 'fetchCategories').mockRejectedValueOnce(new Error('Categories API down'));
      vi.spyOn(mockClient, 'fetchLabels').mockRejectedValueOnce(new Error('Labels API down'));

      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();

      expect(cache.getAccounts()).toHaveLength(2);
      expect(cache.getAccountsTimestamp()).toBe(currentTime);
      expect(cache.isAccountsFresh()).toBe(true);

      // Failed domains must have timestamp 0 and remain not fresh
      expect(cache.getCategories()).toHaveLength(0);
      expect(cache.getCategoriesTimestamp()).toBe(0);
      expect(cache.isCategoriesFresh()).toBe(false);

      expect(cache.getLabels()).toHaveLength(0);
      expect(cache.getLabelsTimestamp()).toBe(0);
      expect(cache.isLabelsLoaded()).toBe(false);
      expect(cache.isLabelsFresh()).toBe(false);
    });

    it('respects custom cacheDurationMilliseconds', () => {
      const customTtlMs = 15 * 60 * 1000; // 15 mins
      const cache = new WalletCacheService(mockClient, { cacheDurationMilliseconds: customTtlMs });

      expect(cache.getCacheDurationMilliseconds()).toBe(customTtlMs);
    });

    it('defaults to 30 minutes cache duration when not specified', () => {
      const cache = new WalletCacheService(mockClient);
      expect(cache.getCacheDurationMilliseconds()).toBe(DEFAULT_METADATA_CACHE_DURATION_MS);
      expect(DEFAULT_METADATA_CACHE_DURATION_MS).toBe(30 * 60 * 1000);
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

      // Other domains remain fresh
      expect(cache.isCategoriesFresh()).toBe(true);
      expect(cache.getCategoriesTimestamp()).toBe(currentTime);
      expect(cache.isLabelsFresh()).toBe(true);
      expect(cache.getLabelsTimestamp()).toBe(currentTime);
    });

    it('invalidateCategories marks categories stale without affecting accounts or labels', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      cache.invalidateCategories();

      expect(cache.isCategoriesFresh()).toBe(false);
      expect(cache.getCategoriesTimestamp()).toBe(0);
      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isLabelsFresh()).toBe(true);
    });

    it('invalidateLabels marks labels stale without affecting accounts or categories', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      cache.invalidateLabels();

      expect(cache.isLabelsFresh()).toBe(false);
      expect(cache.getLabelsTimestamp()).toBe(0);
      expect(cache.isLabelsLoaded()).toBe(false);
      expect(cache.isAccountsFresh()).toBe(true);
      expect(cache.isCategoriesFresh()).toBe(true);
    });

    it('invalidateAll resets all three domain timestamps', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

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
      expect(cache.isLabelsLoaded()).toBe(false);
    });

    it('getOrFetchAccounts returns cached data without calling upstream client when fresh', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      // Within TTL (10 minutes later)
      vi.setSystemTime(currentTime + 10 * 60 * 1000);
      const accounts = await cache.getOrFetchAccounts();

      expect(accounts).toHaveLength(2);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1); // Not called again!
    });

    it('getOrFetchAccounts calls upstream client when stale', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      // Past TTL (31 minutes later, default TTL is 30 mins)
      vi.setSystemTime(currentTime + 31 * 60 * 1000);
      expect(cache.isAccountsFresh()).toBe(false);

      const accounts = await cache.getOrFetchAccounts();

      expect(accounts).toHaveLength(2);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(2);
      expect(cache.getAccountsTimestamp()).toBe(currentTime + 31 * 60 * 1000);
    });

    it('getOrFetchAccounts calls upstream client when forceRefresh is true regardless of TTL', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      await cache.initialize();
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(1);

      // Only 1 minute later, but forceRefresh = true
      vi.setSystemTime(currentTime + 60 * 1000);
      const accounts = await cache.getOrFetchAccounts(true);

      expect(accounts).toHaveLength(2);
      expect(mockClient.fetchAccounts).toHaveBeenCalledTimes(2);
    });

    it('getOrFetchCategories and getOrFetchLabels fetch on-demand when empty or stale', async () => {
      const cache = new WalletCacheService(mockClient);
      const currentTime = 1_700_000_000_000;
      vi.setSystemTime(currentTime);

      // Not initialized yet
      expect(cache.isCategoriesFresh()).toBe(false);
      expect(cache.isLabelsFresh()).toBe(false);

      const categories = await cache.getOrFetchCategories();
      const labels = await cache.getOrFetchLabels();

      expect(categories).toHaveLength(2);
      expect(labels).toHaveLength(2);
      expect(mockClient.fetchCategories).toHaveBeenCalledTimes(1);
      expect(mockClient.fetchLabels).toHaveBeenCalledTimes(1);

      // Second call within TTL does not hit upstream again
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

      vi.spyOn(client, 'callMcpTool').mockImplementation(async () => {
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

      // In the new decoupled design, client always delegates to upstream tool
      const secondCallResult = await client.fetchAccounts();
      expect(secondCallResult[0].id).toBe('acc-2');
      expect(toolCallCount).toBe(2);
    });

    it('fetchCategories dispatches to callMcpTool every time and does not hold onto old cached arrays', async () => {
      const client = new WalletMcpClientService('https://wallet.example.com', 'test-token');
      let toolCallCount = 0;

      vi.spyOn(client, 'callMcpTool').mockImplementation(async () => {
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

      vi.spyOn(client, 'callMcpTool').mockImplementation(async () => {
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

      // Verification that no cachedAccountList/cachedLabelList/cachedCategoryList fields exist on client instance
      expect((client as unknown as Record<string, unknown>).cachedLabelList).toBeUndefined();
      expect((client as unknown as Record<string, unknown>).cachedAccountList).toBeUndefined();
      expect((client as unknown as Record<string, unknown>).cachedCategoryList).toBeUndefined();
      expect((client as unknown as Record<string, unknown>).cacheStore).toBeUndefined();
    });
  });
});
