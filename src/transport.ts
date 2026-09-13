// Shared transport implementation for rpc-chrome/v1 chunked protocol.
import {
  encodePayload,
  estimatePayloadMemory,
  PayloadDescriptor,
  PayloadChunk,
  PayloadSource,
  PayloadDecoder,
  MIN_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
} from './codec';

export const RPC_V1_PROTOCOL = 'rpc-chrome/v1';

export interface TransportOptions {
  chunkSize?: number; // default: 256 Ki code units / chars
  maxTotalBytes?: number; // default: 512 MiB total accounted payload budget
  maxChunks?: number; // default: 100_000
  maxBlobs?: number; // default: 10_000
  maxJsonLength?: number; // default: 128 Mi code units
  sessionTimeoutMs?: number; // default: 30_000 ms inactivity
  messageTimeoutMs?: number; // default: 10_000 ms per message exchange
  maxSessions?: number; // default: 100 concurrent transfer sessions
}

export type LargePayloadOptions = TransportOptions;

export interface RequesterOptions {
  largePayloads?: boolean | LargePayloadOptions;
}

export interface ResponderConfig {
  external?: boolean;
  largePayloads?: boolean | LargePayloadOptions;
}

export const DEFAULT_TRANSPORT_OPTIONS: Required<TransportOptions> = {
  chunkSize: 256 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxChunks: 100_000,
  maxBlobs: 10_000,
  maxJsonLength: 128 * 1024 * 1024,
  sessionTimeoutMs: 30_000,
  messageTimeoutMs: 10_000,
  maxSessions: 100,
};

export const MAX_METADATA_STRING_LENGTH = 1024;
const MAX_TIMER_MS = 2147483647; // 2^31 - 1, maximum JS setTimeout delay

function validatePositiveInt(val: unknown, name: string, max?: number): number {
  if (typeof val !== 'number' || !Number.isSafeInteger(val) || val <= 0) {
    throw new TypeError(`Option '${name}' must be a positive safe integer`);
  }
  if (max !== undefined && val > max) {
    throw new RangeError(`Option '${name}' (${val}) exceeds maximum allowed (${max})`);
  }
  return val;
}

export function resolveTransportOptions(
  opt?: boolean | LargePayloadOptions
): Required<TransportOptions> {
  if (typeof opt === 'object' && opt !== null) {
    const chunkSize =
      opt.chunkSize !== undefined
        ? validatePositiveInt(opt.chunkSize, 'chunkSize', MAX_CHUNK_SIZE)
        : DEFAULT_TRANSPORT_OPTIONS.chunkSize;
    if (chunkSize < MIN_CHUNK_SIZE) {
      throw new RangeError(`chunkSize must be at least ${MIN_CHUNK_SIZE}`);
    }

    return {
      chunkSize,
      maxTotalBytes:
        opt.maxTotalBytes !== undefined
          ? validatePositiveInt(opt.maxTotalBytes, 'maxTotalBytes')
          : DEFAULT_TRANSPORT_OPTIONS.maxTotalBytes,
      maxChunks:
        opt.maxChunks !== undefined
          ? validatePositiveInt(opt.maxChunks, 'maxChunks', 1_000_000)
          : DEFAULT_TRANSPORT_OPTIONS.maxChunks,
      maxBlobs:
        opt.maxBlobs !== undefined
          ? validatePositiveInt(opt.maxBlobs, 'maxBlobs', 100_000)
          : DEFAULT_TRANSPORT_OPTIONS.maxBlobs,
      maxJsonLength:
        opt.maxJsonLength !== undefined
          ? validatePositiveInt(opt.maxJsonLength, 'maxJsonLength')
          : DEFAULT_TRANSPORT_OPTIONS.maxJsonLength,
      sessionTimeoutMs:
        opt.sessionTimeoutMs !== undefined
          ? validatePositiveInt(opt.sessionTimeoutMs, 'sessionTimeoutMs', MAX_TIMER_MS)
          : DEFAULT_TRANSPORT_OPTIONS.sessionTimeoutMs,
      messageTimeoutMs:
        opt.messageTimeoutMs !== undefined
          ? validatePositiveInt(opt.messageTimeoutMs, 'messageTimeoutMs', MAX_TIMER_MS)
          : DEFAULT_TRANSPORT_OPTIONS.messageTimeoutMs,
      maxSessions:
        opt.maxSessions !== undefined
          ? validatePositiveInt(opt.maxSessions, 'maxSessions', 10_000)
          : DEFAULT_TRANSPORT_OPTIONS.maxSessions,
    };
  }
  return { ...DEFAULT_TRANSPORT_OPTIONS };
}

export function validateMetadataString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_METADATA_STRING_LENGTH) {
    throw new TypeError(
      `Invalid ${name}: must be a non-empty string under ${MAX_METADATA_STRING_LENGTH} chars`
    );
  }
  return value;
}

export function sanitizeErrorPayload(e: unknown): { message: string; stack?: string } {
  try {
    const raw = e as { message?: unknown; stack?: unknown } | null;
    return {
      message: (typeof raw?.message === 'string' ? raw.message : String(e)).slice(0, 2048),
      stack: typeof raw?.stack === 'string' ? raw.stack.slice(0, 4096) : undefined,
    };
  } catch {
    return { message: 'Unknown error' };
  }
}

// Normalize untrusted descriptors to known numeric fields before storing
export function normalizePayloadDescriptor(desc: unknown): PayloadDescriptor {
  if (typeof desc !== 'object' || desc === null) {
    throw new TypeError('Invalid payload descriptor: must be an object');
  }
  const d = desc as Record<string, unknown>;
  if (d.version !== 1) {
    throw new Error(`Unsupported descriptor version: ${String(d.version)}`);
  }

  const requiredFields: Array<keyof PayloadDescriptor> = [
    'totalChunks',
    'jsonChunks',
    'blobChunks',
    'jsonLength',
    'totalBlobBytes',
    'totalBlobs',
    'chunkSize',
  ];
  for (const field of requiredFields) {
    const val = d[field];
    if (typeof val !== 'number' || !Number.isSafeInteger(val) || val < 0) {
      throw new TypeError(`Invalid descriptor field '${field}': must be a non-negative safe integer`);
    }
  }

  return {
    version: 1,
    totalChunks: d.totalChunks as number,
    jsonChunks: d.jsonChunks as number,
    blobChunks: d.blobChunks as number,
    jsonLength: d.jsonLength as number,
    totalBlobBytes: d.totalBlobBytes as number,
    totalBlobs: d.totalBlobs as number,
    chunkSize: d.chunkSize as number,
  };
}

export function validateDescriptorLimits(
  desc: PayloadDescriptor,
  options: Required<TransportOptions>
): void {
  if (desc.totalChunks > options.maxChunks) {
    throw new RangeError(`Descriptor totalChunks (${desc.totalChunks}) exceeds limit (${options.maxChunks})`);
  }
  if (desc.totalBlobs > options.maxBlobs) {
    throw new RangeError(`Descriptor totalBlobs (${desc.totalBlobs}) exceeds limit (${options.maxBlobs})`);
  }
  if (desc.jsonLength > options.maxJsonLength) {
    throw new RangeError(`Descriptor jsonLength (${desc.jsonLength}) exceeds limit (${options.maxJsonLength})`);
  }
  const accounted = estimatePayloadMemory(desc.jsonLength, desc.totalBlobBytes);
  if (accounted > options.maxTotalBytes) {
    throw new RangeError(`Accounted payload bytes (${accounted}) exceeds limit (${options.maxTotalBytes})`);
  }
}

// Trusted sender context identity
export interface CallerIdentity {
  type: 'tab' | 'extension';
  extensionId?: string;
  tabId?: number;
  frameId?: number;
  documentId?: string;
  url?: string;
}

export function extractCallerIdentity(sender: chrome.runtime.MessageSender): CallerIdentity {
  const isTab = sender.tab && sender.tab.id !== undefined && sender.tab.id !== -1;
  return {
    type: isTab ? 'tab' : 'extension',
    extensionId: sender.id,
    tabId: isTab ? sender.tab!.id : undefined,
    frameId: sender.frameId,
    documentId: (sender as any).documentId,
    url: sender.url,
  };
}

// Strict fail-closed caller comparison
export function matchesCallerIdentity(owner: CallerIdentity, candidate: CallerIdentity): boolean {
  if (owner.type !== candidate.type) return false;
  if (owner.extensionId !== candidate.extensionId) return false;

  if (owner.type === 'tab') {
    if (owner.tabId !== candidate.tabId) return false;
    if (owner.documentId !== undefined && candidate.documentId !== owner.documentId) return false;
    if (owner.frameId !== undefined && candidate.frameId !== owner.frameId) return false;
    return true;
  }

  // Extension context (e.g. extension page, popup, options, SW)
  if (owner.documentId !== undefined) {
    if (candidate.documentId !== owner.documentId) return false;
  } else if (owner.url !== undefined) {
    if (candidate.url !== owner.url) return false;
  }

  if (owner.frameId !== undefined && candidate.frameId !== owner.frameId) return false;

  return true;
}

// Synchronous envelope inspection to distinguish messages this responder owns from ones it must ignore
export function shouldHandleV1Message(
  msg: unknown,
  channel: string,
  responderId: string
): { handle: boolean; reason: 'ignore' | 'unsupported_protocol' | 'ok' } {
  if (typeof msg !== 'object' || msg === null) return { handle: false, reason: 'ignore' };
  const anyMsg = msg as Record<string, unknown>;
  if (anyMsg.channel !== channel) return { handle: false, reason: 'ignore' };

  if (typeof anyMsg.protocol === 'string' && anyMsg.protocol.startsWith('rpc-chrome/')) {
    if (anyMsg.protocol !== RPC_V1_PROTOCOL) {
      if (typeof anyMsg.targetResponderId === 'string' && anyMsg.targetResponderId !== responderId) {
        return { handle: false, reason: 'ignore' };
      }
      return { handle: true, reason: 'unsupported_protocol' };
    }
  } else {
    return { handle: false, reason: 'ignore' };
  }

  if (typeof anyMsg.targetResponderId === 'string' && anyMsg.targetResponderId !== responderId) {
    return { handle: false, reason: 'ignore' };
  }

  if (typeof anyMsg.type !== 'string' || !anyMsg.type.startsWith('rpc:v1:')) {
    return { handle: false, reason: 'ignore' };
  }

  return { handle: true, reason: 'ok' };
}

// Protocol Envelope Types
export interface V1CallInline {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:call-inline';
  channel: string;
  callId: string;
  method: string;
  descriptor: PayloadDescriptor;
  chunk: PayloadChunk;
}

export interface V1ReplyInline {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:reply-inline';
  channel: string;
  callId: string;
  descriptor: PayloadDescriptor;
  chunk: PayloadChunk;
}

export interface V1ReplyStream {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:reply-stream';
  channel: string;
  callId: string;
  transferId: string;
  responderId: string;
  descriptor: PayloadDescriptor;
  firstChunk: PayloadChunk;
}

export interface V1StartUpload {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:start-upload';
  channel: string;
  transferId: string;
  method: string;
  descriptor: PayloadDescriptor;
}

export interface V1AckUpload {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:ack-upload';
  channel: string;
  transferId: string;
  responderId: string;
}

export interface V1UploadChunk {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:upload-chunk';
  channel: string;
  transferId: string;
  targetResponderId: string;
  chunk: PayloadChunk;
}

export interface V1AckChunk {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:ack-chunk';
  channel: string;
  transferId: string;
  seq: number;
}

export interface V1CompleteUpload {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:complete-upload';
  channel: string;
  transferId: string;
  targetResponderId: string;
}

export interface V1PullChunk {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:pull-chunk';
  channel: string;
  transferId: string;
  targetResponderId: string;
  seq: number;
}

export interface V1ChunkReply {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:chunk';
  channel: string;
  transferId: string;
  chunk: PayloadChunk;
}

export interface V1Release {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:release';
  channel: string;
  transferId: string;
  targetResponderId: string;
}

export interface V1Abort {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:abort';
  channel: string;
  transferId: string;
  targetResponderId: string;
  reason?: string;
}

export interface V1ErrorReply {
  protocol: typeof RPC_V1_PROTOCOL;
  type: 'rpc:v1:error';
  channel: string;
  callId?: string;
  transferId?: string;
  error: {
    message: string;
    stack?: string;
  };
}

export interface UploadSession {
  transferId: string;
  method: string;
  descriptor: PayloadDescriptor;
  decoder: PayloadDecoder;
  callerIdentity: CallerIdentity;
  accountedBytes: number;
  timer: ReturnType<typeof setTimeout>;
  executed: boolean;
}

export interface DownloadSession {
  transferId: string;
  descriptor: PayloadDescriptor;
  source: PayloadSource;
  callerIdentity: CallerIdentity;
  accountedBytes: number;
  timer: ReturnType<typeof setTimeout>;
}

// Receiver-side transfer manager: bounds upload and download sessions, memory, timeouts
// ponytail: in-memory transfer sessions with per-session timeout; SW restart surfaces failure
export class ReceiverTransferManager {
  readonly options: Required<TransportOptions>;
  private uploadSessions = new Map<string, UploadSession>();
  private downloadSessions = new Map<string, DownloadSession>();
  private currentAccountedBytes = 0;
  private isDisposed = false;

  constructor(options?: boolean | LargePayloadOptions) {
    this.options = resolveTransportOptions(options);
  }

  get totalSessions(): number {
    return this.uploadSessions.size + this.downloadSessions.size;
  }

  get totalAccountedBytes(): number {
    return this.currentAccountedBytes;
  }

  private resetSessionTimer(session: { timer: ReturnType<typeof setTimeout>; transferId: string }, isUpload: boolean) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      if (isUpload) {
        this.abortUploadSession(session.transferId, undefined, new Error('Upload session timed out due to inactivity'));
      } else {
        this.releaseDownloadSession(session.transferId);
      }
    }, this.options.sessionTimeoutMs);
  }

  createUploadSession(
    transferId: string,
    method: string,
    rawDescriptor: unknown,
    callerIdentity: CallerIdentity
  ): void {
    if (this.isDisposed) throw new Error('Responder transfer manager has been disposed');
    validateMetadataString(transferId, 'transferId');
    validateMetadataString(method, 'method');

    if (this.uploadSessions.has(transferId)) {
      throw new Error(`Upload session ${transferId} already exists`);
    }

    if (this.totalSessions >= this.options.maxSessions) {
      throw new Error(`Max concurrent transfer sessions (${this.options.maxSessions}) reached`);
    }

    const descriptor = normalizePayloadDescriptor(rawDescriptor);
    validateDescriptorLimits(descriptor, this.options);

    const accountedBytes = estimatePayloadMemory(descriptor.jsonLength, descriptor.totalBlobBytes);
    if (this.currentAccountedBytes + accountedBytes > this.options.maxTotalBytes) {
      throw new Error(`Aggregate payload memory limit (${this.options.maxTotalBytes}) exceeded`);
    }

    const decoder = new PayloadDecoder(descriptor, {
      maxTotalBytes: this.options.maxTotalBytes,
      maxChunks: this.options.maxChunks,
      maxBlobs: this.options.maxBlobs,
      maxJsonLength: this.options.maxJsonLength,
    });

    const session: UploadSession = {
      transferId,
      method,
      descriptor,
      decoder,
      callerIdentity,
      accountedBytes,
      timer: setTimeout(() => {
        this.abortUploadSession(transferId, undefined, new Error('Upload session timed out due to inactivity'));
      }, this.options.sessionTimeoutMs),
      executed: false,
    };

    this.currentAccountedBytes += accountedBytes;
    this.uploadSessions.set(transferId, session);
  }

  acceptUploadChunk(transferId: string, chunk: PayloadChunk, caller: CallerIdentity): void {
    validateMetadataString(transferId, 'transferId');
    const session = this.uploadSessions.get(transferId);
    if (!session) throw new Error(`Upload session ${transferId} not found or expired`);
    if (!matchesCallerIdentity(session.callerIdentity, caller)) {
      throw new Error(`Caller identity mismatch for transfer ${transferId}`);
    }

    try {
      session.decoder.acceptChunk(chunk);
      this.resetSessionTimer(session, true);
    } catch (err) {
      // Discard invalid session for verified owner immediately rather than waiting for TTL
      this.abortUploadSession(transferId, undefined, err as Error);
      throw err;
    }
  }

  finishUploadSession(transferId: string, caller: CallerIdentity): { method: string; args: unknown[] } {
    validateMetadataString(transferId, 'transferId');
    const session = this.uploadSessions.get(transferId);
    if (!session) throw new Error(`Upload session ${transferId} not found or expired`);
    if (!matchesCallerIdentity(session.callerIdentity, caller)) {
      throw new Error(`Caller identity mismatch for transfer ${transferId}`);
    }
    if (session.executed) {
      throw new Error(`Upload session ${transferId} has already been executed`);
    }

    session.executed = true;
    clearTimeout(session.timer);
    this.uploadSessions.delete(transferId);
    this.currentAccountedBytes -= session.accountedBytes;

    try {
      const rawArgs = session.decoder.finish();
      if (!Array.isArray(rawArgs)) throw new TypeError('Decoded RPC arguments payload must be an array');
      return { method: session.method, args: rawArgs };
    } finally {
      session.decoder.dispose();
    }
  }

  // Authenticated external abort or internal cleanup
  abortUploadSession(transferId: string, caller?: CallerIdentity, reason?: Error): void {
    validateMetadataString(transferId, 'transferId');
    const session = this.uploadSessions.get(transferId);
    if (!session) return;
    if (caller && !matchesCallerIdentity(session.callerIdentity, caller)) {
      throw new Error(`Caller identity mismatch for upload ${transferId}`);
    }

    clearTimeout(session.timer);
    this.uploadSessions.delete(transferId);
    this.currentAccountedBytes -= session.accountedBytes;
    session.decoder.abort(reason);
  }

  createDownloadSession(
    transferId: string,
    source: PayloadSource,
    callerIdentity: CallerIdentity
  ): void {
    if (this.isDisposed) {
      source.dispose();
      throw new Error('Responder transfer manager has been disposed');
    }
    validateMetadataString(transferId, 'transferId');

    if (this.downloadSessions.has(transferId)) {
      source.dispose();
      throw new Error(`Download session ${transferId} already exists`);
    }

    if (this.totalSessions >= this.options.maxSessions) {
      source.dispose();
      throw new Error(`Max concurrent transfer sessions (${this.options.maxSessions}) reached`);
    }

    const descriptor = normalizePayloadDescriptor(source.descriptor);
    try {
      validateDescriptorLimits(descriptor, this.options);
    } catch (err) {
      source.dispose();
      throw err;
    }

    const accountedBytes = estimatePayloadMemory(
      descriptor.jsonLength,
      descriptor.totalBlobBytes
    );
    if (this.currentAccountedBytes + accountedBytes > this.options.maxTotalBytes) {
      source.dispose();
      throw new Error(`Aggregate payload memory limit (${this.options.maxTotalBytes}) exceeded`);
    }

    const session: DownloadSession = {
      transferId,
      descriptor,
      source,
      callerIdentity,
      accountedBytes,
      timer: setTimeout(() => {
        this.releaseDownloadSession(transferId);
      }, this.options.sessionTimeoutMs),
    };

    this.currentAccountedBytes += accountedBytes;
    this.downloadSessions.set(transferId, session);
  }

  async readDownloadChunk(transferId: string, seq: number, caller: CallerIdentity): Promise<PayloadChunk> {
    validateMetadataString(transferId, 'transferId');
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new TypeError(`Invalid chunk sequence index: ${seq}`);
    }

    const session = this.downloadSessions.get(transferId);
    if (!session) throw new Error(`Download session ${transferId} not found or expired`);
    if (!matchesCallerIdentity(session.callerIdentity, caller)) {
      throw new Error(`Caller identity mismatch for download ${transferId}`);
    }

    const chunk = await session.source.readChunk(seq);
    this.resetSessionTimer(session, false);
    return chunk;
  }

  // Authenticated external release or internal cleanup
  releaseDownloadSession(transferId: string, caller?: CallerIdentity): void {
    validateMetadataString(transferId, 'transferId');
    const session = this.downloadSessions.get(transferId);
    if (!session) return;
    if (caller && !matchesCallerIdentity(session.callerIdentity, caller)) {
      throw new Error(`Caller identity mismatch for download ${transferId}`);
    }

    clearTimeout(session.timer);
    this.downloadSessions.delete(transferId);
    this.currentAccountedBytes -= session.accountedBytes;
    session.source.dispose();
  }

  dispose(): void {
    this.isDisposed = true;
    for (const session of this.uploadSessions.values()) {
      clearTimeout(session.timer);
      session.decoder.dispose();
    }
    this.uploadSessions.clear();

    for (const session of this.downloadSessions.values()) {
      clearTimeout(session.timer);
      session.source.dispose();
    }
    this.downloadSessions.clear();
    this.currentAccountedBytes = 0;
  }
}

// Bounded message exchange helper to prevent hanging on unfamiliar / dead peers
export function sendWithTimeout(
  sendFn: (msg: unknown) => Promise<unknown>,
  msg: unknown,
  timeoutMs: number,
  contextDesc = 'RPC message'
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    sendFn(msg),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${contextDesc} timed out after ${timeoutMs}ms waiting for peer response`));
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Universal Sender Helper for all requester types
export async function sendV1Call(
  sendMessageFn: (msg: unknown) => Promise<unknown>,
  channel: string,
  method: string,
  args: unknown[],
  options?: boolean | LargePayloadOptions
): Promise<unknown> {
  validateMetadataString(channel, 'channel');
  validateMetadataString(method, 'method');

  const resolved = resolveTransportOptions(options);
  const source = encodePayload(args, { chunkSize: resolved.chunkSize });

  const isInline = source.descriptor.totalChunks === 1 && source.descriptor.totalBlobs === 0;

  let activeUploadTransferId: string | undefined;
  let activeDownloadTransferId: string | undefined;
  let activeTargetResponderId: string | undefined;
  let uploadCompleted = false;
  let downloadCompleted = false;
  let activeDecoder: PayloadDecoder | undefined;
  const correlationId = crypto.randomUUID();

  try {
    validateDescriptorLimits(source.descriptor, resolved);
    let response: unknown;

    if (isInline) {
      const callId = correlationId;
      const chunk = await source.readChunk(0);
      const callMsg: V1CallInline = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:call-inline',
        channel,
        callId,
        method,
        descriptor: source.descriptor,
        chunk,
      };

      response = await sendWithTimeout(
        sendMessageFn,
        callMsg,
        resolved.messageTimeoutMs,
        `Method '${method}' inline call`
      );
    } else {
      // Large argument upload: start with a harmless probe step before sending data
      const transferId = correlationId;
      activeUploadTransferId = transferId;

      const startMsg: V1StartUpload = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:start-upload',
        channel,
        transferId,
        method,
        descriptor: source.descriptor,
      };

      const startAck = (await sendWithTimeout(
        sendMessageFn,
        startMsg,
        resolved.messageTimeoutMs,
        `Method '${method}' start-upload probe`
      )) as Record<string, unknown> | undefined;

      if (!startAck || startAck.protocol !== RPC_V1_PROTOCOL || startAck.channel !== channel) {
        throw new Error(
          `Peer does not support rpc-chrome/v1 or did not accept transfer on channel '${channel}'`
        );
      }
      if (startAck.type === 'rpc:v1:error') {
        const errObj = startAck.error as { message?: string; stack?: string } | undefined;
        const err = new Error(`Error in method ${method}: ${errObj?.message || 'Unknown error'}`);
        err.stack = errObj?.stack;
        throw err;
      }
      if (startAck.type !== 'rpc:v1:ack-upload' || startAck.transferId !== transferId) {
        throw new Error(`Unexpected start-upload response: ${String(startAck.type)}`);
      }

      const targetResponderId = validateMetadataString(startAck.responderId, 'responderId');
      activeTargetResponderId = targetResponderId;

      // Sequentially upload all chunks
      for (let seq = 0; seq < source.descriptor.totalChunks; seq++) {
        const chunk = await source.readChunk(seq);
        const chunkMsg: V1UploadChunk = {
          protocol: RPC_V1_PROTOCOL,
          type: 'rpc:v1:upload-chunk',
          channel,
          transferId,
          targetResponderId,
          chunk,
        };
        const chunkAck = (await sendWithTimeout(
          sendMessageFn,
          chunkMsg,
          resolved.messageTimeoutMs,
          `Method '${method}' upload chunk ${seq}`
        )) as Record<string, unknown> | undefined;

        if (!chunkAck || chunkAck.protocol !== RPC_V1_PROTOCOL || chunkAck.channel !== channel) {
          throw new Error(`Upload chunk ${seq} lost connection on channel '${channel}'`);
        }
        if (chunkAck.type === 'rpc:v1:error') {
          const errObj = chunkAck.error as { message?: string; stack?: string } | undefined;
          const err = new Error(`Error in method ${method}: ${errObj?.message || 'Unknown error'}`);
          err.stack = errObj?.stack;
          throw err;
        }
        if (chunkAck.type !== 'rpc:v1:ack-chunk' || chunkAck.transferId !== transferId || chunkAck.seq !== seq) {
          throw new Error(`Invalid chunk ack for sequence ${seq}`);
        }
      }

      // Completion request invokes the method exactly once in the active session
      const completeMsg: V1CompleteUpload = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:complete-upload',
        channel,
        transferId,
        targetResponderId,
      };

      response = await sendWithTimeout(
        sendMessageFn,
        completeMsg,
        resolved.messageTimeoutMs,
        `Method '${method}' complete-upload`
      );
      uploadCompleted = true;
    }

    if (!response || typeof response !== 'object') {
      throw new Error(`Method ${method} on channel '${channel}' returned no response from peer`);
    }

    const res = response as Record<string, unknown>;
    if (res.protocol !== RPC_V1_PROTOCOL || res.channel !== channel) {
      if (res.type === 'error' && res.error) {
        const errObj = res.error as { message?: string; stack?: string };
        const err = new Error(`Error in method ${method}: ${errObj.message || 'Unknown error'}`);
        err.stack = errObj.stack;
        throw err;
      }
      throw new Error(`Method ${method} returned invalid response protocol: ${String(res.protocol)}`);
    }

    if (res.type === 'rpc:v1:error') {
      const errObj = res.error as { message?: string; stack?: string } | undefined;
      const err = new Error(`Error in method ${method}: ${errObj?.message || 'Unknown error'}`);
      err.stack = errObj?.stack;
      throw err;
    }

    if (res.callId !== correlationId) throw new Error('RPC response callId mismatch');

    // Inline result
    if (res.type === 'rpc:v1:reply-inline') {
      const desc = normalizePayloadDescriptor(res.descriptor);
      validateDescriptorLimits(desc, resolved);
      const decoder = new PayloadDecoder(desc, resolved);
      activeDecoder = decoder;
      decoder.acceptChunk(res.chunk as PayloadChunk);
      const finalVal = decoder.finish();
      downloadCompleted = true;
      return finalVal;
    }

    // Streamed result
    if (res.type === 'rpc:v1:reply-stream') {
      const streamRes = res as unknown as V1ReplyStream;
      const transferId = validateMetadataString(streamRes.transferId, 'transferId');
      const responderId = validateMetadataString(streamRes.responderId, 'responderId');
      activeDownloadTransferId = transferId;
      activeTargetResponderId = responderId;

      const desc = normalizePayloadDescriptor(streamRes.descriptor);
      validateDescriptorLimits(desc, resolved);
      const decoder = new PayloadDecoder(desc, resolved);
      activeDecoder = decoder;

      decoder.acceptChunk(streamRes.firstChunk);

      for (let seq = 1; seq < desc.totalChunks; seq++) {
        const pullMsg: V1PullChunk = {
          protocol: RPC_V1_PROTOCOL,
          type: 'rpc:v1:pull-chunk',
          channel,
          transferId,
          targetResponderId: responderId,
          seq,
        };

        const chunkReply = (await sendWithTimeout(
          sendMessageFn,
          pullMsg,
          resolved.messageTimeoutMs,
          `Method '${method}' pull chunk ${seq}`
        )) as Record<string, unknown> | undefined;

        if (!chunkReply || chunkReply.protocol !== RPC_V1_PROTOCOL || chunkReply.channel !== channel) {
          decoder.abort(new Error('Connection lost while pulling result chunks'));
          throw new Error(`Failed to pull chunk ${seq} for method ${method}`);
        }
        if (chunkReply.type === 'rpc:v1:error') {
          const errObj = chunkReply.error as { message?: string; stack?: string } | undefined;
          decoder.abort(new Error(errObj?.message));
          const err = new Error(`Error in method ${method}: ${errObj?.message || 'Unknown error'}`);
          err.stack = errObj?.stack;
          throw err;
        }
        if (chunkReply.type !== 'rpc:v1:chunk' || chunkReply.transferId !== transferId || !chunkReply.chunk) {
          decoder.abort(new Error(`Unexpected response type: ${String(chunkReply.type)}`));
          throw new Error(`Invalid chunk response pulling sequence ${seq}`);
        }

        const chunk = chunkReply.chunk as PayloadChunk;
        if (chunk.seq !== seq) {
          decoder.abort(new Error(`Chunk sequence mismatch: expected ${seq}, got ${chunk.seq}`));
          throw new Error(`Chunk sequence mismatch pulling seq ${seq}`);
        }

        decoder.acceptChunk(chunk);
      }

      const finalResult = decoder.finish();
      downloadCompleted = true;

      // Best-effort release of receiver resources
      const releaseMsg: V1Release = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:release',
        channel,
        transferId,
        targetResponderId: responderId,
      };
      sendWithTimeout(sendMessageFn, releaseMsg, 1000).catch(() => {});

      return finalResult;
    }

    throw new Error(`Unknown response type '${String(res.type)}' for method ${method}`);
  } finally {
    source.dispose();
    if (activeDecoder) {
      try {
        if (!downloadCompleted) activeDecoder.abort();
        else activeDecoder.dispose();
      } catch {
        // ignore
      }
    }
    // Best effort cleanup of unfinished transfer on failure
    if (activeUploadTransferId && !uploadCompleted && activeTargetResponderId) {
      const abortMsg: V1Abort = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:abort',
        channel,
        transferId: activeUploadTransferId,
        targetResponderId: activeTargetResponderId,
        reason: 'Client encountered error or timeout',
      };
      sendWithTimeout(sendMessageFn, abortMsg, 1000).catch(() => {});
    }
    if (activeDownloadTransferId && !downloadCompleted && activeTargetResponderId) {
      const releaseMsg: V1Release = {
        protocol: RPC_V1_PROTOCOL,
        type: 'rpc:v1:release',
        channel,
        transferId: activeDownloadTransferId,
        targetResponderId: activeTargetResponderId,
      };
      sendWithTimeout(sendMessageFn, releaseMsg, 1000).catch(() => {});
    }
  }
}
