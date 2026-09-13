import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vitestConfiguration from '../vitest.config';
import {
  discoverDirectProductionImports,
  extractRuntimeStaticImportSpecifiers,
} from '../scripts/verifyVitestCoverage.js';

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

interface CoverageConfiguration {
  include?: string[];
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

  it('discovers coverage from imported production modules without a per-file whitelist', () => {
    const resolvedConfiguration = vitestConfiguration as unknown as {
      test?: { coverage?: CoverageConfiguration };
    };

    expect(resolvedConfiguration.test?.coverage?.include).toBeUndefined();
  });

  it('extracts multiline and side-effect runtime imports while ignoring type-only imports', () => {
    const moduleSpecifiers = extractRuntimeStaticImportSpecifiers(`
      import type { Alpha } from '../src/types/alpha.js';
      import {
        runtimeValue,
        type RuntimeShape,
      } from '../src/runtime.js';
      import { type OnlyType } from '../src/types/onlyType.js';
      import '../src/sideEffect.js';
    `);

    expect(moduleSpecifiers).toEqual(
      expect.arrayContaining(['../src/runtime.js', '../src/sideEffect.js'])
    );
    expect(moduleSpecifiers).not.toContain('../src/types/alpha.js');
    expect(moduleSpecifiers).not.toContain('../src/types/onlyType.js');
  });

  it('discovers existing Vitest production imports automatically', () => {
    expect(discoverDirectProductionImports()).toEqual(
      expect.arrayContaining([
        'src/utils/digitNormalization.ts',
        'src/utils/exponentialBackoff.ts',
      ])
    );
  });
});
