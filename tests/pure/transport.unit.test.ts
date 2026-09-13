import { test, expect } from '@playwright/test';
import {
  ReceiverTransferManager,
  matchesCallerIdentity,
  extractCallerIdentity,
  shouldHandleV1Message,
  resolveTransportOptions,
  normalizePayloadDescriptor,
  validateDescriptorLimits,
  sendWithTimeout,
  sendV1Call,
  sanitizeErrorPayload,
  RPC_V1_PROTOCOL,
  CallerIdentity,
  V1CallInline,
} from '../../src/transport';
import { encodePayload, PayloadDescriptor } from '../../src/codec';
import { Responder } from '../../src/chrome';

test.describe('Transport Unit Tests', () => {
  test('error diagnostics stay bounded even for non-Error throws', () => {
    expect(sanitizeErrorPayload({ message: 42, stack: {} })).toEqual({ message: '[object Object]', stack: undefined });
    expect(sanitizeErrorPayload(Object.create(null))).toEqual({ message: 'Unknown error' });
    const error = sanitizeErrorPayload({ message: 'x'.repeat(10000), stack: 'y'.repeat(10000) });
    expect(error.message).toHaveLength(2048);
    expect(error.stack).toHaveLength(4096);
  });

  test('a reply for a different call is rejected without replay', async () => {
    let calls = 0;
    await expect(sendV1Call(async () => {
      calls++;
      return { protocol: RPC_V1_PROTOCOL, type: 'rpc:v1:reply-inline', channel: 'test', callId: 'wrong-call' };
    }, 'test', 'read', [], true)).rejects.toThrow('callId mismatch');
    expect(calls).toBe(1);
  });

  test('a chunk for a different transfer fails and releases the selected download', async () => {
    const source = encodePayload('x'.repeat(100), { chunkSize: 64 });
    const sent: string[] = [];
    try {
      await expect(sendV1Call(async raw => {
        const msg = raw as { type: string; callId?: string; seq: number };
        sent.push(msg.type);
        if (msg.type === 'rpc:v1:call-inline') return {
          protocol: RPC_V1_PROTOCOL, type: 'rpc:v1:reply-stream', channel: 'test', callId: msg.callId,
          transferId: 'selected', responderId: 'receiver', descriptor: source.descriptor, firstChunk: await source.readChunk(0),
        };
        if (msg.type === 'rpc:v1:pull-chunk') return {
          protocol: RPC_V1_PROTOCOL, type: 'rpc:v1:chunk', channel: 'test', transferId: 'wrong-transfer', chunk: await source.readChunk(msg.seq),
        };
        return {};
      }, 'test', 'read', [], true)).rejects.toThrow('Invalid chunk response');
      expect(sent).toEqual(['rpc:v1:call-inline', 'rpc:v1:pull-chunk', 'rpc:v1:release']);
    } finally {
      source.dispose();
    }
  });

  test('2. shouldHandleV1Message synchronously filters targets and protocol versions', () => {
    const myId = 'responder-alpha';
    const channel = 'my-channel';

    // Different channel -> ignore
    expect(
      shouldHandleV1Message(
        { protocol: RPC_V1_PROTOCOL, channel: 'other-channel', type: 'rpc:v1:call-inline' },
        channel,
        myId
      )
    ).toEqual({ handle: false, reason: 'ignore' });

    // Targeted at another responder -> ignore synchronously
    expect(
      shouldHandleV1Message(
        { protocol: RPC_V1_PROTOCOL, channel, type: 'rpc:v1:upload-chunk', targetResponderId: 'responder-beta' },
        channel,
        myId
      )
    ).toEqual({ handle: false, reason: 'ignore' });

    // Targeted at my responder -> accept
    expect(
      shouldHandleV1Message(
        { protocol: RPC_V1_PROTOCOL, channel, type: 'rpc:v1:upload-chunk', targetResponderId: myId },
        channel,
        myId
      )
    ).toEqual({ handle: true, reason: 'ok' });

    // Untargeted initial call -> accept
    expect(
      shouldHandleV1Message(
        { protocol: RPC_V1_PROTOCOL, channel, type: 'rpc:v1:call-inline', method: 'test' },
        channel,
        myId
      )
    ).toEqual({ handle: true, reason: 'ok' });

    // Unsupported protocol version aimed at this channel -> flag for synchronous rejection
    expect(
      shouldHandleV1Message(
        { protocol: 'rpc-chrome/v2', channel, type: 'rpc:v2:call' },
        channel,
        myId
      )
    ).toEqual({ handle: true, reason: 'unsupported_protocol' });
  });

  test('3. Caller identity matching strictly fails closed for both tab and extension contexts', () => {
    // Tab callers
    const tabOwner: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 10,
      frameId: 0,
      documentId: 'doc-tab-1',
    };
    const tabSame: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 10,
      frameId: 0,
      documentId: 'doc-tab-1',
    };
    const tabDiffDoc: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 10,
      frameId: 0,
      documentId: 'doc-tab-2',
    };
    const tabMissingDoc: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 10,
      frameId: 0,
    };
    const tabDiffFrame: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 10,
      frameId: 1,
      documentId: 'doc-tab-1',
    };

    expect(matchesCallerIdentity(tabOwner, tabSame)).toBe(true);
    expect(matchesCallerIdentity(tabOwner, tabDiffDoc)).toBe(false);
    expect(matchesCallerIdentity(tabOwner, tabMissingDoc)).toBe(false);
    expect(matchesCallerIdentity(tabOwner, tabDiffFrame)).toBe(false);

    // Extension page callers (e.g. popup vs options page)
    const extDocOwner: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      documentId: 'doc-popup-A',
      url: 'chrome-extension://ext1/popup.html',
    };
    const extDocSame: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      documentId: 'doc-popup-A',
      url: 'chrome-extension://ext1/popup.html',
    };
    const extDocOptions: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      documentId: 'doc-options-B',
      url: 'chrome-extension://ext1/options.html',
    };
    const extMissingDoc: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      url: 'chrome-extension://ext1/popup.html',
    };

    expect(matchesCallerIdentity(extDocOwner, extDocSame)).toBe(true);
    // Different extension document fails
    expect(matchesCallerIdentity(extDocOwner, extDocOptions)).toBe(false);
    // Missing documentId when owner specified it fails closed
    expect(matchesCallerIdentity(extDocOwner, extMissingDoc)).toBe(false);

    // URL fallback when documentId is absent from owner
    const extUrlOwner: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      url: 'chrome-extension://ext1/page.html',
    };
    const extUrlSame: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      url: 'chrome-extension://ext1/page.html',
    };
    const extUrlDiff: CallerIdentity = {
      type: 'extension',
      extensionId: 'ext1',
      url: 'chrome-extension://ext1/other.html',
    };
    expect(matchesCallerIdentity(extUrlOwner, extUrlSame)).toBe(true);
    expect(matchesCallerIdentity(extUrlOwner, extUrlDiff)).toBe(false);

    // Tab vs Extension mismatch
    expect(matchesCallerIdentity(tabOwner, extDocOwner)).toBe(false);
  });

  test('4. Authenticated release and abort prevent unauthorized session cancellation', async () => {
    const manager = new ReceiverTransferManager();
    const authorizedOwner: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 5,
      documentId: 'doc1',
    };
    const attacker: CallerIdentity = {
      type: 'tab',
      extensionId: 'ext1',
      tabId: 6,
      documentId: 'doc2',
    };

    // 4a. Upload session abort authorization
    const sourceUpload = encodePayload(['secret-data']);
    manager.createUploadSession('t-up', 'method1', sourceUpload.descriptor, authorizedOwner);

    // Attacker cannot abort owner's upload session
    expect(() => manager.abortUploadSession('t-up', attacker)).toThrow(/Caller identity mismatch/);
    expect(manager.totalSessions).toBe(1);

    // Owner can upload chunks
    manager.acceptUploadChunk('t-up', await sourceUpload.readChunk(0), authorizedOwner);
    expect(manager.totalSessions).toBe(1);

    // Authorized owner can abort
    manager.abortUploadSession('t-up', authorizedOwner);
    expect(manager.totalSessions).toBe(0);
    sourceUpload.dispose();

    // 4b. Download session release authorization
    const sourceDownload = encodePayload(['result-payload']);
    manager.createDownloadSession('t-down', sourceDownload, authorizedOwner);
    expect(manager.totalSessions).toBe(1);

    // Attacker cannot release owner's download session
    expect(() => manager.releaseDownloadSession('t-down', attacker)).toThrow(/Caller identity mismatch/);
    expect(manager.totalSessions).toBe(1);

    // Owner can read chunk
    const chunk = await manager.readDownloadChunk('t-down', 0, authorizedOwner);
    expect(chunk.kind).toBe('json');

    // Authorized owner releases
    manager.releaseDownloadSession('t-down', authorizedOwner);
    expect(manager.totalSessions).toBe(0);

    manager.dispose();
  });

  test('5. TransportOptions and Descriptor validation and normalization fail deterministically on bad input', () => {
    // Bad options
    expect(() => resolveTransportOptions({ maxSessions: -5 })).toThrow(TypeError);
    expect(() => resolveTransportOptions({ chunkSize: 1 })).toThrow(RangeError); // < MIN_CHUNK_SIZE (4)
    expect(() => resolveTransportOptions({ sessionTimeoutMs: 3_000_000_000 })).toThrow(RangeError); // > MAX_TIMER_MS

    const validOpts = resolveTransportOptions({ chunkSize: 16384, sessionTimeoutMs: 5000 });
    expect(validOpts.chunkSize).toBe(16384);
    expect(validOpts.sessionTimeoutMs).toBe(5000);

    // Normalizing descriptor strips unknown keys and validates numeric fields
    const untrustedDesc = {
      version: 1,
      totalChunks: 2,
      jsonChunks: 1,
      blobChunks: 1,
      jsonLength: 50,
      totalBlobBytes: 100,
      totalBlobs: 1,
      chunkSize: 100,
      extraMaliciousProperty: { deeply: 'nested' },
    };
    const cleanDesc = normalizePayloadDescriptor(untrustedDesc);
    expect('extraMaliciousProperty' in cleanDesc).toBe(false);
    expect(cleanDesc.totalChunks).toBe(2);

    // Validate descriptor limits
    expect(() =>
      validateDescriptorLimits(cleanDesc, resolveTransportOptions({ maxTotalBytes: 50 }))
    ).toThrow(RangeError);
  });

  test('6. Decoding failure during chunk acceptance cleans up session immediately', async () => {
    const manager = new ReceiverTransferManager();
    const caller: CallerIdentity = { type: 'extension', extensionId: 'ext1' };

    const source = encodePayload('test-data', { chunkSize: 10 });
    manager.createUploadSession('t-corrupt', 'methodX', source.descriptor, caller);
    expect(manager.totalSessions).toBe(1);

    // Feed a malformed chunk (seq out of order)
    expect(() =>
      manager.acceptUploadChunk('t-corrupt', { seq: 5, kind: 'json', data: 'corrupt' }, caller)
    ).toThrow();

    // Session is removed immediately on corruption without lingering until TTL
    expect(manager.totalSessions).toBe(0);
    expect(manager.totalAccountedBytes).toBe(0);

    source.dispose();
    manager.dispose();
  });

  test('7. sendWithTimeout bounds message wait and clears timer on settle', async () => {
    // Fast resolving sendFn
    const fastFn = async () => 'pong';
    const result = await sendWithTimeout(fastFn, { ping: true }, 500);
    expect(result).toBe('pong');

    // Never resolving sendFn (simulates peer ignoring message)
    const hangingFn = () => new Promise(() => {});
    await expect(sendWithTimeout(hangingFn, { ping: true }, 50)).rejects.toThrow(
      /timed out after 50ms/
    );
  });

  test('8. External v1 messages are explicitly rejected without buffering or running handlers', async () => {
    let mockExternalListener: any = null;
    const fakeChrome = {
      runtime: {
        onMessage: { addListener: () => {}, removeListener: () => {} },
        onMessageExternal: {
          removeListener: () => {},
          addListener: (fn: any) => {
            mockExternalListener = fn;
          },
        },
      },
    };
    (globalThis as any).chrome = fakeChrome;

    let handlerCalled = false;
    const responder = new Responder<{ secretOp: () => string }>('ext-channel', {
      external: true,
      largePayloads: true,
    });
    responder.subscribe('secretOp', () => {
      handlerCalled = true;
      return 'secret-data';
    });

    expect(mockExternalListener).not.toBeNull();

    let replyResult: any = null;
    const sendResponse = (res: any) => {
      replyResult = res;
    };

    const externalV1Call: V1CallInline = {
      protocol: RPC_V1_PROTOCOL,
      type: 'rpc:v1:call-inline',
      channel: 'ext-channel',
      callId: 'call-ext',
      method: 'secretOp',
      descriptor: {
        version: 1,
        totalChunks: 1,
        jsonChunks: 1,
        blobChunks: 0,
        jsonLength: 10,
        totalBlobBytes: 0,
        totalBlobs: 0,
        chunkSize: 100,
      },
      chunk: { seq: 0, kind: 'json', data: '{"root":[]}' },
    };

    const handled = mockExternalListener(externalV1Call, { id: 'other-ext-id' }, sendResponse);
    expect(handled).toBe(true);
    expect(handlerCalled).toBe(false);
    expect(replyResult).toEqual({
      protocol: RPC_V1_PROTOCOL,
      type: 'rpc:v1:error',
      channel: 'ext-channel',
      error: { message: 'External chunked transfers are not supported in rpc-chrome/v1' },
    });

    responder.dispose();
  });
});
