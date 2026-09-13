import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { createTestServer, type TestServer } from './testServer';

const rootDir = path.resolve(__dirname, '..');
export const getExtensionPath = () =>
  process.env.E2E_EXTENSION_PATH
    ? path.resolve(rootDir, process.env.E2E_EXTENSION_PATH)
    : path.resolve(rootDir, '.e2e-extension');

export type TestFixtures = {
  context: BrowserContext;
  extensionId: string;
  extensionPage: Page;
  server: TestServer;
  openTestTab: (subPath?: string) => Promise<Page>;
};

export const test = base.extend<TestFixtures>({
  server: async ({}, use) => {
    const server = await createTestServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },

  context: async ({}, use, testInfo) => {
    const isHeaded = testInfo.project.use.headless === false;

    const extPath = getExtensionPath();
    const args = [
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
    ];

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: !isHeaded,
      args,
    });

    try {
      await use(context);
    } finally {
      await context.close();
    }
  },

  extensionId: async ({ context }, use) => {
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    const extensionId = background.url().split('/')[2];
    await use(extensionId);
  },

  extensionPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/page.html`);
    await page.waitForSelector('#status:has-text("ready")', { timeout: 15000 });
    await use(page);
  },

  openTestTab: async ({ context, server }, use) => {
    const openTab = async (subPath = '/') => {
      const page = await context.newPage();
      await page.goto(`${server.url}${subPath}`);
      await page.waitForSelector('#content-bridge[data-ready="true"]', { state: 'attached', timeout: 15000 });
      return page;
    };
    await use(openTab);
  },
});

export { expect } from '@playwright/test';
