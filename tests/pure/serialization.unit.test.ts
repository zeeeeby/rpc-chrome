import { test, expect } from '@playwright/test';
import {
  encodePayload,
  PayloadDecoder,
  isBlob,
  base64ToUint8Array,
  PayloadEncoderOptions,
  PayloadDecoderOptions,
  DecodeResult,
  estimatePayloadMemory,
} from '../../src/codec';

async function roundtrip(
  value: unknown,
  encoderOptions?: PayloadEncoderOptions,
  decoderOptions?: PayloadDecoderOptions
): Promise<unknown> {
  const source = encodePayload(value, encoderOptions);
  const decoder = new PayloadDecoder(source.descriptor, decoderOptions);
  let result: DecodeResult = { done: false };
  for (let seq = 0; seq < source.descriptor.totalChunks; seq++) {
    const chunk = await source.readChunk(seq);
    result = decoder.acceptChunk(chunk);
  }
  source.dispose();
  expect(result.done).toBe(true);
  expect(decoder.finish()).toEqual(result.value);
  return result.value;
}

async function expectBlobEquals(actual: unknown, expected: Blob): Promise<void> {
  expect(isBlob(actual)).toBe(true);
  const b = actual as Blob;
  expect(b.type).toBe(expected.type);
  expect(b.size).toBe(expected.size);
  const actBuf = await b.arrayBuffer();
  const expBuf = await expected.arrayBuffer();
  expect(new Uint8Array(actBuf)).toEqual(new Uint8Array(expBuf));
}

test.describe('Serialization Codec unit tests', () => {
  test('1. Nested JSON values roundtrip (Unicode, emoji, escapes, null, primitives, undefined semantics)', async () => {
    // Primitives
    expect(await roundtrip(null)).toBe(null);
    expect(await roundtrip(0)).toBe(0);
    expect(await roundtrip(-42.5)).toBe(-42.5);
    expect(await roundtrip(true)).toBe(true);
    expect(await roundtrip(false)).toBe(false);
    expect(await roundtrip('')).toBe('');

    // Root undefined
    expect(await roundtrip(undefined)).toBe(undefined);

    // Unicode, emoji, complex scripts
    const textWithUnicode = 'Hello 世界! 🚀✨ 👨‍👩‍👧‍👦 — \u0000 \b \f \n \r \t " \\ /';
    expect(await roundtrip(textWithUnicode)).toBe(textWithUnicode);

    // Nested object & array with escapes and undefined semantics
    const input = {
      title: 'Emoji test 🎨',
      emptyStr: '',
      nullVal: null,
      zero: 0,
      neg: -999,
      bool: true,
      escapes: 'Line1\nLine2\t"quoted" \\escaped\\',
      tags: ['alpha', 'beta', null, 'gamma'],
      // Undefined in array becomes null (standard JSON behavior)
      arrWithUndefined: [1, undefined, 3],
      // Undefined in object property is omitted (standard JSON behavior)
      omittedProp: undefined,
      deep: {
        level1: {
          level2: {
            items: [
              { id: 1, name: 'first' },
              { id: 2, name: 'second', nestedArray: [true, false, null] },
            ],
          },
        },
      },
    };

    const output = (await roundtrip(input)) as any;
    expect(output.title).toBe(input.title);
    expect(output.emptyStr).toBe('');
    expect(output.nullVal).toBe(null);
    expect(output.zero).toBe(0);
    expect(output.neg).toBe(-999);
    expect(output.bool).toBe(true);
    expect(output.escapes).toBe(input.escapes);
    expect(output.tags).toEqual(['alpha', 'beta', null, 'gamma']);
    expect(output.arrWithUndefined).toEqual([1, null, 3]);
    expect('omittedProp' in output).toBe(false);
    expect(output.deep).toEqual(input.deep);

    // Date / toJSON behavior preservation
    const now = new Date();
    const dateOutput = await roundtrip({ date: now });
    expect(dateOutput).toEqual({ date: now.toJSON() });

    // Cyclic values throw TypeError before sending
    const cyclicObj: any = { name: 'cyclic' };
    cyclicObj.self = cyclicObj;
    expect(() => encodePayload(cyclicObj)).toThrow(TypeError);

    // Unsupported root types throw TypeError
    expect(() => encodePayload(() => {})).toThrow(TypeError);
    expect(() => encodePayload(Symbol('sym'))).toThrow(TypeError);
    expect(() => encodePayload(BigInt(123))).toThrow(TypeError);
    expect(() => encodePayload(new Map())).toThrow(TypeError);
    expect(() => encodePayload(new Set())).toThrow(TypeError);
  });

  test('2. Top-level Blob and Blobs nested in objects/arrays roundtrip exact bytes/MIME', async () => {
    // Top-level Blob with text
    const textBlob = new Blob(['Hello, this is a top-level blob! ✨'], {
      type: 'text/plain;charset=utf-8',
    });
    const resTextBlob = await roundtrip(textBlob);
    await expectBlobEquals(resTextBlob, textBlob);

    // Empty Blob with explicit MIME
    const emptyBlob = new Blob([], { type: 'application/x-empty-test' });
    const resEmptyBlob = await roundtrip(emptyBlob);
    await expectBlobEquals(resEmptyBlob, emptyBlob);

    // Binary zero bytes and full range byte values
    const binaryBytes = new Uint8Array([0, 0, 0, 0, 1, 127, 128, 254, 255, 0, 42]);
    const binaryBlob = new Blob([binaryBytes], { type: 'application/octet-stream' });
    const resBinaryBlob = await roundtrip(binaryBlob);
    await expectBlobEquals(resBinaryBlob, binaryBlob);

    // Multiple distinct Blobs nested in plain objects and arrays
    const blobA = new Blob(['first-blob'], { type: 'text/plain' });
    const blobB = new Blob([new Uint8Array([10, 20, 30, 40])], { type: 'application/x-custom' });
    const blobC = new Blob([], { type: 'image/png' });

    const complexPayload = {
      header: 'multi-blob payload',
      primaryBlob: blobA,
      items: [
        { id: 'item-1', data: blobB },
        { id: 'item-2', empty: blobC, note: 'sibling' },
      ],
      emptyArray: [],
    };

    const resComplex = (await roundtrip(complexPayload)) as typeof complexPayload;
    expect(resComplex.header).toBe('multi-blob payload');
    await expectBlobEquals(resComplex.primaryBlob, blobA);
    expect(resComplex.items[0].id).toBe('item-1');
    await expectBlobEquals(resComplex.items[0].data, blobB);
    expect(resComplex.items[1].id).toBe('item-2');
    expect(resComplex.items[1].note).toBe('sibling');
    await expectBlobEquals(resComplex.items[1].empty, blobC);
  });

  test('JSON traversal preserves Blob paths through shared objects, empty keys, arrays, and toJSON', async () => {
    const blob = new Blob(['shared bytes'], { type: 'text/plain' });
    const shared = { '': { ['__proto__']: blob } };
    let reads = 0;
    const input = {
      left: shared,
      array: [shared, undefined, , () => {}, Symbol('omitted')],
      get right() { reads++; return shared; },
      custom: { toJSON(key: string) { return { key, value: shared }; } },
      omitted: () => {},
    };
    const output = await roundtrip(input, { chunkSize: 32 }) as any;
    expect(reads).toBe(1);
    expect(output.array.slice(1)).toEqual([null, null, null, null]);
    expect(output).not.toHaveProperty('omitted');
    expect(output.custom.key).toBe('custom');
    for (const item of [output.left, output.right, output.array[0], output.custom.value]) {
      await expectBlobEquals(item['']['__proto__'], blob);
    }
    expect(shared['']['__proto__']).toBe(blob);
  });

  test('Blob path depth, key length, and MIME limits survive JSON traversal', async () => {
    const blob = new Blob(['boundary']);
    let nested: unknown = blob;
    for (let i = 0; i < 256; i++) nested = { child: nested };
    await roundtrip(nested);
    await roundtrip({ ['x'.repeat(512)]: blob });
    expect(() => encodePayload({ child: nested })).toThrow('Payload nesting exceeds maximum depth');
    expect(() => encodePayload({ ['x'.repeat(513)]: blob })).toThrow('Blob MIME or property path exceeds limits');
    expect(() => encodePayload(new Blob([], { type: 'x'.repeat(257) }))).toThrow('Blob MIME or property path exceeds limits');
  });

  test('3. User objects resembling internal tags and keys such as __proto__ roundtrip without prototype changes', async () => {
    // User object containing internal-looking fields
    const userLookalike = {
      $__rpc_blob__: 12345,
      blobs: ['not a blob', { path: ['fake'], size: 999 }],
      version: 1,
      totalChunks: 99,
      data: 'innocent user string',
    };

    const resLookalike = (await roundtrip(userLookalike)) as typeof userLookalike;
    expect(resLookalike).toEqual(userLookalike);
    expect(isBlob(resLookalike)).toBe(false);

    // User object with own __proto__ property parsed from JSON
    const parsedWithProto = JSON.parse('{"__proto__": {"polluted": true}, "safeProp": 42}');
    const resProto = (await roundtrip(parsedWithProto)) as any;

    expect(resProto.safeProp).toBe(42);
    // Object prototype must NOT be polluted
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty('polluted')).toBe(false);

    // User object with Blob under own special keys ('__proto__', 'constructor', 'prototype')
    const specialKeyObj = {
      ['__proto__']: new Blob(['proto-blob-content'], { type: 'text/plain' }),
      constructor: new Blob(['constructor-blob'], { type: 'text/custom' }),
      prototype: new Blob(['prototype-blob'], { type: 'text/custom2' }),
    };

    const resSpecial = (await roundtrip(specialKeyObj)) as any;
    const protoBlob = Object.getOwnPropertyDescriptor(resSpecial, '__proto__')?.value;
    await expectBlobEquals(protoBlob, Object.getOwnPropertyDescriptor(specialKeyObj, '__proto__')?.value);
    await expectBlobEquals(resSpecial.constructor, specialKeyObj.constructor);
    await expectBlobEquals(resSpecial.prototype, specialKeyObj.prototype);
    expect(({} as any).polluted).toBeUndefined();
  });

  test('4. Chunk boundaries just below/equal/above small configured size; chunks stay bounded and fragment long strings', async () => {
    const configuredChunkSize = 32;

    // Test a very long individual string (5000 characters)
    const longString = 'abc🦊xyz🚀'.repeat(500); // multi-byte and emoji
    const sourceLong = encodePayload(longString, { chunkSize: configuredChunkSize });
    expect(sourceLong.descriptor.totalChunks).toBeGreaterThan(50);

    const decoderLong = new PayloadDecoder(sourceLong.descriptor);
    let lastResult: DecodeResult = { done: false };

    for (let seq = 0; seq < sourceLong.descriptor.totalChunks; seq++) {
      const chunk = await sourceLong.readChunk(seq);
      const jsonStr = JSON.stringify(chunk);
      expect(jsonStr.length).toBeLessThan(configuredChunkSize * 4 + 100);
      lastResult = decoderLong.acceptChunk(chunk);
    }
    sourceLong.dispose();
    expect(lastResult.done).toBe(true);
    expect(lastResult.value).toBe(longString);

    // Test boundary sizes: length right at, below, and above chunk boundaries
    for (const len of [
      configuredChunkSize - 1,
      configuredChunkSize,
      configuredChunkSize + 1,
      configuredChunkSize * 2 - 1,
      configuredChunkSize * 2,
      configuredChunkSize * 2 + 1,
    ]) {
      const boundaryStr = 'A'.repeat(len);
      const res = await roundtrip(boundaryStr, { chunkSize: configuredChunkSize });
      expect(res).toBe(boundaryStr);

      const boundaryBlob = new Blob(['B'.repeat(len)], { type: 'text/plain' });
      const blobRes = await roundtrip(boundaryBlob, { chunkSize: configuredChunkSize });
      await expectBlobEquals(blobRes, boundaryBlob);
    }
  });

  test('5. Malformed descriptors, wrong ordering/index, invalid base64, length mismatch, and limits fail deterministically', async () => {
    // Malformed descriptor: wrong version
    expect(
      () =>
        new PayloadDecoder({
          version: 2 as any,
          totalChunks: 1,
          jsonChunks: 1,
          blobChunks: 0,
          jsonLength: 10,
          totalBlobBytes: 0,
          totalBlobs: 0,
          chunkSize: 100,
        })
    ).toThrow(/version/);

    // Malformed descriptor: chunks sum mismatch
    expect(
      () =>
        new PayloadDecoder({
          version: 1,
          totalChunks: 5,
          jsonChunks: 2,
          blobChunks: 2, // 2 + 2 != 5
          jsonLength: 100,
          totalBlobBytes: 0,
          totalBlobs: 0,
          chunkSize: 50,
        })
    ).toThrow(/totalChunks/);

    // Budget limit enforcement via estimatePayloadMemory
    expect(estimatePayloadMemory(100, 200)).toBe(400);
    expect(
      () =>
        new PayloadDecoder(
          {
            version: 1,
            totalChunks: 2,
            jsonChunks: 1,
            blobChunks: 1,
            jsonLength: 50,
            totalBlobBytes: 500,
            totalBlobs: 1,
            chunkSize: 100,
          },
          { maxTotalBytes: 400 } // lower than 50*2 + 500 = 600
        )
    ).toThrow(/exceeds limit/);

    // Budget limit enforcement: maxBlobs
    expect(
      () =>
        new PayloadDecoder(
          {
            version: 1,
            totalChunks: 2,
            jsonChunks: 1,
            blobChunks: 1,
            jsonLength: 50,
            totalBlobBytes: 50,
            totalBlobs: 10,
            chunkSize: 100,
          },
          { maxBlobs: 5 }
        )
    ).toThrow(/totalBlobs/);

    // Wrong sequence ordering: chunk 1 before chunk 0
    const source = encodePayload({ a: 1 }, { chunkSize: 10 });
    const decoder = new PayloadDecoder(source.descriptor);
    const chunk0 = await source.readChunk(0);
    const chunk1 = await source.readChunk(1);

    expect(() => decoder.acceptChunk(chunk1)).toThrow(/Invalid chunk sequence/);

    // Correct chunk 0, then duplicate chunk 0
    decoder.acceptChunk(chunk0);
    expect(() => decoder.acceptChunk(chunk0)).toThrow(/Invalid chunk sequence/);
    source.dispose();

    // Invalid base64 in blob chunk: invalid chars
    const blobSource = encodePayload(new Blob(['test-blob'], { type: 'text/plain' }), {
      chunkSize: 16,
    });
    const blobDecoder = new PayloadDecoder(blobSource.descriptor);
    for (let i = 0; i < blobSource.descriptor.jsonChunks; i++) {
      blobDecoder.acceptChunk(await blobSource.readChunk(i));
    }
    expect(() =>
      blobDecoder.acceptChunk({
        seq: blobSource.descriptor.jsonChunks,
        kind: 'blob',
        blobIndex: 0,
        data: '@@@invalid-base64@@@',
      })
    ).toThrow(/length mismatch|Invalid base64/);

    blobSource.dispose();

    // Strict base64 validation rejects URL-safe base64 that js-base64 would otherwise accept
    expect(() => base64ToUint8Array('---------AA=')).toThrow('Invalid base64 string');

    // Length mismatch: JSON chunk data does not match expected length
    const badJsonDecoder = new PayloadDecoder({
      version: 1,
      totalChunks: 1,
      jsonChunks: 1,
      blobChunks: 0,
      jsonLength: 100,
      totalBlobBytes: 0,
      totalBlobs: 0,
      chunkSize: 100,
    });
    expect(() =>
      badJsonDecoder.acceptChunk({
        seq: 0,
        kind: 'json',
        data: '{"tooShort":true}',
      })
    ).toThrow(/length mismatch/);

    // Extra chunk after completion throws
    const simpleSource = encodePayload('hello');
    const simpleDecoder = new PayloadDecoder(simpleSource.descriptor);
    const c0 = await simpleSource.readChunk(0);
    const res = simpleDecoder.acceptChunk(c0);
    expect(res.done).toBe(true);
    expect(() => simpleDecoder.acceptChunk(c0)).toThrow(/already completed/);
    simpleSource.dispose();

    // Hostile manifest attempting to traverse unowned/inherited property throws
    const hostileManifest = {
      isUndefined: false,
      root: {},
      blobs: [{ path: ['toString'], size: 0, mime: 'text/plain' }],
    };
    const hostileJson = JSON.stringify(hostileManifest);
    const hostileDecoder = new PayloadDecoder({
      version: 1,
      totalChunks: 1,
      jsonChunks: 1,
      blobChunks: 0,
      jsonLength: hostileJson.length,
      totalBlobBytes: 0,
      totalBlobs: 1,
      chunkSize: hostileJson.length + 10,
    });
    expect(() =>
      hostileDecoder.acceptChunk({
        seq: 0,
        kind: 'json',
        data: hostileJson,
      })
    ).toThrow(/Blob target property must exist as an own property/);

    // Hostile manifest attempting path traversal on absent property
    const hostileProtoManifest = {
      isUndefined: false,
      root: {},
      blobs: [{ path: ['__proto__', 'polluted'], size: 0, mime: 'text/plain' }],
    };
    const hostileProtoJson = JSON.stringify(hostileProtoManifest);
    const hostileProtoDecoder = new PayloadDecoder({
      version: 1,
      totalChunks: 1,
      jsonChunks: 1,
      blobChunks: 0,
      jsonLength: hostileProtoJson.length,
      totalBlobBytes: 0,
      totalBlobs: 1,
      chunkSize: hostileProtoJson.length + 10,
    });
    expect(() =>
      hostileProtoDecoder.acceptChunk({
        seq: 0,
        kind: 'json',
        data: hostileProtoJson,
      })
    ).toThrow(/Path segment does not exist as own property/);

    // Lifecycle finish() on incomplete decoder throws
    const incSource = encodePayload('hello-multi-chunk', { chunkSize: 6 });
    const incDecoder = new PayloadDecoder(incSource.descriptor);
    expect(() => incDecoder.finish()).toThrow(/Payload incomplete/);
    incDecoder.abort();
    expect(() => incDecoder.finish()).toThrow(/aborted/);
    incSource.dispose();
  });

  test('6. Blob encoding demonstrates per-fragment access without materializing full binary at start', async () => {
    // Create a 1000-byte test Blob
    const data = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) data[i] = i % 256;
    const testBlob = new Blob([data], { type: 'application/octet-stream' });

    let arrayBufferCallsOnOriginal = 0;
    const originalArrayBuffer = testBlob.arrayBuffer.bind(testBlob);
    testBlob.arrayBuffer = async function () {
      arrayBufferCallsOnOriginal++;
      return originalArrayBuffer();
    };

    let sliceCalls = 0;
    const originalSlice = testBlob.slice.bind(testBlob);
    testBlob.slice = function (start?: number, end?: number, contentType?: string) {
      sliceCalls++;
      return originalSlice(start, end, contentType);
    };

    // 1. Initial encodePayload must NOT call arrayBuffer on the blob
    const source = encodePayload(testBlob, { chunkSize: 200 });
    expect(arrayBufferCallsOnOriginal).toBe(0);
    expect(sliceCalls).toBe(0);
    expect(source.descriptor.blobChunks).toBeGreaterThan(1);

    // 2. Reading JSON chunks does not read blob bytes
    for (let seq = 0; seq < source.descriptor.jsonChunks; seq++) {
      const chunk = await source.readChunk(seq);
      expect(chunk.kind).toBe('json');
    }
    expect(arrayBufferCallsOnOriginal).toBe(0);
    expect(sliceCalls).toBe(0);

    // 3. Reading the first blob chunk calls slice once for the requested bounded byte window
    const firstBlobSeq = source.descriptor.jsonChunks;
    const blobChunk1 = await source.readChunk(firstBlobSeq);
    expect(blobChunk1.kind).toBe('blob');
    expect(sliceCalls).toBe(1);
    expect(arrayBufferCallsOnOriginal).toBe(0);

    // 4. Decode the chunks through PayloadDecoder and verify reconstruction
    const decoder = new PayloadDecoder(source.descriptor);
    for (let seq = 0; seq < source.descriptor.jsonChunks; seq++) {
      decoder.acceptChunk(await source.readChunk(seq));
    }
    decoder.acceptChunk(blobChunk1);
    let finalResult: DecodeResult = { done: false };
    for (let seq = firstBlobSeq + 1; seq < source.descriptor.totalChunks; seq++) {
      finalResult = decoder.acceptChunk(await source.readChunk(seq));
    }
    expect(finalResult.done).toBe(true);

    // Verification: arrayBuffer was NEVER called on the original full Blob during encode or chunk reads
    expect(arrayBufferCallsOnOriginal).toBe(0);

    // Check that the reconstructed Blob content matches original data without touching testBlob
    const reconstructedBlob = finalResult.value as Blob;
    expect(isBlob(reconstructedBlob)).toBe(true);
    expect(reconstructedBlob.type).toBe('application/octet-stream');
    expect(reconstructedBlob.size).toBe(1000);
    const reconstructedBuffer = await reconstructedBlob.arrayBuffer();
    expect(new Uint8Array(reconstructedBuffer)).toEqual(data);

    source.dispose();
  });
});
