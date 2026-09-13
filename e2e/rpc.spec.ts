import { test, expect } from './fixtures';

test.describe('RPC Chrome Base End-to-End Suite', () => {
  test('1. extension page -> SW: RuntimeRequester and Requester return small nested JSON object', async ({
    extensionPage,
  }) => {
    // 1a. RuntimeRequester
    const userViaRuntime = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRuntimeRequester('getUser', '42');
    });

    expect(userViaRuntime).toEqual({
      id: '42',
      name: 'User 42',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    });

    // 1b. Requester
    const userViaRequester = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('getUser', '99');
    });

    expect(userViaRequester).toEqual({
      id: '99',
      name: 'User 99',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    });
  });

  test('2. content script -> SW: isolated-world script calls SW and updates DOM marker', async ({
    openTestTab,
  }) => {
    const tab = await openTestTab('/content-to-sw');

    // Trigger RPC call from isolated content script to background service worker
    await tab.evaluate(() => {
      document.dispatchEvent(
        new CustomEvent('test-trigger-content-call', {
          detail: { method: 'getUser', args: ['101'] },
        })
      );
    });

    // Wait for content script to receive response and update DOM marker
    const resultLocator = tab.locator('#content-result[data-status="success"]');
    await expect(resultLocator).toBeVisible({ timeout: 10000 });

    const rawText = await resultLocator.textContent();
    const payload = JSON.parse(rawText || '{}');

    expect(payload.success).toBe(true);
    expect(payload.result).toEqual({
      id: '101',
      name: 'User 101',
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    });
  });

  test('3. SW and extension page -> tab content script via Requester.callTab and ContentScriptRequester', async ({
    extensionPage,
    openTestTab,
  }) => {
    const tab = await openTestTab('/tab-target');

    // Query tabId from extension page
    const tabs = await extensionPage.evaluate(async (url) => {
      return await chrome.tabs.query({ url: `${url}*` });
    }, tab.url().split('?')[0]);

    expect(tabs.length).toBeGreaterThanOrEqual(1);
    const targetTabId = tabs[0].id!;

    // 3a. Extension page -> tab via Requester.callTab
    const tabEcho = await extensionPage.evaluate(
      async ({ tabId }) => {
        return await window.testApi.callTabViaRequester(tabId, 'echoTab', 'hello-tab');
      },
      { tabId: targetTabId }
    );

    expect(tabEcho).toEqual({
      echo: 'hello-tab',
      tabUrl: tab.url(),
    });

    // 3b. SW -> tab via Requester.callTab (forwarded through background method)
    const swToTabEcho = await extensionPage.evaluate(
      async ({ tabId }) => {
        return await window.testApi.callBgViaRequester('callTabFromBg', tabId, 'from-sw');
      },
      { tabId: targetTabId }
    );

    expect(swToTabEcho).toEqual({
      echo: 'from-sw',
      tabUrl: tab.url(),
    });

    // 3c. ContentScriptRequester broadcast across tabs
    const csResults = await extensionPage.evaluate(async () => {
      return await window.testApi.callTabsViaContentScriptRequester('echoTab', 'broadcast-check');
    });

    expect(Array.isArray(csResults)).toBe(true);
    const found = csResults.find((r: any) => r.tabId === targetTabId);
    expect(found).toBeDefined();
    expect(found?.response).toEqual({
      echo: 'broadcast-check',
      tabUrl: tab.url(),
    });
  });

  test('4. user handler error reaches requester with useful message and stack', async ({
    extensionPage,
    openTestTab,
  }) => {
    // 4a. Handler error in SW
    const bgError = await extensionPage.evaluate(async () => {
      try {
        await window.testApi.callBgViaRuntimeRequester('failingMethod', true);
        return null;
      } catch (e: any) {
        return { message: e.message, stack: e.stack };
      }
    });

    expect(bgError).not.toBeNull();
    expect(bgError!.message).toContain(
      'Error in method failingMethod: User handler error in failingMethod'
    );

    // 4b. Handler error in tab content script
    const tab = await openTestTab('/tab-error');
    const tabs = await extensionPage.evaluate(async (url) => {
      return await chrome.tabs.query({ url: `${url}*` });
    }, tab.url().split('?')[0]);

    const targetTabId = tabs[0].id!;

    const tabError = await extensionPage.evaluate(
      async ({ tabId }) => {
        try {
          await window.testApi.callTabViaRequester(tabId, 'tabFailingMethod');
          return null;
        } catch (e: any) {
          return { message: e.message };
        }
      },
      { tabId: targetTabId }
    );

    expect(tabError).not.toBeNull();
    expect(tabError!.message).toContain(
      'Error in method tabFailingMethod: Error inside tab content script handler'
    );
  });

  test('5. subscribe/unsubscribe and subscribeUniversal behavior on Responder', async ({
    extensionPage,
  }) => {
    // 5a. Initial named handler returns base implementation
    const baseResult = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testNamedTarget');
    });
    expect(baseResult).toEqual({ source: 'base-named', version: 1 });

    // 5b. Add named override handler -> response demonstrably switches to override
    await extensionPage.evaluate(async () => {
      await window.testApi.callBgViaRequester('addOverrideHandler');
    });

    const overrideResult = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testNamedTarget');
    });
    expect(overrideResult).toEqual({ source: 'override-named', version: 2 });

    // 5c. Remove named override handler -> response demonstrably returns to base handler
    await extensionPage.evaluate(async () => {
      await window.testApi.callBgViaRequester('removeOverrideHandler');
    });

    const revertedResult = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testNamedTarget');
    });
    expect(revertedResult).toEqual({ source: 'base-named', version: 1 });

    // 5d. Universal handler initial state returns base universal implementation
    const baseUniversal = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testUniversalTarget', 3, 4);
    });
    expect(baseUniversal).toEqual({ sum: 7, source: 'base-universal' });

    // 5e. Add universal override handler -> response switches to override universal
    await extensionPage.evaluate(async () => {
      await window.testApi.callBgViaRequester('addUniversalOverride');
    });

    const overrideUniversal = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testUniversalTarget', 3, 4);
    });
    expect(overrideUniversal).toEqual({ sum: 70, source: 'override-universal' });

    // 5f. Remove universal override handler -> response returns to base universal
    await extensionPage.evaluate(async () => {
      await window.testApi.callBgViaRequester('removeUniversalOverride');
    });

    const revertedUniversal = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('testUniversalTarget', 3, 4);
    });
    expect(revertedUniversal).toEqual({ sum: 7, source: 'base-universal' });
  });

  test('6. at least two independent content script tabs use the same channel concurrently', async ({
    openTestTab,
  }) => {
    const tabA = await openTestTab('/tab-alpha');
    const tabB = await openTestTab('/tab-beta');

    // Trigger calls from both tabs concurrently
    await Promise.all([
      tabA.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent('test-trigger-content-call', {
            detail: { method: 'getUser', args: ['client-alpha'] },
          })
        );
      }),
      tabB.evaluate(() => {
        document.dispatchEvent(
          new CustomEvent('test-trigger-content-call', {
            detail: { method: 'getUser', args: ['client-beta'] },
          })
        );
      }),
    ]);

    const resA = tabA.locator('#content-result[data-status="success"]');
    const resB = tabB.locator('#content-result[data-status="success"]');

    await expect(resA).toBeVisible({ timeout: 10000 });
    await expect(resB).toBeVisible({ timeout: 10000 });

    const dataA = JSON.parse((await resA.textContent()) || '{}');
    const dataB = JSON.parse((await resB.textContent()) || '{}');

    expect(dataA.result.id).toBe('client-alpha');
    expect(dataA.result.name).toBe('User client-alpha');
    expect(dataB.result.id).toBe('client-beta');
    expect(dataB.result.name).toBe('User client-beta');
  });

  test('7. broadcast via ContentScriptRequester across multiple tabs validates shape without relying on tab order', async ({
    extensionPage,
    openTestTab,
  }) => {
    const tab1 = await openTestTab('/broadcast-first');
    const tab2 = await openTestTab('/broadcast-second');

    // ContentScriptRequester sends message to all matching tabs
    const results = await extensionPage.evaluate(async () => {
      return await window.testApi.callTabsViaContentScriptRequester('echoTab', 'broadcast-token');
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(2);

    for (const item of results) {
      expect(typeof item.tabId).toBe('number');
      expect(item.response.echo).toBe('broadcast-token');
      expect(typeof item.response.tabUrl).toBe('string');
    }

    // Tab ordering in ContentScriptRequester results is asynchronous and arrival-dependent;
    // assert membership rather than fixed array indices
    const urls = results.map((r: any) => r.response.tabUrl);
    expect(urls).toContain(tab1.url());
    expect(urls).toContain(tab2.url());
  });
});
