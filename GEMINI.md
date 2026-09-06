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
- Assign standard GitHub labels appropriately (e.g. `--label "enhancement"` or `--label "bug"`).


