import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WalletMcpCapabilityService,
  DEFAULT_CAPABILITY_CACHE_DURATION_MS,
} from '../src/services/walletMcpCapabilityService.js';
import { normalizeWalletClientProfile } from '../src/services/walletProfileNormalizer.js';
import {
  WalletMcpClientService,
  WalletMcpRequestError,
  WALLET_MCP_ALLOWED_TOOL_NAMES,
} from '../src/services/walletMcpService.js';
import {
  WalletClientProfile,
  WalletMcpToolCapability,
} from '../src/types/walletCapabilityTypes.js';

describe('walletProfileNormalizer', () => {
  it('normalizes a realistic complete Wallet MCP client profile response', () => {
    const rawFixture = {
      _meta: {
        rateLimit: {
          capacity: 300,
          refillPerMinute: 5,
          remaining: 298,
        },
        syncedAt: '2026-09-19T10:06:23.076Z',
      },
      agentHints: [
        {
          type: 'tool.discovery',
          severity: 'info',
          text: 'mcpTools is the authoritative inventory of tools.',
        },
      ],
      baseCurrency: 'idr',
      budgetSettings: {
        firstDayOfMonth: 1,
      },
      grantedScopes: [
        'records.create',
        'records.read',
        'accounts.read',
        'categories.read',
        'budgets.read',
      ],
      mcpTools: [
        'get_client_profile',
        'get_records',
        'create_records',
      ],
      syncState: 'complete',
      system: 'Wallet',
      toolCount: 20,
      usedCurrencies: {
        list: ['IDR', 'USD'],
        message: 'Currencies currently used.',
      },
    };

    const fixedTimestamp = 1_700_000_000_000;
    const profile = normalizeWalletClientProfile(rawFixture, fixedTimestamp);

    expect(profile.fetchedAt).toBe(fixedTimestamp);
    expect(profile.baseCurrency).toBe('IDR');
    expect(profile.syncState).toBe('complete');
    expect(profile.system).toBe('Wallet');
    expect(profile.toolCount).toBe(20);
    expect(profile.grantedScopes).toBeDefined();
    expect(profile.grantedScopes?.has('records.create')).toBe(true);
    expect(profile.grantedScopes?.has('records.read')).toBe(true);
    expect(profile.grantedScopes?.has('labels.write')).toBe(false);
    expect(profile.usedCurrencies).toEqual(['IDR', 'USD']);
    expect(profile.mcpTools).toEqual(['get_client_profile', 'get_records', 'create_records']);
    expect(profile.budgetSettings).toEqual({ firstDayOfMonth: 1 });
    expect(profile.rateLimit).toEqual({
      limit: 300,
      remaining: 298,
      resetAt: undefined,
      retryAfterMilliseconds: undefined,
    });
    expect(profile.agentHints).toHaveLength(1);
    expect(profile.raw).toBe(rawFixture);
  });

  it('normalizes array-based usedCurrencies and alternative sync property structure', () => {
    const rawFixture = {
      baseCurrency: 'USD',
      sync: {
        state: 'in_progress',
        error: 'Network glitch',
      },
      usedCurrencies: ['usd', 'eur'],
      grantedScopes: ['accounts.read'],
    };

    const profile = normalizeWalletClientProfile(rawFixture);

    expect(profile.baseCurrency).toBe('USD');
    expect(profile.syncState).toBe('in_progress');
    expect(profile.syncError).toBe('Network glitch');
    expect(profile.usedCurrencies).toEqual(['USD', 'EUR']);
    expect(profile.grantedScopes?.has('accounts.read')).toBe(true);
  });

  it('preserves missing optional fields as undefined so tri-state logic can yield unknown', () => {
    const rawFixture = {
      system: 'Wallet',
    };

    const profile = normalizeWalletClientProfile(rawFixture);

    expect(profile.grantedScopes).toBeUndefined();
    expect(profile.syncState).toBeUndefined();
    expect(profile.syncError).toBeUndefined();
    expect(profile.baseCurrency).toBeUndefined();
    expect(profile.usedCurrencies).toEqual([]);
    expect(profile.mcpTools).toEqual([]);
    expect(profile.budgetSettings).toBeUndefined();
    expect(profile.rateLimit).toBeUndefined();
  });

  it('handles non-object and null raw inputs gracefully without throwing', () => {
    const nonObjectProfile = normalizeWalletClientProfile(null);
    expect(nonObjectProfile.grantedScopes).toBeUndefined();
    expect(nonObjectProfile.usedCurrencies).toEqual([]);
    expect(nonObjectProfile.raw).toEqual({});

    const stringInputProfile = normalizeWalletClientProfile('invalid string payload');
    expect(stringInputProfile.grantedScopes).toBeUndefined();
    expect(stringInputProfile.usedCurrencies).toEqual([]);
  });
});

describe('WalletMcpCapabilityService', () => {
  let mockWalletClient: WalletMcpClientService;
  let simulatedAdvertisedTools: WalletMcpToolCapability[];
  let simulatedProfile: WalletClientProfile;
  let simulatedCurrentTime: number;

  beforeEach(() => {
    simulatedCurrentTime = 1_000_000;

    simulatedAdvertisedTools = [
      {
        name: 'get_records',
        description: 'Fetch records',
        inputFields: [],
        isApplicationSupported: true,
        hasOutputSchema: true,
      },
      {
        name: 'create_records',
        description: 'Create records',
        inputFields: [],
        isApplicationSupported: true,
        hasOutputSchema: true,
      },
      {
        name: 'get_records_aggregation',
        description: 'Aggregate records',
        inputFields: [],
        isApplicationSupported: true,
        hasOutputSchema: true,
      },
    ];

    simulatedProfile = {
      grantedScopes: new Set(['records.create', 'records.read', 'accounts.read']),
      syncState: 'complete',
      baseCurrency: 'IDR',
      usedCurrencies: ['IDR', 'USD'],
      mcpTools: ['get_records', 'create_records', 'get_records_aggregation'],
      system: 'Wallet',
      toolCount: 3,
      fetchedAt: simulatedCurrentTime,
      raw: {},
    };

    mockWalletClient = {
      listTools: vi.fn().mockResolvedValue(simulatedAdvertisedTools),
      getClientProfile: vi.fn().mockResolvedValue(simulatedProfile),
      callMcpTool: vi.fn(),
    } as unknown as WalletMcpClientService;
  });

  it('returns unknown for all tri-state checks before capability discovery runs', () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      clock: () => simulatedCurrentTime,
    });

    expect(capabilityService.supportsTool('get_records')).toBe('unknown');
    expect(capabilityService.hasScope('records.read')).toBe('unknown');
    expect(capabilityService.isSyncReady()).toBe('unknown');
    expect(capabilityService.getBaseCurrency()).toBeUndefined();
    expect(capabilityService.getToolCapability('get_records')).toBeUndefined();
    expect(capabilityService.getClientProfile()).toBeUndefined();
    expect(capabilityService.getAdvertisedToolNames()).toEqual([]);
  });

  it('populates capabilities after refreshCapabilities and answers queries definitively', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      clock: () => simulatedCurrentTime,
    });

    const snapshot = await capabilityService.refreshCapabilities();

    expect(mockWalletClient.listTools).toHaveBeenCalledTimes(1);
    expect(mockWalletClient.getClientProfile).toHaveBeenCalledWith(false);

    expect(snapshot.tools.size).toBe(3);
    expect(capabilityService.supportsTool('get_records')).toBe(true);
    expect(capabilityService.supportsTool('create_records')).toBe(true);
    expect(capabilityService.supportsTool('unadvertised_tool')).toBe(false);

    expect(capabilityService.hasScope('records.create')).toBe(true);
    expect(capabilityService.hasScope('records.read')).toBe(true);
    expect(capabilityService.hasScope('budgets.read')).toBe(false);

    expect(capabilityService.isSyncReady()).toBe(true);
    expect(capabilityService.getBaseCurrency()).toBe('IDR');
    expect(capabilityService.getToolCapability('get_records')?.description).toBe('Fetch records');
    expect(capabilityService.getClientProfile()?.baseCurrency).toBe('IDR');
    expect(capabilityService.getAdvertisedToolNames()).toEqual([
      'get_records',
      'create_records',
      'get_records_aggregation',
    ]);
  });

  it('evaluates sync readiness states deterministically across different values', async () => {
    const testCases: Array<{ state?: string; expected: boolean | 'unknown' }> = [
      { state: 'complete', expected: true },
      { state: 'ready', expected: true },
      { state: 'synced', expected: true },
      { state: 'OK', expected: true },
      { state: 'in_progress', expected: false },
      { state: 'syncing', expected: false },
      { state: 'error', expected: false },
      { state: 'failed', expected: false },
      { state: 'pending', expected: false },
      { state: 'unknown_vendor_state', expected: 'unknown' },
      { state: undefined, expected: 'unknown' },
    ];

    for (const testCase of testCases) {
      const customProfile: WalletClientProfile = {
        grantedScopes: new Set(['records.read']),
        syncState: testCase.state,
        usedCurrencies: [],
        mcpTools: [],
        fetchedAt: simulatedCurrentTime,
        raw: {},
      };

      const customClient = {
        listTools: vi.fn().mockResolvedValue([]),
        getClientProfile: vi.fn().mockResolvedValue(customProfile),
      } as unknown as WalletMcpClientService;

      const capabilityService = new WalletMcpCapabilityService(customClient, {
        clock: () => simulatedCurrentTime,
      });

      await capabilityService.refreshCapabilities();
      expect(capabilityService.isSyncReady()).toBe(testCase.expected);
    }
  });

  it('yields unknown when grantedScopes was omitted in profile response', async () => {
    const profileWithoutScopes: WalletClientProfile = {
      grantedScopes: undefined,
      syncState: 'complete',
      usedCurrencies: [],
      mcpTools: [],
      fetchedAt: simulatedCurrentTime,
      raw: {},
    };

    const clientWithoutScopes = {
      listTools: vi.fn().mockResolvedValue([]),
      getClientProfile: vi.fn().mockResolvedValue(profileWithoutScopes),
    } as unknown as WalletMcpClientService;

    const capabilityService = new WalletMcpCapabilityService(clientWithoutScopes, {
      clock: () => simulatedCurrentTime,
    });

    await capabilityService.refreshCapabilities();
    expect(capabilityService.hasScope('records.read')).toBe('unknown');
    expect(capabilityService.hasScope('accounts.read')).toBe('unknown');
  });

  it('allows runtime tool rejection to override optimistic advertised capability', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      clock: () => simulatedCurrentTime,
    });

    await capabilityService.refreshCapabilities();
    expect(capabilityService.supportsTool('create_records')).toBe(true);

    // Simulate downstream server runtime rejection (e.g. 403 Forbidden or scope revoked)
    capabilityService.markToolRejection('create_records', 'Scope records.create revoked at runtime');

    expect(capabilityService.supportsTool('create_records')).toBe(false);
    // Other tools remain supported
    expect(capabilityService.supportsTool('get_records')).toBe(true);
  });

  it('respects bounded cache duration and allows forced refresh', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      cacheDurationMilliseconds: 5000,
      clock: () => simulatedCurrentTime,
    });

    await capabilityService.refreshCapabilities();
    expect(mockWalletClient.listTools).toHaveBeenCalledTimes(1);

    // Advance time slightly within cache TTL
    simulatedCurrentTime += 2000;
    await capabilityService.refreshCapabilities();
    expect(mockWalletClient.listTools).toHaveBeenCalledTimes(1);

    // Force refresh bypasses cache TTL
    await capabilityService.refreshCapabilities(true);
    expect(mockWalletClient.listTools).toHaveBeenCalledTimes(2);

    // Advance time past TTL
    simulatedCurrentTime += 6000;
    await capabilityService.refreshCapabilities();
    expect(mockWalletClient.listTools).toHaveBeenCalledTimes(3);
  });

  it('clears state on invalidate so subsequent queries return unknown', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      clock: () => simulatedCurrentTime,
    });

    await capabilityService.refreshCapabilities();
    capabilityService.markToolRejection('get_records', 'Temporary rejection');
    expect(capabilityService.supportsTool('get_records')).toBe(false);

    capabilityService.invalidate();

    expect(capabilityService.supportsTool('get_records')).toBe('unknown');
    expect(capabilityService.hasScope('records.read')).toBe('unknown');
    expect(capabilityService.isSyncReady()).toBe('unknown');
    expect(capabilityService.getClientProfile()).toBeUndefined();
    expect(capabilityService.getAdvertisedToolNames()).toEqual([]);
  });

  it('handles partial failure when listTools succeeds but getClientProfile fails', async () => {
    const partialFailureClient = {
      listTools: vi.fn().mockResolvedValue(simulatedAdvertisedTools),
      getClientProfile: vi.fn().mockRejectedValue(new Error('Profile endpoint unavailable')),
    } as unknown as WalletMcpClientService;

    const capabilityService = new WalletMcpCapabilityService(partialFailureClient, {
      clock: () => simulatedCurrentTime,
    });

    const snapshot = await capabilityService.refreshCapabilities();

    expect(snapshot.tools.size).toBe(3);
    expect(capabilityService.supportsTool('get_records')).toBe(true);
    expect(capabilityService.hasScope('records.read')).toBe('unknown');
    expect(capabilityService.isSyncReady()).toBe('unknown');
  });

  it('handles partial failure when getClientProfile succeeds but listTools fails', async () => {
    const partialFailureClient = {
      listTools: vi.fn().mockRejectedValue(new Error('Tools endpoint failed')),
      getClientProfile: vi.fn().mockResolvedValue(simulatedProfile),
    } as unknown as WalletMcpClientService;

    const capabilityService = new WalletMcpCapabilityService(partialFailureClient, {
      clock: () => simulatedCurrentTime,
    });

    const snapshot = await capabilityService.refreshCapabilities();

    expect(snapshot.tools.size).toBe(0);
    expect(capabilityService.supportsTool('get_records')).toBe('unknown');
    expect(capabilityService.hasScope('records.read')).toBe(true);
    expect(capabilityService.isSyncReady()).toBe(true);
  });

  it('rethrows when both endpoints fail without prior cached snapshot', async () => {
    const completeFailureClient = {
      listTools: vi.fn().mockRejectedValue(new Error('Connection refused')),
      getClientProfile: vi.fn().mockRejectedValue(new Error('Connection refused')),
    } as unknown as WalletMcpClientService;

    const capabilityService = new WalletMcpCapabilityService(completeFailureClient, {
      clock: () => simulatedCurrentTime,
    });

    await expect(capabilityService.refreshCapabilities()).rejects.toThrow('Connection refused');
  });

  it('preserves fail-closed security invariant: discovered tools do not expand semantic execution allowlist', async () => {
    const unallowlistedAdvertisedToolName = 'unallowlisted_mutation_tool';
    expect((WALLET_MCP_ALLOWED_TOOL_NAMES as readonly string[]).includes(unallowlistedAdvertisedToolName)).toBe(false);

    const realClient = new WalletMcpClientService('https://wallet.example.com', 'test-token');

    // Attempting to invoke an unallowlisted tool directly must fail with DEFINITIVE_FAILURE
    await expect(
      (realClient as unknown as { callMcpTool(name: string): Promise<unknown> })
        .callMcpTool(unallowlistedAdvertisedToolName)
    ).rejects.toThrow(WalletMcpRequestError);
  });

  it('bounds runtime tool rejection lifetime and allows recovery via force-refresh or TTL expiration', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      cacheDurationMilliseconds: 5000,
      clock: () => simulatedCurrentTime,
    });

    await capabilityService.refreshCapabilities();
    expect(capabilityService.supportsTool('create_records')).toBe(true);

    // 1. Mark tool rejected at runtime (e.g. 403 Forbidden or scope revoked)
    capabilityService.markToolRejection('create_records', 'Method not allowed');
    expect(capabilityService.supportsTool('create_records')).toBe(false);

    // 2. While rejection is still fresh (< 5000ms), runtime rejection still overrides optimistic cached advertisement
    simulatedCurrentTime += 1000;
    expect(capabilityService.supportsTool('create_records')).toBe(false);

    // 3. Authoritative recovery branch A: force-refresh re-advertises the tool and clears stale runtime rejection
    await capabilityService.refreshCapabilities(true);
    expect(capabilityService.supportsTool('create_records')).toBe(true);

    // 4. Re-mark rejection to test authoritative recovery branch B: TTL expiration
    capabilityService.markToolRejection('create_records', 'Temporary network failure');
    expect(capabilityService.supportsTool('create_records')).toBe(false);

    // Advance beyond the configured freshness window (rejection TTL)
    simulatedCurrentTime += 6000;
    // Calling refreshCapabilities after TTL expiration re-evaluates advertised tools
    await capabilityService.refreshCapabilities();
    expect(capabilityService.supportsTool('create_records')).toBe(true);
  });

  it('tracks freshness independently per discovery source and degrades to unknown when profile refresh fails', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      cacheDurationMilliseconds: 5000,
      clock: () => simulatedCurrentTime,
    });

    // 1. Initial discovery: both tools and profile succeed
    await capabilityService.refreshCapabilities();
    expect(capabilityService.hasScope('records.create')).toBe(true);
    expect(capabilityService.isSyncReady()).toBe(true);
    expect(capabilityService.getBaseCurrency()).toBe('IDR');
    expect(capabilityService.getClientProfile()).toBeDefined();
    expect(capabilityService.supportsTool('get_records')).toBe(true);

    // 2. Advance beyond cache TTL
    simulatedCurrentTime += 6000;

    // 3. Subsequent refresh: listTools succeeds but getClientProfile fails
    mockWalletClient.getClientProfile = vi.fn().mockRejectedValue(new Error('Profile endpoint unavailable'));
    await capabilityService.refreshCapabilities();

    // 4. Verification: success from listTools cannot renew freshness of failed getClientProfile
    // Queries depending on profile must degrade conservatively to 'unknown' / undefined
    expect(capabilityService.hasScope('records.create')).toBe('unknown');
    expect(capabilityService.isSyncReady()).toBe('unknown');
    expect(capabilityService.getBaseCurrency()).toBeUndefined();
    expect(capabilityService.getClientProfile()).toBeUndefined();

    // While queries depending on tools remain fresh and definitive
    expect(capabilityService.supportsTool('get_records')).toBe(true);
    expect(capabilityService.getToolCapability('get_records')).toBeDefined();
    expect(capabilityService.getAdvertisedToolNames()).toContain('get_records');

    // 5. Repeating refresh cycles while profile continues to fail still never revives stale profile data
    simulatedCurrentTime += 6000;
    await capabilityService.refreshCapabilities();
    expect(capabilityService.hasScope('records.create')).toBe('unknown');
    expect(capabilityService.isSyncReady()).toBe('unknown');

    // 6. When getClientProfile recovers on the next refresh cycle, profile queries recover to fresh definitive values
    simulatedCurrentTime += 6000;
    mockWalletClient.getClientProfile = vi.fn().mockResolvedValue(simulatedProfile);
    await capabilityService.refreshCapabilities();
    expect(capabilityService.hasScope('records.create')).toBe(true);
    expect(capabilityService.isSyncReady()).toBe(true);
    expect(capabilityService.getBaseCurrency()).toBe('IDR');
  });

  it('degrades tool queries to unknown when listTools fails after TTL while profile succeeds', async () => {
    const capabilityService = new WalletMcpCapabilityService(mockWalletClient, {
      cacheDurationMilliseconds: 5000,
      clock: () => simulatedCurrentTime,
    });

    // Initial discovery
    await capabilityService.refreshCapabilities();
    expect(capabilityService.supportsTool('get_records')).toBe(true);
    expect(capabilityService.hasScope('records.create')).toBe(true);

    // Advance beyond cache TTL
    simulatedCurrentTime += 6000;

    // Subsequent refresh: listTools fails but getClientProfile succeeds
    mockWalletClient.listTools = vi.fn().mockRejectedValue(new Error('MCP server connection reset'));
    await capabilityService.refreshCapabilities();

    // Success from profile cannot renew freshness of failed listTools
    expect(capabilityService.supportsTool('get_records')).toBe('unknown');
    expect(capabilityService.getToolCapability('get_records')).toBeUndefined();
    expect(capabilityService.getAdvertisedToolNames()).toEqual([]);

    // Profile queries remain fresh
    expect(capabilityService.hasScope('records.create')).toBe(true);
    expect(capabilityService.isSyncReady()).toBe(true);
  });
});
