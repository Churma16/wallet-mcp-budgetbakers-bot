# Testing

The repository uses Vitest as its unified test runner for all hermetic unit, integration, and regression test suites.

## Standard test commands

### Core offline execution
- `npm test` runs all hermetic offline suites once via Vitest.
- `npm run test:offline` is maintained as an alias for `npm test`.
- `npm run test:vitest` runs all Vitest suites once.
- `npm run test:vitest:watch` runs Vitest suites in interactive watch mode for local development.
- `npm run test:coverage` runs Vitest with v8 coverage generation and executes `scripts/verifyVitestCoverage.ts` to verify LCOV report discovery.

### Focused suite runners
- `npm run test:history` runs transaction history retrieval, pagination, and sorting tests.
- `npm run test:history-filters` runs composable transaction history filter tests (accounts, categories, types, dates).
- `npm run test:history-search` runs transaction history search and pagination regression suites.
- `npm run test:summary` runs transaction summary aggregation and fast-path handler suites.
- `npm run test:format` runs the message format helper suite.
- `npm run test:formatter` runs the human-response formatter suite.
- `npm run test:i18n` runs the response dictionary and localization suite.
- `npm run test:budget` runs the budget parsing suite.
- `npm run test:category-context` runs the category context suite.
- `npm run test:receipt-ocr` runs the receipt OCR prompt structure suite.
- `npm run test:phone` runs the phone-number normalization suite.
- `npm run test:redaction` runs the logger credential redaction suite.
- `npm run test:sanitizer` runs the logger account and PAN sanitization suite.
- `npm run test:media-limits` runs the media download limit boundary suite.
- `npm run test:email-rules` runs the bank email rules, domain validation, and prompt injection defense suites.
- `npm run test:ai-fallback` runs the fallback AI provider suite.
- `npm run test:whatsapp-safeguards` runs the WhatsApp safeguards and session recovery suite.
- `npm run test:whatsapp-hardening` runs the WhatsApp socket hardening and reconnection suite.
- `npm run test:telegram-safeguards` runs the Telegram safeguards and network resilience suite.
- `npm run test:gateway-resilience` runs the messaging gateway resilience and lifecycle suites.
- `npm run test:console` runs the console messaging adapter suite.

## Hermetic suites vs. live diagnostic scripts

The testing strategy strictly distinguishes between hermetic offline suites and live external service probes:

1. **Hermetic offline suites (`tests/**/*.vitest.test.ts`)**:
   - Discovered automatically by `vitest.config.ts`.
   - Run in offline environments without live credentials, network access, or external service dependencies.
   - Execute automatically on every pull request and push in GitHub Actions CI.
   - All external network calls (Wallet MCP, WhatsApp, Telegram, Google Gemini, OpenAI, IMAP) are fully stubbed or mocked.

2. **Explicit live diagnostic scripts (`tests/*.test.ts`)**:
   - Named without the `.vitest.` infix (`aiProvider.test.ts`, `geminiAiProvider.test.ts`, `emailListenerService.test.ts`, `fetchRealEmailsGate.test.ts`, `telegramBot.test.ts`, `walletMcpService.test.ts`).
   - Invoked only on demand via explicit live scripts (e.g. `npm run test:mcp:live`, `npm run test:email:live`, `npm run test:ai:live`).
   - Never discovered or executed by default CI runs or `npm test`.

## Vitest authoring conventions

All new tests in this repository must follow these standards:

1. **File naming**: Place test files under `tests/` and use the `.vitest.test.ts` extension (e.g., `tests/exampleFeature.vitest.test.ts`).
2. **Explicit imports**: Import `describe`, `it`, `expect`, `vi`, `beforeEach`, and `afterEach` directly from `'vitest'`. Global test variables are disabled.
3. **Structured grouping**: Group related scenarios with `describe` blocks and give each behavior an informative, scenario-level `it` title.
4. **Table-driven testing**: When testing multiple inputs or boundary conditions against the same logic, prefer `it.each` tables.
5. **State isolation & cleanup**:
   - Reset module state, language, or environment variables in `beforeEach` and `afterEach`.
   - Always call `vi.restoreAllMocks()` or `vi.clearAllMocks()` after tests that mock timers or service methods.
6. **Strict emoji boundaries**:
   - Do not insert raw emoji characters into system logs, console outputs, error messages, or internal assertions.
   - Emojis are permitted only when asserting expected user-facing messages formatted for chat clients.

## Coverage verification

Vitest coverage uses `@vitest/coverage-v8` to generate text reports in the terminal and an LCOV report at `coverage/vitest/lcov.info`.

After coverage collection, `scripts/verifyVitestCoverage.ts` runs automatically to verify that production sources imported by test suites are accurately indexed in the LCOV report without requiring manual source whitelists. The SonarCloud pipeline consumes `coverage/vitest/lcov.info` directly to enforce quality gates on pull requests.
