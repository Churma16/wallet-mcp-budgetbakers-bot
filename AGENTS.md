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
When creating or editing GitHub issues for this repository (`wallet_mcp`), use the appropriate issue format below. Scale detail to the work; do not require a complete design before investigation.

### 1. Mandatory Structure by Issue Type
For bug reports, include:
- `## Summary`: The problem and its user-visible impact.
- `## Steps to Reproduce`: Reproduction steps and relevant environment details. State when reproduction is not yet available; do not invent it.
- `## Expected vs. Actual Behavior`: Clearly distinguish intended and observed behavior.
- `## Acceptance Criteria`: Actionable, verifiable checklist using GitHub task list syntax (`- [ ]`).

For features and enhancements, include:
- `## Summary`: The proposed capability.
- `## Motivation / Current Limitations`: The problem or limitation motivating the work.
- `## Desired Outcome`: The behavior or capability users should gain.
- `## Acceptance Criteria`: Actionable, verifiable checklist using GitHub task list syntax (`- [ ]`).

For refactoring, performance, and documentation issues, adapt the feature format to the intended technical or documentation outcome.

Add `## Proposed Architecture & Design` and `## Proposed Implementation Plan` when complexity warrants them. Include relevant data flow, component changes, migration considerations, and risks. Distinguish proposals from confirmed findings. Unknown design decisions may be marked `To be determined during investigation`; specific files are not required before investigation. Keep simple issues concise and avoid repeating information across sections.

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

### 4. Single-Purpose Assessment & Proactive Separation Recommendation
Before creating any GitHub issue that stems from user feedback or bug reports:
- **Analyze Scope**: Evaluate whether the request contains independently deliverable outcomes. Different files or technical layers alone do not justify splitting one cohesive change.
- **Proactive Suggestion (Pre-Creation Gate)**: If distinct concerns are identified, do **NOT** immediately create a single monolithic issue. Instead:
  1. Clearly outline the separate concerns and the benefits of splitting (e.g., independent tracking, isolated PRs/commits, cleaner labeling).
  2. Propose candidate titles and label sets for each distinct issue.
  3. Prompt the user for confirmation on whether to keep them unified or split into separate issues.
- **Proceed Only After User Alignment**: Create the issue(s) according to the user's chosen structure.

## Standardized GitHub Pull Request Structure
When creating or editing GitHub Pull Requests for this repository (`wallet_mcp`), use the concise default format below and expand it when complexity warrants.

### 1. Required Default Structure
Every PR description must include:
- `## Summary`: What changed and why. Describe the resulting behavior, with a before/after example when useful.
- `## Verification`: Checks actually performed and their results. Include relevant test commands, covered scenarios, build checks, and regression results. Identify checks not run and material limitations. Never present planned or illustrative results as completed verification. Assertion counts and passing percentages are not required.
- `## Related Issues`: Use `Closes #<id>` or `Fixes #<id>` only when the PR fully resolves the issue; otherwise use `Related to #<id>`. Write `None` when no issue applies.

Add `## Detailed Changes` when reviewers need implementation context beyond the summary. Add `## Motivation & Context` when the rationale needs further explanation. Complex changes must document relevant architecture, migration or rollout considerations, and material risks; use dedicated sections when helpful. Do not repeat information or list every changed file merely to fill a template. Small changes may use one sentence per required section.

Run verification appropriate to the change, including the TypeScript build and relevant regression tests for changes that affect application code. Documentation-only changes do not require application tests or a build unless they affect executable behavior. Check changed content for forbidden raw emojis under the project's human-facing-only rule; do not require a repository-wide zero-emoji claim or an emoji declaration in every PR. Human-facing replies remain allowed.

### 2. Safe CLI Creation via `--body-file`
To prevent Windows PowerShell string truncation and backtick escaping failures:
- **NEVER** pass multiline PR descriptions inline using `gh pr create --body "..."`.
- **ALWAYS** write the complete markdown content to a temporary file (e.g. in the scratch directory) and pass it using `gh pr create --body-file <path>` or `gh pr edit <id> --body-file <path>`.

### 3. Title & Branch Parity
- PR title must follow Conventional Commits format without JIRA ID prefix (e.g., `feat(messaging): ...`, `fix(security): ...`).
- Branch names must follow standard kebab-cased format `<branch-type>/<short-kebab-description>` without JIRA prefixes.
