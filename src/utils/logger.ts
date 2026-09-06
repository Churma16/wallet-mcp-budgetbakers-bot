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
 * Standardized logger with [HH:mm] timestamp and level tags
 */
export const applicationLogger = {
  info: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [info] ${message}`, ...optionalArguments);
  },
  success: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [success] ${message}`, ...optionalArguments);
  },
  warn: (message: string, ...optionalArguments: unknown[]): void => {
    console.warn(`${getFormattedTimestamp()} [warn] ${message}`, ...optionalArguments);
  },
  error: (message: string, ...optionalArguments: unknown[]): void => {
    console.error(`${getFormattedTimestamp()} [error] ${message}`, ...optionalArguments);
  },
  chat: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [chat] ${message}`, ...optionalArguments);
  },
  ai: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [ai] ${message}`, ...optionalArguments);
  },
  mcp: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [mcp] ${message}`, ...optionalArguments);
  },
  security: (message: string, ...optionalArguments: unknown[]): void => {
    console.log(`${getFormattedTimestamp()} [security] ${message}`, ...optionalArguments);
  },
};
