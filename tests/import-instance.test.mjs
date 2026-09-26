import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = process.env.SILLYCLIENT_TEST_HOST_DIST;
const base = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
if (!compiled || !base) throw new Error('Set the host build and migration test directories.');
const { importManagedInstance, prepareImportedPluginDependencies, IMPORT_INCOMPLETE, IMPORT_SETTINGS } = require(path.join(compiled, 'runtime/import-instance.js'));
const { parse } = require('yaml');
const { localImportConfiguration } = require(path.join(compiled, 'runtime/import-config.js'));
const { inspectMigrationSource } = require(path.join(compiled, 'runtime/data-migration.js'));
const { inspectImportSelection } = require(path.join(compiled, 'runtime/import-source.js'));
let root, source, context, registered;
async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'import-instance-case-'));
  source = path.join(root, 'old-tavern');
  registered = [];
  await put(path.join(source, 'package.json'), '{"name":"sillytavern","version":"1.13.4"}');
  await put(path.join(source, 'server.js'), 'throw new Error("Do not execute the source");');
  await put(path.join(source, 'plugins.js'), '// original runtime entry');
  await put(path.join(source, 'src/app.js'), '// original runtime');
  await put(path.join(source, 'public/index.html'), '<html>Original runtime</html>');
  await put(path.join(source, 'default/config.yaml'), 'listen: false\n');
  await put(path.join(source, 'config.yaml'), 'dataRoot: ./data\nlisten: true\n');
  await put(path.join(source, 'data/default-user/settings.json'), '{"theme":"test"}');
  await put(path.join(source, 'data/default-user/chats/chat.jsonl'), '{"mes":"test"}\n');
  await put(path.join(source, 'data/default-user/secrets.json'), '{"key":"secret"}');
  await put(path.join(source, 'node_modules/do-not-copy.txt'), 'old deps');
  await put(path.join(source, 'public/scripts/extensions/third-party/untrusted/index.js'), 'old extension');
  context = {
    managedRoot: path.join(root, 'managed'),
    register: (id, directory) => {
      assert.ok(existsSync(path.join(directory, 'server.js')));
      assert.ok(existsSync(path.join(directory, IMPORT_INCOMPLETE)));
      registered.push({ id, directory });
    },
  };
  await fs.mkdir(context.managedRoot);
});
afterEach(async () => {
  if (path.dirname(root) !== path.resolve(base) || !path.basename(root).startsWith('import-instance-case-')) {
    throw new Error('Unsafe cleanup directory.');
  }
  await fs.rm(root, { recursive: true, force: true });
});
async function run(options = {}) {
  return importManagedInstance(await inspectMigrationSource(source), { sourceStopped: true, ...options }, context);
}
async function assertNoStaging() {
  assert.deepEqual((await fs.readdir(context.managedRoot)).filter(name => name.startsWith('instance-import-')), []);
}

test('GUI workflow copies runtime and data, registers only at the end, and preserves the source', async () => {
  const result = await run();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].directory, result.directory);
  assert.equal(await fs.readFile(path.join(result.directory, 'plugins.js'), 'utf8'), '// original runtime entry');
  assert.equal(await fs.readFile(path.join(result.directory, 'data/default-user/chats/chat.jsonl'), 'utf8'), '{"mes":"test"}\n');
  assert.equal(await fs.readFile(path.join(source, 'config.yaml'), 'utf8'), 'dataRoot: ./data\nlisten: true\n');
  assert.equal(await fs.readFile(path.join(result.directory, 'public/scripts/extensions/third-party/untrusted/index.js'), 'utf8'), 'old extension');
  for (const missing of ['node_modules', 'data/default-user/secrets.json', IMPORT_INCOMPLETE]) {
    assert.equal(existsSync(path.join(result.directory, missing)), false);
  }
  assert.match(await fs.readFile(path.join(result.directory, 'config.yaml'), 'utf8'), /listen: false/);
  await assertNoStaging();
});

test('explicit secret opt-in and named user accounts survive import', async () => {
  await put(path.join(source, 'data/alice/settings.json'), '{}');
  const result = await run({ includeSecrets: true });
  assert.equal(await fs.readFile(path.join(result.directory, 'data/default-user/secrets.json'), 'utf8'), '{"key":"secret"}');
  const settings = JSON.parse(await fs.readFile(path.join(result.directory, IMPORT_SETTINGS), 'utf8'));
  assert.equal(settings.enableUserAccounts, true);
});

test('repeated imports use distinct destinations and never overwrite an existing instance', async () => {
  const first = await run();
  const original = await fs.readFile(path.join(first.directory, 'server.js'));
  const second = await run();
  assert.notEqual(first.directory, second.directory);
  assert.deepEqual(await fs.readFile(path.join(first.directory, 'server.js')), original);
});

test('cancelling during runtime copy removes staging and creates no registered instance', async () => {
  const abort = new AbortController();
  await assert.rejects(run({
    signal: abort.signal,
    onStage(percent, stage) { if (stage === 'runtime' && percent > 55) abort.abort(); },
  }), { code: 'CANCELLED' });
  assert.equal(registered.length, 0);
  assert.deepEqual(await fs.readdir(context.managedRoot), []);
  await assertNoStaging();
});

test('incomplete source runtime fails without leaving a visible instance', async () => {
  await fs.rm(path.join(source, 'default'), { recursive: true });
  await assert.rejects(run(), { code: 'INVALID_RUNTIME' });
  assert.equal(registered.length, 0);
  await assertNoStaging();
});

test('runtime junctions are rejected and unrelated files remain untouched', async () => {
  await put(path.join(root, 'outside/keep.txt'), 'keep');
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'src/linked'), 'junction');
  await assert.rejects(run(), { code: 'LINK_NOT_SUPPORTED' });
  assert.equal(await fs.readFile(path.join(root, 'outside/keep.txt'), 'utf8'), 'keep');
  assert.equal(registered.length, 0);
});

test('changed configuration invalidates the prior user confirmation', async () => {
  const plan = await inspectMigrationSource(source);
  await fs.appendFile(path.join(source, 'config.yaml'), 'port: 9999\n');
  await assert.rejects(importManagedInstance(plan, { sourceStopped: true }, context), { code: 'SOURCE_CHANGED' });
  assert.equal(registered.length, 0);
});

test('registration failure preserves a marked, non-runnable copy', async () => {
  context.register = () => { throw new Error('Simulated registry write failure'); };
  await assert.rejects(run(), { code: 'REGISTRATION_FAILED' });
  const entries = await fs.readdir(context.managedRoot);
  assert.equal(entries.length, 1);
  assert.ok(existsSync(path.join(context.managedRoot, entries[0], IMPORT_INCOMPLETE)));
  await assertNoStaging();
});

test('managed root inside the source is rejected before creating output', async () => {
  context.managedRoot = path.join(source, 'managed');
  await fs.mkdir(context.managedRoot);
  await assert.rejects(run(), { code: 'OVERLAPPING_PATHS' });
  assert.deepEqual(await fs.readdir(context.managedRoot), []);
});

test('source stop confirmation is required by the integrated workflow', async () => {
  await assert.rejects(run({ sourceStopped: false }), { code: 'SOURCE_NOT_STOPPED' });
  assert.equal(registered.length, 0);
});

test('installation and its data directory resolve to the same import plan', async () => {
  const installation = await inspectImportSelection(source);
  const data = await inspectImportSelection(path.join(source, 'data'));
  assert.equal(data.sourceRoot, installation.sourceRoot);
  assert.equal(data.dataRoot, installation.dataRoot);
  assert.deepEqual(data.files, installation.files);
});

test('detached data requires an explicit runtime and external-data consent', async () => {
  const detached = path.join(root, 'saved-data');
  await fs.cp(path.join(source, 'data'), detached, { recursive: true });
  await assert.rejects(inspectImportSelection(detached), { code: 'RUNTIME_REQUIRED' });
  await assert.rejects(inspectImportSelection(detached, { runtimeRoot: source }), { code: 'EXTERNAL_DATA_ROOT' });
  await put(path.join(detached, 'default-user/settings.json'), '{"detached":true}');
  const plan = await inspectImportSelection(detached, { runtimeRoot: source, allowExternalData: true });
  const result = await importManagedInstance(plan, {
    sourceStopped: true, allowExternalData: true,
  }, context);
  assert.equal(await fs.readFile(path.join(result.directory, 'data/default-user/settings.json'), 'utf8'), '{"detached":true}');
  assert.equal(await fs.readFile(path.join(source, 'data/default-user/settings.json'), 'utf8'), '{"theme":"test"}');
});

test('data folder selection overrides a different configured dataRoot', async () => {
  const selected = path.join(source, 'backup-data');
  await fs.cp(path.join(source, 'data'), selected, { recursive: true });
  await put(path.join(selected, 'default-user/settings.json'), '{"chosen":true}');
  const plan = await inspectImportSelection(selected);
  const result = await importManagedInstance(plan, { sourceStopped: true }, context);
  assert.equal(await fs.readFile(path.join(result.directory, 'data/default-user/settings.json'), 'utf8'), '{"chosen":true}');
});

test('staging and final rename stay on the selected target volume', async t => {
  const rename = fs.rename.bind(fs);
  let checked = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    assert.equal(path.dirname(path.dirname(from)), context.managedRoot);
    assert.equal(path.dirname(to), context.managedRoot);
    checked = true;
    return rename(from, to);
  });
  const result = await run();
  assert.equal(path.dirname(result.directory), context.managedRoot);
  assert.equal(checked, true);
  await assertNoStaging();
});

test('punctuation-prefixed installation names generate stable registry IDs', async () => {
  const moved = path.join(root, '.old-tavern');
  await fs.rename(source, moved);
  source = moved;
  const result = await run();
  assert.match(result.instanceId, /^old-tavern-import-/);
});

test('data directory junction and unsupported runtime are rejected', async () => {
  const alias = path.join(root, 'data-alias');
  await fs.symlink(path.join(source, 'data'), alias, 'junction');
  await assert.rejects(inspectImportSelection(alias, { runtimeRoot: source, allowExternalData: true }),
    { code: 'LINK_NOT_SUPPORTED' });
  await put(path.join(source, 'package.json'), '{"name":"sillytavern","version":"2.0.0"}');
  await assert.rejects(inspectImportSelection(path.join(source, 'data')), { code: 'UNSUPPORTED_VERSION' });
});

test('profile-only and empty data directories cannot be imported as an instance', async () => {
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  await assert.rejects(inspectImportSelection(empty, { runtimeRoot: source, allowExternalData: true }), { code: 'NO_USER_DATA' });
  await assert.rejects(inspectImportSelection(path.join(source, 'data/default-user'), { runtimeRoot: source }), { code: 'NO_USER_DATA' });
});

test('copy retains per-user/global extensions, server plugins, presets and their configuration', async () => {
  const files = {
    'data/default-user/extensions/local/index.js': 'throw new Error("Do not run while importing");',
    'data/default-user/extensions/local/config.json': '{"custom":true}',
    'data/default-user/OpenAI Settings/custom.json': '{"preset":"keep"}',
    'data/alice/settings.json': '{"extension_settings":{"local":{"value":42}}}',
    'data/alice/extensions/local/index.js': '// alice extension',
    'public/scripts/extensions/third-party/global/manifest.json': '{"display_name":"global"}',
    'plugins/server/index.js': 'throw new Error("Do not run while importing");',
    'plugins/server/package.json': '{"name":"server","dependencies":{"example":"1.0.0"}}',
    'plugins/server/config.json': '{"custom":"preserved"}',
  };
  for (const [file, text] of Object.entries(files)) await put(path.join(source, file), text);
  const originalConfig = 'dataRoot: ./data\nlisten: true\nenableServerPlugins: true\nextensions:\n  enabled: true\n  customSetting: 7\ncustomPlugin:\n  value: retained\n';
  await put(path.join(source, 'config.yaml'), originalConfig);
  const excluded = [
    'plugins/server/node_modules/example/index.js',
    'plugins/server/.git/config',
    'public/scripts/extensions/third-party/global/node_modules/example/index.js',
    'data/default-user/extensions/local/.git',
    'data/alice/extensions/local/node_modules/example/index.js',
  ];
  for (const file of excluded) await put(path.join(source, file), 'must stay only in source');
  const result = await run();
  for (const [file, text] of Object.entries(files)) {
    assert.equal(await fs.readFile(path.join(result.directory, file), 'utf8'), text);
    assert.equal(await fs.readFile(path.join(source, file), 'utf8'), text);
  }
  for (const file of excluded) assert.equal(existsSync(path.join(result.directory, file)), false);
  assert.equal(await fs.readFile(path.join(source, 'config.yaml'), 'utf8'), originalConfig);
  const config = parse(await fs.readFile(path.join(result.directory, 'config.yaml'), 'utf8'));
  assert.equal(config.enableServerPlugins, true);
  assert.equal(config.enableServerPluginsAutoUpdate, false);
  assert.equal(config.extensions.autoUpdate, false);
  assert.equal(config.extensions.customSetting, 7);
  assert.equal(config.customPlugin.value, 'retained');
  assert.equal(config.listen, false);
  assert.equal(config.enableUserAccounts, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, IMPORT_SETTINGS), 'utf8')).pluginsCopied, true);
});

test('known plugin secrets remain opt-in across runtime and user extensions', async () => {
  const files = [
    'plugins/server/secrets.json',
    'public/scripts/extensions/third-party/global/secrets.json',
    'data/default-user/extensions/local/secrets.json',
  ];
  for (const file of files) await put(path.join(source, file), '{"token":"synthetic"}');
  const without = await run();
  const withSecrets = await run({ includeSecrets: true });
  for (const file of files) {
    assert.equal(existsSync(path.join(without.directory, file)), false);
    assert.equal(await fs.readFile(path.join(withSecrets.directory, file), 'utf8'), '{"token":"synthetic"}');
  }
});

test('plugin directory links fail without registration or modifying the linked directory', async () => {
  await put(path.join(root, 'outside/keep'), 'keep');
  await fs.mkdir(path.join(source, 'plugins'));
  await fs.symlink(path.join(root, 'outside'), path.join(source, 'plugins/linked'), 'junction');
  await assert.rejects(run(), { code: 'LINK_NOT_SUPPORTED' });
  assert.equal(registered.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'outside/keep'), 'utf8'), 'keep');
  await assertNoStaging();
});

test('startup configuration retains plugin settings and the original server-plugin toggle', () => {
  const original = {
    dataRoot: 'D:/old-data', port: 1234, listen: true, ssl: { enabled: true },
    enableServerPlugins: false, customPlugin: { nested: { value: 9 } },
    extensions: { enabled: true, allowedTypes: ['example'] },
    basicAuthMode: true, basicAuthUser: { password: 'synthetic' }, sso: { autheliaAuth: true },
  };
  const config = localImportConfiguration(original, 9001, true);
  assert.equal(config.port, 9001);
  assert.equal(config.dataRoot, './data');
  assert.equal(config.enableServerPlugins, false);
  assert.deepEqual(config.customPlugin, original.customPlugin);
  assert.deepEqual(config.extensions.allowedTypes, ['example']);
  assert.equal(config.basicAuthMode, false);
  assert.equal(config.basicAuthUser, undefined);
  assert.equal(config.sso, undefined);
  assert.equal(config.enableUserAccounts, true);
  assert.equal(original.dataRoot, 'D:/old-data');
  assert.equal(original.basicAuthMode, true);
});

test('plugin dependencies install only on explicit startup and only once after success', async () => {
  await put(path.join(source, 'config.yaml'), 'dataRoot: ./data\nenableServerPlugins: true\n');
  await put(path.join(source, 'plugins/extra/package.json'), '{"name":"synthetic-extra"}');
  const result = await run();
  const calls = [];
  const before = await fs.readFile(path.join(source, 'plugins/extra/package.json'), 'utf8');
  const install = async directory => { calls.push(directory); };
  await prepareImportedPluginDependencies(result.directory, install);
  await prepareImportedPluginDependencies(result.directory, install);
  assert.deepEqual(calls, [path.join(result.directory, 'plugins/extra')]);
  assert.equal(await fs.readFile(path.join(source, 'plugins/extra/package.json'), 'utf8'), before);
  const settings = JSON.parse(await fs.readFile(path.join(result.directory, IMPORT_SETTINGS), 'utf8'));
  assert.equal(settings.pluginDependenciesReady, true);
});

test('failed dependency preparation is retryable and disabled server plugins are not installed', async () => {
  await put(path.join(source, 'plugins/extra/package.json'), '{"name":"synthetic-extra"}');
  const result = await run();
  await prepareImportedPluginDependencies(result.directory, async () => { assert.fail('Disabled plugin installation'); });
  await put(path.join(result.directory, 'config.yaml'), 'enableServerPlugins: true\n');
  await assert.rejects(prepareImportedPluginDependencies(result.directory, async () => {
    throw new Error('synthetic install failure');
  }), /synthetic install failure/);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, IMPORT_SETTINGS), 'utf8')).pluginDependenciesReady, false);
  await prepareImportedPluginDependencies(result.directory, async () => {});
  assert.equal(JSON.parse(await fs.readFile(path.join(result.directory, IMPORT_SETTINGS), 'utf8')).pluginDependenciesReady, true);
});
