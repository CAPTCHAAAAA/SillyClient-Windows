import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = process.env.SILLYCLIENT_TEST_HOST_DIST;
const base = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
if (!compiled || !base) throw new Error('Set the host build and migration test directories.');

let root, mockDesktop;
async function put(dir, file, content) {
  const full = path.join(dir, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'discover-test-case-'));
  mockDesktop = path.join(root, 'Desktop');
  await fs.mkdir(mockDesktop, { recursive: true });
});

afterEach(async () => {
  if (path.dirname(root) !== path.resolve(base) || !path.basename(root).startsWith('discover-test-case-')) {
    throw new Error('Unsafe cleanup directory.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('discovers valid sillytavern candidate in custom roots', async () => {
  const { discoverLocalTaverns } = require(path.join(compiled, 'runtime/auto-discover.js'));
  const tavernDir = path.join(mockDesktop, 'SillyTavern-1.12.0');
  await put(tavernDir, 'package.json', JSON.stringify({ name: 'sillytavern', version: '1.12.0' }));
  await put(tavernDir, 'server.js', '// server');
  await put(tavernDir, 'data/default-user/settings.json', '{}');

  const results = await discoverLocalTaverns({ customRoots: [mockDesktop] });
  assert.equal(results.length, 1);
  assert.equal(results[0].version, '1.12.0');
  assert.equal(results[0].hasUserData, true);
  assert.equal(results[0].name, 'SillyTavern-1.12.0');
});

test('ignores non-tavern directory', async () => {
  const { discoverLocalTaverns } = require(path.join(compiled, 'runtime/auto-discover.js'));
  const otherDir = path.join(mockDesktop, 'random-project');
  await put(otherDir, 'package.json', JSON.stringify({ name: 'other-app', version: '1.0.0' }));
  await put(otherDir, 'index.js', '// not server.js');

  const results = await discoverLocalTaverns({ customRoots: [mockDesktop] });
  assert.equal(results.length, 0);
});

test('respects maxResults limit', async () => {
  const { discoverLocalTaverns } = require(path.join(compiled, 'runtime/auto-discover.js'));
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(mockDesktop, `SillyTavern-Inst-${i}`);
    await put(dir, 'package.json', JSON.stringify({ name: 'sillytavern', version: `1.${i}.0` }));
    await put(dir, 'server.js', '// server');
  }

  const results = await discoverLocalTaverns({ customRoots: [mockDesktop], maxResults: 2 });
  assert.equal(results.length, 2);
});
