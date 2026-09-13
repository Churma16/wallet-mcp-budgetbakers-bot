import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function getWorkflowContent(): string {
  const workflowPath = path.resolve(process.cwd(), '.github/workflows/container.yml');
  return readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
}

function getPullRequestTriggerLines(): string[] {
  const workflowLines = getWorkflowContent().split(/\r?\n/);
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

describe('container workflow manual GHCR promotions', () => {
  it('exposes explicit latest and stable channels plus a stable version input', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain('  workflow_dispatch:');
    expect(workflowContent).toContain("      channel:\n        description: 'Mutable GHCR alias to publish'");
    expect(workflowContent).toContain("          - 'latest'");
    expect(workflowContent).toContain("          - 'stable'");
    expect(workflowContent).toContain('      version:');
  });

  it('validates stable promotions before checkout or publishing', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain('if [[ -z "$VERSION" ]]; then');
    expect(workflowContent).toContain('if [[ ! "$VERSION" =~ ^v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]; then');
    expect(workflowContent).toContain('git ls-remote --exit-code --refs');
    expect(workflowContent).toContain('"refs/tags/${VERSION}"');
  });

  it('builds main for latest and the fully qualified requested version tag for stable', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain('Checkout latest main revision');
    expect(workflowContent).toContain('ref: main');
    expect(workflowContent).toContain('Checkout stable release revision');
    expect(workflowContent).toContain('ref: refs/tags/${{ inputs.version }}');
  });

  it('derives the immutable SHA tag from the checked-out source commit', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain('git rev-parse --short=7 HEAD');
    expect(workflowContent).toContain('type=raw,value=sha-${{ steps.source.outputs.short_sha }}');
  });

  it('publishes mutable aliases only for the selected manual channel', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain(
      "type=raw,value=latest,enable=${{ github.event_name == 'workflow_dispatch' && inputs.channel == 'latest' }}"
    );
    expect(workflowContent).toContain(
      "type=raw,value=stable,enable=${{ github.event_name == 'workflow_dispatch' && inputs.channel == 'stable' }}"
    );
    expect(workflowContent).toContain(
      "type=raw,value=${{ inputs.version || 'unused-stable-version' }},enable=${{ github.event_name == 'workflow_dispatch' && inputs.channel == 'stable' }}"
    );
  });

  it('preserves tag publishing, pull request non-publishing, and Docker cache behavior', () => {
    const workflowContent = getWorkflowContent();

    expect(workflowContent).toContain('type=ref,event=tag');
    expect(workflowContent).toContain("push: ${{ github.event_name != 'pull_request' }}");
    expect(workflowContent).toContain('cache-from: type=gha');
    expect(workflowContent).toContain('cache-to: type=gha,mode=max');
  });
});
