import { Requester, RuntimeRequester, ContentScriptRequester, Responder } from '../../dist/index.mjs';
import type { BackgroundMethods, TabMethods, PageMethods } from './types';

// Baseline requesters
const bgRuntimeRequester = new RuntimeRequester<BackgroundMethods>('bg-channel');
const bgRequester = new Requester<BackgroundMethods>('bg-channel');
const bgRequesterWithQueryInfo = new Requester<BackgroundMethods>('bg-channel', {});
const tabRequester = new Requester<TabMethods>('tab-channel');
const tabContentScriptRequester = new ContentScriptRequester<TabMethods>('tab-channel', {});

// Opt-in large payload requesters (16 KiB chunks)
const bgLargeRuntimeRequester = new RuntimeRequester<BackgroundMethods>('bg-large-channel', {
  largePayloads: { chunkSize: 16 * 1024 },
});
const bgLargeRequester = new Requester<BackgroundMethods>('bg-large-channel', undefined, {
  largePayloads: { chunkSize: 16 * 1024 },
});
const tabLargeRequester = new Requester<TabMethods>('tab-large-channel', undefined, {
  largePayloads: { chunkSize: 16 * 1024 },
});
const tabLargeContentScriptRequester = new ContentScriptRequester<TabMethods>('tab-large-channel', {}, {
  largePayloads: { chunkSize: 16 * 1024 },
});

// Default large payload requesters (256 KiB chunks) for >64 MiB acceptance tests
const bgDefaultLargeRequester = new Requester<BackgroundMethods>('bg-default-large-channel', undefined, {
  largePayloads: true,
});
const bgDefaultLargeRuntimeRequester = new RuntimeRequester<BackgroundMethods>('bg-default-large-channel', {
  largePayloads: true,
});

// Expiry requester with 1s timeout and maxSessions: 1
const bgExpiryRequester = new Requester<BackgroundMethods>('bg-expiry-channel', undefined, {
  largePayloads: { maxSessions: 1, sessionTimeoutMs: 1000, chunkSize: 16 * 1024 },
});

const pageResponder = new Responder<PageMethods>('page-channel');
pageResponder.subscribe('pingPage', () => {
  return { fromPage: true };
});

declare global {
  interface Window {
    testApi: {
      callBgViaRuntimeRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgViaRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgViaRequesterWithQueryInfo: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callTabViaRequester: <M extends keyof TabMethods>(tabId: number, method: M, ...args: any[]) => Promise<any>;
      callTabsViaContentScriptRequester: <M extends keyof TabMethods>(method: M, ...args: any[]) => Promise<any>;

      // Large payload APIs
      callBgViaLargeRuntimeRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgViaLargeRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callTabViaLargeRequester: <M extends keyof TabMethods>(tabId: number, method: M, ...args: any[]) => Promise<any>;
      callTabsViaLargeContentScriptRequester: <M extends keyof TabMethods>(method: M, ...args: any[]) => Promise<any>;

      // Acceptance APIs (Task 4)
      callBgViaDefaultLargeRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgViaDefaultLargeRuntimeRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgViaExpiryRequester: <M extends keyof BackgroundMethods>(method: M, ...args: any[]) => Promise<any>;
      callBgWithCustomTimeout: <M extends keyof BackgroundMethods>(timeoutMs: number, method: M, ...args: any[]) => Promise<any>;
      callBgWithLocalLimit: <M extends keyof BackgroundMethods>(maxTotalBytes: number, method: M, ...args: any[]) => Promise<any>;
    };
  }
}

window.testApi = {
  callBgViaRuntimeRequester: (method, ...args) => bgRuntimeRequester.call(method as any, ...args),
  callBgViaRequester: (method, ...args) => bgRequester.call(method as any, ...args),
  callBgViaRequesterWithQueryInfo: (method, ...args) => bgRequesterWithQueryInfo.call(method as any, ...args),
  callTabViaRequester: (tabId, method, ...args) => tabRequester.callTab(tabId, method as any, ...args),
  callTabsViaContentScriptRequester: (method, ...args) => tabContentScriptRequester.call(method as any, ...args),

  callBgViaLargeRuntimeRequester: (method, ...args) => bgLargeRuntimeRequester.call(method as any, ...args),
  callBgViaLargeRequester: (method, ...args) => bgLargeRequester.call(method as any, ...args),
  callTabViaLargeRequester: (tabId, method, ...args) => tabLargeRequester.callTab(tabId, method as any, ...args),
  callTabsViaLargeContentScriptRequester: (method, ...args) => tabLargeContentScriptRequester.call(method as any, ...args),

  callBgViaDefaultLargeRequester: (method, ...args) => bgDefaultLargeRequester.call(method as any, ...args),
  callBgViaDefaultLargeRuntimeRequester: (method, ...args) => bgDefaultLargeRuntimeRequester.call(method as any, ...args),
  callBgViaExpiryRequester: (method, ...args) => bgExpiryRequester.call(method as any, ...args),
  callBgWithCustomTimeout: (timeoutMs, method, ...args) => {
    const customReq = new Requester<BackgroundMethods>('bg-default-large-channel', undefined, {
      largePayloads: { messageTimeoutMs: timeoutMs },
    });
    return customReq.call(method as any, ...args);
  },
  callBgWithLocalLimit: (maxTotalBytes, method, ...args) => {
    const limitedReq = new Requester<BackgroundMethods>('bg-default-large-channel', undefined, {
      largePayloads: { maxTotalBytes },
    });
    return limitedReq.call(method as any, ...args);
  },
};

const statusEl = document.getElementById('status');
if (statusEl) {
  statusEl.textContent = 'ready';
}
