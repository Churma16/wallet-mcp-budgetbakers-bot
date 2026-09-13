# Testing

The repository is migrating its hermetic test suite from the custom `tsx` runner to Vitest incrementally.

## Transition commands

- `npm run test:offline` runs the remaining legacy hermetic suites through `tests/runOfflineTests.ts`.
- `npm run test:vitest` runs migrated and newly authored Vitest suites once.
- `npm run test:vitest:watch` runs Vitest suites in watch mode for local development.
- `npm run test:format` runs only the migrated message-format helper suite.
- `npm run test:phone` runs only the migrated phone-number normalization suite.
- `npm run test:redaction` runs only the migrated logger-redaction suite.
- `npm run test:email-rules` runs the migrated bank-email Gate 1, sender-domain validation, and email prompt-injection defense suites.
- `npm run test:coverage` keeps both legacy and Vitest coverage paths available during the transition.

`npm test` intentionally remains mapped to the legacy runner until all required offline suites have reached Vitest parity. CI runs both the legacy and Vitest commands during the migration. After the email-security migration batch, 33 suites remain registered in the legacy runner.

Vitest coverage intentionally relies on Vitest's default imported-file discovery instead of maintaining a per-source whitelist. Production modules imported and executed by current or future `*.vitest.test.ts` suites are therefore added to `coverage/vitest/lcov.info` automatically, while modules exercised only by remaining legacy suites continue to be represented by `coverage/legacy/lcov.info`.

After each Vitest coverage run, `scripts/verifyVitestCoverage.ts` uses `tests/sharedUtilities.vitest.test.ts` as a stable coverage canary. It discovers that suite's production imports from source text and verifies that every canary module has an `SF:` entry in the Vitest LCOV report. This checks the imported-file coverage mechanism without maintaining a production-source allowlist. The verifier intentionally does not require every source-text import from every suite to appear in LCOV because TypeScript can erase type-only imports and Vitest mocks can replace imported production modules before their source executes.

Future migration batches do not need to edit `vitest.config.ts` or the verifier just to make newly migrated production modules appear in coverage. At full Vitest cutover, the repository can move from mixed imported-file discovery to a whole-production-source coverage scope with intentional exclusions.

## Vitest conventions

New hermetic tests and migrated suites should:

1. Use the `*.vitest.test.ts` suffix while both runners coexist. `vitest.config.ts` only discovers that suffix, preventing legacy executable tests from being collected accidentally.
2. Import `describe`, `it`/`test`, `expect`, and `vi` explicitly from `vitest`; globals are disabled.
3. Group related behavior with `describe` and give each independent behavior a named `it`/`test` case so failures are reported at scenario level.
4. Prefer table-driven cases with `it.each` when the same behavior is exercised against multiple inputs.
5. Keep default tests hermetic. Do not call live Wallet, Telegram, WhatsApp, email, Gemini, or other external services from suites discovered by the default Vitest configuration.
6. Keep fixtures deterministic and local. Prefer small inline fixtures or dedicated local fixture helpers over network-derived state.
7. Use `beforeEach`/`afterEach` for state reset and `vi.fn`/`vi.spyOn` for mocks. Restore or reset mocks so one test cannot leak state into another.
8. Preserve every existing assertion and regression scenario when migrating a legacy suite. During the transition, retaining the legacy suite temporarily as a parity baseline is acceptable.

## Migrating a legacy suite

For a bounded migration:

1. Port the suite to a `*.vitest.test.ts` file without dropping scenarios.
2. Run the legacy suite and its Vitest counterpart to verify behavioral parity.
3. Keep live/integration entry points explicit and outside the default Vitest include pattern.
4. Remove the legacy registration and file only after the migrated suite is proven equivalent and the PR scope remains reviewable.
5. Continue adding any new hermetic regression coverage for the migrated area in Vitest. No per-module Vitest coverage configuration is required because imported production modules are discovered automatically.

The initial proof-of-concept was `tests/messageFormatHelper.vitest.test.ts`. After side-by-side parity validation, its legacy baseline has been retired. The first Phase 2 utility batch migrated container workflow trigger validation, logger credential redaction, and phone-number normalization/environment parsing. The next bounded batch migrates bank-email Gate 1 rules, malformed/spoofed sender-domain validation, and email-derived prompt trust-boundary defenses. Remaining legacy suites stay registered in `tests/runOfflineTests.ts` until they are migrated in bounded batches with the same parity process.
