import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The panel mod's tests run under `claude plugin test` (npm run test:panel).
    exclude: ['plugins/**', 'node_modules/**'],
  },
});
