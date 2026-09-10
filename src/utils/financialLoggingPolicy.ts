import { applicationLogger } from './logger.js';

const MAX_METADATA_KEYS = 12;
const COLLECTION_KEYS = [
  'records',
  'results',
  'accounts',
  'categories',
  'budgets',
  'transactions',
  'items',
  'contents',
  'messages',
] as const;

export function isFinancialPayloadDebugEnabled(): boolean {
  return (process.env.DEBUG_FINANCIAL_PAYLOADS || '').trim().toLowerCase() === 'true';
}

export function isCredentialPropertyKey(propertyKeyName: string): boolean {
  const normalizedKey = propertyKeyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalizedKey === 'password' ||
    normalizedKey === 'secret' ||
    normalizedKey === 'token' ||
    normalizedKey === 'authorization' ||
    normalizedKey === 'credentials' ||
    normalizedKey.endsWith('apikey') ||
    normalizedKey.endsWith('accesstoken') ||
    normalizedKey.endsWith('refreshtoken') ||
    normalizedKey.endsWith('bottoken') ||
    normalizedKey.endsWith('clientsecret') ||
    normalizedKey.endsWith('privatekey')
  );
}

function redactCredentialPairsInText(rawText: string): string {
  return rawText.replace(
    /((?:["']?(?:access[_-]?token|refresh[_-]?token|bot[_-]?token|api[_-]?key|password|secret|client[_-]?secret|private[_-]?key)["']?)\s*[:=]\s*["']?)([^"'\s,;}]+)(["']?)/gi,
    '$1[REDACTED]$3'
  );
}

/**
 * Redacts structured credential fields before detailed financial debugging is written.
 * The normal logger sanitizer still runs afterwards as a second defense layer.
 */
export function sanitizeFinancialDebugPayload(
  payload: unknown,
  visitedObjects: WeakSet<object> = new WeakSet()
): unknown {
  if (typeof payload === 'string') {
    return redactCredentialPairsInText(payload);
  }
  if (payload === null || payload === undefined || typeof payload !== 'object') {
    return payload;
  }
  if (visitedObjects.has(payload)) {
    return '[CIRCULAR]';
  }
  if (payload instanceof Date || payload instanceof RegExp) {
    return payload;
  }

  visitedObjects.add(payload);

  if (payload instanceof Error) {
    const sanitizedError = new Error(redactCredentialPairsInText(payload.message));
    sanitizedError.name = payload.name;
    sanitizedError.stack = payload.stack ? redactCredentialPairsInText(payload.stack) : payload.stack;
    for (const [propertyKey, propertyValue] of Object.entries(payload)) {
      (sanitizedError as unknown as Record<string, unknown>)[propertyKey] = isCredentialPropertyKey(propertyKey)
        ? '[REDACTED]'
        : sanitizeFinancialDebugPayload(propertyValue, visitedObjects);
    }
    return sanitizedError;
  }

  if (Array.isArray(payload)) {
    return payload.map(item => sanitizeFinancialDebugPayload(item, visitedObjects));
  }

  return Object.fromEntries(
    Object.entries(payload).map(([propertyKey, propertyValue]) => [
      propertyKey,
      isCredentialPropertyKey(propertyKey)
        ? '[REDACTED]'
        : sanitizeFinancialDebugPayload(propertyValue, visitedObjects),
    ])
  );
}

/**
 * Converts an arbitrary payload into metadata-only information suitable for default logs.
 * No values from the original financial payload are retained.
 */
export function summarizeFinancialLogPayload(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) {
    return { payloadType: String(payload) };
  }
  if (payload instanceof Error) {
    return { payloadType: 'error', errorName: payload.name };
  }
  if (Array.isArray(payload)) {
    return { payloadType: 'array', itemCount: payload.length };
  }
  if (typeof payload === 'object') {
    const objectPayload = payload as Record<string, unknown>;
    const propertyKeys = Object.keys(objectPayload);
    const collectionKey = COLLECTION_KEYS.find(key => Array.isArray(objectPayload[key]));
    return {
      payloadType: 'object',
      keyCount: propertyKeys.length,
      keys: propertyKeys.slice(0, MAX_METADATA_KEYS),
      ...(collectionKey ? { recordCount: (objectPayload[collectionKey] as unknown[]).length } : {}),
    };
  }
  if (typeof payload === 'string') {
    return { payloadType: 'string', characterCount: payload.length };
  }
  return { payloadType: typeof payload };
}

let policyInstalled = false;

/**
 * Makes detailed file payloads opt-in while keeping credential redaction active in both modes.
 */
export function installFinancialLoggingPolicy(): void {
  if (policyInstalled) {
    return;
  }
  policyInstalled = true;

  const originalFileDetail = applicationLogger.fileDetail.bind(applicationLogger);
  applicationLogger.fileDetail = (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    if (detailPayload === undefined) {
      originalFileDetail(logLevelTag, summaryTitle);
      return;
    }

    const payloadToLog = isFinancialPayloadDebugEnabled()
      ? sanitizeFinancialDebugPayload(detailPayload)
      : summarizeFinancialLogPayload(detailPayload);

    originalFileDetail(logLevelTag, summaryTitle, payloadToLog);
  };
}

installFinancialLoggingPolicy();
