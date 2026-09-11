# Development, logging, diagnostics, and releases

[Back to README](../README.md) · [Contributing guide](../CONTRIBUTING.md)

## Local checks

CI uses Node.js 22. Install locked dependencies with `npm ci`. For application changes, run:

```sh
npm run build
npm test
```

`npm run build` runs TypeScript. `npm test` runs the offline suites registered in [runOfflineTests.ts](../tests/runOfflineTests.ts), without live service credentials. Use `npm test -- --verbose` for individual test output or `npm run test:coverage` for coverage.

For documentation-only changes, check links, heading anchors, code examples, and consistency with the implementation. Report what was checked and any setup paths not tested.

Use `npm run dev` to restart on source changes. See [package.json](../package.json) for all scripts and [the contributing test guide](../CONTRIBUTING.md#testing--quality-verification) for test conventions. The runner and package scripts are the authoritative inventory; avoid relying on a fixed suite count.

## Logging and error investigation

The application writes daily files under `logs/` using the name `app-YYYY-MM-DD.log`. Standard log calls appear in both the terminal and the daily file. Terminal tags are lowercase, such as `[info]` and `[error]`; daily-file tags are uppercase, such as `[INFO]`, `[ERROR]`, `[CHAT]`, `[AI]`, `[MCP]`, and `[SECURITY]`. Detailed `fileDetail` entries go to the file without adding their payloads to the terminal.

Follow the current log while reproducing a problem:

```powershell
# Windows PowerShell
Get-Content .\logs\app-YYYY-MM-DD.log -Wait
```

```sh
# macOS / Linux
tail -f logs/app-YYYY-MM-DD.log
```

Replace the date with the local log filename. The timestamp inside each entry is ISO 8601; terminal timestamps use local `HH:mm` time.

Detailed financial payloads are disabled by default. In this mode, `fileDetail` records payload type, property names, counts, and similar metadata instead of values. If metadata is insufficient for a local investigation:

1. Set `DEBUG_FINANCIAL_PAYLOADS=true` in `.env`.
2. Restart the application and reproduce the smallest possible case.
3. Set the flag back to `false` and restart after collecting the relevant entry.
4. Remove transaction text, amounts, counterparties, account identifiers, email content, tokens, and session data before sharing logs.

Credential and account-number sanitizers remain active in debug mode, but they are safeguards rather than a guarantee that a log is safe to publish. Do not attach the entire `logs/` directory to an issue. Prefer the shortest relevant excerpt, including the timestamp, level, operation summary, and error name.

`LOG_RETENTION_DAYS` controls cleanup of files named `app-*.log`; cleanup runs when the application starts. Changing it does not delete unrelated files. See [runtime limits and logs](configuration.md#runtime-limits-and-logs) for both logging settings.

## Diagnostics and troubleshooting

Live diagnostics read `.env` and connect to external services. They may use API quota, read private data, or send a test notification. They are optional setup tools, separate from the offline suite.

| Command | What it does |
| --- | --- |
| `npm run test:mcp:live` | Checks Wallet credentials and reads profile, accounts, and categories |
| `npm run test:ai:live` | Exercises the configured AI provider with sample extraction requests |
| `npm run test:gemini:live` | Exercises Gemini extraction |
| `npm run test:email:live` | Checks IMAP credentials and inbox connectivity |
| `npm run test:email-gate-live` | Fetches actual inbox messages and evaluates email rules |
| `npm run test:telegram:live` | Checks the bot token and sends a test message to the configured user |

Review each script under [tests/](../tests/) before running it against a private account. Use the final diagnostic output as well as the exit status when evaluating success.

| Symptom | Check |
| --- | --- |
| Installation fails on an older runtime | Use Node.js 22, matching CI; the AI and WhatsApp dependencies require at least Node.js 20. |
| Wallet queries fail | Verify the endpoint, token, and read scopes with the MCP diagnostic. |
| AI extraction fails | Check the selected model ID, credential, quota, and timeout. Receipt models must accept images. |
| WhatsApp starts during Telegram setup | Set `ENABLED_MESSENGER_CHANNELS=telegram` and clear the template's sample `ALLOWED_PHONE_NUMBER`. |
| Telegram notifications fail | Use a numeric user ID and start a private conversation with the bot first. |
| An email is missing | Check that sync is enabled, the message is within the startup lookback, and its format matches a bank rule. Already processed message IDs are skipped; deduplication does not restore tickets lost on restart. |
| Pending tickets disappear | Unprocessed tickets expire after 24 hours. All ticket states are lost on restart. |
| A confirmation cannot be retried | It may be processing or have an uncertain write outcome. Inspect Wallet and reconcile manually before cancelling or entering a replacement transaction. |

## Release workflows

The repository also includes a [Dockerfile](../Dockerfile) and a [container workflow](../.github/workflows/container.yml). The workflow builds on pull requests and can publish images to GHCR on pushes or manual runs. Container operation was not live-tested as part of this documentation update.

The repository uses Conventional Commits to describe changes. See [commit conventions](../CONTRIBUTING.md#commit-message-conventions) for types and examples.

### CI

[ci.yml](../.github/workflows/ci.yml) builds and runs offline tests for pull requests targeting `main`, qualifying pushes to `main`, and manual runs. Its push trigger ignores README, changelog, and license-only changes. Passing CI verifies the checked scenarios, not every live integration.

### Snapshots

[snapshot-release.yml](../.github/workflows/snapshot-release.yml) builds and tests before publishing a GitHub prerelease tagged `v<version>-snapshot.<short-sha>`. It runs on qualifying pushes to `main` and can be dispatched manually. Path filters and release-commit exclusions mean not every push creates a snapshot.

### Stable releases

Maintainers run [manual-release.yml](../.github/workflows/manual-release.yml) from GitHub Actions using **Run workflow**, selecting `main` for a normal release.

The workflow accepts an automatic or explicit patch/minor/major bump and a dry-run option. It installs dependencies, builds, tests, generates the version/changelog update, pushes the release commit and tag, and publishes release notes. Dry-run mode skips pushing and publication. The workflow acts on the selected branch, so check the branch before dispatching it.
