import { expect, type Page, type FrameLocator } from '@playwright/test';

export interface ManualChunk {
  seq: number;
  kind: 'json';
  data: string;
}

export interface ManualUploadPlan {
  transferId: string;
  descriptor: {
    version: 1;
    totalChunks: number;
    jsonChunks: number;
    blobChunks: 0;
    jsonLength: number;
    totalBlobBytes: 0;
    totalBlobs: 0;
    chunkSize: number;
  };
  chunks: ManualChunk[];
  startMessage: {
    protocol: 'rpc-chrome/v1';
    type: 'rpc:v1:start-upload';
    channel: string;
    transferId: string;
    method: string;
    descriptor: any;
  };
  chunkMessages: (responderId: string) => Array<{
    protocol: 'rpc-chrome/v1';
    type: 'rpc:v1:upload-chunk';
    channel: string;
    transferId: string;
    targetResponderId: string;
    chunk: ManualChunk;
  }>;
  completeMessage: (responderId: string) => {
    protocol: 'rpc-chrome/v1';
    type: 'rpc:v1:complete-upload';
    channel: string;
    transferId: string;
    targetResponderId: string;
  };
}

export function createManualUploadPlan(
  channel: string,
  method: string,
  args: unknown[],
  chunkSize = 100
): ManualUploadPlan {
  const transferId = 'manual-transfer-' + Math.random().toString(36).slice(2);
  const manifest = JSON.stringify({ isUndefined: false, root: args, blobs: [] });
  const jsonChunks = Math.max(1, Math.ceil(manifest.length / chunkSize));
  const descriptor: ManualUploadPlan['descriptor'] = {
    version: 1 as const,
    totalChunks: jsonChunks,
    jsonChunks,
    blobChunks: 0 as const,
    jsonLength: manifest.length,
    totalBlobBytes: 0,
    totalBlobs: 0,
    chunkSize,
  };

  const chunks: ManualChunk[] = [];
  for (let seq = 0; seq < jsonChunks; seq++) {
    const start = seq * chunkSize;
    const end = Math.min(start + chunkSize, manifest.length);
    chunks.push({
      seq,
      kind: 'json',
      data: manifest.slice(start, end),
    });
  }

  const startMessage = {
    protocol: 'rpc-chrome/v1' as const,
    type: 'rpc:v1:start-upload' as const,
    channel,
    transferId,
    method,
    descriptor,
  };

  const chunkMessages = (responderId: string) =>
    chunks.map((chunk) => ({
      protocol: 'rpc-chrome/v1' as const,
      type: 'rpc:v1:upload-chunk' as const,
      channel,
      transferId,
      targetResponderId: responderId,
      chunk,
    }));

  const completeMessage = (responderId: string) => ({
    protocol: 'rpc-chrome/v1' as const,
    type: 'rpc:v1:complete-upload' as const,
    channel,
    transferId,
    targetResponderId: responderId,
  });

  return {
    transferId,
    descriptor,
    chunks,
    startMessage,
    chunkMessages,
    completeMessage,
  };
}

type ScopeWithLocator = { locator: (selector: string) => any };

export async function rawFromContent(
  scope: ScopeWithLocator,
  message: unknown,
  timeoutMs = 10000
): Promise<any> {
  const requestId = 'req-' + Math.random().toString(36).slice(2);
  const bridge = scope.locator('#content-bridge');
  const resultEl = scope.locator(`#content-result[data-req-id="${requestId}"][data-status="done"]`);

  await bridge.evaluate(
    (el: HTMLElement, { reqId, msg }: { reqId: string; msg: unknown }) => {
      const res = document.getElementById('content-result');
      if (res) {
        res.removeAttribute('data-req-id');
        res.setAttribute('data-status', 'pending');
      }
      document.dispatchEvent(
        new CustomEvent('test-send-raw-v1', { detail: { requestId: reqId, message: msg } })
      );
    },
    { reqId: requestId, msg: message }
  );

  await expect(resultEl).toBeAttached({ timeout: timeoutMs });
  const rawText = await resultEl.textContent();
  const parsed = JSON.parse(rawText || '{}');
  if (!parsed.success) {
    throw new Error(parsed.error || 'Content bridge error');
  }
  return parsed.reply;
}
