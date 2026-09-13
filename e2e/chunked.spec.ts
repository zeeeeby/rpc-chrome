import { test, expect } from './fixtures';

test.describe('Opt-in Chunked Transport Suite (rpc-chrome/v1)', () => {
  test('1. Large JSON request and response crossing multiple 16 KiB fragments', async ({
    extensionPage,
  }) => {
    // Generate ~80 KiB nested JSON object (crosses at least 5 fragments with 16 KiB chunk size)
    const largeObject = {
      title: 'Large Payload Test',
      timestamp: Date.now(),
      records: Array.from({ length: 400 }, (_, i) => ({
        id: `rec-${i}`,
        index: i,
        data: `Sample data chunk ${i} - ${'x'.repeat(150)}`,
        tags: ['alpha', 'beta', 'gamma', 'delta'],
        meta: { active: i % 2 === 0, score: i * 1.5 },
      })),
    };

    // 1a. Via RuntimeRequester (page -> SW)
    const resRuntime = await extensionPage.evaluate(async (payload) => {
      return await window.testApi.callBgViaLargeRuntimeRequester('echoLargeJson', payload);
    }, largeObject);

    expect(resRuntime).toEqual(largeObject);

    // 1b. Via Requester (page -> SW)
    const resRequester = await extensionPage.evaluate(async (payload) => {
      return await window.testApi.callBgViaLargeRequester('echoLargeJson', payload);
    }, largeObject);

    expect(resRequester).toEqual(largeObject);

    // Verify invocation count was exactly 2 (once per call, no replay)
    const count = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaLargeRequester('getInvocationCount', 'echoLargeJson');
    });
    expect(count).toBe(2);
  });

  test('2. Nested Blob upload and download: exact byte and MIME equality', async ({
    extensionPage,
  }) => {
    // Single Blob roundtrip
    const blobResult = await extensionPage.evaluate(async () => {
      // 35 KiB binary data (crosses multiple 16 KiB chunks)
      const bytes = new Uint8Array(35000);
      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
      const testBlob = new Blob([bytes], { type: 'application/x-binary-test' });

      const reply = await window.testApi.callBgViaLargeRequester('echoBlob', {
        label: 'test-binary',
        blob: testBlob,
      });

      const replyBuf = await reply.blob.arrayBuffer();
      const replyBytes = Array.from(new Uint8Array(replyBuf));

      return {
        label: reply.label,
        size: reply.size,
        blobSize: reply.blob.size,
        blobType: reply.blob.type,
        bytesMatch: replyBytes.every((val, idx) => val === idx % 256),
      };
    });

    expect(blobResult.label).toBe('echo-test-binary');
    expect(blobResult.size).toBe(35000);
    expect(blobResult.blobSize).toBe(35000);
    expect(blobResult.blobType).toBe('application/x-binary-test');
    expect(blobResult.bytesMatch).toBe(true);

    // Multiple Blobs nested in an array of objects
    const multiBlobResult = await extensionPage.evaluate(async () => {
      const f1 = new Blob(['File 1 plain text content 🚀'], { type: 'text/plain;charset=utf-8' });
      const f2Bytes = new Uint8Array([10, 20, 30, 40, 50, 0, 255]);
      const f2 = new Blob([f2Bytes], { type: 'application/octet-stream' });

      const reply = await window.testApi.callBgViaLargeRequester('nestedBlobRoundtrip', {
        title: 'archive-1',
        files: [
          { name: 'notes.txt', content: f1 },
          { name: 'binary.dat', content: f2 },
        ],
      });

      const f1EchoText = await reply.files[0].content.text();
      const f2EchoBuf = await reply.files[1].content.arrayBuffer();

      return {
        title: reply.title,
        count: reply.count,
        f1Name: reply.files[0].name,
        f1Type: reply.files[0].content.type,
        f1Text: f1EchoText,
        f2Name: reply.files[1].name,
        f2Type: reply.files[1].content.type,
        f2Bytes: Array.from(new Uint8Array(f2EchoBuf)),
      };
    });

    expect(multiBlobResult.title).toBe('processed-archive-1');
    expect(multiBlobResult.count).toBe(2);
    expect(multiBlobResult.f1Name).toBe('echo-notes.txt');
    expect(multiBlobResult.f1Type).toBe('text/plain;charset=utf-8');
    expect(multiBlobResult.f1Text).toBe('File 1 plain text content 🚀');
    expect(multiBlobResult.f2Name).toBe('echo-binary.dat');
    expect(multiBlobResult.f2Type).toBe('application/octet-stream');
    expect(multiBlobResult.f2Bytes).toEqual([10, 20, 30, 40, 50, 0, 255]);
  });

  test('3. Small opt-in call, undefined return value, and error propagation', async ({
    extensionPage,
  }) => {
    // 3a. Small call completes in single inline exchange
    const user = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaLargeRequester('getUser', 'small-user-1');
    });
    expect(user.id).toBe('small-user-1');
    expect(user.name).toBe('User small-user-1');

    // 3b. Undefined return value is preserved
    const undefinedRes = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaLargeRequester('returnUndefined');
    });
    expect(undefinedRes).toBeUndefined();

    // 3c. User handler error propagation
    const errorRes = await extensionPage.evaluate(async () => {
      try {
        await window.testApi.callBgViaLargeRequester('failingMethod', true);
        return null;
      } catch (err: any) {
        return { message: err.message, stack: err.stack };
      }
    });
    expect(errorRes).not.toBeNull();
    expect(errorRes?.message).toContain('User handler error in failingMethod');

    // 3d. Unregistered method in opt-in mode throws explicit not-found error
    const notFoundError = await extensionPage.evaluate(async () => {
      try {
        await window.testApi.callBgViaLargeRequester('nonExistentMethod' as any);
        return null;
      } catch (err: any) {
        return { message: err.message };
      }
    });
    expect(notFoundError).not.toBeNull();
    expect(notFoundError?.message).toContain("Method 'nonExistentMethod' not found");
  });

  test('4. Requester.callTab and ContentScriptRequester over large-payload channel', async ({
    extensionPage,
    openTestTab,
  }) => {
    const tab1 = await openTestTab('/tab-large-target-1');
    const tab2 = await openTestTab('/tab-large-target-2');

    const tabs = await extensionPage.evaluate(async (url) => {
      return await chrome.tabs.query({ url: `${url}*` });
    }, tab1.url().split('?')[0]);

    const targetTabId = tabs[0].id!;

    // 4a. Requester.callTab to tab content script with large payload
    const tabEcho = await extensionPage.evaluate(
      async ({ tabId }) => {
        const largeStr = 'TabPayload-'.repeat(2000); // ~22 KiB, crosses 16 KiB chunk boundary
        return await window.testApi.callTabViaLargeRequester(tabId, 'echoLargeJsonTab', { text: largeStr });
      },
      { tabId: targetTabId }
    );
    expect(tabEcho.text).toBe('TabPayload-'.repeat(2000));

    // 4b. ContentScriptRequester broadcast across tabs
    const broadcastResults = await extensionPage.evaluate(async () => {
      const msg = 'BroadcastMsg-'.repeat(1500);
      return await window.testApi.callTabsViaLargeContentScriptRequester('echoLargeJsonTab', { broadcast: msg });
    });

    expect(Array.isArray(broadcastResults)).toBe(true);
    expect(broadcastResults.length).toBeGreaterThanOrEqual(2);
    for (const r of broadcastResults) {
      expect(typeof r.tabId).toBe('number');
      expect(r.response.broadcast).toBe('BroadcastMsg-'.repeat(1500));
    }

    // 4c. Tab content script -> background SW with large payload
    await tab1.evaluate(() => {
      const bigArray = Array.from({ length: 500 }, (_, i) => `item-${i}`);
      document.dispatchEvent(
        new CustomEvent('test-trigger-large-content-call', {
          detail: { method: 'echoLargeJson', args: [bigArray] },
        })
      );
    });

    const resultLocator = tab1.locator('#content-result[data-status="success"]');
    await expect(resultLocator).toBeVisible({ timeout: 10000 });
    const contentData = JSON.parse((await resultLocator.textContent()) || '{}');
    expect(contentData.success).toBe(true);
    expect(contentData.result).toHaveLength(500);
    expect(contentData.result[499]).toBe('item-499');
  });

  test('5. Concurrent clients transferring large payloads do not mix or interfere', async ({
    openTestTab,
  }) => {
    const tabA = await openTestTab('/tab-concurrent-a');
    const tabB = await openTestTab('/tab-concurrent-b');

    const payloadA = { client: 'Client A', data: 'A'.repeat(30000) };
    const payloadB = { client: 'Client B', data: 'B'.repeat(30000) };

    await Promise.all([
      tabA.evaluate((data) => {
        document.dispatchEvent(
          new CustomEvent('test-trigger-large-content-call', {
            detail: { method: 'echoLargeJson', args: [data] },
          })
        );
      }, payloadA),
      tabB.evaluate((data) => {
        document.dispatchEvent(
          new CustomEvent('test-trigger-large-content-call', {
            detail: { method: 'echoLargeJson', args: [data] },
          })
        );
      }, payloadB),
    ]);

    const resA = tabA.locator('#content-result[data-status="success"]');
    const resB = tabB.locator('#content-result[data-status="success"]');

    await expect(resA).toBeVisible({ timeout: 10000 });
    await expect(resB).toBeVisible({ timeout: 10000 });

    const dataA = JSON.parse((await resA.textContent()) || '{}');
    const dataB = JSON.parse((await resB.textContent()) || '{}');

    expect(dataA.result.client).toBe('Client A');
    expect(dataA.result.data).toBe('A'.repeat(30000));

    expect(dataB.result.client).toBe('Client B');
    expect(dataB.result.data).toBe('B'.repeat(30000));
  });
});
