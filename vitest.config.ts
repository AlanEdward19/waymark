import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Bound subprocess contention so git integration tests keep their normal timeouts.
    maxWorkers: 4,
  },
});
