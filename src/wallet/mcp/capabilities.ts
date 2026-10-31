import type {
  CapabilityTriState,
  WalletClientProfile,
  WalletMcpCapabilityOptions,
  WalletMcpCapabilityQuery,
  WalletMcpCapabilitySnapshot,
  WalletMcpToolCapability,
} from '../types.js';
import { applicationLogger } from '../../lib/logger.js';

export interface CapabilityDiscoveryClient {
  listTools(): Promise<WalletMcpToolCapability[]>;
  getClientProfile(forceRefresh?: boolean): Promise<WalletClientProfile>;
}

export const DEFAULT_CAPABILITY_CACHE_DURATION_MS = 1000 * 60 * 5; // 5 minutes

const KNOWN_SYNC_READY_STATES = new Set(['complete', 'ready', 'synced', 'ok']);
const KNOWN_SYNC_UNREADY_STATES = new Set(['error', 'failed', 'in_progress', 'syncing', 'pending']);

/**
 * Narrow, typed capability and readiness facade combining:
 * 1. MCP listTools() for server-advertised tools and input schemas
 * 2. Wallet get_client_profile for permissions, sync state, and base currency
 *
 * Implements conservative tri-state (true | false | 'unknown') semantics so that
 * missing or un-probed metadata never gives false certainty.
 * Runtime rejections take precedence over cached advertisements.
 */
export class WalletMcpCapabilityService implements WalletMcpCapabilityQuery {
  private readonly cacheDurationMs: number;
  private readonly rejectionTtlMilliseconds: number;
  private readonly clock: () => number;
  private cachedSnapshot?: WalletMcpCapabilitySnapshot;
  private readonly toolsMap = new Map<string, WalletMcpToolCapability>();
  private toolsDiscovered = false;
  private toolsFetchedAtTimestamp = 0;
  private cachedProfile?: WalletClientProfile;
  private profileFetchedAtTimestamp = 0;
  private readonly runtimeRejections = new Map<string, { reason: string; rejectedAt: number }>();

  constructor(
    private readonly walletMcpClient: CapabilityDiscoveryClient,
    options: WalletMcpCapabilityOptions = {}
  ) {
    this.cacheDurationMs = options.cacheDurationMilliseconds ?? DEFAULT_CAPABILITY_CACHE_DURATION_MS;
    this.rejectionTtlMilliseconds = options.rejectionTtlMilliseconds ?? this.cacheDurationMs;
    this.clock = options.clock ?? Date.now;
  }

  private isToolsFresh(currentTime: number): boolean {
    return this.toolsDiscovered && (currentTime - this.toolsFetchedAtTimestamp <= this.cacheDurationMs);
  }

  private isProfileFresh(currentTime: number): boolean {
    return this.cachedProfile !== undefined && (currentTime - this.profileFetchedAtTimestamp <= this.cacheDurationMs);
  }

  private getActiveRuntimeRejections(currentTime: number): Map<string, string> {
    const activeRejections = new Map<string, string>();
    for (const [toolName, rejection] of this.runtimeRejections.entries()) {
      if (currentTime - rejection.rejectedAt <= this.rejectionTtlMilliseconds) {
        activeRejections.set(toolName, rejection.reason);
      } else {
        this.runtimeRejections.delete(toolName);
      }
    }
    return activeRejections;
  }

  public async refreshCapabilities(forceRefresh: boolean = false): Promise<WalletMcpCapabilitySnapshot> {
    const currentTime = this.clock();
    const isCacheExpired = !this.cachedSnapshot ||
      (currentTime - this.cachedSnapshot.fetchedAt > this.cacheDurationMs);

    if (!forceRefresh && this.cachedSnapshot && !isCacheExpired) {
      return this.cachedSnapshot;
    }

    const [toolsResult, profileResult] = await Promise.allSettled([
      this.walletMcpClient.listTools(),
      this.walletMcpClient.getClientProfile(forceRefresh),
    ]);

    if (toolsResult.status === 'fulfilled') {
      this.toolsMap.clear();
      for (const tool of toolsResult.value) {
        this.toolsMap.set(tool.name, tool);
      }
      this.toolsDiscovered = true;
      this.toolsFetchedAtTimestamp = currentTime;

      for (const [toolName, rejection] of this.runtimeRejections.entries()) {
        if (currentTime - rejection.rejectedAt > this.rejectionTtlMilliseconds) {
          this.runtimeRejections.delete(toolName);
        }
      }
    } else {
      applicationLogger.fileDetail('warn', 'Failed to discover advertised MCP tools', {
        error: toolsResult.reason instanceof Error ? toolsResult.reason.message : String(toolsResult.reason),
      });
      if (currentTime - this.toolsFetchedAtTimestamp > this.cacheDurationMs) {
        this.toolsMap.clear();
        this.toolsDiscovered = false;
      }
    }

    if (profileResult.status === 'fulfilled') {
      this.cachedProfile = profileResult.value;
      this.profileFetchedAtTimestamp = currentTime;
    } else {
      applicationLogger.fileDetail('warn', 'Failed to refresh client profile', {
        error: profileResult.reason instanceof Error ? profileResult.reason.message : String(profileResult.reason),
      });
      if (currentTime - this.profileFetchedAtTimestamp > this.cacheDurationMs) {
        this.cachedProfile = undefined;
      }
    }

    if (toolsResult.status === 'rejected' && profileResult.status === 'rejected' && !this.cachedSnapshot) {
      const primaryError = toolsResult.reason instanceof Error
        ? toolsResult.reason
        : new Error(String(toolsResult.reason));
      throw primaryError;
    }

    this.cachedSnapshot = {
      tools: this.isToolsFresh(currentTime) ? new Map(this.toolsMap) : new Map(),
      profile: this.isProfileFresh(currentTime) ? this.cachedProfile : undefined,
      runtimeRejections: this.getActiveRuntimeRejections(currentTime),
      fetchedAt: currentTime,
      toolsFetchedAt: this.toolsDiscovered ? this.toolsFetchedAtTimestamp : undefined,
      profileFetchedAt: this.cachedProfile ? this.profileFetchedAtTimestamp : undefined,
    };

    return this.cachedSnapshot;
  }

  public getCapabilitySnapshot(): WalletMcpCapabilitySnapshot {
    const currentTime = this.clock();
    const activeRejections = this.getActiveRuntimeRejections(currentTime);

    return {
      tools: this.isToolsFresh(currentTime) ? new Map(this.toolsMap) : new Map(),
      profile: this.isProfileFresh(currentTime) ? this.cachedProfile : undefined,
      runtimeRejections: activeRejections,
      fetchedAt: this.cachedSnapshot?.fetchedAt ?? currentTime,
      toolsFetchedAt: this.toolsDiscovered ? this.toolsFetchedAtTimestamp : undefined,
      profileFetchedAt: this.cachedProfile ? this.profileFetchedAtTimestamp : undefined,
    };
  }

  public supportsTool(toolName: string): CapabilityTriState {
    const currentTime = this.clock();
    const rejection = this.runtimeRejections.get(toolName);
    if (rejection) {
      if (currentTime - rejection.rejectedAt <= this.rejectionTtlMilliseconds) {
        return false;
      }
      this.runtimeRejections.delete(toolName);
    }

    if (!this.isToolsFresh(currentTime)) {
      return 'unknown';
    }

    return this.toolsMap.has(toolName);
  }

  public hasScope(scope: string): CapabilityTriState {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime) || this.cachedProfile?.grantedScopes === undefined) {
      return 'unknown';
    }
    return this.cachedProfile.grantedScopes.has(scope);
  }

  public isSyncReady(): CapabilityTriState {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime) || !this.cachedProfile?.syncState) {
      return 'unknown';
    }

    const syncState = this.cachedProfile.syncState.trim().toLowerCase();
    if (KNOWN_SYNC_READY_STATES.has(syncState)) {
      return true;
    }
    if (KNOWN_SYNC_UNREADY_STATES.has(syncState)) {
      return false;
    }

    return 'unknown';
  }

  public getBaseCurrency(): string | undefined {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime)) {
      return undefined;
    }
    return this.cachedProfile?.baseCurrency;
  }

  public getToolCapability(toolName: string): WalletMcpToolCapability | undefined {
    const currentTime = this.clock();
    if (!this.isToolsFresh(currentTime)) {
      return undefined;
    }
    return this.toolsMap.get(toolName);
  }

  public getClientProfile(): WalletClientProfile | undefined {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime)) {
      return undefined;
    }
    return this.cachedProfile;
  }

  public getAdvertisedToolNames(): readonly string[] {
    const currentTime = this.clock();
    if (!this.isToolsFresh(currentTime)) {
      return [];
    }
    return Array.from(this.toolsMap.keys());
  }

  public markToolRejection(toolName: string, reason: string = 'Runtime tool rejection'): void {
    const currentTime = this.clock();
    this.runtimeRejections.set(toolName, { reason, rejectedAt: currentTime });
    applicationLogger.fileDetail('warn', `Recorded runtime tool rejection [${toolName}]`, {
      tool: toolName,
      reason,
      rejectedAt: currentTime,
    });
  }

  public invalidate(): void {
    this.cachedSnapshot = undefined;
    this.toolsMap.clear();
    this.toolsDiscovered = false;
    this.toolsFetchedAtTimestamp = 0;
    this.cachedProfile = undefined;
    this.profileFetchedAtTimestamp = 0;
    this.runtimeRejections.clear();
  }
}
