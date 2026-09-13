import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.vitest.test.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage/vitest',
      include: [
        'src/setup/**/*.ts',
        'src/diagnostics/**/*.ts',
      ],
    },
  },
});
