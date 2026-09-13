import { test, expect } from './fixtures';
import { rawFromContent, createManualUploadPlan } from './rawHelper';

test.describe('Acceptance Scenarios Suite (rpc-chrome/v1)', () => {
  test('1. True large request (>64 MiB) with compact validation, and native size rejection control', async ({
    extensionPage,
  }) => {
    test.setTimeout(90000);

    // 1a. Native control: raw chrome.runtime.sendMessage rejects oversized payload
    const controlResult = await extensionPage.evaluate(async () => {
      try {
        const huge = 'A'.repeat(66 * 1024 * 1024);
        await chrome.runtime.sendMessage({ channel: 'bg-channel', type: 'request', method: 'echo', args: [huge] });
        return { failed: false, error: null };
      } catch (err: any) {
        return { failed: true, error: err?.message || String(err) };
      }
    });

    expect(controlResult.failed).toBe(true);
    expect(controlResult.error).toMatch(/exceeded|length|serialize|could not/i);

    // 1b. True large request: 66 MiB sent via public RPC with default 256 KiB chunks
    const requestResult = await extensionPage.evaluate(async () => {
      const sizeMb = 66;
      const totalLength = sizeMb * 1024 * 1024;
      const blockSize = 1024 * 1024;
      const blocks: string[] = [];

      for (let b = 0; b < sizeMb; b++) {
        const char = String.fromCharCode(65 + (b % 26));
        if (b === 0) {
          blocks.push('LARGE-START-' + char.repeat(blockSize - 12));
        } else if (b === sizeMb - 1) {
          blocks.push(char.repeat(blockSize - 10) + '-LARGE-END');
        } else {
          blocks.push(char.repeat(blockSize));
        }
      }

      const hugeText = blocks.join('');
      const reply = await window.testApi.callBgViaDefaultLargeRequester('verifyLargePayload', {
        text: hugeText,
        expectedLength: totalLength,
      });

      return {
        replyLength: reply.length,
        head: reply.head,
        tail: reply.tail,
        verified: reply.verified,
      };
    });

    expect(requestResult.replyLength).toBe(66 * 1024 * 1024);
    expect(requestResult.head).toBe('LARGE-START-');
    expect(requestResult.tail).toBe('-LARGE-END');
    expect(requestResult.verified).toBe(true);
  });

  test('2. True large response (>64 MiB) generated in SW and verified in receiving context', async ({
    extensionPage,
  }) => {
    test.setTimeout(90000);

    const responseReport = await extensionPage.evaluate(async () => {
      const sizeMb = 66;
      const expectedLength = sizeMb * 1024 * 1024;

      const res = await window.testApi.callBgViaDefaultLargeRequester('generateLargePayload', sizeMb);
      if (!res || typeof res.text !== 'string') {
        return { valid: false, error: 'Invalid response structure' };
      }

      const len = res.text.length;
      if (len !== expectedLength) {
        return { valid: false, error: `Length mismatch: expected ${expectedLength}, got ${len}` };
      }

      const head = res.text.slice(0, 12);
      const tail = res.text.slice(-10);
      if (head !== 'RES-START---' || tail !== '-RES-END--') {
        return { valid: false, error: `Boundary mismatch: head=${head}, tail=${tail}` };
      }

      for (let b = 1; b < sizeMb - 1; b++) {
        const expectedChar = String.fromCharCode(65 + (b % 26));
        const sampleIndex = b * 1024 * 1024 + 500;
        if (res.text[sampleIndex] !== expectedChar) {
          return { valid: false, error: `Sample check failed at block ${b}` };
        }
      }

      return {
        valid: true,
        receivedLength: len,
        head,
        tail,
      };
    });

    expect(responseReport.valid).toBe(true);
    expect(responseReport.receivedLength).toBe(66 * 1024 * 1024);
    expect(responseReport.head).toBe('RES-START---');
    expect(responseReport.tail).toBe('-RES-END--');
  });

  test('3. Real IndexedDB Media: Blob roundtrip browser -> SW -> native IndexedDB -> SW -> new browser page', async ({
    context,
    extensionId,
    extensionPage,
  }) => {
    // 3a. Page 1 puts media into native IndexedDB via background SW
    const initialPut = await extensionPage.evaluate(async () => {
      const byteLen = 48 * 1024;
      const data = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) data[i] = (i * 7 + 13) % 256;

      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');

      const blob = new Blob([data], { type: 'application/x-custom-media' });
      const putRes = await window.testApi.callBgViaDefaultLargeRequester('putMedia', {
        id: 'media-item-42',
        blob,
        tags: ['binary', 'test', 'v1'],
      });

      return {
        success: putRes.success,
        id: putRes.id,
        hashHex,
        byteLen,
      };
    });

    expect(initialPut.success).toBe(true);

    // 3b. Close Page 1
    await extensionPage.close();

    // 3c. Open a fresh extension page
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${extensionId}/page.html`);
    await page2.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

    // 3d. Retrieve media from SW IndexedDB on page2 and verify SHA-256 equality
    const retrieved = await page2.evaluate(async () => {
      const item = await window.testApi.callBgViaDefaultLargeRequester('getMedia', 'media-item-42');
      if (!item || !item.blob) return { found: false };

      const isRealBlob = item.blob instanceof Blob;
      const buf = await item.blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buf);
      const hashHex = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      return {
        found: true,
        isRealBlob,
        id: item.id,
        tags: item.tags,
        blobSize: item.blob.size,
        blobType: item.blob.type,
        hashHex,
      };
    });

    expect(retrieved.found).toBe(true);
    expect(retrieved.isRealBlob).toBe(true);
    expect(retrieved.id).toBe('media-item-42');
    expect(retrieved.tags).toEqual(['binary', 'test', 'v1']);
    expect(retrieved.blobSize).toBe(initialPut.byteLen);
    expect(retrieved.blobType).toBe('application/x-custom-media');
    expect(retrieved.hashHex).toBe(initialPut.hashHex);

    await page2.close();
  });

  test('4. Routing and document changes: cross-document hijacking rejected, and real transfer continuation interrupted on reload', async ({
    openTestTab,
    extensionPage,
  }) => {
    // 4a. Iframe / cross-document hijacking rejection
    const hostTab = await openTestTab('/iframe-host');
    const childFrame = hostTab.frameLocator('#test-child-iframe');
    await expect(childFrame.locator('#content-bridge[data-ready="true"]')).toBeAttached({ timeout: 15000 });

    // Child iframe starts an upload transfer session via isolated content script bridge
    const childPlan = createManualUploadPlan('bg-default-large-channel', 'echoLargeJson', ['child-data'], 40);
    const startAck = await rawFromContent(childFrame, childPlan.startMessage);
    expect(startAck.type).toBe('rpc:v1:ack-upload');
    const targetResponderId = startAck.responderId;

    // Main frame (different documentId) attempts to send chunk for child iframe's transfer
    const hijackChunkMsg = childPlan.chunkMessages(targetResponderId)[0];
    const hijackChunkReply = await rawFromContent(hostTab, hijackChunkMsg);
    expect(hijackChunkReply.type).toBe('rpc:v1:error');
    expect(hijackChunkReply.error.message).toContain('Caller identity mismatch');

    // Main frame attempts to abort child iframe's transfer
    const hijackAbortMsg = {
      protocol: 'rpc-chrome/v1',
      type: 'rpc:v1:abort',
      channel: 'bg-default-large-channel',
      transferId: childPlan.transferId,
      targetResponderId: targetResponderId,
      reason: 'Attacker abort',
    };
    const hijackAbortReply = await rawFromContent(hostTab, hijackAbortMsg);
    expect(hijackAbortReply.type).toBe('rpc:v1:error');
    expect(hijackAbortReply.error.message).toContain('Caller identity mismatch');

    // Child iframe completes its own transfer successfully
    for (const chunk of childPlan.chunkMessages(targetResponderId)) {
      const childChunkAck = await rawFromContent(childFrame, chunk);
      expect(childChunkAck.type).toBe('rpc:v1:ack-chunk');
    }
    const childResult = await rawFromContent(childFrame, childPlan.completeMessage(targetResponderId));
    expect(childResult.type).toBe('rpc:v1:reply-inline');

    // 4b. Real multi-chunk transfer continuation interrupted when target tab reloads
    const navTab = await openTestTab('/nav-interruption-target');
    const tabs = await extensionPage.evaluate(async (url) => {
      return await chrome.tabs.query({ url: `${url}*` });
    }, navTab.url().split('?')[0]);
    const targetTabId = tabs[0].id!;

    // Start a real multi-chunk upload session against the tab's content script responder
    const tabUploadPlan = createManualUploadPlan('tab-large-channel', 'echoLargeJsonTab', ['tab-payload-data'], 20);
    const tabStartAck: any = await extensionPage.evaluate(
      async ({ tabId, msg }) => {
        return await chrome.tabs.sendMessage(tabId, msg);
      },
      { tabId: targetTabId, msg: tabUploadPlan.startMessage }
    );
    expect(tabStartAck.type).toBe('rpc:v1:ack-upload');
    const tabResponderId = tabStartAck.responderId;

    // Reload the tab while the transfer session is in flight
    await navTab.reload();
    await navTab.waitForSelector('#content-bridge[data-ready="true"]', { state: 'attached', timeout: 15000 });

    // Continuation chunk targeted at the old tab responder must reject or be ignored by the new context
    const continuationReply: any = await extensionPage.evaluate(
      async ({ tabId, msg }) => {
        try {
          return await chrome.tabs.sendMessage(tabId, msg);
        } catch (err: any) {
          return { failed: true, message: err?.message || String(err) };
        }
      },
      { tabId: targetTabId, msg: tabUploadPlan.chunkMessages(tabResponderId)[0] }
    );

    // Either chrome.tabs.sendMessage failed or the new responder ignored/rejected the mismatched responderId
    const rejectedOrIgnored = continuationReply?.failed || continuationReply?.type === 'rpc:v1:error' || continuationReply === undefined;
    expect(rejectedOrIgnored).toBe(true);

    // New positive call to reloaded tab works
    const freshTabReply = await extensionPage.evaluate(
      async ({ tabId }) => {
        return await window.testApi.callTabViaRequester(tabId, 'echoTab', 'fresh-after-reload');
      },
      { tabId: targetTabId }
    );
    expect(freshTabReply.echo).toBe('fresh-after-reload');
  });

  test('5. Client close and resource expiry: closing client frees session after TTL, allowing fresh transfer', async ({
    context,
    extensionId,
  }) => {
    // bg-expiry-channel has maxSessions: 1, sessionTimeoutMs: 1000
    // 5a. Open Page A and reserve the single available upload session
    const pageA = await context.newPage();
    await pageA.goto(`chrome-extension://${extensionId}/page.html`);
    await pageA.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

    const planA = createManualUploadPlan('bg-expiry-channel', 'echoLargeJson', ['page-a-data'], 50);
    const startA: any = await pageA.evaluate(async (msg) => {
      return await chrome.runtime.sendMessage(msg);
    }, planA.startMessage);
    expect(startA.type).toBe('rpc:v1:ack-upload');

    // 5b. Open Page B and check stats
    const pageB = await context.newPage();
    await pageB.goto(`chrome-extension://${extensionId}/page.html`);
    await pageB.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

    const statsInitial = await pageB.evaluate(async () => {
      return await window.testApi.callBgViaExpiryRequester('getExpiryStats');
    });
    expect(statsInitial.totalSessions).toBe(1);

    // Page B attempts second concurrent transfer -> rejected by maxSessions: 1
    const planB = createManualUploadPlan('bg-expiry-channel', 'echoLargeJson', ['page-b-data'], 50);
    const startB: any = await pageB.evaluate(async (msg) => {
      return await chrome.runtime.sendMessage(msg);
    }, planB.startMessage);
    expect(startB.type).toBe('rpc:v1:error');
    expect(startB.error.message).toContain('Max concurrent transfer sessions (1) reached');

    // 5c. Close Page A (client close)
    await pageA.close();

    // 5d. Poll Page B until server session expires (sessionTimeoutMs: 1000)
    let expired = false;
    for (let i = 0; i < 40; i++) {
      const currentStats = await pageB.evaluate(async () => {
        return await window.testApi.callBgViaExpiryRequester('getExpiryStats');
      });
      if (currentStats.totalSessions === 0 && currentStats.totalAccountedBytes === 0) {
        expired = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(expired).toBe(true);

    // 5e. Fresh multi-fragment transfer on Page B now succeeds
    const multiChunkPayload = 'X'.repeat(30000); // crosses multiple 16 KiB chunks
    const freshResult = await pageB.evaluate(async (payload) => {
      return await window.testApi.callBgViaExpiryRequester('echoLargeJson', payload);
    }, multiChunkPayload);
    expect(freshResult).toBe(multiChunkPayload);

    await pageB.close();
  });

  test('6. Service Worker stop: genuine CDP stopWorker after committed effect, in-flight failure, and new call recovery without replay', async ({
    context,
    extensionId,
    extensionPage,
  }) => {
    const callerPage = extensionPage;
    const inspectorPage = await context.newPage();
    await inspectorPage.goto(`chrome-extension://${extensionId}/page.html`);
    await inspectorPage.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

    const cdp = await context.newCDPSession(callerPage);
    try {
      let targetVersionId: string | undefined;
      const expectedScript = `chrome-extension://${extensionId}/background.js`;

      cdp.on('ServiceWorker.workerVersionUpdated', (event: any) => {
        for (const v of event.versions || []) {
          if (v.scriptURL === expectedScript && v.runningStatus === 'running') {
            targetVersionId = v.versionId;
          }
        }
      });

      await cdp.send('ServiceWorker.enable');

      for (let i = 0; i < 30 && !targetVersionId; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(targetVersionId).toBeDefined();

      // Start long-running in-flight call that commits effect before delay
      const inFlightPromise = callerPage.evaluate(async () => {
        try {
          await window.testApi.callBgViaDefaultLargeRequester('delayedEffectMethod', 'sw-kill-42', 8000);
          return { completed: true };
        } catch (err: any) {
          return { completed: false, error: err?.message || String(err) };
        }
      });

      // Poll from inspectorPage until the effect is confirmed COMMITTED in IndexedDB
      let effectCommitted = false;
      for (let i = 0; i < 40; i++) {
        const count = await inspectorPage.evaluate(async () => {
          return await window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'effect-sw-kill-42');
        });
        if (count === 1) {
          effectCommitted = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(effectCommitted).toBe(true);

      // Now stop the actual worker using genuine Chromium CDP command
      await cdp.send('ServiceWorker.stopWorker', { versionId: targetVersionId! });

      // In-flight call must fail boundedly
      const inFlightResult = await inFlightPromise;
      expect(inFlightResult.completed).toBe(false);

      // Wait 300ms, then make a NEW explicit call: Chrome spawns a new SW instance
      await new Promise((r) => setTimeout(r, 300));
      const revivedResult = await callerPage.evaluate(async () => {
        return await window.testApi.callBgViaDefaultLargeRequester('getUser', 'revived-user');
      });
      expect(revivedResult.id).toBe('revived-user');

      // Persisted invocation count remains 1 (NO automatic replay)
      const countAfter = await inspectorPage.evaluate(async () => {
        return await window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'effect-sw-kill-42');
      });
      expect(countAfter).toBe(1);
    } finally {
      await cdp.detach();
      await inspectorPage.close();
    }
  });

  test('7. No method replay: client timeout never replays committed effect, and duplicate complete-upload rejected', async ({
    context,
    extensionId,
    extensionPage,
  }) => {
    // 7a. Client-side message timeout does not replay committed handler
    const timeoutResult = await extensionPage.evaluate(async () => {
      try {
        await window.testApi.callBgWithCustomTimeout(300, 'delayedEffectMethod', 'timeout-noreplay', 2500);
        return { timedOut: false };
      } catch (err: any) {
        return { timedOut: true, message: err?.message || String(err) };
      }
    });

    expect(timeoutResult.timedOut).toBe(true);
    expect(timeoutResult.message).toContain('timed out after 300ms');

    // Poll until handler completes its committed execution
    const inspectorPage = await context.newPage();
    await inspectorPage.goto(`chrome-extension://${extensionId}/page.html`);
    await inspectorPage.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

    await expect.poll(() => inspectorPage.evaluate(() =>
      window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'complete-timeout-noreplay')
    ), { timeout: 4000, intervals: [100] }).toBe(1);

    // After the original handler completes, its effect count is still exactly one.
    const finalCount = await inspectorPage.evaluate(async () => {
      return await window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'effect-timeout-noreplay');
    });
    expect(finalCount).toBe(1);
    await inspectorPage.close();

    // 7b. Duplicate complete-upload rejected and method not re-executed
    const dupPlan = createManualUploadPlan('bg-default-large-channel', 'delayedEffectMethod', ['dup-upload-test', 0], 60);
    const startAck: any = await extensionPage.evaluate(async (msg) => {
      return await chrome.runtime.sendMessage(msg);
    }, dupPlan.startMessage);
    expect(startAck.type).toBe('rpc:v1:ack-upload');
    const responderId = startAck.responderId;

    for (const chunkMsg of dupPlan.chunkMessages(responderId)) {
      const chunkAck: any = await extensionPage.evaluate(async (msg) => {
        return await chrome.runtime.sendMessage(msg);
      }, chunkMsg);
      expect(chunkAck.type).toBe('rpc:v1:ack-chunk');
    }

    // First completion executes method
    const complete1: any = await extensionPage.evaluate(async (msg) => {
      return await chrome.runtime.sendMessage(msg);
    }, dupPlan.completeMessage(responderId));
    expect(complete1.type).toBe('rpc:v1:reply-inline');

    const countAfterFirst = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'effect-dup-upload-test');
    });
    expect(countAfterFirst).toBe(1);

    // Second completion on same transferId rejected
    const complete2: any = await extensionPage.evaluate(async (msg) => {
      return await chrome.runtime.sendMessage(msg);
    }, dupPlan.completeMessage(responderId));
    expect(complete2.type).toBe('rpc:v1:error');
    expect(complete2.error.message).toContain('not found or expired');

    // Method was NOT re-executed
    const countAfterSecond = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaDefaultLargeRequester('getInvocationCount', 'effect-dup-upload-test');
    });
    expect(countAfterSecond).toBe(1);
  });

  test('8. Protocol / budget edges: disabled peer rejection, invalid controls, oversized args, and stream release', async ({
    extensionPage,
  }) => {
    // 8a. Calling opt-out responder with largePayloads rejects before handler execution
    const initialEchoCount = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('getInvocationCount', 'echoLargeJson');
    });

    const optOutPlan = createManualUploadPlan('bg-channel', 'echoLargeJson', ['data'], 50);
    const optOutReply: any = await extensionPage.evaluate(msg => chrome.runtime.sendMessage(msg), optOutPlan.startMessage);

    expect(optOutReply.type).toBe('rpc:v1:error');
    expect(optOutReply.error.message).toContain("Large payloads are disabled on responder for channel 'bg-channel'");

    const echoCountAfter = await extensionPage.evaluate(async () => {
      return await window.testApi.callBgViaRequester('getInvocationCount', 'echoLargeJson');
    });
    expect(echoCountAfter).toBe(initialEchoCount);

    // 8b. Unsupported protocol version rejected synchronously
    const v2Reply: any = await extensionPage.evaluate(async () => {
      return await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            protocol: 'rpc-chrome/v2',
            type: 'rpc:v2:call',
            channel: 'bg-default-large-channel',
          },
          resolve
        );
      });
    });
    expect(v2Reply.type).toBe('rpc:v1:error');
    expect(v2Reply.error.message).toContain("Unsupported protocol version 'rpc-chrome/v2'");

    // 8c. Incomplete upload: complete-upload sent before all chunks uploaded
    const incompletePlan = createManualUploadPlan('bg-default-large-channel', 'echoLargeJson', ['incomplete-data'], 20);
    const incompleteStart = await extensionPage.evaluate(msg => chrome.runtime.sendMessage(msg), incompletePlan.startMessage);
    expect(incompleteStart.type).toBe('rpc:v1:ack-upload');
    const incompleteChunk = await extensionPage.evaluate(msg => chrome.runtime.sendMessage(msg), incompletePlan.chunkMessages(incompleteStart.responderId)[0]);
    expect(incompleteChunk.type).toBe('rpc:v1:ack-chunk');
    const incompleteReply: any = await extensionPage.evaluate(msg => chrome.runtime.sendMessage(msg), incompletePlan.completeMessage(incompleteStart.responderId));

    expect(incompleteReply.type).toBe('rpc:v1:error');
    expect(incompleteReply.error.message).toContain('Payload incomplete');

    // 8d. Local oversized args: client configured with maxTotalBytes: 500 rejects 600-char string locally
    const localOversizedError = await extensionPage.evaluate(async () => {
      try {
        await window.testApi.callBgWithLocalLimit(500, 'echoLargeJson', 'X'.repeat(600));
        return null;
      } catch (err: any) {
        return { name: err.name, message: err.message };
      }
    });

    expect(localOversizedError).not.toBeNull();
    expect(localOversizedError?.name).toBe('RangeError');
    expect(localOversizedError?.message).toContain('exceeds limit');

    // 8e. Stream release: downloading a multi-chunk result releases download session
    await extensionPage.evaluate(async () => {
      // Request 1 MiB result on expiry channel (crosses multiple 16 KiB chunks)
      await window.testApi.callBgViaExpiryRequester('generateLargePayload', 1);
    });

    // Poll until release cleans up download session
    let released = false;
    for (let i = 0; i < 30; i++) {
      const stats = await extensionPage.evaluate(async () => {
        return await window.testApi.callBgViaExpiryRequester('getExpiryStats');
      });
      if (stats.totalSessions === 0 && stats.totalAccountedBytes === 0) {
        released = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(released).toBe(true);
  });
});
