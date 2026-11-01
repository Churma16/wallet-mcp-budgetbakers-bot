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

### 4. SonarCloud and PR Verification via GitHub CLI (No curl)
When inspecting SonarCloud status, quality gate results, or review feedback on Pull Requests:
- **Use GitHub CLI Only**: Always inspect PR comments, review feedback, and status check details via `gh pr view <pr> --comments` and `gh pr checks <pr>`.
- **No curl to SonarCloud**: Do not make raw HTTP/curl requests directly to `sonarcloud.io` or external API endpoints. The SonarCloud GitHub integration automatically posts Quality Gate results and line annotations directly to the PR discussion.

## MCP Capability and Protocol Audit Before Implementation
For changes to Wallet-domain operations, Wallet MCP adapters, capability/tool discovery, generic MCP transport/protocol plumbing, or Wallet metadata sources of truth, audit upstream capabilities before adding local behavior. This operationalizes the native-first architecture in #121, typed capability discovery in #163, and official-client migration in #165 without duplicating those designs.

### 1. Required Capability Audit
Before implementation:
1. Inspect the current repository adapter and its existing contracts.
2. Inspect current Wallet MCP tools and schemas for relevant native filtering/search, aggregation/grouping, transfers, CRUD, entity/reference access, metadata, rollback, and delete behavior.
3. When transport or protocol behavior is involved, inspect the current official MCP SDK/protocol support for transport, protocol-version negotiation, tool discovery and invocation, lifecycle, and session mechanics.
4. Verify ambiguous contracts with focused documentation, contract, or test evidence before adding a broad fallback. Live external checks must remain explicit and outside default CI.

A missing method in `WalletMcpClientService` or another application wrapper does not prove that Wallet MCP lacks the capability. Likewise, needing an MCP request does not justify hand-building generic JSON-RPC or transport plumbing.

### 2. Native and Authoritative Sources First
- Prefer a native Wallet operation when it satisfies the required contract.
- Prefer official MCP SDK/protocol abstractions when they satisfy transport or protocol requirements; do not build a second generic MCP client without a demonstrated gap.
- Preserve and use authoritative Wallet metadata rather than maintaining duplicate canonical registries or recomputing source-of-truth state where appropriate. This includes category hierarchy/group/assignability, bank-sync/source, budget/aggregation, profile base-currency/readiness, and bounded typed-consumer metadata.
- Retain local compatibility behavior only for a specific, documented upstream or SDK gap, and keep the shim as narrow as that evidence permits.

Application-owned human-language aliases, validation, safety policy, and presentation remain valid. Native-first behavior must preserve deterministic sender authorization, trusted-entity validation, pending/confirmation state, `UNKNOWN` handling, reconciliation, correlation/deduplication policy, and semantic tool allowlists; capability discovery must not automatically expose every advertised tool to the LLM.

### 3. Scope and PR Evidence
Do not apply this audit to unrelated presentation-only messaging, localization, logging unrelated to MCP transport, CI/test-runner migration, or email transport work that does not change Wallet semantics.

For relevant PRs, record a concise decision such as the native Wallet capability and official protocol layer used, whether local compatibility remains, or the concrete gap and evidence that justify a bounded shim. Do not require this note, a live Wallet call, or live external-service testing for unrelated PRs.

## Vitest Invariant for Hermetic Test Suites
Following the Vitest cutover (Issues #113 & #140), all hermetic unit, integration, and regression test suites in this repository MUST be authored directly in Vitest:
- **File Naming & Discovery**: Hermetic test files must be named `tests/**/*.vitest.test.ts` to match the include pattern in `vitest.config.ts`.
- **Test Authoring API**: Import and use Vitest APIs explicitly (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach` from `'vitest'`). Do not write custom procedural runners or ad-hoc scripts.
- **Execution**: Run with `npm test`, `npm run test:vitest`, or `npx vitest run tests/<filename>.vitest.test.ts`.
- **Legacy Runner Retired**: The legacy `tests/runOfflineTests.ts` runner has been completely retired and removed. All offline suites execute through Vitest.
- **Verification Requirement**: PRs introducing new capabilities or refactorings must verify `npm test` and `npm run build`.

## Complexity-Based Handler & File Splitting Guidelines
To maintain codebase maintainability without premature fragmentation or unnecessary navigation overhead:
- **Co-locate Thin Wrappers**: Group simple, thin delegating handlers (typically <= ~50 lines with no complex business logic, no heavy dependencies, and identical structural patterns—e.g. read-only forwarders like `CHECK_BALANCE`, `CHECK_BUDGET`, `HELP_MENU`) into a single cohesive file (e.g. `readActionHandlers.ts`).
- **Separate Dedicated Files for Complex Workflows**: Extract a handler/class into its own dedicated file ONLY when it is non-trivial (e.g., > ~50 lines, has multi-step validation, manages clarification/draft states, calls preparation/side-effect services, or possesses unique heavy dependencies like `createRecordActionHandler.ts`).
- **Pragmatic Evolution**: Keep read-only actions consolidated until an individual action grows substantial independent logic (e.g., advanced filtering, pagination UI, or export capabilities), at which point it may be extracted into its own file.

## Remote Container & Production Log Inspection
When asked to inspect, stream, debug, or analyze remote logs, errors, AI decisions, or container activity for Wallet MCP running on the VPS:
- **Mandatory Skill**: Use the `churma-wallet-mcp-logs` skill.
- **Execution Mechanism**: Run commands via the local SSH alias `vps`:
  `ssh vps "sudo -n /usr/local/sbin/wallet-mcp-logs <since> <lines>"`
- **Allowed Parameters**:
  - `<since>`: `5m`, `15m`, `30m`, `1h`, `2h`, `6h`, `12h`, `24h`
  - `<lines>`: integer between `1` and `5000` (default: 50, max recommended: 200)
- **Strict Permissions Guardrail**: Do not attempt direct `docker logs`, Docker socket access, or connecting as `root`. The VPS uses a hardened, least-privilege setup where only the `codex-observer` user executes the dedicated `/usr/local/sbin/wallet-mcp-logs` helper script via passwordless sudo.
- **Read-Only Invariant**: Log inspection is strictly read-only. Never run `docker restart`, `systemctl`, or container mutation commands unless explicitly commanded by the user.

## Mandatory Class Documentation (TSDoc)
All classes (services, handlers, adapters, controllers, clients, and utilities) in this repository must have a top-level TSDoc comment block (`/** ... */`) immediately preceding the class declaration:
- **Core Purpose & Responsibility**: Briefly summarize what the class does and the specific problem/domain it manages.
- **Architectural Role**: Note key collaborators or dependencies (e.g. MCP client, repository, state store) when relevant.
- **Formatting Standard**: Follow standard TSDoc/JSDoc format (`/** ... */`).
- **Emoji Boundary Compliance**: In accordance with the project's strict emoji rule, TSDoc comments must NOT contain raw emojis (use descriptive text placeholders like `[INFO]`, `[WARN]`, or `[ERROR]` if necessary).
- **Public Methods**: Recommended (optional for self-explanatory methods, required for complex business workflows or public API interfaces).

### Example:
```typescript
/**
 * Coordinates transaction record creation workflows, performing multi-step validation,
 * draft resolution, and delegation to the upstream Wallet MCP client.
 */
export class CreateRecordActionHandler {
  // ...
}
```




## Vertical Domain Architecture & Directory Boundaries
The codebase is strictly structured into vertical domain slices and cross-cutting infrastructure. All new files, refactors, and feature additions MUST adhere to the following directory boundaries and rules:

### 1. Canonical System Map (`src/` Root Invariant)
The root `src/` directory must strictly contain only the authorized domains below:

```text
src/
├── app.ts                 # Thin composition root (context assembly + pipeline dispatching)
├── brain/                 # AI Domain: providers, prompts, parsers, clarification, fast path
├── cli/                   # Tooling: doctor diagnostics, setup wizard, env editor
├── config/                # Shared: application & environment configuration schemas
├── core/                  # Orchestration: shared context, message pipeline, action handlers, pending states
├── email/                 # Email Domain: IMAP listener, bank rules, transaction correlation
├── gateway/               # Gateway Domain: WhatsApp, Telegram, Console messaging adapters & coordinator
├── i18n/                  # Localization: dictionaries (en, id) and human message formatters
├── lib/                   # Infrastructure: domain-agnostic utilities (logger, resilience, textCasing)
├── wallet/                # Wallet Domain: BudgetBakers MCP client, records, history, summary, cache
└── index.ts               # Application entry point and process lifecycle/shutdown
```

### 2. Forbidden Horizontal Layers
Never create or re-introduce horizontal layer folders at the `src/` root:
- **Forbidden**: `src/actions/`, `src/handlers/`, `src/services/`, `src/constants/`, `src/utils/`, `src/types/`, `src/diagnostics/`, `src/setup/`.
- Logic must always be assigned to its respective domain slice (`wallet/`, `brain/`, `email/`, `gateway/`, `core/`, or `cli/`).

### 3. Type & Interface Colocation
- Types and interfaces MUST be co-located within their relevant domain slice (e.g., `src/wallet/types.ts`, `src/brain/types.ts`, or local to the specific module).
- Do NOT create a global `src/types/` directory.

### 4. Domain Barrel Exports & Encapsulation Boundary
- Top-level domain slices (`wallet/`, `brain/`, `core/`, etc.) MUST maintain an `index.ts` that acts as the authoritative public API boundary for that domain.
- External domains, gateway adapters, and integration test suites MUST import from the domain's root entrypoint (`../src/wallet/index.js` or `../src/brain/index.js`), rather than deep-linking into private subfolders (e.g. avoid `../src/wallet/records/records.js` or `../src/brain/parsers/amountParser.js` from outside the domain unless executing an isolated white-box unit test of that pure module).

### 5. 1-Level Thematic Subfolder Cap
- In large domains (`wallet/`, `brain/`, `core/`), organize related files into 1-level thematic subfolders (e.g., `wallet/mcp/`, `wallet/records/`, `brain/parsers/`, `core/handlers/`).
- Do NOT nest deeper than 1 level of subfolders inside any domain (avoid `domain/sub1/sub2/...`).
- Small domains (`cli/`, `email/`, `gateway/`, `config/`, `lib/`) should remain flat unless complexity warrants grouping.

### 6. Infrastructure Cleanliness (`src/lib/`)
- `src/lib/` is reserved strictly for cross-cutting, domain-agnostic technical utilities (e.g., Pino logging, resilience exponential backoff, casing and digit formatters).
- Zero business logic, zero financial entities, and zero AI orchestration are permitted in `src/lib/`.

### 7. Thin Composition Root (`src/app.ts`)
- `src/app.ts` must remain a thin composition root responsible only for wiring configuration, assembling context, and binding messaging gateway adapters.
- Avoid multi-parameter constructor injection chains (anti-pattern: passing 20+ service fields). Domain operations and state must be encapsulated, executing message processing pipelines linearly through dedicated dispatching abstractions.
