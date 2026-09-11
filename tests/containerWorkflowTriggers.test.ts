import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const workflowPath = path.resolve(process.cwd(), '.github/workflows/container.yml');
const workflow = readFileSync(workflowPath, 'utf8');
const workflowLines = workflow.split(/\r?\n/);

const pullRequestStart = workflowLines.indexOf('  pull_request:');
const nextTriggerStart = workflowLines.findIndex(
  (line, index) => index > pullRequestStart && /^  \S/.test(line)
);

assert.notEqual(pullRequestStart, -1, 'container workflow must define a pull_request trigger');
assert.notEqual(nextTriggerStart, -1, 'pull_request trigger must be followed by another workflow trigger');

const pullRequestLines = workflowLines.slice(pullRequestStart + 1, nextTriggerStart);

assert.ok(
  pullRequestLines.includes('    branches:') && pullRequestLines.includes('      - main'),
  'container pull request validation must target main'
);

const pathsStart = pullRequestLines.indexOf('    paths:');

assert.notEqual(pathsStart, -1, 'container pull request validation must use path filters');

const configuredPaths = pullRequestLines
  .slice(pathsStart + 1)
  .filter(line => line.startsWith('      - '))
  .map(line => line.replace(/^      - /, '').replace(/^['"]|['"]$/g, ''));

assert.deepEqual(
  configuredPaths,
  [
    'Dockerfile',
    '.dockerignore',
    'package.json',
    'package-lock.json',
    '.github/workflows/container.yml',
  ],
  'container builds must run only for files that can change container assembly or production dependencies'
);

console.log('[PASS] Container workflow limits pull request builds to container-relevant paths');
