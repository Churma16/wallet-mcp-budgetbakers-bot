import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

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

function isRuntimeImport(importDeclaration: ts.ImportDeclaration): boolean {
  const importClause = importDeclaration.importClause;

  if (!importClause) {
    return true;
  }

  if (importClause.isTypeOnly || importClause.name) {
    return !importClause.isTypeOnly;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings || ts.isNamespaceImport(namedBindings)) {
    return true;
  }

  return namedBindings.elements.some(element => !element.isTypeOnly);
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

export function discoverDirectProductionImports(repositoryRoot = process.cwd()): string[] {
  const testsDirectory = path.join(repositoryRoot, 'tests');
  const productionImports = new Set<string>();

  for (const testFilePath of collectVitestTestFiles(testsDirectory)) {
    const sourceText = readFileSync(testFilePath, 'utf8');
    const sourceFile = ts.createSourceFile(
      testFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    for (const statement of sourceFile.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !isRuntimeImport(statement)
      ) {
        continue;
      }

      const productionImport = resolveProductionImport(
        repositoryRoot,
        testFilePath,
        statement.moduleSpecifier.text
      );

      if (productionImport) {
        productionImports.add(productionImport);
      }
    }
  }

  return [...productionImports].sort();
}

export function verifyVitestCoverage(repositoryRoot = process.cwd()): void {
  const coverageFilePath = path.join(repositoryRoot, 'coverage/vitest/lcov.info');

  if (!existsSync(coverageFilePath)) {
    throw new Error(`Vitest LCOV report was not generated at ${coverageFilePath}`);
  }

  const directlyImportedProductionSources = discoverDirectProductionImports(repositoryRoot);
  if (directlyImportedProductionSources.length === 0) {
    throw new Error('No direct production imports were discovered in Vitest suites.');
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

  const missingSourcePaths = directlyImportedProductionSources.filter(
    sourcePath => !normalizedSourceEntries.includes(sourcePath)
  );

  if (missingSourcePaths.length > 0) {
    throw new Error(
      `Vitest LCOV report is missing directly imported production sources: ${missingSourcePaths.join(', ')}`
    );
  }

  console.log(
    `[SUCCESS] Vitest LCOV includes all ${directlyImportedProductionSources.length} directly imported production sources.`
  );
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedScriptPath && fileURLToPath(import.meta.url) === invokedScriptPath) {
  verifyVitestCoverage();
}
