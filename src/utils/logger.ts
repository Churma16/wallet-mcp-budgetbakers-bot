import fs from 'fs';
import path from 'path';

const LOG_DIRECTORY_PATH = path.resolve(process.cwd(), 'logs');

/**
 * Ensures the logs directory exists
 */
function ensureLogDirectoryExists(): void {
  if (!fs.existsSync(LOG_DIRECTORY_PATH)) {
    fs.mkdirSync(LOG_DIRECTORY_PATH, { recursive: true });
  }
}

/**
 * Gets the filepath for the current day's log file (e.g. logs/app-2026-09-06.log)
 */
function getCurrentLogFilePath(): string {
  ensureLogDirectoryExists();
  const currentDate = new Date();
  const year = currentDate.getFullYear();
  const month = String(currentDate.getMonth() + 1).padStart(2, '0');
  const day = String(currentDate.getDate()).padStart(2, '0');
  const dateString = `${year}-${month}-${day}`;
  return path.join(LOG_DIRECTORY_PATH, `app-${dateString}.log`);
}

/**
 * Redacts known sensitive patterns (tokens, passwords, authorization headers, keys) from log strings
 */
export function redactSensitiveData(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') {
    return String(rawText || '');
  }

  return rawText
    // Telegram Bot Token pattern: e.g. 123456789:ABCdefGHIjklMNOpqrsTUVwxyz123456789
    .replace(/(?:bot)?(\d{8,10}:[A-Za-z0-9_-]{35})/gi, '[REDACTED_TELEGRAM_TOKEN]')
    // Authorization: Bearer <token>
    .replace(/(bearer\s+)[A-Za-z0-9_.-]+/gi, '$1[REDACTED_TOKEN]')
    // Common credential key-value patterns: token=..., password=..., secret=..., access_token=...
    .replace(
      /((?:access_token|password|secret|token|api_key|apiKey|bot_token)\s*[:=]\s*["']?)([^"'\s,;]+)(["']?)/gi,
      '$1[REDACTED]$3'
    );
}

/**
 * Checks whether a property key matches known sensitive financial identifiers
 */
export function isSensitivePropertyKey(propertyKeyName: string): boolean {
  if (!propertyKeyName || typeof propertyKeyName !== 'string') {
    return false;
  }
  const normalizedKeyName = propertyKeyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const sensitiveKeyList = [
    'bankaccountnumber',
    'bankaccount',
    'accountnumber',
    'accountno',
    'accno',
    'customerpan',
    'merchantpan',
    'pan',
    'sourceoffund',
    'cardnumber',
    'cardpan',
  ];
  return sensitiveKeyList.includes(normalizedKeyName);
}

/**
 * Checks whether a property key represents non-sensitive metadata (e.g. amounts, timestamps, transaction IDs)
 * that must be preserved without digit pattern masking.
 */
export function isExemptPropertyKey(propertyKeyName: string): boolean {
  if (!propertyKeyName || typeof propertyKeyName !== 'string') {
    return false;
  }
  const normalizedKeyName = propertyKeyName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const exemptKeyList = [
    'amount',
    'balance',
    'spentamount',
    'limitamount',
    'currentbalance',
    'rawcurrentbalance',
    'total',
    'succeeded',
    'failed',
    'id',
    'accountid',
    'transactionid',
    'recordid',
    'categoryid',
    'parentcategoryid',
    'categoryname',
    'name',
    'timestamp',
    'mtimems',
    'executiondurationmilliseconds',
    'duration',
    'durationms',
    'date',
    'recorddate',
    'time',
    'currency',
    'currencycode',
  ];
  return exemptKeyList.includes(normalizedKeyName);
}

/**
 * Masks bank account numbers or PANs by preserving the first 4 and last 4 characters,
 * masking the middle segment with '****' (e.g., 507431877335 -> 5074****7335).
 */
export function maskSensitiveValue(rawValue: unknown): string {
  if (rawValue === null || rawValue === undefined) {
    return '';
  }
  const rawStringValue = String(rawValue).trim();
  if (!rawStringValue) {
    return rawStringValue;
  }

  // Preserve if already masked or redacted
  if (rawStringValue.includes('****') || rawStringValue.includes('[REDACTED')) {
    return rawStringValue;
  }

  const numericDigitsOnly = rawStringValue.replace(/\D/g, '');

  // If text contains words/labels alongside digits (e.g., "BCA 507431877335")
  if (/[a-zA-Z]/.test(rawStringValue) && numericDigitsOnly.length >= 8) {
    return maskAccountNumbersAndPansInString(rawStringValue);
  }

  if (numericDigitsOnly.length >= 8) {
    const prefixSegment = numericDigitsOnly.slice(0, 4);
    const suffixSegment = numericDigitsOnly.slice(-4);
    return `${prefixSegment}****${suffixSegment}`;
  }

  if (numericDigitsOnly.length >= 5) {
    const prefixSegment = numericDigitsOnly.slice(0, 2);
    const suffixSegment = numericDigitsOnly.slice(-2);
    return `${prefixSegment}****${suffixSegment}`;
  }

  return '****';
}

/**
 * Scans strings for sensitive key-value pairs and continuous 10-19 digit sequences (account numbers / PANs)
 * and obfuscates them while protecting WhatsApp JIDs, email addresses, and exempt values.
 */
export function maskAccountNumbersAndPansInString(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') {
    return String(rawText || '');
  }

  // 1. Key-value style matching for sensitive keys in strings or embedded JSON
  let processedText = rawText.replace(
    /((?:["']?(?:bankAccountNumber|bank_account_number|accountNumber|account_number|customerPan|customer_pan|merchantPan|merchant_pan|pan|sourceOfFund|source_of_fund|cardNumber|card_number|cardPan|card_pan)["']?)\s*[:=]\s*["']?)([^"'\r\n,;}]+)(["']?)/gi,
    (fullMatchedSubstring, prefixPattern, rawPropertyValue, suffixPattern) => {
      if (rawPropertyValue.includes('****') || rawPropertyValue.includes('[REDACTED')) {
        return fullMatchedSubstring;
      }
      return `${prefixPattern}${maskSensitiveValue(rawPropertyValue)}${suffixPattern}`;
    }
  );

  // 2. Continuous digit sequences between 10 and 19 characters (standard account numbers and PANs)
  // Negative lookahead (?![@][a-zA-Z0-9_.-]+) protects WhatsApp JIDs (e.g. 6281234567890@s.whatsapp.net) and emails
  const continuousDigitSequenceRegex = /(?<!\d)(\d{4})\d{2,11}(\d{4})(?!\d)(?![@][a-zA-Z0-9_.-]+)/g;

  processedText = processedText.replace(
    continuousDigitSequenceRegex,
    '$1****$2'
  );

  return processedText;
}

/**
 * Recursively sanitizes payloads (objects, arrays, errors, primitives) before logging or writing to disk.
 * Obfuscates bank account numbers and PANs while preserving non-sensitive data and handling circular references safely.
 */
export function sanitizeSensitiveLogPayload(
  payload: unknown,
  visitedObjectSet: WeakSet<object> = new WeakSet(),
  currentPropertyKey?: string
): unknown {
  // 1. Handle Null / Undefined / Non-object primitives
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload === 'boolean') {
    return payload;
  }

  if (typeof payload === 'number' || typeof payload === 'bigint') {
    if (currentPropertyKey && isSensitivePropertyKey(currentPropertyKey)) {
      return maskSensitiveValue(payload);
    }
    return payload;
  }

  if (typeof payload === 'string') {
    // If the key is exempt (e.g. amount, transactionId, categoryId, accountId), do not mask digit patterns
    if (currentPropertyKey && isExemptPropertyKey(currentPropertyKey)) {
      return redactSensitiveData(payload);
    }
    // If the key is sensitive, mask the value
    if (currentPropertyKey && isSensitivePropertyKey(currentPropertyKey)) {
      return maskSensitiveValue(payload);
    }
    // For general strings (messages, notes, log lines), redact tokens and mask account numbers/PANs
    return maskAccountNumbersAndPansInString(redactSensitiveData(payload));
  }

  if (typeof payload === 'function') {
    return '[Function]';
  }

  // 2. Handle Object types (check circular references)
  if (typeof payload === 'object') {
    if (visitedObjectSet.has(payload)) {
      return '[CIRCULAR]';
    }
    visitedObjectSet.add(payload);

    // 2a. Handle Error instances
    if (payload instanceof Error) {
      const sanitizedErrorMessage = maskAccountNumbersAndPansInString(redactSensitiveData(payload.message));
      const sanitizedErrorObject = new Error(sanitizedErrorMessage);
      sanitizedErrorObject.name = payload.name;
      if (payload.stack) {
        sanitizedErrorObject.stack = maskAccountNumbersAndPansInString(redactSensitiveData(payload.stack));
      }

      // Copy and sanitize custom properties attached to Error
      const customPropertyKeyList = Object.keys(payload);
      for (const customPropertyKey of customPropertyKeyList) {
        if (customPropertyKey !== 'name' && customPropertyKey !== 'message' && customPropertyKey !== 'stack') {
          (sanitizedErrorObject as unknown as Record<string, unknown>)[customPropertyKey] = sanitizeSensitiveLogPayload(
            (payload as unknown as Record<string, unknown>)[customPropertyKey],
            visitedObjectSet,
            customPropertyKey
          );
        }
      }
      return sanitizedErrorObject;
    }

    // 2b. Handle Date instances
    if (payload instanceof Date) {
      return payload;
    }

    // 2c. Handle RegExp instances
    if (payload instanceof RegExp) {
      return payload;
    }

    // 2d. Handle Array instances
    if (Array.isArray(payload)) {
      return payload.map(arrayElementItem =>
        sanitizeSensitiveLogPayload(arrayElementItem, visitedObjectSet, currentPropertyKey)
      );
    }

    // 2e. Handle Plain Objects
    const sanitizedPlainObject: Record<string, unknown> = {};
    for (const [propertyKey, propertyValue] of Object.entries(payload)) {
      sanitizedPlainObject[propertyKey] = sanitizeSensitiveLogPayload(
        propertyValue,
        visitedObjectSet,
        propertyKey
      );
    }
    return sanitizedPlainObject;
  }

  return payload;
}

/**
 * Sanitizes an argument object, error, or primitive to prevent credential leaks and financial PII exposure.
 * Delegates to sanitizeSensitiveLogPayload.
 */
export function sanitizeLogArgument(argumentItem: unknown): unknown {
  return sanitizeSensitiveLogPayload(argumentItem);
}

/**
 * Helper to format objects, errors, and primitive values for file logging
 */
function formatLogPayload(dataItem: unknown, indentationSpaces: string = '  '): string {
  const sanitizedItem = sanitizeSensitiveLogPayload(dataItem);
  if (sanitizedItem instanceof Error) {
    const redactedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(sanitizedItem.message));
    const redactedStack = sanitizedItem.stack
      ? maskAccountNumbersAndPansInString(redactSensitiveData(sanitizedItem.stack))
      : 'No stack trace';
    return `\n${indentationSpaces}Error Name: ${sanitizedItem.name}\n${indentationSpaces}Error Message: ${redactedMessage}\n${indentationSpaces}Stack: ${redactedStack}`;
  }
  if (typeof sanitizedItem === 'object' && sanitizedItem !== null) {
    try {
      const serializedJsonString = JSON.stringify(sanitizedItem, null, 2);
      const redactedJsonString = maskAccountNumbersAndPansInString(redactSensitiveData(serializedJsonString));
      return '\n' + redactedJsonString.split('\n').map(line => `${indentationSpaces}${line}`).join('\n');
    } catch {
      return ` ${maskAccountNumbersAndPansInString(redactSensitiveData(String(sanitizedItem)))}`;
    }
  }
  return ` ${maskAccountNumbersAndPansInString(redactSensitiveData(String(sanitizedItem)))}`;
}

/**
 * Appends a log line to the daily log file with ISO timestamp and full error details
 */
function appendLogToFile(logLevelTag: string, message: string, optionalArguments: unknown[]): void {
  try {
    const isoTimestamp = new Date().toISOString();
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    let formattedArguments = '';

    if (optionalArguments && optionalArguments.length > 0) {
      formattedArguments = optionalArguments
        .map(argumentItem => formatLogPayload(argumentItem, '  '))
        .join('');
    }

    const logEntry = `[${isoTimestamp}] [${logLevelTag.toUpperCase()}] ${sanitizedMessage}${formattedArguments}\n`;
    fs.appendFileSync(getCurrentLogFilePath(), logEntry, 'utf-8');
  } catch (fileWriteError: unknown) {
    console.error(`[error] Failed to write to log file: ${fileWriteError}`);
  }
}

/**
 * Purges log files older than the specified retention days (default: 7 days)
 */
export function purgeExpiredLogFiles(retentionDays: number = 7): void {
  try {
    ensureLogDirectoryExists();
    const directoryFiles = fs.readdirSync(LOG_DIRECTORY_PATH);
    const expirationThresholdTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    let purgedFileCount = 0;

    for (const fileName of directoryFiles) {
      if (!fileName.startsWith('app-') || !fileName.endsWith('.log')) {
        continue;
      }

      const filePath = path.join(LOG_DIRECTORY_PATH, fileName);
      const fileStats = fs.statSync(filePath);

      if (fileStats.mtimeMs < expirationThresholdTimestamp) {
        fs.unlinkSync(filePath);
        purgedFileCount++;
      }
    }

    if (purgedFileCount > 0) {
      console.log(`${getFormattedTimestamp()} [info] Purged ${purgedFileCount} log file(s) older than ${retentionDays} days.`);
    }
  } catch (purgeError: unknown) {
    console.error(`[error] Failed to purge expired log files: ${purgeError}`);
  }
}

/**
 * Utility helper to generate timestamp in [HH:mm] format
 */
export function getFormattedTimestamp(): string {
  const currentDateTime = new Date();
  const formattedHours = String(currentDateTime.getHours()).padStart(2, '0');
  const formattedMinutes = String(currentDateTime.getMinutes()).padStart(2, '0');
  return `[${formattedHours}:${formattedMinutes}]`;
}

/**
 * Summarizes an error into a clean, concise, single-line string suitable for terminal display.
 * Strips raw JSON RPC dumps, URL links, and massive stack dumps.
 */
export function formatConciseErrorMessage(rawError: unknown): string {
  if (!rawError) {
    return 'Unknown error';
  }

  const rawErrorMessage = rawError instanceof Error ? rawError.message : String(rawError);
  const trimmedMessage = rawErrorMessage.trim();

  // 1. Try parsing direct JSON or embedded JSON error object
  let jsonCandidateMatch: string | null = null;
  if (trimmedMessage.startsWith('{') && trimmedMessage.endsWith('}')) {
    jsonCandidateMatch = trimmedMessage;
  } else {
    const firstBraceIndex = trimmedMessage.indexOf('{');
    const lastBraceIndex = trimmedMessage.lastIndexOf('}');
    const embeddedErrorPropertyIndex = trimmedMessage.indexOf('"error"');
    if (
      firstBraceIndex !== -1 &&
      lastBraceIndex > firstBraceIndex &&
      embeddedErrorPropertyIndex > firstBraceIndex &&
      embeddedErrorPropertyIndex < lastBraceIndex
    ) {
      jsonCandidateMatch = trimmedMessage.slice(firstBraceIndex, lastBraceIndex + 1);
    }
  }

  if (jsonCandidateMatch) {
    try {
      const parsedJson = JSON.parse(jsonCandidateMatch);
      const errorObject = parsedJson.error || parsedJson;
      const statusCode = errorObject.code || errorObject.status;
      const statusText = errorObject.status;

      if (statusCode === 429 || statusText === 'RESOURCE_EXHAUSTED') {
        return 'Rate limit / Quota exceeded (429 RESOURCE_EXHAUSTED)';
      }
      if (statusCode === 503 || statusText === 'UNAVAILABLE') {
        return 'Model high demand / Temporarily unavailable (503 UNAVAILABLE)';
      }
      if (statusCode === 504 || statusText === 'DEADLINE_EXCEEDED') {
        return 'Gateway timeout / Deadline exceeded (504 DEADLINE_EXCEEDED)';
      }
      if (statusCode === 404 || statusText === 'NOT_FOUND') {
        return 'Model not found (404 NOT_FOUND)';
      }
      if (errorObject.message) {
        const firstLine = String(errorObject.message).split('\n')[0].trim();
        return `${statusCode ? `${statusCode}: ` : ''}${firstLine.length > 70 ? firstLine.slice(0, 67) + '...' : firstLine}`;
      }
      return `${statusCode || 'Error'}: ${statusText || 'API failure'}`;
    } catch {
      // Continue to pattern checks
    }
  }

  // 2. Substring pattern heuristics
  if (trimmedMessage.includes('RESOURCE_EXHAUSTED') || trimmedMessage.includes('429')) {
    return 'Rate limit / Quota exceeded (429)';
  }
  if (trimmedMessage.includes('503') || trimmedMessage.includes('UNAVAILABLE') || trimmedMessage.includes('high demand')) {
    return 'Model high demand / Temporarily unavailable (503)';
  }
  if (trimmedMessage.includes('504') || trimmedMessage.includes('DEADLINE_EXCEEDED')) {
    return 'Gateway timeout (504)';
  }
  if (trimmedMessage.toLowerCase().includes('time') || trimmedMessage.toLowerCase().includes('abort')) {
    return 'Request timed out';
  }
  if (trimmedMessage.includes('404') || trimmedMessage.includes('NOT_FOUND')) {
    return 'Model not found (404)';
  }

  // 3. Clean single line fallback (max 80 chars)
  const firstLine = trimmedMessage.split('\n')[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

/**
 * Standardized logger with [HH:mm] timestamp, level tags, and persistent daily file logging
 */
export const applicationLogger = {
  info: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [info] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('info', sanitizedMessage, sanitizedArguments);
  },
  success: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [success] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('success', sanitizedMessage, sanitizedArguments);
  },
  warn: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.warn(`${getFormattedTimestamp()} [warn] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('warn', sanitizedMessage, sanitizedArguments);
  },
  error: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.error(`${getFormattedTimestamp()} [error] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('error', sanitizedMessage, sanitizedArguments);
  },
  chat: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [chat] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('chat', sanitizedMessage, sanitizedArguments);
  },
  ai: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [ai] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('ai', sanitizedMessage, sanitizedArguments);
  },
  mcp: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [mcp] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('mcp', sanitizedMessage, sanitizedArguments);
  },
  security: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = maskAccountNumbersAndPansInString(redactSensitiveData(message));
    const sanitizedArguments = optionalArguments.map(argumentItem => sanitizeSensitiveLogPayload(argumentItem));
    console.log(`${getFormattedTimestamp()} [security] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('security', sanitizedMessage, sanitizedArguments);
  },
  /**
   * Writes detailed debug information (payloads, state objects) directly to the log file
   * without cluttering the terminal output
   */
  fileDetail: (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    const sanitizedSummary = maskAccountNumbersAndPansInString(redactSensitiveData(summaryTitle));
    const sanitizedPayload = detailPayload !== undefined ? [sanitizeSensitiveLogPayload(detailPayload)] : [];
    appendLogToFile(logLevelTag, sanitizedSummary, sanitizedPayload);
  },
};

let consoleInterceptorsInstalled = false;

/**
 * Installs idempotent console interceptors that redirect verbose Signal Protocol
 * (libsignal) logs away from the terminal and into the daily log file.
 *
 * libsignal hardcodes calls directly to Node's global console object
 * (console.info / console.warn), bypassing the Pino logger passed into
 * makeWASocket. This wrapper selectively suppresses those specific sessions and
 * persists them via applicationLogger.fileDetail for auditing, while transparently
 * passing through every other console.info / console.warn invocation.
 */
export function installConsoleInterceptors(): void {
  if (consoleInterceptorsInstalled) {
    return;
  }
  consoleInterceptorsInstalled = true;

  const originalConsoleInfo = console.info.bind(console);
  const originalConsoleWarn = console.warn.bind(console);

  console.info = (...args: unknown[]): void => {
    const firstArgument = typeof args[0] === 'string' ? args[0] : '';
    if (firstArgument.includes('Closing session:')) {
      applicationLogger.fileDetail('whatsapp', 'Signal Protocol: Closing session', args[1]);
      return;
    }
    originalConsoleInfo(...args);
  };

  console.warn = (...args: unknown[]): void => {
    const firstArgument = typeof args[0] === 'string' ? args[0] : '';
    if (firstArgument.includes('Closing open session in favor of incoming prekey bundle')) {
      applicationLogger.fileDetail('whatsapp', 'Signal Protocol: Closing open session in favor of incoming prekey bundle');
      return;
    }
    originalConsoleWarn(...args);
  };
}
