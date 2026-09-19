import { WalletAgentHint } from './walletTypes.js';

export type CapabilityTriState = boolean | 'unknown';

export type WalletMcpFailureClassification =
  | 'AUTHORIZATION'
  | 'TOOL_UNAVAILABLE'
  | 'REQUEST_INVALID'
  | 'TRANSIENT'
  | 'UNKNOWN';

export type WalletMcpBoundedJsonValue =
  | string
  | number
  | boolean
  | null
  | WalletMcpBoundedJsonValue[]
  | WalletMcpBoundedJsonObject;

export interface WalletMcpBoundedJsonObject {
  readonly [key: string]: WalletMcpBoundedJsonValue;
}

export interface WalletMcpToolInputFieldCapability {
  readonly name: string;
  readonly required: boolean;
  readonly types: string[];
  readonly description?: string;
  readonly enumValues?: Array<string | number | boolean | null>;
}

export interface WalletMcpToolCapability {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: WalletMcpBoundedJsonObject;
  readonly outputSchema?: WalletMcpBoundedJsonObject;
  readonly inputFields: WalletMcpToolInputFieldCapability[];
  readonly isApplicationSupported: boolean;
  readonly hasOutputSchema: boolean;
}

export interface WalletMcpRateLimitMetadata {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;
  readonly retryAfterMilliseconds?: number;
}

export interface WalletMcpResponseMetadata {
  readonly rateLimit?: WalletMcpRateLimitMetadata;
  readonly agentHints?: WalletAgentHint[];
}

export interface WalletClientBudgetSettings {
  readonly firstDayOfMonth?: number;
}

export interface WalletClientProfile {
  readonly grantedScopes?: ReadonlySet<string>;
  readonly syncState?: string;
  readonly syncError?: string;
  readonly baseCurrency?: string;
  readonly usedCurrencies: readonly string[];
  readonly system?: string;
  readonly toolCount?: number;
  readonly mcpTools: readonly string[];
  readonly budgetSettings?: WalletClientBudgetSettings;
  readonly agentHints?: readonly WalletAgentHint[];
  readonly rateLimit?: WalletMcpRateLimitMetadata;
  readonly fetchedAt: number;
}

export interface WalletMcpCapabilitySnapshot {
  readonly tools: ReadonlyMap<string, WalletMcpToolCapability>;
  readonly profile?: WalletClientProfile;
  readonly runtimeRejections: ReadonlyMap<string, string>;
  readonly fetchedAt: number;
  readonly toolsFetchedAt?: number;
  readonly profileFetchedAt?: number;
}

export interface WalletMcpCapabilityQuery {
  supportsTool(toolName: string): CapabilityTriState;
  hasScope(scope: string): CapabilityTriState;
  isSyncReady(): CapabilityTriState;
  getBaseCurrency(): string | undefined;
  getToolCapability(toolName: string): WalletMcpToolCapability | undefined;
  getClientProfile(): WalletClientProfile | undefined;
  getAdvertisedToolNames(): readonly string[];
  markToolRejection(toolName: string, reason?: string): void;
}

export interface WalletMcpCapabilityOptions {
  readonly cacheDurationMilliseconds?: number;
  readonly rejectionTtlMilliseconds?: number;
  readonly clock?: () => number;
}
