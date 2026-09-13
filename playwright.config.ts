import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['tests/**/*.test.ts', 'e2e/**/*.spec.ts'],
  timeout: 30000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'unit',
      testMatch: 'tests/**/*.unit.test.ts',
    },
    {
      name: 'e2e',
      testMatch: 'e2e/**/*.spec.ts',
    },
  ],
});
