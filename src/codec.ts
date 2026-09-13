// Private serialization module for JSON-compatible values and nested Blobs.
// Designed for bounded JSON-safe chunked transfers over Chrome messaging.

import { fromUint8Array, toUint8Array } from 'js-base64';

export interface PayloadDescriptor {
  version: 1;
  totalChunks: number;
  jsonChunks: number;
  blobChunks: number;
  jsonLength: number; // in UTF-16 code units
  totalBlobBytes: number; // in raw binary bytes
  totalBlobs: number;
  chunkSize: number; // max UTF-16 code units for JSON; max ASCII chars for base64
}

export type PayloadChunk =
  | { seq: number; kind: 'json'; data: string }
  | { seq: number; kind: 'blob'; blobIndex: number; data: string };

export interface PayloadSource {
  readonly descriptor: PayloadDescriptor;
  readChunk(seq: number): Promise<PayloadChunk>;
  dispose(): void;
}

export interface PayloadEncoderOptions {
  chunkSize?: number; // default: 256 Ki code units/chars
}

export interface PayloadDecoderOptions {
  maxTotalBytes?: number; // default: 512 MiB total accounted payload budget (jsonLength * 2 + totalBlobBytes)
  maxChunks?: number; // default: 100_000
  maxBlobs?: number; // default: 10_000
  maxJsonLength?: number; // default: 128 Mi code units
}

export interface DecodeResult {
  done: boolean;
  value?: unknown;
}

export const MIN_CHUNK_SIZE = 4;
export const MAX_CHUNK_SIZE = 1024 * 1024; // 1 Mi code units / characters
const DEFAULT_CHUNK_SIZE = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB accounted size
const DEFAULT_MAX_CHUNKS = 100_000;
const DEFAULT_MAX_BLOBS = 10_000;
const DEFAULT_MAX_JSON_LENGTH = 128 * 1024 * 1024; // 128 Mi code units (allows >64 MiB JSON strings)
const MAX_MIME_LENGTH = 256;
const MAX_PATH_DEPTH = 256;
const MAX_PATH_SEGMENT_LENGTH = 512;

// Accounts UTF-16 characters at 2 bytes each plus raw blob bytes
export function estimatePayloadMemory(jsonLength: number, totalBlobBytes: number): number {
  return jsonLength * 2 + totalBlobBytes;
}

export function isBlob(value: unknown): value is Blob {
  if (!value || typeof value !== 'object') return false;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  const tag = Object.prototype.toString.call(value);
  return (
    (tag === '[object Blob]' || tag === '[object File]') &&
    typeof (value as Blob).slice === 'function' &&
    typeof (value as Blob).size === 'number' &&
    typeof (value as Blob).type === 'string'
  );
}

// ponytail: retain strict base64 alphabet and padding check before permissive js-base64 decoder
export function base64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  if (base64.length === 0) return new Uint8Array(new ArrayBuffer(0));
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new Error('Invalid base64 string');
  }
  return toUint8Array(base64) as Uint8Array<ArrayBuffer>;
}

interface ExtractedBlob {
  path: Array<string | number>;
  size: number;
  mime: string;
  blob: Blob;
}

interface EncodedManifest {
  isUndefined?: boolean;
  root: unknown;
  blobs: Array<{ path: Array<string | number>; size: number; mime: string }>;
}

function encodeManifest(
  rootValue: unknown
): { jsonString: string; blobs: ExtractedBlob[] } {
  if (typeof rootValue === 'function' || typeof rootValue === 'symbol') {
    throw new TypeError(`Unsupported root type: ${typeof rootValue}`);
  }

  const blobs: ExtractedBlob[] = [];
  const paths = new WeakMap<object, Array<string | number>>();

  // ponytail: JSON handles traversal, toJSON, omitted values, and cycles; only Blob paths are custom.
  const root = JSON.stringify(rootValue === undefined ? null : rootValue, function (key, val: unknown) {
    if (val === undefined || typeof val === 'function' || typeof val === 'symbol') return val;
    const parentPath = paths.get(this);
    const path = parentPath ? [...parentPath, Array.isArray(this) ? Number(key) : key] : [];
    if (path.length > MAX_PATH_DEPTH) throw new RangeError('Payload nesting exceeds maximum depth');
    if (isBlob(val)) {
      if (val.type.length > MAX_MIME_LENGTH || path.some(seg => typeof seg === 'string' && seg.length > MAX_PATH_SEGMENT_LENGTH)) {
        throw new RangeError('Blob MIME or property path exceeds limits');
      }
      blobs.push({ path, size: val.size, mime: val.type, blob: val });
      return null;
    }
    if (val instanceof Map || val instanceof Set) {
      throw new TypeError(`${Object.prototype.toString.call(val)} serialization is not supported`);
    }
    if (val !== null && typeof val === 'object') paths.set(val, path);
    return val;
  });
  if (root === undefined) {
    throw new TypeError('Payload root must be JSON-serializable');
  }

  const metadata = blobs.map(({ path, size, mime }) => ({ path, size, mime }));
  return {
    jsonString: `{"isUndefined":${rootValue === undefined},"root":${root},"blobs":${JSON.stringify(metadata)}}`,
    blobs,
  };
}

function placeBlobAtPath(root: unknown, path: Array<string | number>, blob: Blob): unknown {
  if (path.length === 0) {
    if (root !== null) {
      throw new Error('Root blob must replace a null placeholder');
    }
    return blob;
  }

  let current: any = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (typeof current !== 'object' || current === null) {
      throw new Error(`Cannot traverse path at segment: ${String(seg)}`);
    }
    if (Array.isArray(current)) {
      if (typeof seg !== 'number' || !Number.isSafeInteger(seg) || seg < 0 || seg >= current.length) {
        throw new Error(`Invalid array index segment: ${String(seg)}`);
      }
      current = current[seg];
    } else {
      if (typeof seg !== 'string') {
        throw new Error(`Expected string property segment, got: ${typeof seg}`);
      }
      if (!Object.prototype.hasOwnProperty.call(current, seg)) {
        throw new Error(`Path segment does not exist as own property: ${seg}`);
      }
      current = seg === '__proto__'
        ? Object.getOwnPropertyDescriptor(current, '__proto__')?.value
        : current[seg];
    }
  }

  const lastSeg = path[path.length - 1];
  if (typeof current !== 'object' || current === null) {
    throw new Error(`Cannot set blob at segment: ${String(lastSeg)}`);
  }

  if (Array.isArray(current)) {
    if (typeof lastSeg !== 'number' || !Number.isSafeInteger(lastSeg) || lastSeg < 0 || lastSeg >= current.length) {
      throw new Error(`Invalid array index for blob placement: ${String(lastSeg)}`);
    }
    if (current[lastSeg] !== null) {
      throw new Error(`Blob at index ${lastSeg} must replace a null placeholder`);
    }
    current[lastSeg] = blob;
  } else {
    if (typeof lastSeg !== 'string') {
      throw new Error(`Expected string property for blob placement, got: ${typeof lastSeg}`);
    }
    if (!Object.prototype.hasOwnProperty.call(current, lastSeg)) {
      throw new Error(`Blob target property must exist as an own property: ${lastSeg}`);
    }
    const existing = lastSeg === '__proto__'
      ? Object.getOwnPropertyDescriptor(current, '__proto__')?.value
      : current[lastSeg];
    if (existing !== null) {
      throw new Error(`Blob at property '${lastSeg}' must replace a null placeholder`);
    }
    Object.defineProperty(current, lastSeg, {
      value: blob,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  return root;
}

export function encodePayload(value: unknown, options?: PayloadEncoderOptions): PayloadSource {
  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw new RangeError(`chunkSize must be a safe integer between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
  }

  const k = Math.floor(chunkSize / 4);
  const binaryChunkSize = k > 0 ? k * 3 : Math.max(1, Math.floor((chunkSize * 3) / 4));

  const { jsonString, blobs } = encodeManifest(value);
  const jsonChunks = Math.max(1, Math.ceil(jsonString.length / chunkSize));

  const blobChunkCounts: number[] = [];
  let totalBlobChunks = 0;
  let totalBlobBytes = 0;

  for (const b of blobs) {
    totalBlobBytes += b.size;
    const count = b.size === 0 ? 0 : Math.ceil(b.size / binaryChunkSize);
    blobChunkCounts.push(count);
    totalBlobChunks += count;
  }

  const totalChunks = jsonChunks + totalBlobChunks;

  const descriptor: PayloadDescriptor = {
    version: 1,
    totalChunks,
    jsonChunks,
    blobChunks: totalBlobChunks,
    jsonLength: jsonString.length,
    totalBlobBytes,
    totalBlobs: blobs.length,
    chunkSize,
  };

  let disposed = false;
  let jsonRef: string | null = jsonString;
  let blobsRef: ExtractedBlob[] | null = blobs;

  return {
    descriptor,
    async readChunk(seq: number): Promise<PayloadChunk> {
      if (disposed || !jsonRef || !blobsRef) {
        throw new Error('Payload source has been disposed');
      }
      if (!Number.isSafeInteger(seq) || seq < 0 || seq >= totalChunks) {
        throw new RangeError(`Invalid chunk sequence index: ${seq}`);
      }

      if (seq < jsonChunks) {
        const start = seq * chunkSize;
        const end = Math.min(start + chunkSize, jsonRef.length);
        return {
          seq,
          kind: 'json',
          data: jsonRef.slice(start, end),
        };
      }

      let offset = seq - jsonChunks;
      for (let i = 0; i < blobsRef.length; i++) {
        const count = blobChunkCounts[i];
        if (count === 0) continue;
        if (offset < count) {
          const byteStart = offset * binaryChunkSize;
          const byteEnd = Math.min(byteStart + binaryChunkSize, blobsRef[i].size);
          const slice = blobsRef[i].blob.slice(byteStart, byteEnd);
          const buffer = await slice.arrayBuffer();
          const data = fromUint8Array(new Uint8Array(buffer));
          return {
            seq,
            kind: 'blob',
            blobIndex: i,
            data,
          };
        }
        offset -= count;
      }

      throw new Error(`Unreachable chunk offset for sequence index: ${seq}`);
    },
    dispose() {
      disposed = true;
      jsonRef = null;
      blobsRef = null;
    },
  };
}

export class PayloadDecoder {
  readonly descriptor: PayloadDescriptor;
  private readonly options: Required<PayloadDecoderOptions>;
  private readonly binaryChunkSize: number;
  private nextSeq = 0;
  private jsonParts: string[] = [];
  private manifest: EncodedManifest | null = null;
  private blobParts: Uint8Array<ArrayBuffer>[][] = [];
  private blobReceivedBytes: number[] = [];
  private currentBlobIndex = 0;
  private finalValue: unknown = undefined;
  private isDone = false;
  private isDisposed = false;
  private abortReason: Error | null = null;

  constructor(descriptor: PayloadDescriptor, options?: PayloadDecoderOptions) {
    if (!descriptor || typeof descriptor !== 'object') {
      throw new TypeError('Invalid payload descriptor: must be an object');
    }
    if (descriptor.version !== 1) {
      throw new Error(`Unsupported payload descriptor version: ${String(descriptor.version)}`);
    }

    const requiredIntegerFields: Array<keyof PayloadDescriptor> = [
      'totalChunks',
      'jsonChunks',
      'blobChunks',
      'jsonLength',
      'totalBlobBytes',
      'totalBlobs',
      'chunkSize',
    ];
    for (const field of requiredIntegerFields) {
      const val = descriptor[field];
      if (!Number.isSafeInteger(val) || (val as number) < 0) {
        throw new TypeError(`Invalid descriptor field '${field}': must be a non-negative safe integer`);
      }
    }

    if (descriptor.chunkSize < MIN_CHUNK_SIZE || descriptor.chunkSize > MAX_CHUNK_SIZE) {
      throw new RangeError(`descriptor.chunkSize must be between ${MIN_CHUNK_SIZE} and ${MAX_CHUNK_SIZE}`);
    }

    const expectedJsonChunks = Math.max(1, Math.ceil(descriptor.jsonLength / descriptor.chunkSize));
    if (descriptor.jsonChunks !== expectedJsonChunks) {
      throw new Error(`descriptor.jsonChunks (${descriptor.jsonChunks}) does not match expected (${expectedJsonChunks})`);
    }

    if (descriptor.totalChunks !== descriptor.jsonChunks + descriptor.blobChunks) {
      throw new Error('descriptor.totalChunks must equal jsonChunks + blobChunks');
    }

    if (options) {
      for (const [key, val] of Object.entries(options)) {
        if (val !== undefined && (!Number.isSafeInteger(val) || (val as number) <= 0)) {
          throw new TypeError(`Option '${key}' must be a positive safe integer`);
        }
      }
    }

    this.options = {
      maxTotalBytes: options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
      maxChunks: options?.maxChunks ?? DEFAULT_MAX_CHUNKS,
      maxBlobs: options?.maxBlobs ?? DEFAULT_MAX_BLOBS,
      maxJsonLength: options?.maxJsonLength ?? DEFAULT_MAX_JSON_LENGTH,
    };

    if (descriptor.totalChunks > this.options.maxChunks) {
      throw new Error(`Payload totalChunks (${descriptor.totalChunks}) exceeds limit (${this.options.maxChunks})`);
    }
    if (descriptor.totalBlobs > this.options.maxBlobs) {
      throw new Error(`Payload totalBlobs (${descriptor.totalBlobs}) exceeds limit (${this.options.maxBlobs})`);
    }
    if (descriptor.jsonLength > this.options.maxJsonLength) {
      throw new Error(`Payload jsonLength (${descriptor.jsonLength}) exceeds limit (${this.options.maxJsonLength})`);
    }
    const accountedBytes = estimatePayloadMemory(descriptor.jsonLength, descriptor.totalBlobBytes);
    if (accountedBytes > this.options.maxTotalBytes) {
      throw new Error(`Accounted payload bytes (${accountedBytes}) exceeds limit (${this.options.maxTotalBytes})`);
    }

    const k = Math.floor(descriptor.chunkSize / 4);
    this.binaryChunkSize = k > 0 ? k * 3 : Math.max(1, Math.floor((descriptor.chunkSize * 3) / 4));
    this.descriptor = descriptor;
  }

  acceptChunk(chunk: PayloadChunk): DecodeResult {
    if (this.isDisposed) {
      throw this.abortReason || new Error('Payload decoder has been disposed');
    }
    if (this.isDone) {
      throw new Error('Payload decoder has already completed');
    }
    if (!chunk || typeof chunk !== 'object') {
      throw new TypeError('Invalid chunk: must be an object');
    }
    if (chunk.seq !== this.nextSeq) {
      throw new Error(`Invalid chunk sequence: expected ${this.nextSeq}, got ${chunk.seq}`);
    }

    this.nextSeq++;

    if (chunk.seq < this.descriptor.jsonChunks) {
      if (chunk.kind !== 'json' || typeof chunk.data !== 'string') {
        throw new TypeError(`Expected json chunk at sequence ${chunk.seq}`);
      }
      const isLastJson = chunk.seq === this.descriptor.jsonChunks - 1;
      const expectedLen = isLastJson
        ? this.descriptor.jsonLength - chunk.seq * this.descriptor.chunkSize
        : this.descriptor.chunkSize;
      if (chunk.data.length !== expectedLen) {
        throw new Error(
          `JSON chunk length mismatch at seq ${chunk.seq}: expected ${expectedLen}, got ${chunk.data.length}`
        );
      }

      this.jsonParts.push(chunk.data);

      if (isLastJson) {
        this.processManifest();
        if (this.descriptor.blobChunks === 0) {
          return { done: true, value: this.finalizeValue() };
        }
      }
      return { done: false };
    }

    // Blob chunk
    if (chunk.kind !== 'blob' || typeof chunk.data !== 'string') {
      throw new TypeError(`Expected blob chunk at sequence ${chunk.seq}`);
    }
    if (!this.manifest) {
      throw new Error('Received blob chunk before manifest was parsed');
    }

    while (
      this.currentBlobIndex < this.manifest.blobs.length &&
      this.manifest.blobs[this.currentBlobIndex].size === 0
    ) {
      this.currentBlobIndex++;
    }

    if (chunk.blobIndex !== this.currentBlobIndex) {
      throw new Error(
        `Unexpected blobIndex in chunk: expected ${this.currentBlobIndex}, got ${chunk.blobIndex}`
      );
    }

    const currentBlobMeta = this.manifest.blobs[this.currentBlobIndex];
    const remainingBytes = currentBlobMeta.size - this.blobReceivedBytes[this.currentBlobIndex];
    const currentSliceBytes = Math.min(this.binaryChunkSize, remainingBytes);
    const expectedBase64Len = Math.ceil(currentSliceBytes / 3) * 4;

    if (chunk.data.length !== expectedBase64Len) {
      throw new Error(
        `Blob chunk base64 length mismatch: expected ${expectedBase64Len}, got ${chunk.data.length}`
      );
    }

    const bytes = base64ToUint8Array(chunk.data);
    if (bytes.byteLength !== currentSliceBytes) {
      throw new Error(`Decoded blob chunk size mismatch: expected ${currentSliceBytes}, got ${bytes.byteLength}`);
    }

    this.blobParts[this.currentBlobIndex].push(bytes);
    this.blobReceivedBytes[this.currentBlobIndex] += bytes.byteLength;

    if (this.blobReceivedBytes[this.currentBlobIndex] === currentBlobMeta.size) {
      this.currentBlobIndex++;
    }

    if (chunk.seq === this.descriptor.totalChunks - 1) {
      return { done: true, value: this.finalizeValue() };
    }

    return { done: false };
  }

  finish(): unknown {
    if (this.isDisposed) {
      throw this.abortReason || new Error('Payload decoder has been disposed');
    }
    if (!this.isDone) {
      throw new Error(
        `Payload incomplete: received ${this.nextSeq} of ${this.descriptor.totalChunks} chunks`
      );
    }
    return this.finalValue;
  }

  abort(reason?: Error): void {
    this.isDisposed = true;
    this.abortReason = reason || new Error('Payload decoder aborted');
    this.cleanup();
    this.finalValue = undefined;
  }

  dispose(): void {
    this.isDisposed = true;
    this.cleanup();
    this.finalValue = undefined;
  }

  private cleanup(): void {
    this.jsonParts = [];
    this.blobParts = [];
    this.manifest = null;
  }

  private processManifest(): void {
    const jsonText = this.jsonParts.join('');
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Failed to parse payload manifest JSON: ${(e as Error).message}`);
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Manifest must be an object');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'root')) throw new Error('Manifest must contain root');
    if (parsed.isUndefined !== undefined && typeof parsed.isUndefined !== 'boolean') {
      throw new Error('Manifest isUndefined must be boolean if present');
    }
    if (parsed.isUndefined && (parsed.root !== null || parsed.blobs?.length > 0)) {
      throw new Error('Incoherent undefined manifest: root must be null and blobs empty');
    }
    if (!Array.isArray(parsed.blobs)) {
      throw new Error('Manifest blobs must be an array');
    }
    if (parsed.blobs.length !== this.descriptor.totalBlobs) {
      throw new Error(
        `Manifest blobs count (${parsed.blobs.length}) does not match descriptor.totalBlobs (${this.descriptor.totalBlobs})`
      );
    }

    let calculatedTotalBytes = 0;
    let expectedBlobChunks = 0;
    const seenPaths = new Set<string>();

    for (let i = 0; i < parsed.blobs.length; i++) {
      const b = parsed.blobs[i];
      if (!b || typeof b !== 'object') {
        throw new Error(`Manifest blob at index ${i} is not an object`);
      }
      if (typeof b.mime !== 'string' || b.mime.length > MAX_MIME_LENGTH) {
        throw new Error(`Invalid or oversized MIME type in blob index ${i}`);
      }
      if (!Number.isSafeInteger(b.size) || b.size < 0) {
        throw new Error(`Invalid size in blob index ${i}: must be non-negative integer`);
      }
      if (!Array.isArray(b.path) || b.path.length > MAX_PATH_DEPTH) {
        throw new Error(`Invalid or over-depth path in blob index ${i}`);
      }

      for (const seg of b.path) {
        if (typeof seg === 'number') {
          if (!Number.isSafeInteger(seg) || seg < 0) {
            throw new Error(`Invalid numeric path segment in blob index ${i}: ${seg}`);
          }
        } else if (typeof seg === 'string') {
          if (seg.length > MAX_PATH_SEGMENT_LENGTH) {
            throw new Error(`Path segment exceeds max length in blob index ${i}`);
          }
        } else {
          throw new Error(`Invalid path segment type in blob index ${i}: ${typeof seg}`);
        }
      }

      const pathKey = JSON.stringify(b.path);
      if (seenPaths.has(pathKey)) {
        throw new Error(`Duplicate blob destination path in manifest: ${pathKey}`);
      }
      seenPaths.add(pathKey);

      calculatedTotalBytes += b.size;
      expectedBlobChunks += b.size === 0 ? 0 : Math.ceil(b.size / this.binaryChunkSize);
    }

    if (calculatedTotalBytes !== this.descriptor.totalBlobBytes) {
      throw new Error(
        `Manifest blob bytes sum (${calculatedTotalBytes}) does not match descriptor.totalBlobBytes (${this.descriptor.totalBlobBytes})`
      );
    }
    if (expectedBlobChunks !== this.descriptor.blobChunks) {
      throw new Error(
        `Calculated blob chunks (${expectedBlobChunks}) does not match descriptor.blobChunks (${this.descriptor.blobChunks})`
      );
    }

    this.manifest = parsed as EncodedManifest;
    this.jsonParts = [];
    this.blobParts = this.manifest.blobs.map(() => []);
    this.blobReceivedBytes = new Array(this.manifest.blobs.length).fill(0);
  }

  private finalizeValue(): unknown {
    if (!this.manifest) {
      throw new Error('Cannot finalize value without manifest');
    }

    for (let i = 0; i < this.manifest.blobs.length; i++) {
      const expectedSize = this.manifest.blobs[i].size;
      const actualSize = this.blobReceivedBytes[i];
      if (actualSize !== expectedSize) {
        throw new Error(
          `Incomplete blob ${i}: expected ${expectedSize} bytes, got ${actualSize} bytes`
        );
      }
    }

    let result = this.manifest.root;

    for (let i = 0; i < this.manifest.blobs.length; i++) {
      const meta = this.manifest.blobs[i];
      const blob = new Blob(this.blobParts[i], { type: meta.mime });
      result = placeBlobAtPath(result, meta.path, blob);
    }

    if (this.manifest.isUndefined) {
      result = undefined;
    }

    this.finalValue = result;
    this.isDone = true;
    this.cleanup();

    return result;
  }
}
