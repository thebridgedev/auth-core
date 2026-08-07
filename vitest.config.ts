import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: true,
    // vitest 4: vi.spyOn() on an already-spied method returns the existing spy
    // rather than a fresh one, so a beforeEach that re-spies no longer resets
    // call history — counts accumulate across a file (logger.test.ts saw
    // file-wide totals leak between cases). Restore originals between tests.
    restoreMocks: true,
  },
});
