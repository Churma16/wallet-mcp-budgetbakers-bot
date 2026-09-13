# Testing

The repository is migrating its hermetic test suite from the custom `tsx` runner to Vitest incrementally.

## Transition commands

- `npm run test:offline` runs the remaining legacy hermetic suites through `tests/runOfflineTests.ts`.
- `npm run test:vitest` runs migrated and newly authored Vitest suites once.
- `npm run test:vitest:watch` runs Vitest suites in watch mode for local development.
- `npm run test:format` runs only the migrated message-format helper suite.
- `npm run test:phone` runs only the migrated phone-number normalization suite.
- `npm run test:redaction` runs only the migrated logger-redaction suite.
- `npm run test:coverage` keeps both legacy and Vitest coverage paths available during the transition.

`npm test` intentionally remains mapped to the legacy runner until all required offline suites have reached Vitest parity. CI runs both the legacy and Vitest commands during the migration.

Vitest coverage intentionally relies on Vitest's default imported-file discovery instead of maintaining a per-source whitelist. Production modules imported by current or future `*.vitest.test.ts` suites are therefore added to `coverage/vitest/lcov.info` automatically, while modules exercised only by remaining legacy suites continue to be represented by `coverage/legacy/lcov.info`.

After each Vitest coverage run, `scripts/verifyVitestCoverage.ts` scans all `*.vitest.test.ts` files, discovers their direct runtime imports from `src/`, and verifies that every discovered production module has an `SF:` entry in the Vitest LCOV report. The invariant scales with new migration batches automatically; adding a newly migrated suite does not require editing a coverage allowlist or verifier path list.

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
5. Continue adding any new hermetic regression coverage for the migrated area in Vitest. No per-module Vitest coverage configuration is required because imported production modules are discovered and verified automatically.

The initial proof-of-concept was `tests/messageFormatHelper.vitest.test.ts`. After side-by-side parity validation, its legacy baseline has been retired. The first Phase 2 utility batch also migrates container workflow trigger validation, logger credential redaction, and phone-number normalization/environment parsing to native Vitest. Remaining legacy suites stay registered in `tests/runOfflineTests.ts` until they are migrated in bounded batches with the same parity process.
