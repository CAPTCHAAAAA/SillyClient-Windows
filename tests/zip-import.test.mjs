import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const compiled = process.env.SILLYCLIENT_TEST_HOST_DIST;
const base = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
if (!compiled || !base) throw new Error('Set the host build and migration test directories.');

let root, stagingParent, validZipPath;

beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'zip-test-case-'));
  stagingParent = path.join(root, 'staging');
  await fs.mkdir(stagingParent, { recursive: true });

  // 鍒涘缓涓€涓悎娉曠殑鍖呭惈閰掗鏂囦欢鐨?ZIP锛堝甫涓€灞傚瓙鏂囦欢澶瑰寘瑁咃級
  const zip = new AdmZip();
  zip.addFile('SillyTavern-1.12.0/package.json', Buffer.from(JSON.stringify({ name: 'sillytavern', version: '1.12.0' })));
  zip.addFile('SillyTavern-1.12.0/server.js', Buffer.from('console.log("server");'));
  zip.addFile('SillyTavern-1.12.0/data/default-user/settings.json', Buffer.from('{"theme":"test"}'));
  validZipPath = path.join(root, 'backup.zip');
  zip.writeZip(validZipPath);
});

afterEach(async () => {
  if (path.dirname(root) !== path.resolve(base) || !path.basename(root).startsWith('zip-test-case-')) {
    throw new Error('Unsafe cleanup directory.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('successfully extracts and locates tavern in nested zip', async () => {
  const { extractAndValidateZip } = require(path.join(compiled, 'runtime/zip-import.js'));
  const progressReports = [];
  const result = await extractAndValidateZip(validZipPath, stagingParent, {
    onProgress: (percent, msg) => progressReports.push({ percent, msg }),
  });

  try {
    assert.ok(result.tavernRoot);
    assert.equal(path.basename(result.tavernRoot), 'SillyTavern-1.12.0');
    const pkg = JSON.parse(await fs.readFile(path.join(result.tavernRoot, 'package.json'), 'utf8'));
    assert.equal(pkg.version, '1.12.0');
    assert.ok(progressReports.length > 0);
  } finally {
    await result.cleanup();
  }

  // check cleanup removed staging
  const exists = await fs.stat(result.stagingDir).then(() => true).catch(() => false);
  assert.equal(exists, false);
});

test('successfully extracts flat tavern zip', async () => {
  const { extractAndValidateZip } = require(path.join(compiled, 'runtime/zip-import.js'));
  const flatZip = new AdmZip();
  flatZip.addFile('package.json', Buffer.from(JSON.stringify({ name: 'sillytavern', version: '1.13.0' })));
  flatZip.addFile('server.js', Buffer.from('// server'));
  const flatZipPath = path.join(root, 'flat.zip');
  flatZip.writeZip(flatZipPath);

  const result = await extractAndValidateZip(flatZipPath, stagingParent);
  try {
    assert.ok(result.tavernRoot);
    assert.equal(result.tavernRoot, result.stagingDir);
  } finally {
    await result.cleanup();
  }
});

test('rejects non-zip extension', async () => {
  const { extractAndValidateZip } = require(path.join(compiled, 'runtime/zip-import.js'));
  const fakePath = path.join(root, 'not-a-zip.tar.gz');
  await fs.writeFile(fakePath, 'dummy');

  await assert.rejects(
    () => extractAndValidateZip(fakePath, stagingParent),
    { code: 'INVALID_ZIP_EXTENSION' }
  );
});

test('rejects zip without tavern runtime', async () => {
  const { extractAndValidateZip } = require(path.join(compiled, 'runtime/zip-import.js'));
  const emptyZip = new AdmZip();
  emptyZip.addFile('readme.txt', Buffer.from('just a text file'));
  const emptyZipPath = path.join(root, 'empty.zip');
  emptyZip.writeZip(emptyZipPath);

  await assert.rejects(
    () => extractAndValidateZip(emptyZipPath, stagingParent),
    { code: 'INVALID_ZIP_STRUCTURE' }
  );
});

test('rejects zip with directory traversal (Zip Slip)', async () => {
  const { extractAndValidateZip } = require(path.join(compiled, 'runtime/zip-import.js'));
  const maliciousZip = new AdmZip();
  maliciousZip.addFile('normal.txt', Buffer.from('evil'));
  maliciousZip.getEntries()[0].entryName = '../../evil.txt';
  const maliciousZipPath = path.join(root, 'slip.zip');
  await fs.writeFile(maliciousZipPath, maliciousZip.toBuffer());

  await assert.rejects(
    () => extractAndValidateZip(maliciousZipPath, stagingParent),
    { code: 'ZIP_SLIP_ATTACK' }
  );
});

test('inspectImportSelection end-to-end resolves zip file with compatibility scan', async () => {
  const { inspectImportSelection } = require(path.join(compiled, 'runtime/import-source.js'));
  const plan = await inspectImportSelection(validZipPath, {
    mode: 'copy',
    stagingParent,
  });

  try {
    assert.equal(plan.isZipSource, true);
    assert.equal(plan.sourceVersion, '1.12.0');
    assert.ok(plan.compatibility);
    assert.equal(plan.compatibility.summary.total, 0);
  } finally {
    if (plan.zipCleanup) await plan.zipCleanup();
  }
});
