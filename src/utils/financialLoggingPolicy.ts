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
 * Makes detailed file payloads opt-in. The logger still performs its normal credential and
 * account-secret sanitization after this policy selects either the raw debug payload or a
 * metadata-only summary.
 */
export function installFinancialLoggingPolicy(): void {
  if (policyInstalled) {
    return;
  }
  policyInstalled = true;

  const originalFileDetail = applicationLogger.fileDetail.bind(applicationLogger);
  applicationLogger.fileDetail = (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    if (detailPayload === undefined || isFinancialPayloadDebugEnabled()) {
      originalFileDetail(logLevelTag, summaryTitle, detailPayload);
      return;
    }

    originalFileDetail(logLevelTag, summaryTitle, summarizeFinancialLogPayload(detailPayload));
  };
}

installFinancialLoggingPolicy();
