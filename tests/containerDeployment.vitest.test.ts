import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(process.cwd());

describe('container deployment configuration', () => {
  it('persists WhatsApp sessions, email deduplication data, and logs in Compose', () => {
    const composeContent = fs.readFileSync(path.join(repositoryRoot, 'compose.yaml'), 'utf8');

    expect(composeContent).toContain('/app/auth_session');
    expect(composeContent).toContain('/app/data');
    expect(composeContent).toContain('/app/logs');
    expect(composeContent).toContain('env_file:');
    expect(composeContent).toContain('.env');
  });

  it('prepares writable persistent directories for the non-root runtime user', () => {
    const dockerfileContent = fs.readFileSync(path.join(repositoryRoot, 'Dockerfile'), 'utf8');

    expect(dockerfileContent).toContain('/app/auth_session');
    expect(dockerfileContent).toContain('/app/data');
    expect(dockerfileContent).toContain('/app/logs');
    expect(dockerfileContent).toContain('USER node');
  });
});
