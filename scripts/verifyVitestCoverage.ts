import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COVERAGE_CANARY_TEST_PATH = 'tests/sharedUtilities.vitest.test.ts';

const toPosixPath = (filePath: string): string => filePath.replaceAll('\\', '/');

function collectVitestTestFiles(directoryPath: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectVitestTestFiles(entryPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.vitest.test.ts')) {
      files.push(entryPath);
    }
  }

  return files;
}

function isTypeOnlyNamedImportClause(importClause: string): boolean {
  const trimmedClause = importClause.trim();
  if (!trimmedClause.startsWith('{') || !trimmedClause.endsWith('}')) {
    return false;
  }

  const importedBindings = trimmedClause
    .slice(1, -1)
    .split(',')
    .map(binding => binding.trim())
    .filter(Boolean);

  return importedBindings.length > 0 && importedBindings.every(binding => binding.startsWith('type '));
}

export function extractRuntimeStaticImportSpecifiers(sourceText: string): string[] {
  const moduleSpecifiers = new Set<string>();

  const sideEffectImportPattern = /^\s*import\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of sourceText.matchAll(sideEffectImportPattern)) {
    moduleSpecifiers.add(match[1]);
  }

  const fromImportPattern = /^\s*import\s+(?!type\b)(?!['"])([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  for (const match of sourceText.matchAll(fromImportPattern)) {
    const importClause = match[1];
    if (!isTypeOnlyNamedImportClause(importClause)) {
      moduleSpecifiers.add(match[2]);
    }
  }

  return [...moduleSpecifiers];
}

function resolveProductionImport(
  repositoryRoot: string,
  testFilePath: string,
  moduleSpecifier: string
): string | null {
  if (!moduleSpecifier.startsWith('.')) {
    return null;
  }

  const absoluteImportPath = path.resolve(path.dirname(testFilePath), moduleSpecifier);
  const extension = path.extname(absoluteImportPath);
  const extensionMap: Record<string, string> = {
    '.js': '.ts',
    '.jsx': '.tsx',
    '.mjs': '.mts',
    '.cjs': '.cts',
  };

  const candidates = extensionMap[extension]
    ? [`${absoluteImportPath.slice(0, -extension.length)}${extensionMap[extension]}`]
    : extension
      ? [absoluteImportPath]
      : [
          `${absoluteImportPath}.ts`,
          `${absoluteImportPath}.tsx`,
          path.join(absoluteImportPath, 'index.ts'),
          path.join(absoluteImportPath, 'index.tsx'),
        ];

  for (const candidatePath of candidates) {
    if (!existsSync(candidatePath)) {
      continue;
    }

    const relativePath = toPosixPath(path.relative(repositoryRoot, candidatePath));
    if (relativePath.startsWith('src/')) {
      return relativePath;
    }
  }

  return null;
}

export function discoverProductionImportsFromTestFile(
  relativeTestFilePath: string,
  repositoryRoot = process.cwd()
): string[] {
  const testFilePath = path.join(repositoryRoot, relativeTestFilePath);
  const sourceText = readFileSync(testFilePath, 'utf8');
  const productionImports = new Set<string>();

  for (const moduleSpecifier of extractRuntimeStaticImportSpecifiers(sourceText)) {
    const productionImport = resolveProductionImport(repositoryRoot, testFilePath, moduleSpecifier);

    if (productionImport) {
      productionImports.add(productionImport);
    }
  }

  return [...productionImports].sort();
}

export function discoverDirectProductionImports(repositoryRoot = process.cwd()): string[] {
  const testsDirectory = path.join(repositoryRoot, 'tests');
  const productionImports = new Set<string>();

  for (const testFilePath of collectVitestTestFiles(testsDirectory)) {
    const relativeTestFilePath = toPosixPath(path.relative(repositoryRoot, testFilePath));

    for (const productionImport of discoverProductionImportsFromTestFile(
      relativeTestFilePath,
      repositoryRoot
    )) {
      productionImports.add(productionImport);
    }
  }

  return [...productionImports].sort();
}

export function verifyVitestCoverage(repositoryRoot = process.cwd()): void {
  const coverageFilePath = path.join(repositoryRoot, 'coverage/vitest/lcov.info');

  if (!existsSync(coverageFilePath)) {
    throw new Error(`Vitest LCOV report was not generated at ${coverageFilePath}`);
  }

  const canaryProductionSources = discoverProductionImportsFromTestFile(
    COVERAGE_CANARY_TEST_PATH,
    repositoryRoot
  );
  if (canaryProductionSources.length === 0) {
    throw new Error(
      `Coverage canary suite ${COVERAGE_CANARY_TEST_PATH} has no direct production imports.`
    );
  }

  const normalizedSourceEntries = readFileSync(coverageFilePath, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.startsWith('SF:'))
    .map(line => line.slice(3))
    .map(sourceEntry =>
      toPosixPath(
        path.relative(
          repositoryRoot,
          path.isAbsolute(sourceEntry)
            ? sourceEntry
            : path.resolve(repositoryRoot, sourceEntry)
        )
      )
    );

  const missingSourcePaths = canaryProductionSources.filter(
    sourcePath => !normalizedSourceEntries.includes(sourcePath)
  );

  if (missingSourcePaths.length > 0) {
    throw new Error(
      `Vitest LCOV auto-discovery is missing coverage-canary production sources: ${missingSourcePaths.join(', ')}`
    );
  }

  console.log(
    `[SUCCESS] Vitest LCOV auto-discovery includes all ${canaryProductionSources.length} production imports from ${COVERAGE_CANARY_TEST_PATH}.`
  );
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScriptPath && fileURLToPath(import.meta.url) === invokedScriptPath) {
  verifyVitestCoverage();
}
