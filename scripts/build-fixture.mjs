import { build } from 'tsup';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const outDir = path.resolve(rootDir, '.e2e-extension');
const fixtureDir = path.resolve(rootDir, 'e2e/extension');

export async function buildFixture(customOutDir, customDistPath) {
  const targetOutDir = customOutDir ? path.resolve(rootDir, customOutDir) : outDir;
  if (!fs.existsSync(targetOutDir)) {
    fs.mkdirSync(targetOutDir, { recursive: true });
  }

  const distEntry = customDistPath ? path.resolve(rootDir, customDistPath) : path.resolve(rootDir, 'dist/index.mjs');
  if (!fs.existsSync(distEntry)) {
    if (customDistPath) throw new Error(`Packed library entry is missing: ${distEntry}`);
    // If library dist does not exist yet, compile it first using tsup
    await build({
      entry: [path.resolve(rootDir, 'src/index.ts')],
      outDir: path.resolve(rootDir, 'dist'),
      format: ['cjs', 'esm'],
      dts: true,
      clean: false,
    });
  }

  const esbuildPlugins = customDistPath
    ? [
        {
          name: 'alias-dist-entry',
          setup(build) {
            build.onResolve({ filter: /dist\/index\.mjs$/ }, () => {
              return { path: distEntry };
            });
          },
        },
      ]
    : [];

  // 1. Build background service worker and extension page (ESM)
  await build({
    entry: [path.resolve(fixtureDir, 'background.ts'), path.resolve(fixtureDir, 'page.ts')],
    outDir: targetOutDir,
    format: ['esm'],
    target: 'es2020',
    sourcemap: 'inline',
    clean: false,
    noExternal: [/.*/],
    esbuildPlugins,
    outExtension() {
      return { js: '.js' };
    },
  });

  // 2. Build content script (IIFE)
  await build({
    entry: [path.resolve(fixtureDir, 'content.ts')],
    outDir: targetOutDir,
    format: ['iife'],
    target: 'es2020',
    sourcemap: 'inline',
    clean: false,
    noExternal: [/.*/],
    esbuildPlugins,
    outExtension() {
      return { js: '.js' };
    },
  });

  // 3. Copy manifest and html files
  fs.copyFileSync(
    path.resolve(fixtureDir, 'manifest.json'),
    path.resolve(targetOutDir, 'manifest.json')
  );
  fs.copyFileSync(
    path.resolve(fixtureDir, 'page.html'),
    path.resolve(targetOutDir, 'page.html')
  );
}

if (process.argv[1] === __filename) {
  buildFixture(process.argv[2], process.argv[3]).catch((err) => {
    console.error('Failed to build fixture:', err);
    process.exit(1);
  });
}
