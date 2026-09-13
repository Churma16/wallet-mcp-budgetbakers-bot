import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const coverageFilePath = path.resolve(process.cwd(), 'coverage/vitest/lcov.info');
const representativeMigratedSourcePaths = [
  'src/utils/logger.ts',
  'src/config/environmentConfig.ts',
  'src/services/messaging/messageFormatHelper.ts',
] as const;

if (!existsSync(coverageFilePath)) {
  throw new Error(`Vitest LCOV report was not generated at ${coverageFilePath}`);
}

const normalizedSourceEntries = readFileSync(coverageFilePath, 'utf8')
  .split(/\r?\n/)
  .filter(line => line.startsWith('SF:'))
  .map(line => line.slice(3).replaceAll('\\', '/'));

const missingSourcePaths = representativeMigratedSourcePaths.filter(requiredSourcePath =>
  !normalizedSourceEntries.some(
    sourceEntry =>
      sourceEntry === requiredSourcePath || sourceEntry.endsWith(`/${requiredSourcePath}`)
  )
);

if (missingSourcePaths.length > 0) {
  throw new Error(
    `Vitest LCOV report is missing representative migrated production sources: ${missingSourcePaths.join(', ')}`
  );
}

console.log('[SUCCESS] Vitest LCOV includes representative migrated production sources.');
