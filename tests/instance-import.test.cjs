const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const AdmZip = require('adm-zip');

const {
  inspectImportArchive,
  importInstanceData,
  exportInstance,
} = require('../dist/runtime/instance-import');

test('instance-import unit tests', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-import-'));

  t.after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // 1. Create a dummy instance directory
  const instanceDir = path.join(tmpDir, 'instance-alpha');
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'server.js'), 'console.log("server");', 'utf8');
  fs.writeFileSync(path.join(instanceDir, 'package.json'), '{"name":"tavern"}', 'utf8');
  const dataDir = path.join(instanceDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'existing.txt'), 'old-content', 'utf8');

  // 2. Create a zip archive with user data and system files
  const archivePath = path.join(tmpDir, 'backup.zip');
  const zip = new AdmZip();
  zip.addFile('data/chats/chat1.json', Buffer.from('{"messages":[]}'));
  zip.addFile('data/characters/bot.png', Buffer.from([1, 2, 3, 4]));
  zip.addFile('data/_webpack/cache.bin', Buffer.from('cache')); // should be skipped
  zip.addFile('plugins/custom-plugin/index.js', Buffer.from('plugin-code'));
  zip.addFile('public/scripts/extensions/third-party/my-ext/ext.js', Buffer.from('ext-code'));
  zip.addFile('node_modules/express/index.js', Buffer.from('ignored-node-module')); // should be skipped
  zip.addFile('package.json', Buffer.from('{"hacked":true}')); // should be skipped
  zip.addFile('secrets.json', Buffer.from('{"token":"secret"}')); // optional
  zip.writeZip(archivePath);

  await t.test('inspectImportArchive properly inspects and classifies user data', async () => {
    const summary = await inspectImportArchive(archivePath);
    assert.equal(summary.importable, true);
    assert.equal(summary.hasSecrets, true);
    assert.equal(summary.hasConfig, false);
    // 4 user data entries: data/chats/chat1.json, data/characters/bot.png, plugins/custom-plugin/index.js, public/scripts/extensions/third-party/my-ext/ext.js
    assert.equal(summary.importEntries, 4);
    // Skipped: data/_webpack/cache.bin, node_modules/express/index.js, package.json, secrets.json
    assert.equal(summary.skippedEntries, 4);
  });

  await t.test('importInstanceData extracts user data and ignores system files', async () => {
    const outcome = await importInstanceData({
      instanceId: 'test-inst',
      installPath: instanceDir,
      archivePath: archivePath,
      includeOptional: false,
    });

    assert.equal(outcome.imported, 4);
    assert.equal(outcome.skipped, 4);

    // Verify user data files are imported
    assert.equal(fs.existsSync(path.join(instanceDir, 'data', 'chats', 'chat1.json')), true);
    assert.equal(fs.existsSync(path.join(instanceDir, 'plugins', 'custom-plugin', 'index.js')), true);
    assert.equal(fs.existsSync(path.join(instanceDir, 'public', 'scripts', 'extensions', 'third-party', 'my-ext', 'ext.js')), true);

    // Verify existing untouched files remain
    assert.equal(fs.existsSync(path.join(instanceDir, 'data', 'existing.txt')), true);
    assert.equal(fs.readFileSync(path.join(instanceDir, 'data', 'existing.txt'), 'utf8'), 'old-content');

    // Verify system files were NEVER overwritten or imported
    assert.equal(fs.readFileSync(path.join(instanceDir, 'package.json'), 'utf8'), '{"name":"tavern"}');
    assert.equal(fs.existsSync(path.join(instanceDir, 'node_modules')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, 'data', '_webpack')), false);
    assert.equal(fs.existsSync(path.join(instanceDir, 'secrets.json')), false);
  });

  await t.test('inspectImportArchive handles wrapper prefix (e.g. SillyTavern/...) correctly', async () => {
    const wrappedZipPath = path.join(tmpDir, 'wrapped.zip');
    const wrappedZip = new AdmZip();
    wrappedZip.addFile('SillyTavern/data/test.json', Buffer.from('{}'));
    wrappedZip.addFile('SillyTavern/server.js', Buffer.from('server'));
    wrappedZip.writeZip(wrappedZipPath);

    const summary = await inspectImportArchive(wrappedZipPath);
    assert.equal(summary.importable, true);
    assert.equal(summary.wrapperPrefix, 'SillyTavern/');
    assert.equal(summary.importEntries, 1);
    assert.equal(summary.skippedEntries, 1);
  });

  await t.test('exportInstance creates a valid zip in downloads', async () => {
    const result = await exportInstance({
      instanceId: 'test-inst',
      installPath: instanceDir,
    });

    assert.ok(result.path);
    assert.ok(result.bytes > 0);
    assert.equal(fs.existsSync(result.path), true);

    // Read back exported zip
    const expZip = new AdmZip(result.path);
    const expEntries = expZip.getEntries().map((e) => e.entryName.replace(/\\/g, '/'));
    assert.ok(expEntries.includes('server.js'));
    assert.ok(expEntries.some((e) => e.startsWith('data/')));

    // Cleanup exported file
    try { fs.rmSync(result.path, { force: true }); } catch {}
  });
});
