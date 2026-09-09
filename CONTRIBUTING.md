# Contributing Guide

Thank you for your interest in contributing to the **AI Bookkeeper for BudgetBakers Wallet**! We welcome contributions from the community, whether you are adding new features, improving existing architectures through refactoring, or expanding test coverage.

Please take a few moments to review this guide before submitting your pull requests.

---

## Table of Contents

- [Getting Started](#getting-started)
  - [Finding an Issue & Claiming Workflow](#finding-an-issue--claiming-workflow)
- [Branching Strategy](#branching-strategy)
- [Development Guidelines](#development-guidelines)
  - [Developing New Features](#1-developing-new-features)
  - [Code Refactoring](#2-code-refactoring)
  - [Coding Standards & Best Practices](#3-coding-standards--best-practices)
  - [AI-Assisted Contributions (AI Agents Welcome)](#4-ai-assisted-contributions-ai-agents-welcome)
- [Testing & Quality Verification](#testing--quality-verification)
- [Commit Message Conventions](#commit-message-conventions)
- [Pull Request Process](#pull-request-process)

---

## Getting Started

### Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **Package Manager**: npm (bundled with Node.js)
- **TypeScript**: 5.x (executed seamlessly via `tsx`)

### Local Setup

1. **Fork and clone** the repository:
   ```bash
   git clone https://github.com/<your-username>/wallet-mcp-budgetbakers-bot.git
   cd wallet-mcp-budgetbakers-bot
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Set up local environment**:
   ```bash
   cp .env.example .env
   ```
   Fill in your development credentials (e.g. `GEMINI_API_KEY`, `WALLET_MCP_ACCESS_TOKEN`). You can run in test mode using diagnostic scripts without spinning up live messaging sessions.

4. **Verify initial build**:
   ```bash
   npm run build
   ```

### Finding an Issue & Claiming Workflow

To prevent duplicate effort and make sure maintainers know who is working on what, please claim an issue before you start coding:

1. **Discover a task**: You are welcome to take on **any open, unassigned issue** across the repository!
   - For first-time contributors, we recommend starting with [`good first issue`](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) (small, well-scoped tasks).
   - Check [`help wanted`](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) for areas where community assistance is actively requested.
   - Experienced contributors are free to claim any other open `bug`, `enhancement`, or `refactor` issue, or propose a new capability via an issue or [GitHub Discussions](https://github.com/Churma16/wallet-mcp-budgetbakers-bot/discussions).
2. **Read the issue** carefully and make sure you understand the requested scope and acceptance criteria.
3. **Comment on the issue** to express interest, briefly outline your intended approach (especially for larger features or refactoring), and request assignment before writing code.
4. **Wait for assignment** by a maintainer. Once assigned, create your feature branch following the [Branching Strategy](#branching-strategy) and begin implementation.

> [!IMPORTANT]
> Please do not start coding or open a pull request for an issue that has not been assigned to you. Working on unassigned issues risks duplicate effort and conflicting pull requests.

---

## Branching Strategy

This project uses standard, descriptive kebab-cased branch names. Keep branch names concise and self-explanatory:

```
<branch-type>/<short-kebab-description>
```

### Branch Types

| Type | Purpose | Example |
| :--- | :--- | :--- |
| `feature/` | Introducing new functionality or integrations | `feature/export-csv-reports` |
| `refactor/` | Code structure improvements without behavioral changes | `refactor/unify-prompt-builder` |
| `fix/` | Bug fixes and edge case resolutions | `fix/currency-rounding-error` |
| `test/` | Adding missing tests or improving test coverage | `test/add-email-gate-scenarios` |
| `docs/` | Documentation updates and examples | `docs/update-contributing-guide` |
| `chore/` | Build scripts, dependencies, or maintenance tasks | `chore/bump-dependencies` |

Always branch off the latest `main` branch:
```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```

---

## Development Guidelines

### 1. Developing New Features

When introducing a new feature, consider the modular architecture of the codebase:

- **Provider & Channel Agnosticism**:
  - Keep messaging logic decoupled from specific platforms. Use the interfaces in `src/services/messaging/types.ts` so features work across both WhatsApp (`baileys`) and Telegram (`grammy`).
  - Keep AI logic decoupled across providers. Interface through `src/services/ai/financialAiProvider.ts` and construct prompts in `src/services/ai/aiPromptBuilder.ts`.
- **Internationalization (i18n)**:
  - Never hardcode user-facing strings in source files or service methods.
  - Add all new response texts, receipt templates, and error messages to both dictionaries:
    - Indonesian: `src/i18n/locales/id.ts`
    - English: `src/i18n/locales/en.ts`
  - Update `src/i18n/types.ts` to maintain strict key parity between languages.
- **Account-Aware Multi-Currency**:
  - When outputting financial values, look up the target account's configured currency code (`account.currency`).
  - Utilize the helper functions in `src/utils/humanResponseFormatter.ts` to ensure consistent currency symbols and decimal precision (e.g., zero decimals for `IDR`, two decimals for `USD`/`EUR`).
- **Fast-Path Optimization (Zero-Token)**:
  - If a user command or confirmation pattern can be determined deterministically (such as simple commands, cancellations, or ticket numbers), route it through `src/utils/fastPathIntentDetector.ts` to conserve AI tokens and reduce response latency.

### 2. Code Refactoring

Refactoring efforts should improve maintainability, performance, and readability while preserving existing behavior:

- **Preserve Contracts**: Ensure external interfaces (MCP client endpoints, gateway dispatch methods, and fast-path parser outputs) remain backward-compatible.
- **Centralize Common Logic**: Shared routines (e.g. prompt construction, error formatting, currency mapping) should reside in dedicated utility or service files rather than being duplicated across adapters.
- **Run Regressions**: Always run all diagnostic scripts after refactoring to ensure no regressions were introduced.

### 3. Coding Standards & Best Practices

- **Strict Emoji Boundaries**:
  - **Forbidden in System Logic & Logs**: Do not insert raw emoji characters into `console.log`, `console.error`, error messages, internal exceptions, code comments, or identifiers.
  - **Allowed in Human-Facing Output Only**: Emojis are strictly permitted in user-facing WhatsApp and Telegram templates (e.g., in `src/i18n/locales/`).
  - **Console Logging Placeholders**: Use clean text placeholders in logs:
    - `[SUCCESS]` instead of checkmark emojis
    - `[ERROR]` instead of cross emojis
    - `[WARN]` instead of warning signs
    - `[INFO]` instead of info symbols
    - `[TRANSFER]` instead of refresh or cycle icons
- **Descriptive Naming Conventions**:
  - Avoid cryptic abbreviations (e.g., use `userTransactionRecord` instead of `trxRec`, `availableAccountList` instead of `accs`).
  - Function and variable names should clearly express their intent and context.
- **TypeScript Type Safety**:
  - Maintain `strict: true` compliance.
  - Avoid `any` types; define explicit interfaces or types under `src/types/` or co-located with the module.
- **Environment Variables**:
  - Never hardcode configurable parameters, URLs, credentials, or keys.
  - Define new variables in `src/config/environmentConfig.ts` with validation and provide documentation in `.env.example`.
- **File Naming Conventions**:
  - Use `camelCase.ts` consistently across all production source files and test suites.
  - Suffix roles clearly by responsibility layer:
    - `*Service.ts`: Core business logic, cache management, and protocol orchestration (e.g. `walletMcpService.ts`, `walletCacheService.ts`, `pendingTransactionService.ts`).
    - `*Handler.ts`: Inbound message, action, or command event routing (e.g. `userMessageHandler.ts`, `fastPathHandler.ts`).
    - `*Adapter.ts`: Messaging transport drivers (e.g. `whatsappAdapter.ts`, `telegramAdapter.ts`).
    - `*Evaluator.ts` / `*Detector.ts` / `*Validator.ts` / `*Formatter.ts` / `*Helper.ts`: Pure functional utilities and transformations.
    - `*Rules.ts` / `*Config.ts`: Declarative configurations and domain rule specifications.
  - Multi-word brand and protocol names in identifiers are formatted in standard lowercase camelCase (e.g., `whatsapp`, `gmail`, `imap`).
  - Unit test files maintain 1-to-1 parity with their target source module: `<sourceModuleName>.test.ts` (e.g. `walletMcpService.test.ts`, `humanResponseFormatter.test.ts`, `geminiAiProvider.test.ts`).

### 4. AI-Assisted Contributions (AI Agents Welcome)

This repository welcomes contributions produced with the help of modern AI coding assistants and agents (e.g., Cursor, Claude Code, GitHub Copilot, Gemini CLI, Antigravity, Aider). AI-generated code is held to the exact same review bar as human-written code. If you use an AI agent, honor these guardrails:

- **Human Code Ownership**: You are responsible for the code you submit. Read, understand, and be able to explain every part of the diff. Never blindly accept generated output.
- **No Hallucinated Dependencies**: Only use libraries already present in `package.json`, or add new ones intentionally with clear justification. Never reference packages, APIs, or configuration options that do not actually exist in this repository or its dependencies.
- **Mandatory Local Verification**: Before submitting a pull request, both of the following must pass cleanly:
  ```bash
  npm run build
  npm test
  ```
  The build must compile without errors and all 14 offline hermetic test suites must pass.
- **Rule Adherence**: Ensure generated code follows repository conventions, including the [Strict Emoji Boundaries](#3-coding-standards--best-practices) (no raw emojis in code, console logs, or documentation), descriptive naming, camelCase file names, strict TypeScript types, and the i18n requirements described earlier in this guide.

---

## Testing & Quality Verification

Before submitting code, ensure that your changes compile and pass all automated test suites.

### Standard Test Command

Run the unified offline test runner:
```bash
npm test
# or with verbose sub-test output:
npm test -- --verbose
```
This command executes all 14 hermetic offline test suites in sequence. It requires no live network calls, active credentials, or running MCP instances, making it completely deterministic and safe for local development and CI pipelines.

### Test Suites Overview

#### 1. Automated Offline Test Suites (Hermetic & Mocked)
These test suites run automatically as part of `npm test` and require no `.env` credentials:

| Script | Test Target | Description |
| :--- | :--- | :--- |
| `npm test` | All 14 Suites | Executes all hermetic test suites sequentially with execution summary |
| `npm run test:format` | `tests/messageFormatHelper.test.ts` | WhatsApp markdown to Telegram HTML conversion & escaping |
| `npm run test:formatter` | `tests/humanResponseFormatter.test.ts` | WhatsApp confirmation & balance response templates |
| `npm run test:i18n` | `tests/responseDictionary.test.ts` | Multi-language dictionary key parity (Indonesian/English) |
| `npm run test:budget` | `tests/budgetParsing.test.ts` | Budget metric parsing from spending.current & closed filter |
| `npm run test:email-rules` | `tests/bankEmailRules.test.ts` | Bank email Gate 1 parsing rules & confirmation intent detector |
| `npm run test:ai-fallback` | `tests/fallbackAiProvider.test.ts` | Cascading multi-provider failover (429/503) & error classification |
| `npm run test:whatsapp-safeguards` | `tests/whatsappSafeguards.test.ts` | WhatsApp exponential backoff, circuit breaker & ban protections |
| `npm run test:whatsapp-hardening` | `tests/whatsappSocketHardening.test.ts` | Baileys socket options & typing presence debouncing |
| `npm run test:telegram-safeguards` | `tests/telegramSafeguards.test.ts` | Telegram rate limiting & unauthorized user whitelist gates |
| `npm run test:media-limits` | `tests/mediaDownloadLimits.test.ts` | Inbound media download size limits & buffer exhaustion defense |
| `npm run test:gateway-resilience` | `tests/messagingGatewayResilience.test.ts` | Multi-adapter gateway lifecycle, degraded mode & background reconnection |
| `npm run test:redaction` | `tests/loggerRedaction.test.ts` | Credential redaction for tokens, passwords, and secrets |
| `npm run test:sanitizer` | `tests/loggerSanitizer.test.ts` | Bank account number and PAN masking & circular reference safety |
| `npm run test:receipt-ocr` | `tests/receiptOcrPrompt.test.ts` | Receipt vision OCR system instructions, timezone offset & QRIS rules |

#### 2. Live Diagnostic Scripts (Require Active `.env` Credentials)
These scripts connect to real third-party endpoints and are intended for manual diagnostics during local setup:

| Script | Required `.env` Variables | Purpose |
| :--- | :--- | :--- |
| `npm run test:mcp:live` | `WALLET_MCP_ACCESS_TOKEN` | Tests connectivity and queries accounts/categories from BudgetBakers MCP |
| `npm run test:ai:live` | `GEMINI_API_KEY` / `OPENAI_API_KEY` | Tests live LLM NLU extraction with real API queries |
| `npm run test:gemini:live` | `GEMINI_API_KEY` | Tests live Google Gemini provider integration |
| `npm run test:email:live` | `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASSWORD` | Tests Gmail IMAP connection and INBOX capabilities |
| `npm run test:email-gate-live` | `EMAIL_IMAP_USER`, `EMAIL_IMAP_PASSWORD` | Fetches real bank emails from INBOX and evaluates through Gate 1 |
| `npm run test:telegram:live` | `TELEGRAM_BOT_TOKEN` | Validates Telegram bot token authorization and message dispatch |

#### 3. Type Checking & Build Verification
```bash
npm run build
```
Compiles TypeScript source code (`tsc`) to verify strict type compliance across all components.

### Adding New Tests

- When introducing a new feature, utility, or safeguard, add a corresponding test suite under `tests/` following the naming convention `<targetModule>.test.ts`.
- If the test is hermetic and mocked, register it in `OFFLINE_TEST_SUITES` in `tests/runOfflineTests.ts` so it is automatically included in `npm test`.
- Ensure all tests exit cleanly with status code `0` on success and code `1` on failure.

---

## Commit Message Conventions

This repository follows the [Conventional Commits](https://www.conventionalcommits.org/) specification for clear, readable project history and automated release changelog generation.

### Commit Format

```
<type>(<optional-scope>): <description>
```

### Supported Types

- `feat`: A new feature for the application
- `fix`: A bug fix
- `refactor`: A code change that neither fixes a bug nor adds a feature
- `test`: Adding missing tests or correcting existing tests
- `docs`: Documentation changes only
- `perf`: A code change that improves performance
- `chore`: Changes to build processes, auxiliary tools, or libraries

### Examples

- `feat(i18n): support spanish response dictionary`
- `refactor(ai): centralize prompt builder across providers`
- `fix(currency): handle fractional decimal precision for eur accounts`
- `test(rules): add test cases for gopay transaction emails`
- `docs: update contributing guide with testing workflows`

---

## Pull Request Process

Pull requests must target `main`, keep a focused scope, and pass the mandatory CI checks (`npm run build` plus all 14 offline hermetic test suites). The repository ships an automated pull request template at `.github/pull_request_template.md` that pre-fills the required structure below whenever a new PR is opened on GitHub.

1. **Keep Pull Requests Focused**: Limit a single PR to one feature, fix, or cohesive refactoring task. If an issue spans multiple distinct concerns, propose splitting it into separate, reviewable PRs.
2. **Work on Assigned Issues Only**: Implement only issues assigned to you. See [Finding an Issue & Claiming Workflow](#finding-an-issue--claiming-workflow).
3. **Verify Locally**: Ensure `npm run build` and `npm test` (all 14 offline hermetic suites) pass before pushing, along with any additional `npm run test:*` scripts relevant to the areas you changed.
4. **Use the Mandatory 5-Section PR Description**: Every PR description must contain the following sections (mirroring `.github/pull_request_template.md`):
   - **`## Summary`**: High-level overview of what the PR accomplishes and the core problem it solves.
   - **`## Motivation & Context`**: Why the change is necessary, citing previous limitations, edge cases, or the bug being addressed.
   - **`## Detailed Changes`**: Changes grouped by logical component, listing the files touched and the specific mechanisms involved (interfaces, functions, error handling, configuration).
   - **`## Test Verification & Quality Assurance`**: Explicit verification evidence - the test suites executed and their results, the TypeScript build check, and confirmation that zero raw emojis exist in internal code or console output.
   - **`## Related Issues`**: Links to related issues using closing keywords (e.g., `Closes #123`, `Fixes #456`).
5. **Code Review**: Address reviewer feedback promptly. Once approved, commits will be squashed or merged into `main`.
