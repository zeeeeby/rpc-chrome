import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '../..');
const packageTestDir = path.resolve(rootDir, '.package-test');

test.describe('NPM Package Artifact Verification', () => {
  test('1. npm pack --dry-run includes only dist artifacts and package metadata; excludes tests/fixtures/tasks', () => {
    const stdout = execSync('npm pack --dry-run --json', { cwd: rootDir, encoding: 'utf8' });
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);

    const packInfo = parsed[0];
    const pkgJson = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
    expect(packInfo.name).toBe('rpc-chrome');
    expect(packInfo.version).toBe(pkgJson.version);

    const filePaths: string[] = packInfo.files.map((f: { path: string }) => f.path);

    // Required published artifacts
    expect(filePaths).toContain('dist/index.js');
    expect(filePaths).toContain('dist/index.mjs');
    expect(filePaths).toContain('dist/index.d.ts');
    expect(filePaths).toContain('package.json');
    expect(filePaths).toContain('README.md');

    // Forbidden files: must NOT publish test fixtures, profiles, traces, internal tasks
    for (const filePath of filePaths) {
      expect(filePath).not.toMatch(/^e2e\//);
      expect(filePath).not.toMatch(/^tests\//);
      expect(filePath).not.toMatch(/^scripts\//);
      expect(filePath).not.toMatch(/\.e2e/);
      expect(filePath).not.toMatch(/TASKS\.md/);
      expect(filePath).not.toMatch(/playwright\.config/);
      expect(filePath).not.toMatch(/tsconfig/);
      expect(filePath).not.toMatch(/\.aider/);
    }
  });

  test('2. Packing into local tgz and importing extracted artifact resolves public classes', async () => {
    if (fs.existsSync(packageTestDir)) {
      fs.rmSync(packageTestDir, { recursive: true, force: true });
    }
    fs.mkdirSync(packageTestDir, { recursive: true });

    try {
      // Pack into ignored directory
      execSync(`npm pack --pack-destination "${packageTestDir}"`, { cwd: rootDir, encoding: 'utf8' });
      const tarballs = fs.readdirSync(packageTestDir).filter((f) => f.endsWith('.tgz'));
      expect(tarballs.length).toBe(1);

      const tarballPath = path.resolve(packageTestDir, tarballs[0]);

      // Extract tarball
      execSync(`tar -xzf "${tarballPath}" -C "${packageTestDir}"`, { cwd: rootDir, encoding: 'utf8' });
      const extractedPackageDir = path.resolve(packageTestDir, 'package');
      expect(fs.existsSync(path.resolve(extractedPackageDir, 'dist/index.mjs'))).toBe(true);
      expect(fs.existsSync(path.resolve(extractedPackageDir, 'dist/index.d.ts'))).toBe(true);

      // Verify that importing the packed artifact provides all expected exports
      const imported = await import(path.resolve(extractedPackageDir, 'dist/index.mjs'));
      expect(typeof imported.Responder).toBe('function');
      expect(typeof imported.Requester).toBe('function');
      expect(typeof imported.RuntimeRequester).toBe('function');
      expect(typeof imported.ContentScriptRequester).toBe('function');
    } finally {
      fs.rmSync(packageTestDir, { recursive: true, force: true });
    }
  });
});
