import { applicationLogger } from './logger.js';

const FINANCIAL_LOG_PLACEHOLDER = '[FINANCIAL_PAYLOAD_OMITTED]';
const MAX_METADATA_KEYS = 12;

export function isFinancialPayloadDebugEnabled(): boolean {
  return (process.env.DEBUG_FINANCIAL_PAYLOADS || '').trim().toLowerCase() === 'true';
}

function inferRecordCount(payload: Record<string, unknown>): number | undefined {
  const likelyCollectionKeys = [
    'records',
    'results',
    'accounts',
    'categories',
    'budgets',
    'transactions',
    'items',
    'contents',
    'messages',
  ];

  for (const collectionKey of likelyCollectionKeys) {
    const collectionValue = payload[collectionKey];
    if (Array.isArray(collectionValue)) {
      return collectionValue.length;
    }
  }

  return undefined;
}

/**
 * Converts an arbitrary payload into metadata-only information suitable for default logs.
 * No values from the original financial payload are retained.
 */
export function summarizeFinancialLogPayload(payload: unknown): Record<string, unknown> {
  if (payload === null) {
    return { payloadType: 'null' };
  }

  if (payload === undefined) {
    return { payloadType: 'undefined' };
  }

  if (payload instanceof Error) {
    return {
      payloadType: 'error',
      errorName: payload.name,
    };
  }

  if (Array.isArray(payload)) {
    return {
      payloadType: 'array',
      itemCount: payload.length,
    };
  }

  if (typeof payload === 'object') {
    const objectPayload = payload as Record<string, unknown>;
    const propertyKeys = Object.keys(objectPayload);
    const recordCount = inferRecordCount(objectPayload);

    return {
      payloadType: 'object',
      keyCount: propertyKeys.length,
      keys: propertyKeys.slice(0, MAX_METADATA_KEYS),
      ...(recordCount !== undefined ? { recordCount } : {}),
    };
  }

  if (typeof payload === 'string') {
    return {
      payloadType: 'string',
      characterCount: payload.length,
    };
  }

  return { payloadType: typeof payload };
}

/**
 * Removes common transaction-level values from human-readable log messages.
 * This is a defense-in-depth layer for legacy log statements that embedded values directly.
 */
export function minimizeFinancialLogMessage(message: string): string {
  if (isFinancialPayloadDebugEnabled() || !message) {
    return message;
  }

  if (message.startsWith('Processing detected email transaction:')) {
    return 'Processing detected email transaction.';
  }

  if (message.startsWith('[Gate 1 Skip]')) {
    return '[Gate 1 Skip] Email rejected by initial transaction gate.';
  }

  return message
    .replace(
      /\b(Amount|Balance|Merchant|Counterparty|Counter Party|Note|Reference|Ref)\s*:\s*("[^"]*"|'[^']*'|[^,|]+)(?=\s*(?:,|\||$))/gi,
      `$1: ${FINANCIAL_LOG_PLACEHOLDER}`
    )
    .replace(
      /\b(Rp|IDR|USD|EUR|GBP|SGD|JPY)\s*[+-]?[\d.,]+/gi,
      FINANCIAL_LOG_PLACEHOLDER
    );
}

let policyInstalled = false;

/**
 * Installs a process-wide logging policy once. Default detailed payloads are replaced with
 * metadata-only summaries. DEBUG_FINANCIAL_PAYLOADS=true restores detailed payload logging,
 * while the existing logger sanitizer continues to redact credentials and account secrets.
 */
export function installFinancialLoggingPolicy(): void {
  if (policyInstalled) {
    return;
  }
  policyInstalled = true;

  const originalFileDetail = applicationLogger.fileDetail.bind(applicationLogger);
  applicationLogger.fileDetail = (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    const minimizedSummary = minimizeFinancialLogMessage(summaryTitle);

    if (detailPayload === undefined || isFinancialPayloadDebugEnabled()) {
      originalFileDetail(logLevelTag, minimizedSummary, detailPayload);
      return;
    }

    originalFileDetail(logLevelTag, minimizedSummary, summarizeFinancialLogPayload(detailPayload));
  };

  const originalInfo = applicationLogger.info.bind(applicationLogger);
  applicationLogger.info = (message: string, ...optionalArguments: unknown[]): void => {
    originalInfo(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalSuccess = applicationLogger.success.bind(applicationLogger);
  applicationLogger.success = (message: string, ...optionalArguments: unknown[]): void => {
    originalSuccess(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalWarn = applicationLogger.warn.bind(applicationLogger);
  applicationLogger.warn = (message: string, ...optionalArguments: unknown[]): void => {
    originalWarn(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalError = applicationLogger.error.bind(applicationLogger);
  applicationLogger.error = (message: string, ...optionalArguments: unknown[]): void => {
    originalError(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalChat = applicationLogger.chat.bind(applicationLogger);
  applicationLogger.chat = (message: string, ...optionalArguments: unknown[]): void => {
    originalChat(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalAi = applicationLogger.ai.bind(applicationLogger);
  applicationLogger.ai = (message: string, ...optionalArguments: unknown[]): void => {
    originalAi(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalMcp = applicationLogger.mcp.bind(applicationLogger);
  applicationLogger.mcp = (message: string, ...optionalArguments: unknown[]): void => {
    originalMcp(minimizeFinancialLogMessage(message), ...optionalArguments);
  };

  const originalSecurity = applicationLogger.security.bind(applicationLogger);
  applicationLogger.security = (message: string, ...optionalArguments: unknown[]): void => {
    originalSecurity(minimizeFinancialLogMessage(message), ...optionalArguments);
  };
}

installFinancialLoggingPolicy();
