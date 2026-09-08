import fs from 'node:fs';
import https from 'node:https';
import { execSync } from 'node:child_process';

const repository = process.env.GITHUB_REPOSITORY || '';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const tagName = process.env.TAG_NAME || '';
const outputFile = process.env.OUTPUT_FILE || 'release-notes.md';
const version = tagName.replace(/^v/, '');

function requestGitHub(path) {
  if (!repository) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${repository}${path}`,
      headers: {
        'User-Agent': 'wallet-mcp-release-notes-generator',
        ...(token ? { Authorization: `token ${token}` } : {})
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    }).on('error', (err) => {
      console.warn(`[WARN] GitHub API request error: ${err.message}`);
      resolve(null);
    });
  });
}

async function generateReleaseNotes() {
  console.log(`[INFO] Generating release notes for tag: ${tagName || '(none specified)'}`);
  let releaseBody = '';

  // 1. Extract version section from CHANGELOG.md if present
  if (fs.existsSync('CHANGELOG.md') && version) {
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n/g, '\n');
    const escapedVersion = version.replace(/\./g, '\\.');
    const regex = new RegExp(`(?:^|\\n)##\\s*\\[?${escapedVersion}[\\]\\s][^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)`);
    const match = changelog.match(regex);
    if (match && match[1].trim()) {
      releaseBody = match[1].trim();
    }
  }

  // 2. Extract commit and PR history for this version
  const contributors = new Set();
  const changelogEntries = [];

  if (tagName) {
    try {
      let prevTag = '';
      try {
        prevTag = execSync(`git describe --tags --abbrev=0 "${tagName}^" 2>/dev/null || true`, {
          encoding: 'utf8'
        }).trim();
      } catch {
        prevTag = '';
      }

      const revRange = prevTag ? `${prevTag}..${tagName}` : tagName;
      console.log(`[INFO] Comparing commit range: ${revRange}`);

      const rawCommits = execSync(`git log --pretty=format:"%h%x09%an%x09%s" ${revRange}`, {
        encoding: 'utf8'
      }).trim();

      if (rawCommits) {
        const commitLines = rawCommits.split('\n').filter(Boolean);

        for (const line of commitLines) {
          const parts = line.split('\t');
          const hash = parts[0];
          const authorName = parts[1];
          const subject = parts.slice(2).join('\t');

          // Skip automated release commits
          if (subject.startsWith('chore(release):') || subject.startsWith('chore(main): release')) {
            continue;
          }

          // Check if commit came from a PR (e.g., #13 or (#13))
          const prMatch = subject.match(/\(#?(\d+)\)|#(\d+)/);
          if (prMatch) {
            const prNumber = prMatch[1] || prMatch[2];
            const prData = await requestGitHub(`/pulls/${prNumber}`);
            const authorLogin = prData && prData.user ? prData.user.login : null;

            if (authorLogin) {
              contributors.add(`@${authorLogin}`);
              changelogEntries.push(`* ${subject} by @${authorLogin} in #${prNumber}`);
            } else {
              changelogEntries.push(`* ${subject} in #${prNumber}`);
            }
          } else {
            // Direct commit
            const commitData = await requestGitHub(`/commits/${hash}`);
            const authorLogin = commitData && commitData.author ? commitData.author.login : null;

            if (authorLogin) {
              contributors.add(`@${authorLogin}`);
              changelogEntries.push(`* ${subject} by @${authorLogin} (${hash})`);
            } else {
              changelogEntries.push(`* ${subject} by ${authorName} (${hash})`);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`[WARN] Could not retrieve commit details: ${error.message}`);
    }
  }

  // 3. Assemble release notes document
  let finalNotes = '';

  if (releaseBody) {
    finalNotes += `${releaseBody}\n\n`;
  }

  if (changelogEntries.length > 0) {
    finalNotes += `### What's Changed\n\n${changelogEntries.join('\n')}\n\n`;
  }

  if (contributors.size > 0) {
    finalNotes += `### Contributors\n\n${Array.from(contributors).join(', ')}\n`;
  }

  const outputContent = finalNotes.trim() || 'No notable changes recorded.';
  fs.writeFileSync(outputFile, outputContent);
  console.log(`[SUCCESS] Release notes written to ${outputFile}`);
}

generateReleaseNotes().catch((error) => {
  console.error(`[ERROR] Failed to generate release notes: ${error.message}`);
  fs.writeFileSync(outputFile, 'No notable changes recorded.');
});
