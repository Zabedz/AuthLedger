import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './test/global-setup.ts',
    // DB-backed integration tests share tables; serial execution keeps
    // truncation between tests race-free.
    fileParallelism: false,
  },
});
