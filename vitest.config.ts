import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.vitest.test.ts'],
    passWithNoTests: false,
  },
});
