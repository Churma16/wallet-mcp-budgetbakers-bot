import type { Tool } from '@modelcontextprotocol/client';
import {
  MAX_DISCOVERED_WALLET_MCP_INPUT_FIELDS,
  MAX_WALLET_MCP_AGENT_HINTS,
  WALLET_MCP_ALLOWED_TOOL_NAMES,
} from '../constants.js';
import type {
  WalletAgentHint,
  WalletMcpBoundedJsonObject,
  WalletMcpBoundedJsonValue,
  WalletMcpRateLimitMetadata,
  WalletMcpResponseMetadata,
  WalletMcpToolCapability,
  WalletMcpToolInputFieldCapability,
} from '../types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue.slice(0, maximumLength) : undefined;
}

export function normalizeFiniteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeAgentHintData(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const boundedEntries = Object.entries(value)
    .slice(0, 16)
    .filter((entry): entry is [string, string | number | boolean | null] => {
      const entryValue = entry[1];
      return entryValue === null || ['string', 'number', 'boolean'].includes(typeof entryValue);
    })
    .map(([key, entryValue]) => [key.slice(0, 80), entryValue]);

  return boundedEntries.length > 0 ? Object.fromEntries(boundedEntries) : undefined;
}

export function normalizeAgentHints(value: unknown): WalletAgentHint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalizedHints = value
    .slice(0, MAX_WALLET_MCP_AGENT_HINTS)
    .reduce<WalletAgentHint[]>((result, hint) => {
      if (!isRecord(hint)) {
        return result;
      }
      const type = truncateText(hint.type, 160);
      if (!type) {
        return result;
      }
      result.push({
        type,
        severity: truncateText(hint.severity, 40),
        text: truncateText(hint.text, 500),
        data: normalizeAgentHintData(hint.data),
      });
      return result;
    }, []);

  return normalizedHints.length > 0 ? normalizedHints : undefined;
}

export function normalizeRateLimitMetadata(value: unknown): WalletMcpRateLimitMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const rateLimit: WalletMcpRateLimitMetadata = {
    limit: normalizeFiniteNonNegativeNumber(value.limit),
    remaining: normalizeFiniteNonNegativeNumber(value.remaining),
    resetAt: truncateText(value.resetAt ?? value.reset, 100),
    retryAfterMilliseconds: normalizeFiniteNonNegativeNumber(
      value.retryAfterMilliseconds ?? value.retryAfterMs
    ),
  };

  return Object.values(rateLimit).some(item => item !== undefined) ? rateLimit : undefined;
}

export function normalizeResponseMetadata(response: unknown): WalletMcpResponseMetadata | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  const resultRecord = response;
  const metadataRecord = isRecord(resultRecord._meta) ? resultRecord._meta : undefined;
  const structuredRecord = isRecord(resultRecord.structuredContent)
    ? resultRecord.structuredContent
    : undefined;
  const rateLimit = normalizeRateLimitMetadata(metadataRecord?.rateLimit);
  const agentHints = normalizeAgentHints(
    metadataRecord?.agentHints ?? structuredRecord?.agentHints ?? resultRecord.agentHints
  );

  return rateLimit || agentHints ? { rateLimit, agentHints } : undefined;
}

export function normalizeBoundedJsonValue(
  value: unknown,
  remainingNodeBudget: { value: number },
  depth: number = 0
): WalletMcpBoundedJsonValue | undefined {
  if (remainingNodeBudget.value <= 0 || depth > 6) {
    return undefined;
  }
  remainingNodeBudget.value--;

  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, 1_000);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 64)
      .map(item => normalizeBoundedJsonValue(item, remainingNodeBudget, depth + 1))
      .filter((item): item is WalletMcpBoundedJsonValue => item !== undefined);
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .slice(0, 64)
    .map(([key, propValue]): [string, WalletMcpBoundedJsonValue | undefined] => [
      key.slice(0, 160),
      normalizeBoundedJsonValue(propValue, remainingNodeBudget, depth + 1),
    ])
    .filter((entry): entry is [string, WalletMcpBoundedJsonValue] => entry[1] !== undefined);

  return Object.fromEntries(entries);
}

export function normalizeBoundedJsonObject(value: unknown): WalletMcpBoundedJsonObject | undefined {
  const normalizedValue = normalizeBoundedJsonValue(value, { value: 512 });
  return isRecord(normalizedValue)
    ? (normalizedValue as WalletMcpBoundedJsonObject)
    : undefined;
}

export function normalizeToolCapability(tool: Tool): WalletMcpToolCapability {
  const inputSchemaValue: unknown = tool.inputSchema;
  const inputSchema: Record<string, unknown> = isRecord(inputSchemaValue) ? inputSchemaValue : {};
  const properties = isRecord(inputSchema.properties) ? inputSchema.properties : {};
  const requiredNames = new Set(
    Array.isArray(inputSchema.required)
      ? inputSchema.required.filter((name): name is string => typeof name === 'string')
      : []
  );

  const inputFields = Object.entries(properties)
    .slice(0, MAX_DISCOVERED_WALLET_MCP_INPUT_FIELDS)
    .map(([name, schema]): WalletMcpToolInputFieldCapability => {
      const schemaRecord = isRecord(schema) ? schema : {};
      const rawType = schemaRecord.type;
      const types = (Array.isArray(rawType) ? rawType : [rawType])
        .filter((type): type is string => typeof type === 'string')
        .slice(0, 8);
      const enumValues = Array.isArray(schemaRecord.enum)
        ? schemaRecord.enum
            .filter((entry): entry is string | number | boolean | null => (
              entry === null || ['string', 'number', 'boolean'].includes(typeof entry)
            ))
            .slice(0, 32)
        : undefined;

      return {
        name: name.slice(0, 160),
        required: requiredNames.has(name),
        types,
        description: truncateText(schemaRecord.description, 500),
        enumValues: enumValues && enumValues.length > 0 ? enumValues : undefined,
      };
    });

  return {
    name: tool.name.slice(0, 160),
    description: truncateText(tool.description, 1_000),
    inputSchema: normalizeBoundedJsonObject(tool.inputSchema),
    outputSchema: normalizeBoundedJsonObject(tool.outputSchema),
    inputFields,
    isApplicationSupported: (WALLET_MCP_ALLOWED_TOOL_NAMES as readonly string[]).includes(tool.name),
    hasOutputSchema: tool.outputSchema !== undefined,
  };
}
