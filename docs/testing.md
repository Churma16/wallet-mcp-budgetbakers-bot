# Testing

The repository is migrating its hermetic test suite from the custom `tsx` runner to Vitest incrementally.

## Transition commands

- `npm run test:offline` runs the legacy hermetic suites through `tests/runOfflineTests.ts`.
- `npm run test:vitest` runs migrated Vitest suites once.
- `npm run test:vitest:watch` runs migrated Vitest suites in watch mode for local development.
- `npm run test:format` runs only the migrated message-format helper suite.
- `npm run test:coverage` keeps the existing legacy coverage path available during the transition.

`npm test` intentionally remains mapped to the legacy runner until all required offline suites have reached Vitest parity. CI runs both the legacy and Vitest commands during the migration.

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
4. Remove the legacy registration only when the migrated suite is proven equivalent and the PR scope remains reviewable.
5. Continue adding any new hermetic regression coverage for the migrated area in Vitest.

The initial proof-of-concept is `tests/messageFormatHelper.vitest.test.ts`, ported from the existing message-format helper regression suite.
