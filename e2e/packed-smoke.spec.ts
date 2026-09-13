import { test, expect, chromium } from '@playwright/test';
import { execSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const packedTestDir = path.resolve(rootDir, '.package-test-browser');
const packedPkgDir = path.resolve(packedTestDir, 'package');
const packedExtDir = path.resolve(packedTestDir, 'extension');

test.describe('Packed Library Browser Artifact Smoke', () => {
  test('Pack tgz, build fixture using packed artifact, and perform JSON+Blob roundtrip in Chromium', async () => {
    // 1. Prepare clean packed test directories
    if (fs.existsSync(packedTestDir)) {
      fs.rmSync(packedTestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(packedTestDir, { recursive: true });

    try {
      // 2. Pack local package to tgz
      execSync(`npm pack --pack-destination "${packedTestDir}"`, { cwd: rootDir, encoding: 'utf8' });
      const tarballs = fs.readdirSync(packedTestDir).filter((f) => f.endsWith('.tgz'));
      expect(tarballs.length).toBe(1);
      const tgzPath = path.resolve(packedTestDir, tarballs[0]);

      // 3. Extract tarball
      execSync(`tar -xzf "${tgzPath}" -C "${packedTestDir}"`, { cwd: rootDir, encoding: 'utf8' });
      const distMjs = path.resolve(packedPkgDir, 'dist/index.mjs');
      expect(fs.existsSync(distMjs)).toBe(true);

      // 4. Build fixture extension using the extracted packed library artifact
       execFileSync(process.execPath, ['scripts/build-fixture.mjs', packedExtDir, distMjs], { cwd: rootDir, stdio: 'pipe' });
      expect(fs.existsSync(path.resolve(packedExtDir, 'background.js'))).toBe(true);

      // 5. Launch persistent context with extension built from packed artifact
      const profileDir = path.resolve(packedTestDir, 'profile');
      fs.mkdirSync(profileDir, { recursive: true });

      const context = await chromium.launchPersistentContext(profileDir, {
        channel: 'chromium',
        headless: true,
        args: [
          `--disable-extensions-except=${packedExtDir}`,
          `--load-extension=${packedExtDir}`,
        ],
      });

      try {
        let [background] = context.serviceWorkers();
        if (!background) {
          background = await context.waitForEvent('serviceworker', { timeout: 15000 });
        }
        const extensionId = background.url().split('/')[2];
        expect(extensionId).toBeDefined();

        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/page.html`);
        await page.waitForSelector('#status:has-text("ready")', { timeout: 15000 });

        // Log actual browser version
        const userAgent = await page.evaluate(() => navigator.userAgent);
        const browserVerMatch = userAgent.match(/Chrome\/([0-9.]+)/);
        const browserVersion = browserVerMatch ? browserVerMatch[1] : 'unknown';
        console.log(`[packed-smoke] Chromium version: ${browserVersion}`);

        // 6. Perform public RPC roundtrip with JSON + Blob payload
        const smokeResult = await page.evaluate(async () => {
          const sampleBytes = new Uint8Array([1, 2, 3, 4, 5, 255, 128, 0, 42]);
          const testBlob = new Blob([sampleBytes], { type: 'application/x-packed-smoke' });

          const reply = await window.testApi.callBgViaLargeRequester('echoBlob', {
            label: 'packed-artifact-smoke',
            blob: testBlob,
          });

          const replyBuf = await reply.blob.arrayBuffer();
          const replyBytes = Array.from(new Uint8Array(replyBuf));

          return {
            label: reply.label,
            size: reply.size,
            blobSize: reply.blob.size,
            blobType: reply.blob.type,
            isBlob: reply.blob instanceof Blob,
            bytesMatch: replyBytes.every((v, i) => v === sampleBytes[i]),
          };
        });

        expect(smokeResult.label).toBe('echo-packed-artifact-smoke');
        expect(smokeResult.isBlob).toBe(true);
        expect(smokeResult.blobSize).toBe(9);
        expect(smokeResult.blobType).toBe('application/x-packed-smoke');
        expect(smokeResult.bytesMatch).toBe(true);

        await page.close();
      } finally {
        await context.close();
      }
    } finally {
      fs.rmSync(packedTestDir, { recursive: true, force: true });
    }
  });
});
