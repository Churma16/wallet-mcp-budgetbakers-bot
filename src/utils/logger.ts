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
 * Helper to format objects, errors, and primitive values for file logging
 */
function formatLogPayload(dataItem: unknown, indentationSpaces: string = '  '): string {
  if (dataItem instanceof Error) {
    return `\n${indentationSpaces}Error Name: ${dataItem.name}\n${indentationSpaces}Error Message: ${dataItem.message}\n${indentationSpaces}Stack: ${dataItem.stack || 'No stack trace'}`;
  }
  if (typeof dataItem === 'object' && dataItem !== null) {
    try {
      const jsonString = JSON.stringify(dataItem, null, 2);
      return '\n' + jsonString.split('\n').map(line => `${indentationSpaces}${line}`).join('\n');
    } catch {
      return ` ${String(dataItem)}`;
    }
  }
  return ` ${String(dataItem)}`;
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
    console.log(`${getFormattedTimestamp()} [info] ${message}`, ...optionalArguments);
    appendLogToFile('info', message, optionalArguments);
  },
  success: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [success] ${message}`, ...optionalArguments);
    appendLogToFile('success', message, optionalArguments);
  },
  warn: (message: string, ...optionalArguments: unknown[]): void => {
    console.warn(`${getFormattedTimestamp()} [warn] ${message}`, ...optionalArguments);
    appendLogToFile('warn', message, optionalArguments);
  },
  error: (message: string, ...optionalArguments: unknown[]): void => {
    console.error(`${getFormattedTimestamp()} [error] ${message}`, ...optionalArguments);
    appendLogToFile('error', message, optionalArguments);
  },
  chat: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [chat] ${message}`, ...optionalArguments);
    appendLogToFile('chat', message, optionalArguments);
  },
  ai: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [ai] ${message}`, ...optionalArguments);
    appendLogToFile('ai', message, optionalArguments);
  },
  mcp: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [mcp] ${message}`, ...optionalArguments);
    appendLogToFile('mcp', message, optionalArguments);
  },
  security: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [security] ${message}`, ...optionalArguments);
    appendLogToFile('security', message, optionalArguments);
  },
  /**
   * Writes detailed debug information (payloads, state objects) directly to the log file
   * without cluttering the terminal output
   */
  fileDetail: (logLevelTag: string, summaryTitle: string, detailPayload?: unknown): void => {
    appendLogToFile(logLevelTag, summaryTitle, detailPayload !== undefined ? [detailPayload] : []);
  },
};
