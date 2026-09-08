# Contributing Guide

Thank you for your interest in contributing to the **AI Bookkeeper for BudgetBakers Wallet**! We welcome contributions from the community, whether you are adding new features, improving existing architectures through refactoring, or expanding test coverage.

Please take a few moments to review this guide before submitting your pull requests.

---

## Table of Contents

- [Getting Started](#getting-started)
- [Branching Strategy](#branching-strategy)
- [Development Guidelines](#development-guidelines)
  - [Developing New Features](#1-developing-new-features)
  - [Code Refactoring](#2-code-refactoring)
  - [Coding Standards & Best Practices](#3-coding-standards--best-practices)
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

---

## Testing & Quality Verification

Before submitting code, ensure that your changes pass all verification checks.

### Diagnostic & Test Scripts

| Script | Purpose |
| :--- | :--- |
| `npm run test:i18n` | Verifies key parity between language dictionaries, language switching, currency formatting, and fast-path intent detection |
| `npm run test:format` | Tests WhatsApp markdown conversion to Telegram HTML and HTML entity escaping |
| `npm run test:email-rules` | Tests Gate 1 regex rules, bank email domain matching, blacklist filtering, and anti-duplicate logic |
| `npm run test:ai` | Verifies active AI provider integration, system instructions, and JSON extraction |
| `npm run test:mcp` | Tests connectivity, account listing, category querying, and budget fetching with the BudgetBakers MCP server |
| `npm run test:telegram` | Validates Telegram bot token authorization and messaging dispatch |
| `npm run build` | Compiles TypeScript source to verify type soundness and catch compilation errors |

### Adding New Tests

- When adding a new feature or utility, consider adding corresponding unit or diagnostic scenarios in `tests/` (e.g., adding test cases to `tests/responseDictionary.test.ts` when introducing new dictionary entries).
- Ensure all tests exit cleanly with status code `0`.

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

1. **Keep Pull Requests Focused**: Limit a single PR to one feature, fix, or cohesive refactoring task.
2. **Verify Locally**: Ensure `npm run build` and all relevant `npm run test:*` scripts pass before pushing.
3. **Describe Changes**: Provide a clear PR description detailing:
   - **Summary**: High-level overview of changes.
   - **Motivation**: Problem being solved or capability being introduced.
   - **Verification**: List of test scripts executed and local verification results.
4. **Code Review**: Address feedback promptly. Once approved, commits will be squashed or merged into `main`.
