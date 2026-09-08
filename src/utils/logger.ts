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
 * Sanitizes an argument object, error, or primitive to prevent credential leaks
 */
export function sanitizeLogArgument(argumentItem: unknown): unknown {
  if (typeof argumentItem === 'string') {
    return redactSensitiveData(argumentItem);
  }
  if (argumentItem instanceof Error) {
    const sanitizedError = new Error(redactSensitiveData(argumentItem.message));
    sanitizedError.name = argumentItem.name;
    if (argumentItem.stack) {
      sanitizedError.stack = redactSensitiveData(argumentItem.stack);
    }
    return sanitizedError;
  }
  if (typeof argumentItem === 'object' && argumentItem !== null) {
    try {
      const serializedJson = JSON.stringify(argumentItem);
      return JSON.parse(redactSensitiveData(serializedJson));
    } catch {
      return argumentItem;
    }
  }
  return argumentItem;
}

/**
 * Helper to format objects, errors, and primitive values for file logging
 */
function formatLogPayload(dataItem: unknown, indentationSpaces: string = '  '): string {
  const sanitizedItem = sanitizeLogArgument(dataItem);
  if (sanitizedItem instanceof Error) {
    const redactedMessage = redactSensitiveData(sanitizedItem.message);
    const redactedStack = sanitizedItem.stack ? redactSensitiveData(sanitizedItem.stack) : 'No stack trace';
    return `\n${indentationSpaces}Error Name: ${sanitizedItem.name}\n${indentationSpaces}Error Message: ${redactedMessage}\n${indentationSpaces}Stack: ${redactedStack}`;
  }
  if (typeof sanitizedItem === 'object' && sanitizedItem !== null) {
    try {
      const jsonString = JSON.stringify(sanitizedItem, null, 2);
      const redactedJson = redactSensitiveData(jsonString);
      return '\n' + redactedJson.split('\n').map(line => `${indentationSpaces}${line}`).join('\n');
    } catch {
      return ` ${redactSensitiveData(String(sanitizedItem))}`;
    }
  }
  return ` ${redactSensitiveData(String(sanitizedItem))}`;
}

/**
 * Appends a log line to the daily log file with ISO timestamp and full error details
 */
function appendLogToFile(logLevelTag: string, message: string, optionalArguments: unknown[]): void {
  try {
    const isoTimestamp = new Date().toISOString();
    let formattedArguments = '';

    if (optionalArguments && optionalArguments.length > 0) {
      formattedArguments = optionalArguments
        .map(argumentItem => formatLogPayload(argumentItem, '  '))
        .join('');
    }

    const logEntry = `[${isoTimestamp}] [${logLevelTag.toUpperCase()}] ${message}${formattedArguments}\n`;
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
  const jsonCandidateMatch = trimmedMessage.startsWith('{') && trimmedMessage.endsWith('}')
    ? trimmedMessage
    : trimmedMessage.match(/\{[\s\S]*"error"[\s\S]*\}/)?.[0];

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
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [info] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('info', sanitizedMessage, sanitizedArguments);
  },
  success: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [success] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('success', sanitizedMessage, sanitizedArguments);
  },
  warn: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.warn(`${getFormattedTimestamp()} [warn] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('warn', sanitizedMessage, sanitizedArguments);
  },
  error: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.error(`${getFormattedTimestamp()} [error] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('error', sanitizedMessage, sanitizedArguments);
  },
  chat: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [chat] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('chat', sanitizedMessage, sanitizedArguments);
  },
  ai: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [ai] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('ai', sanitizedMessage, sanitizedArguments);
  },
  mcp: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [mcp] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('mcp', sanitizedMessage, sanitizedArguments);
  },
  security: (message: string, ...optionalArguments: unknown[]): void => {
    const sanitizedMessage = redactSensitiveData(message);
    const sanitizedArguments = optionalArguments.map(sanitizeLogArgument);
    console.log(`${getFormattedTimestamp()} [security] ${sanitizedMessage}`, ...sanitizedArguments);
    appendLogToFile('security', sanitizedMessage, sanitizedArguments);
  },
  /**
   * Writes detailed debug information (payloads, state objects) directly to the log file
   * without cluttering the terminal output
   */
  fileDetail: (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    const sanitizedSummary = redactSensitiveData(summaryTitle);
    const sanitizedPayload = detailPayload !== undefined ? [sanitizeLogArgument(detailPayload)] : [];
    appendLogToFile(logLevelTag, sanitizedSummary, sanitizedPayload);
  },
};
