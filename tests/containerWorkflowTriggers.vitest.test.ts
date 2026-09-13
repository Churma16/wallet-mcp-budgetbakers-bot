import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function getPullRequestTriggerLines(): string[] {
  const workflowPath = path.resolve(process.cwd(), '.github/workflows/container.yml');
  const workflowLines = readFileSync(workflowPath, 'utf8').split(/\r?\n/);
  const pullRequestStart = workflowLines.indexOf('  pull_request:');

  expect(pullRequestStart, 'container workflow must define a pull_request trigger').not.toBe(-1);

  const nextTriggerStart = workflowLines.findIndex(
    (line, index) => index > pullRequestStart && /^  \S/.test(line)
  );

  expect(nextTriggerStart, 'pull_request trigger must be followed by another workflow trigger').not.toBe(-1);

  return workflowLines.slice(pullRequestStart + 1, nextTriggerStart);
}

describe('container workflow pull request triggers', () => {
  it('targets the main branch', () => {
    const pullRequestLines = getPullRequestTriggerLines();

    expect(pullRequestLines).toContain('    branches:');
    expect(pullRequestLines).toContain('      - main');
  });

  it('uses path filters for pull request validation', () => {
    const pullRequestLines = getPullRequestTriggerLines();

    expect(pullRequestLines).toContain('    paths:');
  });

  it('runs only for files that can change container assembly or production dependencies', () => {
    const pullRequestLines = getPullRequestTriggerLines();
    const pathsStart = pullRequestLines.indexOf('    paths:');

    expect(pathsStart).not.toBe(-1);

    const configuredPaths = pullRequestLines
      .slice(pathsStart + 1)
      .filter(line => line.startsWith('      - '))
      .map(line => line.replace(/^      - /, '').replace(/^['"]|['"]$/g, ''));

    expect(configuredPaths).toEqual([
      'Dockerfile',
      '.dockerignore',
      'package.json',
      'package-lock.json',
      'tsconfig.json',
      '.github/workflows/container.yml',
    ]);
  });
});
