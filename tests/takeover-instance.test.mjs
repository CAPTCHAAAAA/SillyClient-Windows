import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('yaml');
const base = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
const compiled = process.env.SILLYCLIENT_TEST_HOST_DIST;
if (!base || !compiled) throw new Error('Set the host build and migration test directories.');
const originalLocal = process.env.LOCALAPPDATA;
let root, source, app, store, paths, takeover, inspect, port;
async function put(relative, content) {
  const file = path.join(source, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}
async function snapshot(directory = source) {
  const result = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory() ? await snapshot(file) : await fs.readFile(file, 'hex');
  }
  return result;
}
async function listen() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}
beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'takeover-case-'));
  process.env.LOCALAPPDATA = path.join(root, 'local');
  app = path.join(root, 'app');
  const runtime = path.join(app, 'dist/runtime');
  await fs.mkdir(runtime, { recursive: true });
  for (const name of ['paths', 'distribution', 'instances', 'data-migration', 'takeover-instance']) {
    await fs.copyFile(path.join(compiled, `runtime/${name}.js`), path.join(runtime, `${name}.js`));
  }
  await fs.writeFile(path.join(app, 'package.json'), '{"name":"sillyclient-windows"}');
  paths = require(path.join(runtime, 'paths.js'));
  store = require(path.join(runtime, 'instances.js'));
  takeover = require(path.join(runtime, 'takeover-instance.js'));
  inspect = require(path.join(runtime, 'data-migration.js')).inspectMigrationSource;
  source = path.join(root, 'old');
  const probe = await listen();
  port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  await put('package.json', '{"name":"sillytavern","version":"1.18.0"}');
  await put('server.js', 'throw new Error("Unit tests must not execute this");');
  await put('src/command-line.js', "parser.option('configPath', {});");
  await put('config.yaml', `dataRoot: ./data\nport: ${port}\nlisten: true\nenableUserAccounts: true\nenableServerPlugins: true\nprotocol:\n  ipv4: false\n  ipv6: true\nssl:\n  enabled: true\nbrowserLaunch:\n  enabled: true\nextensions:\n  enabled: true\n  autoUpdate: true\n`);
  await put('start-server.bat', '@echo original launcher');
  await put('node_modules/keep.txt', 'original dependencies');
  await put('plugins/keep.js', '// original plugin');
  await put('data/default-user/settings.json', '{"preset":"original"}');
  await put('data/default-user/secrets.json', '{"key":"synthetic"}');
});
afterEach(async () => {
  if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocal;
  if (path.dirname(root) !== path.resolve(base) || !path.basename(root).startsWith('takeover-case-')) {
    throw new Error('Unsafe cleanup path.');
  }
  await fs.rm(root, { recursive: true, force: true });
});
async function attach(options = {}) {
  return takeover.attachExistingInstance(await inspect(source, options), { sourceStopped: true, ...options });
}

test('attachment and repeated launch preparation leave every source file unchanged', async () => {
  const before = await snapshot();
  const record = await attach();
  assert.equal(record.managementMode, 'in-place');
  assert.equal(record.path, await fs.realpath(source));
  assert.equal(record.dataRoot, path.join(record.path, 'data'));
  const configPath = await takeover.prepareAttachedLaunch(record, port);
  assert.equal(path.dirname(path.dirname(configPath)), path.join(paths.tarvenHome, 'in-place'));
  const config = parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.dataRoot, record.dataRoot);
  assert.equal(config.port, port);
  assert.equal(config.listen, false);
  assert.deepEqual(config.protocol, { ipv4: true, ipv6: false });
  assert.equal(config.ssl.enabled, false);
  assert.equal(config.enableUserAccounts, true);
  assert.equal(config.enableServerPlugins, true);
  assert.equal(config.extensions.enabled, true);
  assert.equal(config.extensions.autoUpdate, false);
  assert.equal(config.browserLaunch.enabled, false);
  assert.equal(await takeover.prepareAttachedLaunch(record, port), configPath);
  assert.deepEqual(await snapshot(), before);
});

test('external data is registered only with consent and is preserved', async () => {
  const external = path.join(root, 'external');
  await fs.rename(path.join(source, 'data'), external);
  await put('config.yaml', `dataRoot: ${JSON.stringify(external)}\nport: ${port}\n`);
  await assert.rejects(attach(), { code: 'EXTERNAL_DATA_ROOT' });
  const record = await attach({ allowExternalData: true });
  assert.equal(record.dataRoot, external);
  assert.throws(() => store.assertNotAttachedPath(external));
  assert.throws(() => store.assertNotAttachedPath(path.join(external, 'default-user')));
});

test('missing dependencies fail without installing or changing files', async () => {
  await fs.rename(path.join(source, 'node_modules'), path.join(source, 'saved-deps'));
  const before = await snapshot();
  await assert.rejects(attach(), /依赖/);
  assert.deepEqual(store.listInstanceRecords(), []);
  assert.deepEqual(await snapshot(), before);
});

test('unrecognized configPath support fails without altering the original', async () => {
  await put('src/command-line.js', 'const unsupported = true;');
  const before = await snapshot();
  await assert.rejects(attach(), /独立配置/);
  assert.deepEqual(await snapshot(), before);
});

test('occupied source and requested ports fail without killing the listener', async () => {
  const record = await attach();
  const listener = await listen();
  try {
    await assert.rejects(takeover.prepareAttachedLaunch(record, listener.address().port), /端口/);
    await put('config.yaml', `dataRoot: ./data\nport: ${listener.address().port}\n`);
    await assert.rejects(attach(), /端口/);
    assert.equal(listener.listening, true);
  } finally { await new Promise(resolve => listener.close(resolve)); }
});

test('consent, cancellation and changed config are checked before registration', async () => {
  const plan = await inspect(source);
  await assert.rejects(takeover.attachExistingInstance(plan, { sourceStopped: false }), { code: 'SOURCE_NOT_STOPPED' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(takeover.attachExistingInstance(plan, { sourceStopped: true, signal: controller.signal }), { code: 'CANCELLED' });
  await fs.appendFile(path.join(source, 'config.yaml'), 'autorun: false\n');
  await assert.rejects(takeover.attachExistingInstance(plan, { sourceStopped: true }), { code: 'SOURCE_CHANGED' });
  assert.deepEqual(store.listInstanceRecords(), []);
});

test('unsupported authentication is never silently disabled', async () => {
  await fs.appendFile(path.join(source, 'config.yaml'), 'basicAuthMode: true\n');
  const before = await snapshot();
  await assert.rejects(attach(), /HTTP Basic Auth/);
  assert.deepEqual(await snapshot(), before);
});

test('duplicate, overlapping and alias registrations are rejected', async () => {
  const record = await attach();
  await assert.rejects(attach(), /已经属于/);
  assert.throws(() => store.registerAttachedInstance('parent', root, path.join(root, 'data')), /已经属于/);
  assert.throws(() => store.registerInstance('alias-id', source), /禁止/);
  assert.throws(() => store.assertNotAttachedPath(path.dirname(source)), /禁止/);
  const alias = path.join(root, 'alias');
  await fs.symlink(source, alias, 'junction');
  assert.throws(() => store.assertNotAttachedPath(path.join(alias, 'data/new')), /禁止/);
  assert.throws(() => store.registerAttachedInstance('alias', alias, path.join(alias, 'data')), /已经属于/);
  assert.equal(store.getInstanceRecord(record.instanceId).managementMode, 'in-place');
});

test('previous managed aliases also prevent duplicate attachment', async () => {
  const alias = path.join(root, 'managed-alias');
  await fs.symlink(source, alias, 'junction');
  store.registerInstance('existing', alias);
  await assert.rejects(attach(), /已经属于/);
});

test('scanning-style registration and usage updates retain attachment metadata', async () => {
  const record = await attach();
  store.registerInstance(record.instanceId, record.path);
  store.beginInstanceUsage(record.instanceId, record.path);
  store.checkpointInstanceUsage(record.instanceId);
  store.finishInstanceUsage(record.instanceId);
  store.beginInstanceUsage(record.instanceId, record.path);
  store.finishStaleUsageSessions();
  assert.equal(store.getInstanceRecord(record.instanceId).managementMode, 'in-place');
  assert.equal(store.getInstanceRecord(record.instanceId).dataRoot, record.dataRoot);
  assert.throws(() => store.registerInstance(record.instanceId, root));
  assert.throws(() => store.beginInstanceUsage(record.instanceId, root));
});

test('removing the registry entry leaves original configuration, plugins and data intact', async () => {
  const before = await snapshot();
  const record = await attach();
  store.removeInstanceRecord(record.instanceId);
  assert.deepEqual(store.listInstanceRecords(), []);
  assert.deepEqual(await snapshot(), before);
});

test('malformed registry fails closed and is never replaced', async () => {
  paths.ensureDirs();
  for (const text of ['{', '{"version":1,"instances":{"bad":{"path":"relative"}}}',
    JSON.stringify({ version: 1, instances: { bad: { path: source, managementMode: 'unknown' } } }),
    JSON.stringify({ version: 1, instances: { bad: { path: source, managementMode: 'in-place' } } })]) {
    await fs.writeFile(paths.instanceRegistryPath, text);
    assert.throws(() => store.assertNotAttachedPath(source));
    await assert.rejects(attach());
    assert.equal(await fs.readFile(paths.instanceRegistryPath, 'utf8'), text);
  }
});

test('application-owned and linked directories cannot be attached', async () => {
  paths.ensureDirs();
  const old = source;
  source = path.join(paths.bootstrapDir, 'servers/old');
  await fs.rename(old, source);
  await assert.rejects(attach(), /软件自己的数据目录/);
  await fs.symlink(source, path.join(root, 'alias'), 'junction');
  await assert.rejects(inspect(path.join(root, 'alias')), { code: 'LINK_NOT_SUPPORTED' });
});
