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
  private readonly clock: () => number;
  private cachedSnapshot?: WalletMcpCapabilitySnapshot;
  private toolsMap = new Map<string, WalletMcpToolCapability>();
  private toolsDiscovered = false;
  private cachedProfile?: WalletClientProfile;
  private readonly runtimeRejections = new Map<string, string>();

  constructor(
    private readonly walletMcpClient: WalletMcpClientService,
    options: WalletMcpCapabilityOptions = {}
  ) {
    this.cacheDurationMs = options.cacheDurationMilliseconds ?? DEFAULT_CAPABILITY_CACHE_DURATION_MS;
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Refreshes advertised tools and client profile in parallel, caching the combined snapshot.
   * If one endpoint fails, the available metadata from the other is still preserved.
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
    } else {
      applicationLogger.fileDetail('warn', 'Failed to discover advertised MCP tools', {
        error: toolsResult.reason instanceof Error ? toolsResult.reason.message : String(toolsResult.reason),
      });
    }

    if (profileResult.status === 'fulfilled') {
      this.cachedProfile = profileResult.value;
    } else {
      applicationLogger.fileDetail('warn', 'Failed to retrieve Wallet client profile', {
        error: profileResult.reason instanceof Error ? profileResult.reason.message : String(profileResult.reason),
      });
    }

    // If both failed and we have no previous cache, reject with the primary error
    if (toolsResult.status === 'rejected' && profileResult.status === 'rejected' && !this.cachedSnapshot) {
      const primaryError = toolsResult.reason instanceof Error
        ? toolsResult.reason
        : new Error(String(toolsResult.reason));
      throw primaryError;
    }

    this.cachedSnapshot = {
      tools: new Map(this.toolsMap),
      profile: this.cachedProfile,
      runtimeRejections: new Map(this.runtimeRejections),
      fetchedAt: currentTime,
    };

    return this.cachedSnapshot;
  }

  /**
   * Checks whether a tool is advertised by the MCP server.
   * - Returns false if the tool was rejected at runtime (rejections take precedence).
   * - Returns 'unknown' if listTools() has not been executed yet.
   * - Returns true if the tool name is in the advertised tools map, false otherwise.
   */
  public supportsTool(toolName: string): CapabilityTriState {
    if (this.runtimeRejections.has(toolName)) {
      return false;
    }
    if (!this.toolsDiscovered) {
      return 'unknown';
    }
    return this.toolsMap.has(toolName);
  }

  /**
   * Checks whether a specific permission/scope is granted in the client profile.
   * - Returns 'unknown' if profile is not loaded or grantedScopes was omitted.
   * - Returns boolean if grantedScopes set is present.
   */
  public hasScope(scope: string): CapabilityTriState {
    if (!this.cachedProfile || this.cachedProfile.grantedScopes === undefined) {
      return 'unknown';
    }
    return this.cachedProfile.grantedScopes.has(scope);
  }

  /**
   * Checks whether Wallet synchronization is in a ready/complete state.
   * - Returns 'unknown' if profile is not loaded or syncState was omitted.
   * - Returns true if syncState is in known ready states ('complete', 'ready', 'synced').
   * - Returns false if syncState is in known unready states ('error', 'in_progress', etc.).
   * - Returns 'unknown' for unrecognized states.
   */
  public isSyncReady(): CapabilityTriState {
    if (!this.cachedProfile || !this.cachedProfile.syncState) {
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
   * Returns the base currency reported by Wallet profile, if available.
   */
  public getBaseCurrency(): string | undefined {
    return this.cachedProfile?.baseCurrency;
  }

  /**
   * Retrieves the detailed bounded capability schema for an advertised tool.
   */
  public getToolCapability(toolName: string): WalletMcpToolCapability | undefined {
    return this.toolsMap.get(toolName);
  }

  /**
   * Returns the cached normalized Wallet client profile, if retrieved.
   */
  public getClientProfile(): WalletClientProfile | undefined {
    return this.cachedProfile;
  }

  /**
   * Lists all currently advertised tool names discovered from listTools().
   */
  public getAdvertisedToolNames(): readonly string[] {
    return Array.from(this.toolsMap.keys());
  }

  /**
   * Records a definitive runtime rejection for an advertised tool.
   * Runtime server rejection overrides optimistic cached capability metadata.
   */
  public markToolRejection(toolName: string, reason: string = 'Runtime tool rejection'): void {
    this.runtimeRejections.set(toolName, reason);
    applicationLogger.fileDetail('warn', `Recorded runtime tool rejection [${toolName}]`, {
      tool: toolName,
      reason,
    });
  }

  /**
   * Invalidates cached capability and profile metadata.
   */
  public invalidate(): void {
    this.cachedSnapshot = undefined;
    this.toolsMap.clear();
    this.toolsDiscovered = false;
    this.cachedProfile = undefined;
    this.runtimeRejections.clear();
  }
}
