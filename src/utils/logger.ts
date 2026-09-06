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
 * Appends a log line to the daily log file with ISO timestamp and full error details
 */
function appendLogToFile(logLevelTag: string, message: string, optionalArguments: unknown[]): void {
  try {
    const isoTimestamp = new Date().toISOString();
    let formattedArguments = '';

    if (optionalArguments && optionalArguments.length > 0) {
      formattedArguments = ' ' + optionalArguments
        .map(argumentItem => {
          if (argumentItem instanceof Error) {
            return `${argumentItem.message}\n${argumentItem.stack || ''}`;
          }
          if (typeof argumentItem === 'object' && argumentItem !== null) {
            try {
              return JSON.stringify(argumentItem, null, 2);
            } catch {
              return String(argumentItem);
            }
          }
          return String(argumentItem);
        })
        .join(' ');
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
};
