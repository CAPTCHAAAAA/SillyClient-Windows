import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const temporaryRoot = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
const compiledRoot = process.env.SILLYCLIENT_TEST_HOST_DIST;
if (!temporaryRoot || !compiledRoot) {
  throw new Error('Set SILLYCLIENT_MIGRATION_TEST_ROOT and SILLYCLIENT_TEST_HOST_DIST.');
}
const base = path.resolve(temporaryRoot);
const originalLocalAppData = process.env.LOCALAPPDATA;
let root;

beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'distribution-case-'));
  process.env.LOCALAPPDATA = path.join(root, 'local-app-data');
});

afterEach(async () => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (path.dirname(root) !== base || !path.basename(root).startsWith('distribution-case-')) {
    throw new Error('Unsafe test cleanup path.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function loadApp(isTest) {
  const app = path.join(root, isTest ? 'trial-app' : 'production-app');
  const runtime = path.join(app, 'dist', 'runtime');
  await fs.mkdir(runtime, { recursive: true });
  for (const name of ['paths.js', 'distribution.js', 'instances.js']) {
    await fs.copyFile(path.join(compiledRoot, 'runtime', name), path.join(runtime, name));
  }
  await fs.writeFile(path.join(app, 'package.json'), JSON.stringify(isTest
    ? { name: 'sillyclient-windows-migration-test', sillyClientChannel: 'migration-test' }
    : { name: 'sillyclient-windows' }));
  return {
    paths: require(path.join(runtime, 'paths.js')),
    instances: require(path.join(runtime, 'instances.js')),
  };
}

test('trial registry and data stay separate from production records', async () => {
  const stable = await loadApp(false);
  const trial = await loadApp(true);
  stable.instances.registerInstance('existing', path.join(root, 'old-tavern'));
  const before = await fs.readFile(stable.paths.instanceRegistryPath);
  assert.deepEqual(trial.instances.listInstanceRecords(), []);
  trial.paths.ensureDirs();
  const target = trial.paths.serverDirFor('trial');
  trial.instances.registerInstance('trial', target);
  assert.notEqual(trial.paths.sillyClientHome, stable.paths.sillyClientHome);
  assert.notEqual(trial.paths.instanceRegistryPath, stable.paths.instanceRegistryPath);
  assert.deepEqual(await fs.readFile(stable.paths.instanceRegistryPath), before);
});

test('trial blocks external directories and prefix-lookalike directories', async () => {
  const { paths } = await loadApp(true);
  const servers = path.join(paths.bootstrapDir, 'servers');
  for (const candidate of [root, servers, path.join(paths.bootstrapDir, 'servers-other', 'one')]) {
    assert.throws(() => paths.assertManagedInstancePath(candidate));
  }
  assert.throws(() => paths.serverDirFor('one', path.join(root, 'external')));
  assert.equal(paths.serverDirFor('one'), path.join(servers, 'one'));
});

test('trial rejects a junction inside its managed instance directory', async () => {
  const { paths } = await loadApp(true);
  paths.ensureDirs();
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  const link = path.join(paths.bootstrapDir, 'servers', 'linked');
  await fs.symlink(outside, link, 'junction');
  assert.throws(() => paths.assertManagedInstancePath(path.join(link, 'one')));
  assert.deepEqual(await fs.readdir(outside), []);
});

test('production directory selection behavior stays unchanged', async () => {
  const { paths } = await loadApp(false);
  const outside = path.join(root, 'external');
  assert.equal(paths.serverDirFor('one', outside), outside);
  await fs.mkdir(outside);
  assert.equal(paths.serverDirFor('one', outside), path.join(outside, 'one'));
});

test('import registration refuses malformed existing records without overwriting them', async () => {
  const { paths, instances } = await loadApp(false);
  paths.ensureDirs();
  await fs.writeFile(paths.instanceRegistryPath, '{"broken":true}');
  assert.throws(() => instances.registerImportedInstance('new', path.join(root, 'new')));
  assert.equal(await fs.readFile(paths.instanceRegistryPath, 'utf8'), '{"broken":true}');
});

test('failed registry replacement preserves the prior file', async () => {
  const { paths, instances } = await loadApp(false);
  instances.registerInstance('existing', path.join(root, 'existing'));
  const before = await fs.readFile(paths.instanceRegistryPath);
  const sync = require('node:fs');
  const rename = sync.renameSync;
  try {
    sync.renameSync = () => { throw new Error('Simulated rename failure'); };
    assert.throws(() => instances.registerImportedInstance('new', path.join(root, 'new')));
  } finally {
    sync.renameSync = rename;
  }
  assert.deepEqual(await fs.readFile(paths.instanceRegistryPath), before);
});
