import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Tests are fully offline and deterministic; no network, no real keys.
    testTimeout: 20_000,
  },
});
