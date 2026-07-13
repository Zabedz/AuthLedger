import { defineConfig, devices } from '@playwright/test';

const API_PORT = 8100;
const WEB_PORT = 5273;
const TEST_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://authledger:authledger@localhost:5432/authledger_e2e';

// Composed stack: the real API and the built SPA behind one origin (the vite
// preview server proxies /api), driven through a real browser. This exercises
// web/src/api.ts and App.tsx, which fastify.inject cannot.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `npx tsx src/index.ts`,
      cwd: '../api',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      env: {
        NODE_ENV: 'development',
        PORT: String(API_PORT),
        LOG_LEVEL: 'warn',
        DATABASE_URL: TEST_DATABASE_URL,
        APP_ORIGIN: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npm run build && npx vite preview --port ${WEB_PORT} --strictPort`,
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_PORT: String(API_PORT) },
    },
  ],
});
