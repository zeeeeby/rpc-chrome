import { Responder, Requester, ContentScriptRequester } from '../../dist/index.mjs';
import type { BackgroundMethods, TabMethods, UserData } from './types';

// Baseline opt-out responder
const bgResponder = new Responder<BackgroundMethods>('bg-channel');
const tabRequesterFromBg = new Requester<TabMethods>('tab-channel');
const csRequesterFromBg = new ContentScriptRequester<TabMethods>('tab-channel', {});

// Opt-in large payload responder (16 KiB chunks)
const bgLargeResponder = new Responder<BackgroundMethods>('bg-large-channel', {
  largePayloads: { chunkSize: 16 * 1024, sessionTimeoutMs: 10000 },
});
const tabLargeRequesterFromBg = new Requester<TabMethods>('tab-large-channel', undefined, {
  largePayloads: { chunkSize: 16 * 1024 },
});
const csLargeRequesterFromBg = new ContentScriptRequester<TabMethods>('tab-large-channel', {}, {
  largePayloads: { chunkSize: 16 * 1024 },
});

// Default large payload responder (256 KiB chunks) for >64 MiB acceptance tests
const bgDefaultLargeResponder = new Responder<BackgroundMethods>('bg-default-large-channel', {
  largePayloads: true,
});

// Expiry-limited responder for session lifecycle tests
const bgExpiryResponder = new Responder<BackgroundMethods>('bg-expiry-channel', {
  largePayloads: { maxSessions: 1, sessionTimeoutMs: 1000, chunkSize: 16 * 1024 },
});

// IndexedDB counter helper for Task 4 restart assertions
function openCountersDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rpc-test-counters', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('counters', { keyPath: 'method' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recordInvocation(method: string): Promise<number> {
  const db = await openCountersDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('counters', 'readwrite');
    const store = tx.objectStore('counters');
    const getReq = store.get(method);
    getReq.onsuccess = () => {
      const current = (getReq.result?.count || 0) + 1;
      store.put({ method, count: current });
      tx.oncomplete = () => resolve(current);
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function getInvocationCount(method: string): Promise<number> {
  const db = await openCountersDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('counters', 'readonly');
    const store = tx.objectStore('counters');
    const getReq = store.get(method);
    getReq.onsuccess = () => resolve(getReq.result?.count || 0);
    tx.onerror = () => reject(tx.error);
  });
}

// Native IndexedDB media store helper
function openMediaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rpc-test-media', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('media', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const methodDelays = new Map<string, number>();

function registerCommonHandlers(r: Responder<BackgroundMethods>) {
  r.subscribe('ping', () => {
    return { pong: true, timestamp: Date.now() };
  });

  r.subscribe('getUser', (id: string): UserData => {
    return {
      id,
      name: `User ${id}`,
      role: 'admin',
      preferences: {
        theme: 'dark',
        notifications: true,
      },
    };
  });

  r.subscribe('echo', (payload) => {
    return {
      received: payload,
      sender: 'background',
    };
  });

  r.subscribe('failingMethod', (shouldFail: boolean) => {
    if (shouldFail) {
      throw new Error('User handler error in failingMethod');
    }
    return 'ok';
  });

  r.subscribe('callTabFromBg', async (tabId: number, text: string) => {
    return await tabRequesterFromBg.callTab(tabId, 'echoTab', text);
  });

  r.subscribe('callAllTabsFromBg', async (text: string) => {
    return await csRequesterFromBg.call('echoTab', text);
  });

  r.subscribe('callTabLargeFromBg', async (tabId: number, text: string) => {
    return await tabLargeRequesterFromBg.callTab(tabId, 'echoTab', text);
  });

  r.subscribe('callAllTabsLargeFromBg', async (text: string) => {
    return await csLargeRequesterFromBg.call('echoTab', text);
  });

  r.subscribe('echoLargeJson', async (payload: unknown) => {
    await recordInvocation('echoLargeJson');
    const delay = methodDelays.get('echoLargeJson');
    if (delay) await new Promise((res) => setTimeout(res, delay));
    return payload;
  });

  r.subscribe('echoBlob', async (payload: { label: string; blob: Blob }) => {
    await recordInvocation('echoBlob');
    const delay = methodDelays.get('echoBlob');
    if (delay) await new Promise((res) => setTimeout(res, delay));
    return {
      label: `echo-${payload.label}`,
      blob: payload.blob,
      size: payload.blob.size,
    };
  });

  r.subscribe(
    'nestedBlobRoundtrip',
    async (payload: { title: string; files: Array<{ name: string; content: Blob }> }) => {
      await recordInvocation('nestedBlobRoundtrip');
      return {
        title: `processed-${payload.title}`,
        files: payload.files.map((f) => ({
          name: `echo-${f.name}`,
          content: f.content,
        })),
        count: payload.files.length,
      };
    }
  );

  r.subscribe('returnUndefined', async () => {
    await recordInvocation('returnUndefined');
    return undefined;
  });

  r.subscribe('getInvocationCount', async (method: string) => {
    return await getInvocationCount(method);
  });

  r.subscribe('setMethodDelay', async (method: string, delayMs: number) => {
    if (delayMs <= 0) methodDelays.delete(method);
    else methodDelays.set(method, delayMs);
    return { ok: true };
  });

  r.subscribe('verifyLargePayload', async (payload: { text: string; expectedLength: number }) => {
    await recordInvocation('verifyLargePayload');
    const len = payload.text.length;
    if (len !== payload.expectedLength) {
      throw new Error(`Length mismatch: expected ${payload.expectedLength}, got ${len}`);
    }
    const head = payload.text.slice(0, 12);
    const tail = payload.text.slice(-10);
    if (!head.startsWith('LARGE-START-') || !tail.endsWith('-LARGE-END')) {
      throw new Error(`Boundary mismatch: head=${head}, tail=${tail}`);
    }
    for (let pos = 1024 * 1024; pos < len - 1024 * 1024; pos += 1024 * 1024) {
      const expectedChar = String.fromCharCode(65 + ((pos / (1024 * 1024)) % 26));
      if (payload.text[pos] !== expectedChar) {
        throw new Error(`Sample mismatch at ${pos}: expected ${expectedChar}, got ${payload.text[pos]}`);
      }
    }
    return {
      length: len,
      head,
      tail,
      verified: true,
    };
  });

  r.subscribe('generateLargePayload', async (sizeMb: number) => {
    await recordInvocation('generateLargePayload');
    const totalLength = sizeMb * 1024 * 1024;
    const blockSize = 1024 * 1024;
    const blocks: string[] = [];
    for (let b = 0; b < sizeMb; b++) {
      const char = String.fromCharCode(65 + (b % 26));
      if (b === 0) {
        blocks.push('RES-START---' + char.repeat(blockSize - 12));
      } else if (b === sizeMb - 1) {
        blocks.push(char.repeat(blockSize - 10) + '-RES-END--');
      } else {
        blocks.push(char.repeat(blockSize));
      }
    }
    const text = blocks.join('');
    return {
      length: text.length,
      text,
    };
  });

  r.subscribe('putMedia', async (payload: { id: string; blob: Blob; tags: string[] }) => {
    await recordInvocation('putMedia');
    const db = await openMediaDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readwrite');
      const store = tx.objectStore('media');
      store.put({
        id: payload.id,
        blob: payload.blob,
        tags: payload.tags,
        savedAt: Date.now(),
      });
      tx.oncomplete = () => resolve({ success: true, id: payload.id });
      tx.onerror = () => reject(tx.error);
    });
  });

  r.subscribe('getMedia', async (id: string) => {
    await recordInvocation('getMedia');
    const db = await openMediaDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('media', 'readonly');
      const store = tx.objectStore('media');
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        if (!getReq.result) {
          resolve(null);
          return;
        }
        resolve({
          id: getReq.result.id,
          blob: getReq.result.blob,
          tags: getReq.result.tags,
        });
      };
      tx.onerror = () => reject(tx.error);
    });
  });

  r.subscribe('delayedEffectMethod', async (id: string, delayMs: number) => {
    await recordInvocation(`effect-${id}`);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await recordInvocation(`complete-${id}`);
    return { executed: true };
  });

  r.subscribe('callTabSlowFromBg', async (tabId: number, text: string, delayMs: number) => {
    return await tabRequesterFromBg.callTab(tabId, 'slowTabEcho', text, delayMs);
  });
}

registerCommonHandlers(bgResponder);
registerCommonHandlers(bgLargeResponder);
registerCommonHandlers(bgDefaultLargeResponder);
registerCommonHandlers(bgExpiryResponder);

bgExpiryResponder.subscribe('getExpiryStats', async () => {
  const tm = (bgExpiryResponder as any).transferManager;
  return {
    totalSessions: tm?.totalSessions ?? 0,
    totalAccountedBytes: tm?.totalAccountedBytes ?? 0,
  };
});

// --- Deterministic Named Handler Subscription Testing on bgResponder ---
bgResponder.subscribe('testNamedTarget', () => {
  return { source: 'base-named', version: 1 };
});

let removeNamedFn: (() => void) | null = null;

bgResponder.subscribe('addOverrideHandler', () => {
  if (!removeNamedFn) {
    removeNamedFn = bgResponder.subscribe('testNamedTarget', () => {
      return { source: 'override-named', version: 2 };
    });
  }
  return { registered: true };
});

bgResponder.subscribe('removeOverrideHandler', () => {
  if (removeNamedFn) {
    removeNamedFn();
    removeNamedFn = null;
  }
  return { unregistered: true };
});

// --- Deterministic Universal Handler Subscription Testing on bgResponder ---
bgResponder.subscribeUniversal(((name: string, args: unknown[]) => {
  if (name === 'testUniversalTarget') {
    const [x, y] = args as [number, number];
    return { sum: x + y, source: 'base-universal' };
  }
  return undefined;
}) as any);

let removeUniversalFn: (() => void) | null = null;

bgResponder.subscribe('addUniversalOverride', () => {
  if (!removeUniversalFn) {
    removeUniversalFn = bgResponder.subscribeUniversal(((name: string, args: unknown[]) => {
      if (name === 'testUniversalTarget') {
        const [x, y] = args as [number, number];
        return { sum: (x + y) * 10, source: 'override-universal' };
      }
      return undefined;
    }) as any);
  }
  return { registered: true };
});

bgResponder.subscribe('removeUniversalOverride', () => {
  if (removeUniversalFn) {
    removeUniversalFn();
    removeUniversalFn = null;
  }
  return { unregistered: true };
});
