import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINIMUM_SUPPORTED_NODE_MAJOR_VERSION } from '../src/diagnostics/doctorService.js';

interface PackageManifest {
  engines?: {
    node?: string;
  };
}

interface PackageLock {
  packages?: Record<
    string,
    {
      engines?: {
        node?: string;
      };
    }
  >;
}

describe('runtime and manual setup contracts', () => {
  it('keeps the documented and packaged Node.js minimum aligned with doctor', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;
    const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8')) as PackageLock;
    const expectedEngine = `>=${MINIMUM_SUPPORTED_NODE_MAJOR_VERSION}`;
    const readme = readFileSync('README.md', 'utf8');
    const setupGuide = readFileSync('docs/setup-and-diagnostics.md', 'utf8');

    expect(MINIMUM_SUPPORTED_NODE_MAJOR_VERSION).toBe(22);
    expect(manifest.engines?.node).toBe(expectedEngine);
    expect(lockfile.packages?.['']?.engines?.node).toBe(expectedEngine);
    expect(readme).toContain('Node.js-%3E=22.0.0-339933');
    expect(readme).toContain('**Node.js**: Version 22.0.0 or higher.');
    expect(readme).toContain('TypeScript 5.x on Node.js 22+ via `tsx`');
    expect(readme).not.toContain('tested on LTS v18 and v20+');
    expect(setupGuide).toContain('Node.js 22 or newer');
  });

  it('documents Telegram whitelist values as immutable numeric user IDs only', () => {
    const envExample = readFileSync('.env.example', 'utf8');

    expect(envExample).toContain('immutable numeric Telegram User ID');
    expect(envExample).toContain('Usernames such as @username are not supported');
    expect(envExample).not.toContain('User ID or Username');
  });
});
