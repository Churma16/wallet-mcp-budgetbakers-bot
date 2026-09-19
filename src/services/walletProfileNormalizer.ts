import {
  WalletClientProfile,
  WalletClientBudgetSettings,
  WalletMcpRateLimitMetadata,
} from '../types/walletCapabilityTypes.js';
import { WalletAgentHint } from '../types/walletTypes.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function normalizeAgentHintItem(hintValue: unknown): WalletAgentHint | undefined {
  if (!isRecord(hintValue)) {
    return undefined;
  }
  const rawType = hintValue.type;
  if (typeof rawType !== 'string' || !rawType.trim()) {
    return undefined;
  }
  const type = rawType.trim().slice(0, 100);
  const severity = typeof hintValue.severity === 'string' ? hintValue.severity.trim().slice(0, 50) : undefined;
  const text = typeof hintValue.text === 'string' ? hintValue.text.trim().slice(0, 1000) : undefined;

  let data: Record<string, unknown> | undefined;
  if (isRecord(hintValue.data)) {
    const boundedEntries = Object.entries(hintValue.data)
      .slice(0, 16)
      .filter((entry): entry is [string, string | number | boolean | null] => {
        const itemValue = entry[1];
        return itemValue === null || ['string', 'number', 'boolean'].includes(typeof itemValue);
      });
    if (boundedEntries.length > 0) {
      data = Object.fromEntries(boundedEntries);
    }
  }

  return { type, severity, text, data };
}

function normalizeRateLimit(rawMeta: unknown): WalletMcpRateLimitMetadata | undefined {
  if (!isRecord(rawMeta) || !isRecord(rawMeta.rateLimit)) {
    return undefined;
  }
  const rateLimitObject = rawMeta.rateLimit;
  const limit = normalizeFiniteNonNegativeNumber(rateLimitObject.limit ?? rateLimitObject.capacity);
  const remaining = normalizeFiniteNonNegativeNumber(rateLimitObject.remaining);
  const resetAt = typeof rateLimitObject.resetAt === 'string' && rateLimitObject.resetAt.trim()
    ? rateLimitObject.resetAt.trim()
    : undefined;
  const retryAfterMilliseconds = normalizeFiniteNonNegativeNumber(
    rateLimitObject.retryAfterMilliseconds ?? rateLimitObject.retryAfter
  );

  if (limit === undefined && remaining === undefined && resetAt === undefined && retryAfterMilliseconds === undefined) {
    return undefined;
  }

  return { limit, remaining, resetAt, retryAfterMilliseconds };
}

/**
 * Normalizes raw get_client_profile MCP response into a bounded, typed WalletClientProfile.
 * Preserves missing optional fields as undefined (e.g. grantedScopes = undefined if property
 * was omitted) so that tri-state capability queries can accurately report 'unknown'.
 */
export function normalizeWalletClientProfile(
  rawResponse: unknown,
  customFetchedAt?: number
): WalletClientProfile {
  const fetchedAt = customFetchedAt ?? Date.now();

  if (!isRecord(rawResponse)) {
    return {
      grantedScopes: undefined,
      syncState: undefined,
      syncError: undefined,
      baseCurrency: undefined,
      usedCurrencies: [],
      system: undefined,
      toolCount: undefined,
      mcpTools: [],
      budgetSettings: undefined,
      agentHints: undefined,
      rateLimit: undefined,
      fetchedAt,
      raw: {},
    };
  }

  // 1. Granted Scopes: undefined if property absent or not an array; Set<string> if present
  let grantedScopes: Set<string> | undefined;
  if (Array.isArray(rawResponse.grantedScopes)) {
    const validScopes = rawResponse.grantedScopes
      .filter((item): item is string => typeof item === 'string')
      .map(scope => scope.trim())
      .filter(scope => scope.length > 0);
    grantedScopes = new Set(validScopes);
  }

  // 2. Synchronization State and Error
  let syncState: string | undefined;
  let syncError: string | undefined;

  if (typeof rawResponse.syncState === 'string' && rawResponse.syncState.trim()) {
    syncState = rawResponse.syncState.trim();
  } else if (isRecord(rawResponse.sync) && typeof rawResponse.sync.state === 'string' && rawResponse.sync.state.trim()) {
    syncState = rawResponse.sync.state.trim();
  }

  if (typeof rawResponse.syncError === 'string' && rawResponse.syncError.trim()) {
    syncError = rawResponse.syncError.trim();
  } else if (isRecord(rawResponse.sync) && typeof rawResponse.sync.error === 'string' && rawResponse.sync.error.trim()) {
    syncError = rawResponse.sync.error.trim();
  }

  // 3. Base Currency
  let baseCurrency: string | undefined;
  if (typeof rawResponse.baseCurrency === 'string' && rawResponse.baseCurrency.trim()) {
    baseCurrency = rawResponse.baseCurrency.trim().toUpperCase();
  }

  // 4. Used Currencies
  let usedCurrencies: string[] = [];
  if (isRecord(rawResponse.usedCurrencies) && Array.isArray(rawResponse.usedCurrencies.list)) {
    usedCurrencies = rawResponse.usedCurrencies.list
      .filter((item): item is string => typeof item === 'string')
      .map(currency => currency.trim().toUpperCase())
      .filter(currency => currency.length > 0);
  } else if (Array.isArray(rawResponse.usedCurrencies)) {
    usedCurrencies = rawResponse.usedCurrencies
      .filter((item): item is string => typeof item === 'string')
      .map(currency => currency.trim().toUpperCase())
      .filter(currency => currency.length > 0);
  }

  // 5. System name & tool count
  const system = typeof rawResponse.system === 'string' && rawResponse.system.trim()
    ? rawResponse.system.trim()
    : undefined;
  const toolCount = normalizeFiniteNonNegativeNumber(rawResponse.toolCount);

  // 6. MCP Tools listed by profile
  let mcpTools: string[] = [];
  if (Array.isArray(rawResponse.mcpTools)) {
    mcpTools = rawResponse.mcpTools
      .filter((item): item is string => typeof item === 'string')
      .map(tool => tool.trim())
      .filter(tool => tool.length > 0);
  }

  // 7. Budget settings
  let budgetSettings: WalletClientBudgetSettings | undefined;
  if (isRecord(rawResponse.budgetSettings)) {
    const firstDayOfMonth = normalizeFiniteNonNegativeNumber(rawResponse.budgetSettings.firstDayOfMonth);
    if (firstDayOfMonth !== undefined) {
      budgetSettings = { firstDayOfMonth };
    }
  }

  // 8. Agent Hints
  let agentHints: WalletAgentHint[] | undefined;
  if (Array.isArray(rawResponse.agentHints)) {
    agentHints = rawResponse.agentHints
      .map(normalizeAgentHintItem)
      .filter((hint): hint is WalletAgentHint => hint !== undefined)
      .slice(0, 20);
  }

  // 9. Rate Limit Metadata
  const rateLimit = normalizeRateLimit(rawResponse._meta);

  return {
    grantedScopes,
    syncState,
    syncError,
    baseCurrency,
    usedCurrencies,
    system,
    toolCount,
    mcpTools,
    budgetSettings,
    agentHints,
    rateLimit,
    fetchedAt,
    raw: rawResponse,
  };
}
