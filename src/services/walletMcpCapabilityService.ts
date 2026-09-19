import {
  CapabilityTriState,
  WalletClientProfile,
  WalletMcpCapabilityOptions,
  WalletMcpCapabilityQuery,
  WalletMcpCapabilitySnapshot,
  WalletMcpToolCapability,
} from '../types/walletCapabilityTypes.js';
import { WalletMcpClientService } from './walletMcpService.js';
import { applicationLogger } from '../utils/logger.js';

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
    private readonly walletMcpClient: WalletMcpClientService,
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

  /**
   * Refreshes advertised tools and client profile in parallel, caching the combined snapshot.
   * Tracks freshness independently per discovery source so failure of one source does not
   * extend the freshness lifetime of stale metadata from the other.
   * Reconciles stale runtime rejections during authoritative rediscovery.
   */
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

      if (forceRefresh) {
        // Force refresh is an authoritative rediscovery demand: clear prior runtime rejections
        this.runtimeRejections.clear();
      } else {
        // Normal refresh: prune any expired runtime rejections
        for (const [toolName, rejection] of this.runtimeRejections.entries()) {
          if (currentTime - rejection.rejectedAt > this.rejectionTtlMilliseconds) {
            this.runtimeRejections.delete(toolName);
          }
        }
      }
    } else {
      applicationLogger.fileDetail('warn', 'Failed to discover advertised MCP tools', {
        error: toolsResult.reason instanceof Error ? toolsResult.reason.message : String(toolsResult.reason),
      });
      // If tools discovery failed and existing tools metadata is past TTL, clear tools cache
      if (currentTime - this.toolsFetchedAtTimestamp > this.cacheDurationMs) {
        this.toolsMap.clear();
        this.toolsDiscovered = false;
      }
    }

    if (profileResult.status === 'fulfilled') {
      this.cachedProfile = profileResult.value;
      this.profileFetchedAtTimestamp = currentTime;
    } else {
      applicationLogger.fileDetail('warn', 'Failed to retrieve Wallet client profile', {
        error: profileResult.reason instanceof Error ? profileResult.reason.message : String(profileResult.reason),
      });
      // If profile retrieval failed and existing profile metadata is past TTL, clear profile cache
      if (currentTime - this.profileFetchedAtTimestamp > this.cacheDurationMs) {
        this.cachedProfile = undefined;
      }
    }

    // If both failed and we have no previous cache, reject with the primary error
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
      toolsFetchedAt: this.toolsFetchedAtTimestamp,
      profileFetchedAt: this.profileFetchedAtTimestamp,
    };

    return this.cachedSnapshot;
  }

  /**
   * Checks whether a tool is advertised by the MCP server.
   * - Returns false if the tool was rejected at runtime and the rejection is still fresh (rejections take precedence).
   * - Returns 'unknown' if listTools() has not been executed yet or tool metadata has expired.
   * - Returns true if the tool name is in the advertised tools map, false otherwise.
   */
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

  /**
   * Checks whether a specific permission/scope is granted in the client profile.
   * - Returns 'unknown' if profile is not loaded, has expired, or grantedScopes was omitted.
   * - Returns boolean if grantedScopes set is present and fresh.
   */
  public hasScope(scope: string): CapabilityTriState {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime) || this.cachedProfile?.grantedScopes === undefined) {
      return 'unknown';
    }
    return this.cachedProfile.grantedScopes.has(scope);
  }

  /**
   * Checks whether Wallet synchronization is in a ready/complete state.
   * - Returns 'unknown' if profile is not loaded, has expired, or syncState was omitted.
   * - Returns true if syncState is in known ready states ('complete', 'ready', 'synced').
   * - Returns false if syncState is in known unready states ('error', 'in_progress', etc.).
   * - Returns 'unknown' for unrecognized states.
   */
  public isSyncReady(): CapabilityTriState {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime) || !this.cachedProfile?.syncState) {
      return 'unknown';
    }
    const normalizedState = this.cachedProfile.syncState.trim().toLowerCase();
    if (KNOWN_SYNC_READY_STATES.has(normalizedState)) {
      return true;
    }
    if (KNOWN_SYNC_UNREADY_STATES.has(normalizedState)) {
      return false;
    }
    return 'unknown';
  }

  /**
   * Returns the base currency reported by Wallet profile, if available and fresh.
   */
  public getBaseCurrency(): string | undefined {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime)) {
      return undefined;
    }
    return this.cachedProfile?.baseCurrency;
  }

  /**
   * Retrieves the detailed bounded capability schema for an advertised tool, if fresh.
   */
  public getToolCapability(toolName: string): WalletMcpToolCapability | undefined {
    const currentTime = this.clock();
    if (!this.isToolsFresh(currentTime)) {
      return undefined;
    }
    return this.toolsMap.get(toolName);
  }

  /**
   * Returns the cached normalized Wallet client profile, if retrieved and fresh.
   */
  public getClientProfile(): WalletClientProfile | undefined {
    const currentTime = this.clock();
    if (!this.isProfileFresh(currentTime)) {
      return undefined;
    }
    return this.cachedProfile;
  }

  /**
   * Lists all currently advertised tool names discovered from listTools(), if fresh.
   */
  public getAdvertisedToolNames(): readonly string[] {
    const currentTime = this.clock();
    if (!this.isToolsFresh(currentTime)) {
      return [];
    }
    return Array.from(this.toolsMap.keys());
  }

  /**
   * Records a definitive runtime rejection for an advertised tool with timestamp.
   * Runtime server rejection overrides optimistic cached capability metadata while fresh.
   */
  public markToolRejection(toolName: string, reason: string = 'Runtime tool rejection'): void {
    const currentTime = this.clock();
    this.runtimeRejections.set(toolName, { reason, rejectedAt: currentTime });
    applicationLogger.fileDetail('warn', `Recorded runtime tool rejection [${toolName}]`, {
      tool: toolName,
      reason,
      rejectedAt: currentTime,
    });
  }

  /**
   * Invalidates cached capability and profile metadata.
   */
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
