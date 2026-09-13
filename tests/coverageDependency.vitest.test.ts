import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages?: Record<
    string,
    {
      devDependencies?: Record<string, string>;
      version?: string;
    }
  >;
}

describe('coverage dependency wiring', () => {
  it('keeps the Vitest V8 coverage provider reproducible through npm ci', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
    const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8')) as PackageLock;

    expect(manifest.devDependencies?.['@vitest/coverage-v8']).toBe('5.0.0');
    expect(lockfile.packages?.['']?.devDependencies?.['@vitest/coverage-v8']).toBe('5.0.0');
    expect(lockfile.packages?.['node_modules/@vitest/coverage-v8']?.version).toBe('5.0.0');

    const coverageScript = manifest.scripts?.['test:coverage:vitest'];
    expect(coverageScript).toBe(
      'vitest run --coverage && tsx scripts/verifyVitestCoverage.ts'
    );
    expect(coverageScript).not.toContain('npm install');
  });

  it('includes migrated production sources in Vitest coverage', () => {
    const vitestConfiguration = readFileSync('vitest.config.ts', 'utf8');
    const migratedProductionSources = [
      'src/utils/logger.ts',
      'src/config/environmentConfig.ts',
      'src/services/messaging/messageFormatHelper.ts',
    ];

    for (const sourcePath of migratedProductionSources) {
      expect(vitestConfiguration).toContain(`'${sourcePath}'`);
    }
  });
});
