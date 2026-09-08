# Project Rules - wallet_mcp

## Strict Emoji Boundaries (Human-Facing Only)
In this project (`wallet_mcp`), raw emojis are **strictly restricted** to human-facing communication channels:
- **Allowed Only For Human Responses**: Raw emojis (e.g., 👋, ✅, ⚠️, 📊, 📈, 💰) are permitted **only** in user-facing WhatsApp messages, chat responses, and human-facing app templates/replies.
- **Forbidden in System Outputs & Code**: Do **NOT** use emojis in:
  - Console logs (`console.log`, `console.info`, `console.debug`)
  - Console errors (`console.error`, `console.warn`)
  - Internal logger outputs (e.g. Pino)
  - Error messages, exceptions, or rejection reasons
  - Internal code logic, variable/function identifiers, and code comments
- **Standard Console Placeholders**: When logging in terminal or console, use clean text tags instead of emojis:
  - `[SUCCESS]` instead of ✅
  - `[ERROR]` instead of ❌
  - `[WARN]` instead of ⚠️
  - `[INFO]` instead of ℹ️ / 📬 / 📊
  - `[TRANSFER]` instead of 🔄
- **Precedence**: Clarifies and scopes the global "No Emojis in Codebase" rule: emojis are strictly allowed in human-facing chat/app responses only, and strictly forbidden in console logs, errors, and system output.

## Personal Project - No JIRA Required
This repository (`wallet_mcp`) is a personal project, not an enterprise/company project.
- **No JIRA ID Required**: Do not prompt the user for a JIRA ticket ID when creating/switching branches, writing commit messages, or generating PR descriptions.
- **Branch Naming**: Use standard descriptive kebab-cased branch names without JIRA ticket prefixes:
  `<branch-type>/<short-kebab-description>`
  *Examples*: `feature/email-bank-sync`, `fix/token-timeout`, `chore/update-readme`
- **Commit Messages**: Follow standard Conventional Commits format (e.g. `feat: add email bank sync`, `fix: ...`, `refactor: ...`) without `[JIRA-ID]` prefix.
- **Precedence**: This overrides the global `git-branch-commit-rules` JIRA ID requirement for this repository only.

## Standardized GitHub Issue Structure
When creating or editing GitHub issues for this repository (`wallet_mcp`), always adhere to the comprehensive 5-section specification:

### 1. Mandatory Structure
Every issue must include the following sections:
- `## Summary`: High-level overview of the feature/enhancement or bug fix.
- `## Motivation / Current Limitations`: Clear breakdown of why this change is necessary and what current architectural or behavioral bottlenecks exist.
- `## Proposed Architecture & Design`: In-depth technical approach, data flow, domain model, or interface designs.
- `## Proposed Implementation Plan`: Specific file changes divided by component layer (e.g. New Files, Modified Files, Test Coverage).
- `## Acceptance Criteria`: Actionable, verifiable checklist using GitHub task list syntax (`- [ ]`).

### 2. Safe CLI Creation via `--body-file`
To prevent Windows PowerShell string truncation and backtick escaping failures:
- **NEVER** pass multiline issue content inline using `gh issue create --body "..."`.
- **ALWAYS** write the complete markdown content to a temporary file (e.g. in the scratch directory) and pass it using `gh issue create --body-file <path>` or `gh issue edit <id> --body-file <path>`.
- **ALWAYS** include `--label "<comma-separated-labels>"` during issue creation (e.g. `gh issue create --title "..." --body-file <path> --label "enhancement,security"`). Never create an issue without labels.

### 3. Mandatory Label / Tag Assignment Policy
Every issue created or updated in this repository MUST have at least one appropriate label assigned. Follow this deterministic mapping:

#### Primary Type Labels (Mapped from Title Prefix):
- `feat(...)` / `feat:` -> `enhancement`
- `fix(...)` / `fix:` -> `bug`
- `refactor(...)` / `refactor:` -> `refactor` (and optionally `enhancement` if introducing significant structural capabilities)
- `docs(...)` / `docs:` -> `documentation`
- `perf(...)` / `perf:` -> `performance`

#### Multi-Label & Domain Criteria:
- **Security / Anti-Ban**: If the issue involves rate limiting, reconnection backoff, circuit breakers, whitelisting, credentials, or session protections, **ALWAYS** add `security` (e.g., `--label "enhancement,security"`).
- **Architectural Refactoring**: If a new feature requires decoupling god files, restructuring handlers, or migrating core abstractions, add `refactor` (e.g., `--label "enhancement,refactor"`).
- **Community Contribution**: If the issue actively requests community test cases, external bank samples, or provider benchmarks, add `help wanted`.

#### Verification Invariant:
- Before completing any issue creation or editing task, verify the issue has its labels populated via `gh issue view <id> --json labels`.

## Standardized GitHub Pull Request Structure
When creating or editing GitHub Pull Requests for this repository (`wallet_mcp`), always adhere to the 5-section specification established across merged repository PRs:

### 1. Mandatory Structure
Every PR description must include the following 5 sections:
- `## Summary`: High-level overview of what the PR accomplishes, what core problem it solves, and its primary architectural impact.
- `## Motivation & Context`: Concrete breakdown of why this change is necessary, citing previous limitations, edge cases, or vulnerability/bug behaviors.
- `## Detailed Changes` (or `## Key Changes`): Grouped by logical component (e.g. `### 1. Component Name`), listing changed files and specific mechanisms (interfaces, functions, error handling, config).
- `## Test Verification & Quality Assurance` (or `## Verification & Test Results`): Explicit evidence of verification:
  - New unit/integration test suites (names, assertion counts, passing rate).
  - TypeScript build check (`npm run build` / `tsc` clean compile).
  - Regression test suites run and results.
  - Confirmation that zero raw emojis exist in internal code or console output (using clean tags `[SUCCESS]`, `[ERROR]`, `[WARN]`, `[INFO]`).
- `## Related Issues`: Explicit issue links using closing keywords (e.g. `- Closes #<id>` or `- Fixes #<id>`).

### 2. Safe CLI Creation via `--body-file`
To prevent Windows PowerShell string truncation and backtick escaping failures:
- **NEVER** pass multiline PR descriptions inline using `gh pr create --body "..."`.
- **ALWAYS** write the complete markdown content to a temporary file (e.g. in the scratch directory) and pass it using `gh pr create --body-file <path>` or `gh pr edit <id> --body-file <path>`.

### 3. Title & Branch Parity
- PR title must follow Conventional Commits format without JIRA ID prefix (e.g., `feat(messaging): ...`, `fix(security): ...`).
- Branch names must follow standard kebab-cased format `<branch-type>/<short-kebab-description>` without JIRA prefixes.



