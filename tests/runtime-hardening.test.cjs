const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createHash } = require('node:crypto');
const vm = require('node:vm');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(project, '..', '..', 'Local', '\u4e34\u65f6');
const originalPaths = fs;

function fixture(t) {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'windows-hardening-'));
  t.after(() => {
    assert.ok(root.startsWith(`${temporaryRoot}${path.sep}windows-hardening-`));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function pathsFor(root) {
  const realPaths = loader()('src/runtime/paths.ts');
  const paths = {
    tarvenHome: root,
    bootstrapDir: path.join(root, 'bootstrap'),
    coversDir: path.join(root, 'covers'),
    tmpDir: path.join(root, 'tmp'),
    logsDir: path.join(root, 'logs'),
    instanceRegistryPath: path.join(root, 'instances.json'),
    legacyServersDir: path.join(root, 'bootstrap', 'servers'),
    appInstancesDir: path.join(root, 'instances'),
    getNodeExe: () => 'C:\\bundled\\node.exe',
    getNpmCli: () => 'C:\\bundled\\npm-cli.js',
    normalizeInstanceId: (id) => String(id).trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'default',
  };
  paths.ensureDirs = () => {
    for (const directory of [paths.bootstrapDir, paths.coversDir, paths.tmpDir, paths.logsDir, paths.legacyServersDir, paths.appInstancesDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  };
  paths.serverDirFor = (id, supplied, mode) => {
    const resolved = realPaths.serverDirFor(id, supplied, mode);
    return supplied ? resolved : path.join(paths.bootstrapDir, 'servers', paths.normalizeInstanceId(id));
  };
  paths.ensureDirs();
  return paths;
}

// Contract tests use production Vite flags without loading the browser-only preview shim.
function productionFrontendFlags(context) {
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'DEV'
      && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'env'
      && ts.isMetaProperty(node.expression.expression)
      && node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
      return ts.factory.createFalse();
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (sourceFile) => ts.visitNode(sourceFile, visit);
}

function loader(overrides = {}) {
  const cache = new Map();
  const load = (file) => {
    const filename = path.resolve(project, file);
    if (cache.has(filename)) return cache.get(filename).exports;
    const loaded = new Module(filename, module);
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    cache.set(filename, loaded);
    loaded.require = (name) => {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
      if (name.startsWith('.')) {
        const candidate = path.resolve(path.dirname(filename), `${name}.ts`);
        if (fs.existsSync(candidate)) return load(candidate);
      }
      return Module.createRequire(filename)(name);
    };
    const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: filename,
      transformers: { before: [productionFrontendFlags] },
    });
    loaded._compile(result.outputText, filename);
    return loaded.exports;
  };
  return load;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function serverFiles(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'server.js'), '// synthetic server\n');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '1.19.0' }));
}

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.killed = true;
    setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
    return true;
  };
  return child;
}

function fakeSpawns() {
  const records = [];
  const children = new Map();
  let pid = 1000;
  const spawn = (command, args, options) => {
    const child = fakeChild(pid++);
    records.push({ command, args, options, child });
    children.set(child.pid, child);
    if (/taskkill\.exe$/i.test(command)) {
      setImmediate(() => {
        const target = children.get(Number(args[1]));
        if (target) { target.exitCode = 0; target.emit('close', 0); }
        child.emit('close', 0);
      });
    }
    return child;
  };
  return { spawn, records };
}

function pluginHarness(t, callbacks = {}) {
  const root = callbacks.root || fixture(t);
  const paths = pathsFor(root);
  const events = [];
  let running = false;
  let exit;
  let starts = 0;
  const fakeProcesses = {
    isServerRunning: () => running,
    activeProcessDirectories: () => [],
    stopServer: async () => {
      if (running) { running = false; exit?.(0); }
    },
    stopServerForDirectory: async () => undefined,
    stopAllProcesses: async () => undefined,
    runNpmInstall: callbacks.runNpmInstall || (async (cwd) => fs.mkdirSync(path.join(cwd, 'node_modules'))),
    startServer: (cwd, id, port, log, onExit, options) => {
      running = true;
      starts++;
      exit = onExit;
      callbacks.onStart?.({ cwd, id, port, options });
      return fakeChild(5000 + starts);
    },
    sendCommand: callbacks.sendCommand || (async () => undefined),
    runProcess: callbacks.runProcess,
  };
  const utils = {
    unzipToDir: callbacks.unzipToDir || (async (_zip, target) => serverFiles(target)),
    downloadFile: callbacks.downloadFile || (async (_url, destination) => fs.writeFileSync(destination, 'synthetic archive')),
    removeDirWithRetries: async (directory) => fs.promises.rm(directory, { recursive: true, force: true }),
    writeText: (file, text) => fs.writeFileSync(file, text),
  };
  const http = {
    get: (_url, _options, onResponse) => {
      const request = new EventEmitter();
      request.destroy = () => undefined;
      request.setTimeout = () => undefined;
      setImmediate(() => onResponse({ statusCode: 200, destroy: () => undefined }));
      return request;
    },
  };
  const network = {
    createServer: () => {
      const server = new EventEmitter();
      server.close = (callback) => callback();
      server.listen = () => setImmediate(() => server.emit('listening'));
      return server;
    },
  };
  const load = loader({
    './runtime/paths': paths, './paths': paths,
    './runtime/process': fakeProcesses, './process': fakeProcesses,
    './runtime/utils': utils,
    './runtime/companion-presets': { installCompanionPreset: () => ({ commit() {}, rollback() {}, applied: false }) },
    './remote-auth': {},
    electron: callbacks.electron || {},
    'node:http': http,
    'node:net': network,
    ...(callbacks.installPreselectedExtensions ? {
      './runtime/preinstalled-extensions': {
        validatePreinstallSelection: (value) => value,
        installPreselectedExtensions: callbacks.installPreselectedExtensions,
      },
    } : {}),
    ...(callbacks.directoryContentIdentity ? {
      './runtime/migration': {
        ...loader({ electron: {} })('src/runtime/migration.ts'),
        directoryContentIdentity: callbacks.directoryContentIdentity,
      },
    } : {}),
  });
  const plugin = load('src/plugin.ts');
  plugin.setMainWindow({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (name, data) => events.push({ name, data }) },
  });
  t.after(async () => plugin.cleanup());
  return { root, paths, events, plugin, load, starts: () => starts, running: () => running };
}

const defaultRuntimeConfig = loader({
  '@capacitor/core': { registerPlugin: () => ({}) },
})('web/capacitor-ui/src/capacitor-plugin.ts').DEFAULT_CONFIG;

test('explicit install path modes are stable for existing and nonexistent selected directories', (t) => {
  const root = fixture(t);
  const paths = loader()('src/runtime/paths.ts');
  const existing = path.join(root, 'existing-root');
  const missing = path.join(root, 'missing-root');
  fs.mkdirSync(existing);
  for (const selected of [existing, missing]) {
    assert.equal(paths.serverDirFor('chosen', `"${selected}"`, 'root'), path.join(selected, 'chosen'));
    assert.equal(paths.serverDirFor('chosen', `"${selected}"`, 'exact'), selected);
  }
  assert.equal(paths.serverDirFor('legacy', existing), path.join(existing, 'legacy'));
  assert.equal(paths.serverDirFor('legacy', missing), missing);
  serverFiles(existing);
  assert.equal(paths.serverDirFor('chosen', existing, 'root'), path.join(existing, 'chosen'));
  assert.equal(paths.serverDirFor('chosen', existing, 'exact'), existing);
});

test('install paths reject malformed values and modes instead of selecting a default directory', (t) => {
  const root = fixture(t);
  const paths = loader()('src/runtime/paths.ts');
  for (const supplied of ['relative-folder', '""', 123, false, {}, null]) {
    assert.throws(() => paths.serverDirFor('chosen', supplied, 'exact'), /path|directory|路径|目录/i);
  }
  assert.throws(() => paths.serverDirFor('chosen', root, 'guess'), /mode/i);
  assert.throws(() => paths.serverDirFor('chosen', undefined, 'root'), /path|directory/i);
  assert.throws(() => paths.serverDirFor('chosen', path.parse(root).root, 'exact'), /root|根目录/i);
});

test('directory picking distinguishes installation roots and preserves legacy source selection and cancellation', async (t) => {
  const dialogs = [];
  let response;
  const harness = pluginHarness(t, {
    electron: {
      dialog: {
        showOpenDialog: async (_window, options) => {
          dialogs.push(options);
          return response;
        },
      },
    },
  });
  const selected = path.join(harness.root, 'selected-root');
  fs.mkdirSync(selected);
  response = { canceled: false, filePaths: [selected] };
  const expected = { name: 'selected-root', path: selected };
  assert.deepEqual(await harness.plugin.handle('pickDirectory'), expected);
  assert.deepEqual(dialogs.at(-1), { properties: ['openDirectory'] });
  assert.deepEqual(await harness.plugin.handle('pickDirectory', { purpose: 'source' }), expected);
  assert.deepEqual(dialogs.at(-1), { properties: ['openDirectory'] });
  assert.deepEqual(await harness.plugin.handle('pickDirectory', { purpose: 'installation' }), {
    ...expected, installPathMode: 'root',
  });
  assert.deepEqual(dialogs.at(-1), {
    title: '选择实例安装根目录',
    properties: ['openDirectory'],
  });
  response = { canceled: true, filePaths: [] };
  assert.deepEqual(await harness.plugin.handle('pickDirectory', { purpose: 'installation' }), { name: '', path: '' });
  const callCount = dialogs.length;
  await assert.rejects(harness.plugin.handle('pickDirectory', { purpose: 'unexpected' }), /purpose/i);
  assert.equal(dialogs.length, callCount);
});

test('invalid custom path selection preserves an already running instance and its registration', async (t) => {
  const harness = pluginHarness(t);
  const runningDirectory = harness.paths.serverDirFor('running');
  serverFiles(runningDirectory);
  fs.mkdirSync(path.join(runningDirectory, 'node_modules'));
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'running', operationId: 'running-op', port: 8000,
  }), { ready: true });
  const before = fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8');
  const file = path.join(harness.root, 'not-a-directory');
  fs.writeFileSync(file, 'preserve this file');
  const incomplete = path.join(harness.root, 'incomplete');
  fs.mkdirSync(incomplete);
  fs.writeFileSync(path.join(incomplete, 'user-note.txt'), 'preserve this note');
  const missing = path.join(harness.root, 'missing-custom');
  for (const options of [
    { installPath: 'relative-path', installPathMode: 'exact' },
    { installPath: file, installPathMode: 'exact' },
    { installPath: incomplete, installPathMode: 'exact' },
    { instanceId: 'running', installPath: missing, installPathMode: 'exact' },
    { installPath: path.parse(harness.root).root, installPathMode: 'exact' },
  ]) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid', operationId: 'invalid-op', port: 8000, ...options,
    }), { ready: false });
    assert.equal(harness.running(), true);
    assert.equal(harness.plugin.isServerReady(), true);
    assert.equal(harness.plugin.getCurrentInstanceId(), 'running');
    assert.equal(harness.plugin.getCurrentOperationId(), 'running-op');
    assert.equal(harness.starts(), 1);
    assert.equal(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'), before);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve this file');
  assert.equal(fs.existsSync(missing), false);
});

test('custom install roots and exact directories drive registration, preinstall and configured data roots', async (t) => {
  const starts = [];
  const queried = [];
  const installed = [];
  let harness;
  harness = pluginHarness(t, {
    onStart: (start) => starts.push(start),
    runProcess: async (_node, args, options) => {
      queried.push({ directory: args[2], cwd: options.cwd });
      return { code: 0, stdout: JSON.stringify({ dataRoot: './custom-data' }) };
    },
    installPreselectedExtensions: async (directory) => {
      installed.push({ directory, dataRoot: await harness.load('src/runtime/instance-config.ts').resolveInstanceDataRoot(directory) });
      return { commit() {}, async rollback() {} };
    },
  });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic archive');
  for (const mode of ['root', 'exact']) {
    for (const exists of [false, true]) {
      const instanceId = `${mode}-${exists}`;
      const selected = path.join(harness.root, `selected-${instanceId}`);
      if (exists) fs.mkdirSync(selected);
      const expected = mode === 'root' ? path.join(selected, instanceId) : selected;
      assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
        instanceId, port: 8000, localZipPath: archive, installPath: `"${selected}"`, installPathMode: mode,
        preinstall: { revision: 1, extensionIds: ['dice'] },
      }), { ready: true });
      assert.equal(starts.at(-1).cwd, expected);
      assert.equal(installed.at(-1).directory, expected);
      assert.equal(installed.at(-1).dataRoot, path.join(expected, 'custom-data'));
      assert.deepEqual(queried.at(-1), { directory: expected, cwd: expected });
      assert.equal(harness.load('src/runtime/instances.ts').getInstanceRecord(instanceId).path, expected);
      assert.equal(fs.existsSync(harness.paths.serverDirFor(instanceId)), false);
    }
  }
});

test('a custom registered path survives restart and owns info, commands and uninstall without its parent', async (t) => {
  const first = pluginHarness(t);
  const archive = path.join(first.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic archive');
  const selected = path.join(first.root, 'selected-root');
  fs.mkdirSync(selected);
  const sibling = path.join(selected, 'keep.txt');
  fs.writeFileSync(sibling, 'not part of this instance');
  const expected = path.join(selected, 'custom');
  assert.deepEqual(await first.plugin.handle('provisionAndStart', {
    instanceId: 'custom', port: 8000, localZipPath: archive, installPath: selected, installPathMode: 'root',
  }), { ready: true });
  await first.plugin.cleanup();
  const commands = [];
  const resumed = pluginHarness(t, {
    root: first.root, sendCommand: async (_text, cwd) => commands.push(cwd),
  });
  assert.equal((await resumed.plugin.handle('scanInstances')).instances.find((item) => item.instanceId === 'custom').path, expected);
  assert.equal((await resumed.plugin.handle('getInstanceInfo', { instanceId: 'custom' })).path, expected);
  assert.equal((await resumed.plugin.handle('getInstanceInfo', {
    instanceId: 'custom', installPath: selected, installPathMode: 'root',
  })).path, expected);
  await resumed.plugin.handle('sendCommand', { instanceId: 'custom', text: 'synthetic' });
  assert.deepEqual(commands, [expected]);
  assert.equal((await resumed.plugin.handle('uninstallInstance', { instanceId: 'custom' })).success, true);
  assert.equal(fs.existsSync(expected), false);
  assert.equal(fs.readFileSync(sibling, 'utf8'), 'not part of this instance');
});

test('a missing registered custom path never adopts a same-ID managed directory during scan or launch', async (t) => {
  const commands = [];
  const harness = pluginHarness(t, { sendCommand: async (_text, cwd) => commands.push(cwd) });
  const missing = path.join(harness.root, 'removed-custom');
  harness.load('src/runtime/instances.ts').registerInstance('custom', missing);
  const impostor = harness.paths.serverDirFor('custom');
  serverFiles(impostor);
  const before = fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8');
  assert.deepEqual((await harness.plugin.handle('scanInstances')).instances, []);
  assert.equal(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'), before);
  const info = await harness.plugin.handle('getInstanceInfo', { instanceId: 'custom' });
  assert.equal(info.path, missing);
  assert.equal(info.status, 'not_found');
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', { instanceId: 'custom', port: 8000 }), { ready: false });
  assert.equal(harness.starts(), 0);
  await harness.plugin.handle('sendCommand', { instanceId: 'custom', text: 'synthetic' });
  assert.deepEqual(commands, []);
  await harness.plugin.handle('uninstallInstance', { instanceId: 'custom' });
  assert.equal(harness.load('src/runtime/instances.ts').getInstanceRecord('custom'), null);
  assert.equal(fs.existsSync(path.join(impostor, 'server.js')), true);
});

test('registered instances reject conflicting explicit paths without replacing registration or deleting another directory', async (t) => {
  const harness = pluginHarness(t);
  const registered = path.join(harness.root, 'registered');
  const other = path.join(harness.root, 'other');
  serverFiles(registered);
  serverFiles(other);
  harness.load('src/runtime/instances.ts').registerInstance('custom', registered);
  const before = fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8');
  const options = { instanceId: 'custom', installPath: other, installPathMode: 'exact', port: 8000 };
  await assert.rejects(harness.plugin.handle('getInstanceInfo', options), /registered|registration/i);
  await assert.rejects(harness.plugin.handle('uninstallInstance', options), /registered|registration/i);
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', options), { ready: false });
  assert.equal(harness.starts(), 0);
  assert.equal(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(registered, 'server.js')), true);
  assert.equal(fs.existsSync(path.join(other, 'server.js')), true);
});

test('copy migration targets remain exact and malformed target paths cannot be swallowed into defaults', async (t) => {
  const harness = pluginHarness(t);
  const source = path.join(harness.root, 'source');
  serverFiles(source);
  const relativeTarget = path.relative(project, path.join(harness.root, 'relative-target'));
  for (const targetPath of [relativeTarget, '""', 123, false, {}, null]) {
    await assert.rejects(harness.plugin.handle('migrateInstance', {
      instanceId: 'bad-target', sourcePath: source, targetPath, mode: 'copy',
    }), /path|directory|路径|目录/i);
  }
  assert.equal(fs.existsSync(harness.paths.instanceRegistryPath), false);
  const target = path.join(harness.root, 'exact-copy');
  const result = await harness.plugin.handle('migrateInstance', {
    instanceId: 'copied', sourcePath: source, targetPath: `"${target}"`, mode: 'copy',
  });
  assert.equal(result.targetPath, target);
  assert.equal(harness.load('src/runtime/instances.ts').getInstanceRecord('copied').path, target);
  assert.equal(fs.existsSync(path.join(source, 'server.js')), true);
});

test('invalid registered paths fail closed instead of disappearing from a registry snapshot', (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const store = loader({ './paths': paths })('src/runtime/instances.ts');
  const bytes = JSON.stringify({ version: 1, instances: { custom: { instanceId: 'custom', path: 'relative-folder' } } });
  fs.writeFileSync(paths.instanceRegistryPath, bytes);
  assert.throws(() => store.getInstanceRecord('custom'), /registered|registry/i);
  assert.throws(() => store.registerInstance('other', path.join(root, 'other')), /registered|registry/i);
  assert.equal(fs.readFileSync(paths.instanceRegistryPath, 'utf8'), bytes);
});

test('provision accepts the real numeric heartbeat defaults and preserves requested intervals in CLI and new YAML', async (t) => {
  const starts = [];
  const harness = pluginHarness(t, { onStart: (start) => starts.push(start) });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic source archive');
  assert.equal(defaultRuntimeConfig.heartbeat, 0);
  for (const heartbeat of [defaultRuntimeConfig.heartbeat, 30, 45, 2147483647]) {
    const instanceId = `heartbeat-${heartbeat}`;
    const config = { ...defaultRuntimeConfig, heartbeat };
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId, operationId: `launch-${heartbeat}`, port: 8000, config, localZipPath: archive,
    }), { ready: true });
    const started = starts.at(-1);
    assert.deepEqual(started.options.args, [
      '--port', '8000', '--browserLaunchEnabled', 'false',
      '--listen', 'false', '--enableIPv4', 'true', '--enableIPv6', 'false',
      '--dnsPreferIPv6', 'false', '--enableKeepAlive', 'false',
      '--heartbeatInterval', String(heartbeat),
    ]);
    const yaml = fs.readFileSync(path.join(started.cwd, 'config.yaml'), 'utf8');
    assert.ok(yaml.split('\n').includes(`heartbeatInterval: ${heartbeat}`));
  }
  assert.equal(harness.starts(), 4);
});

test('provision rejects nonnumeric, noninteger and out-of-range heartbeat values before any installation', async (t) => {
  const harness = pluginHarness(t);
  for (const heartbeat of [true, false, null, '30', -1, 0.5, NaN, Infinity, 2147483648, {}]) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid-heartbeat', port: 8000, config: { ...defaultRuntimeConfig, heartbeat },
    }), { ready: false });
    assert.match(harness.events.filter((event) => event.name === 'tarven:error').at(-1).data.message, /heartbeat/i);
  }
  assert.equal(harness.starts(), 0);
  assert.deepEqual(fs.readdirSync(path.join(harness.paths.bootstrapDir, 'servers')), []);
  assert.ok(!fs.existsSync(harness.paths.instanceRegistryPath));
});

test('provision validates runtime flags and ports through the same launch argument contract', async (t) => {
  const harness = pluginHarness(t);
  for (const key of ['listen', 'ipv4', 'ipv6', 'dnsIpv6', 'keepAlive']) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid-flag', port: 8000, config: { ...defaultRuntimeConfig, [key]: 'false' },
    }), { ready: false });
    assert.match(harness.events.filter((event) => event.name === 'tarven:error').at(-1).data.message,
      new RegExp(`Invalid runtime flag: ${key}`));
  }
  for (const port of [0, -1, 0.5, 65536, NaN, Infinity, -Infinity, '8000', true, false, null, [], {}]) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid-port', port, config: defaultRuntimeConfig,
    }), { ready: false });
    assert.match(harness.events.filter((event) => event.name === 'tarven:error').at(-1).data.message, /Invalid server port/);
  }
  assert.equal(harness.starts(), 0);
  assert.deepEqual(fs.readdirSync(path.join(harness.paths.bootstrapDir, 'servers')), []);
});

test('runtime configuration rejects malformed shapes and unknown keys before interrupting a running instance', async (t) => {
  const harness = pluginHarness(t);
  const runningDirectory = harness.paths.serverDirFor('running-config');
  serverFiles(runningDirectory);
  fs.mkdirSync(path.join(runningDirectory, 'node_modules'));
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'running-config', operationId: 'valid-config-op', port: 8000, config: defaultRuntimeConfig,
  }), { ready: true });
  const before = fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8');
  for (const config of [
    null, 'false', true, false, 1, [], [{ listen: false }], new Date(0), new Map(),
    Object.create({ listen: false }), { keepAlvie: true }, { protocol: { ipv4: true } },
  ]) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid-config', operationId: 'invalid-config-op', port: 8000, config,
    }), { ready: false });
    assert.match(harness.events.filter(event => event.name === 'tarven:error').at(-1).data.message,
      /runtime configuration/i);
    assert.equal(harness.running(), true);
    assert.equal(harness.plugin.isServerReady(), true);
    assert.equal(harness.plugin.getCurrentInstanceId(), 'running-config');
    assert.equal(harness.plugin.getCurrentOperationId(), 'valid-config-op');
    assert.equal(harness.starts(), 1);
    assert.equal(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'), before);
  }
  assert.equal(fs.existsSync(harness.paths.serverDirFor('invalid-config')), false);
});

test('runtime flags reject wrong types and incompatible protocols without silently reverting to defaults', async (t) => {
  const harness = pluginHarness(t);
  for (const key of ['listen', 'ipv4', 'ipv6', 'dnsIpv6', 'keepAlive']) {
    for (const value of [null, 0, 1, 'true', [], {}]) {
      assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
        instanceId: 'invalid-flags', port: 8000, config: { [key]: value },
      }), { ready: false });
      assert.match(harness.events.filter(event => event.name === 'tarven:error').at(-1).data.message,
        new RegExp(`Invalid runtime flag: ${key}`));
    }
  }
  for (const config of [{ ipv4: false, ipv6: false }, { ipv4: false }]) {
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: 'invalid-protocols', port: 8000, config,
    }), { ready: false });
    assert.match(harness.events.filter(event => event.name === 'tarven:error').at(-1).data.message,
      /protocol|IPv6/i);
  }
  assert.equal(harness.starts(), 0);
  assert.equal(fs.existsSync(harness.paths.instanceRegistryPath), false);
  assert.deepEqual(fs.readdirSync(path.join(harness.paths.bootstrapDir, 'servers')), []);
});

test('all supported runtime settings reach actual server arguments and the correct new YAML keys', async (t) => {
  const starts = [];
  const harness = pluginHarness(t, { onStart: start => starts.push(start) });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic source archive');
  for (const enabled of [false, true]) {
    const config = {
      listen: enabled, ipv4: true, ipv6: enabled, dnsIpv6: enabled, keepAlive: enabled, heartbeat: enabled ? 45 : 0,
    };
    assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
      instanceId: `all-settings-${enabled}`, port: 8000, localZipPath: archive, config,
    }), { ready: true });
    const start = starts.at(-1);
    assert.deepEqual(start.options.args, [
      '--port', '8000', '--browserLaunchEnabled', 'false',
      '--listen', String(enabled), '--enableIPv4', 'true', '--enableIPv6', String(enabled),
      '--dnsPreferIPv6', String(enabled), '--enableKeepAlive', String(enabled),
      '--heartbeatInterval', enabled ? '45' : '0',
    ]);
    const yaml = fs.readFileSync(path.join(start.cwd, 'config.yaml'), 'utf8');
    for (const line of [
      `port: 8000`, `listen: ${enabled}`, `  ipv4: true`, `  ipv6: ${enabled}`,
      `dnsPreferIPv6: ${enabled}`, `heartbeatInterval: ${enabled ? 45 : 0}`, `enableKeepAlive: ${enabled}`,
    ]) {
      assert.ok(yaml.split('\n').includes(line), `Missing configuration line: ${line}`);
    }
    assert.ok(!yaml.includes('enableHttpKeepAlive'));
  }
});

test('runtime option overrides preserve existing YAML comments and security fields byte for byte', async (t) => {
  const starts = [];
  const harness = pluginHarness(t, { onStart: start => starts.push(start) });
  const directory = path.join(harness.root, 'existing-config');
  serverFiles(directory);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  const original = [
    '# Keep this comment and every original setting.',
    'dataRoot: ./custom-data',
    'basicAuthMode: true',
    'whitelistMode: true',
    'securityOverride: false',
    'enableKeepAlive: false',
    'port: 9000',
    '',
  ].join('\r\n');
  fs.writeFileSync(path.join(directory, 'config.yaml'), original);
  const config = { listen: false, ipv4: true, ipv6: false, dnsIpv6: true, keepAlive: true, heartbeat: 30 };
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'existing-config', port: 8000, installPath: directory, installPathMode: 'exact', config,
  }), { ready: true });
  assert.equal(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'), original);
  assert.deepEqual(starts[0].options.args, [
    '--port', '8000', '--browserLaunchEnabled', 'false', '--listen', 'false',
    '--enableIPv4', 'true', '--enableIPv6', 'false', '--dnsPreferIPv6', 'true',
    '--enableKeepAlive', 'true', '--heartbeatInterval', '30',
  ]);
  assert.equal(fs.existsSync(path.join(directory, 'start-server.bat')), false);
});

test('coordinator cancels old work before serially allowing the next mutation', async () => {
  const { OperationCoordinator, delay } = loader()('src/runtime/operations.ts');
  const coordinator = new OperationCoordinator();
  const entered = deferred();
  const order = [];
  const first = coordinator.runLatest('first', 'old', async (operation) => {
    order.push('first');
    entered.resolve();
    await delay(100000, operation.signal);
    operation.check();
  });
  await entered.promise;
  const next = coordinator.runLatest('second', 'new', async () => {
    order.push('second');
    return 2;
  });
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(await next, 2);
  assert.deepEqual(order, ['first', 'second']);
});

test('stop during npm prevents service resurrection and preserves existing config', async (t) => {
  const entered = deferred();
  const installation = deferred();
  const harness = pluginHarness(t, {
    runNpmInstall: async (cwd) => {
      entered.resolve();
      await installation.promise;
      fs.mkdirSync(path.join(cwd, 'node_modules'));
    },
  });
  const directory = harness.paths.serverDirFor('existing');
  serverFiles(directory);
  const config = 'dataRoot: D:/custom-data\nbasicAuthMode: true\n';
  fs.writeFileSync(path.join(directory, 'config.yaml'), config);
  const launch = harness.plugin.handle('provisionAndStart', { instanceId: 'existing', operationId: 'launch-1', port: 8000 });
  await entered.promise;
  const stopping = harness.plugin.stopCurrentServer({ instanceId: 'existing', operationId: 'launch-1' });
  installation.resolve();
  assert.deepEqual(await launch, { ready: false });
  await stopping;
  assert.equal(harness.starts(), 0);
  assert.equal(harness.plugin.isServerReady(), false);
  assert.equal(fs.readFileSync(path.join(directory, 'config.yaml'), 'utf8'), config);
  assert.ok(!harness.events.some((event) => event.name === 'tarven:ready' && event.data.ready));
});

test('a failed npm install with partial node_modules is repaired on the next launch without replacing existing data', async (t) => {
  let installs = 0;
  const harness = pluginHarness(t, {
    runNpmInstall: async (cwd) => {
      installs++;
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      if (installs === 1) {
        fs.writeFileSync(path.join(cwd, 'node_modules', 'partial.txt'), 'incomplete dependency');
        throw new Error('synthetic dependency failure');
      }
      fs.writeFileSync(path.join(cwd, 'node_modules', 'complete.txt'), 'repaired dependency');
    },
  });
  const directory = harness.paths.serverDirFor('existing');
  serverFiles(directory);
  fs.mkdirSync(path.join(directory, 'data'));
  fs.writeFileSync(path.join(directory, 'data', 'chat.json'), '{"preserve":true}');
  fs.writeFileSync(path.join(directory, 'config.yaml'), 'dataRoot: ./data\nbasicAuthMode: true\n');
  const source = fs.readFileSync(path.join(directory, 'server.js'));
  const config = fs.readFileSync(path.join(directory, 'config.yaml'));
  const launchOptions = { instanceId: 'existing', port: 8000, config: defaultRuntimeConfig };
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', launchOptions), { ready: false });
  const markers = path.join(harness.paths.bootstrapDir, 'dependency-installs');
  assert.equal(fs.readdirSync(markers).length, 1);
  assert.equal(harness.starts(), 0);
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', launchOptions), { ready: true });
  assert.equal(installs, 2);
  assert.deepEqual(fs.readdirSync(markers), []);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'server.js')), source);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'config.yaml')), config);
  assert.equal(fs.readFileSync(path.join(directory, 'data', 'chat.json'), 'utf8'), '{"preserve":true}');
  await harness.plugin.stopCurrentServer();
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', launchOptions), { ready: true });
  assert.equal(installs, 2, 'A completed install does not reinstall dependencies');
});

test('cancelling npm after it created node_modules leaves recovery state until a successful retry', async (t) => {
  const entered = deferred();
  const finished = deferred();
  let installs = 0;
  const harness = pluginHarness(t, {
    runNpmInstall: async (cwd) => {
      installs++;
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      if (installs === 1) {
        entered.resolve();
        await finished.promise;
      }
    },
  });
  const directory = harness.paths.serverDirFor('cancelled');
  serverFiles(directory);
  fs.writeFileSync(path.join(directory, 'user-note.txt'), 'preserve existing installation');
  const launch = harness.plugin.handle('provisionAndStart', {
    instanceId: 'cancelled', operationId: 'cancelled-op', port: 8000, config: defaultRuntimeConfig,
  });
  await entered.promise;
  const stopped = harness.plugin.stopCurrentServer({ instanceId: 'cancelled', operationId: 'cancelled-op' });
  finished.resolve();
  assert.deepEqual(await launch, { ready: false });
  await stopped;
  const markers = path.join(harness.paths.bootstrapDir, 'dependency-installs');
  assert.equal(fs.readdirSync(markers).length, 1);
  assert.equal(harness.starts(), 0);
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'cancelled', operationId: 'recovered-op', port: 8000, config: defaultRuntimeConfig,
  }), { ready: true });
  assert.equal(installs, 2);
  assert.deepEqual(fs.readdirSync(markers), []);
  assert.equal(fs.readFileSync(path.join(directory, 'user-note.txt'), 'utf8'), 'preserve existing installation');
});

test('takeover never repairs dependencies or writes installation markers into its source', async (t) => {
  let installs = 0;
  const harness = pluginHarness(t, { runNpmInstall: async () => { installs++; } });
  const source = path.join(harness.root, 'source');
  serverFiles(source);
  const original = fs.readdirSync(source).sort();
  await harness.plugin.handle('migrateInstance', {
    instanceId: 'takeover', sourcePath: source, mode: 'takeover',
  });
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'takeover', port: 8000, config: defaultRuntimeConfig,
  }), { ready: false });
  assert.match(harness.events.filter((event) => event.name === 'tarven:error').at(-1).data.message, /Takeover dependencies/);
  assert.equal(installs, 0);
  assert.equal(harness.starts(), 0);
  assert.deepEqual(fs.readdirSync(source).sort(), original);
  assert.ok(!fs.existsSync(path.join(harness.paths.bootstrapDir, 'dependency-installs')));
});

test('stop during download aborts retries and removes only owned staging', async (t) => {
  const entered = deferred();
  let downloads = 0;
  const harness = pluginHarness(t, {
    downloadFile: async (_url, _destination, _progress, signal) => {
      downloads++;
      entered.resolve();
      await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true }));
    },
  });
  const untouched = harness.paths.serverDirFor('valuable');
  serverFiles(untouched);
  fs.writeFileSync(path.join(untouched, 'chat.txt'), 'preserve');
  const launch = harness.plugin.handle('provisionAndStart', { instanceId: 'new-one', operationId: 'download-1', port: 8000, zipballUrl: 'https://example.invalid/source.zip' });
  await entered.promise;
  const stop = harness.plugin.stopCurrentServer({ instanceId: 'new-one', operationId: 'download-1' });
  assert.deepEqual(await launch, { ready: false });
  await stop;
  assert.equal(downloads, 1);
  assert.equal(harness.starts(), 0);
  assert.deepEqual(fs.readdirSync(path.join(harness.paths.bootstrapDir, 'servers')), ['valuable']);
  assert.equal(fs.readFileSync(path.join(untouched, 'chat.txt'), 'utf8'), 'preserve');
});

test('overlapping launches serialize cleanup and delayed old closes cannot stop a newer run', async (t) => {
  const entered = deferred();
  const installing = deferred();
  const harness = pluginHarness(t, {
    runNpmInstall: async (cwd) => {
      if (cwd.endsWith('old')) {
        entered.resolve();
        await installing.promise;
      }
      fs.mkdirSync(path.join(cwd, 'node_modules'));
    },
  });
  serverFiles(harness.paths.serverDirFor('old'));
  serverFiles(harness.paths.serverDirFor('new'));
  const first = harness.plugin.handle('provisionAndStart', { instanceId: 'old', operationId: 'old-op', port: 8000 });
  await entered.promise;
  const second = harness.plugin.handle('provisionAndStart', { instanceId: 'new', operationId: 'new-op', port: 8001 });
  installing.resolve();
  assert.deepEqual(await first, { ready: false });
  assert.deepEqual(await second, { ready: true });
  assert.equal(harness.starts(), 1);
  const status = await harness.plugin.handle('getStatus');
  assert.equal(status.instanceId, 'new');
  assert.equal(status.operationId, 'new-op');
  assert.equal(harness.plugin.canCloseTavern({ instanceId: 'old', operationId: 'old-op' }), false);
  await harness.plugin.stopCurrentServer({ instanceId: 'old', operationId: 'old-op' });
  assert.equal(harness.running(), true);
  assert.ok(harness.events.filter((event) => event.name === 'tarven:ready' && event.data.ready)
    .every((event) => event.data.instanceId === 'new' && event.data.operationId === 'new-op'));
});

test('legacy unscoped close still cancels a pending launch safely', async (t) => {
  const entered = deferred();
  const done = deferred();
  const harness = pluginHarness(t, {
    runNpmInstall: async (cwd) => { entered.resolve(); await done.promise; fs.mkdirSync(path.join(cwd, 'node_modules')); },
  });
  serverFiles(harness.paths.serverDirFor('legacy'));
  const launch = harness.plugin.handle('provisionAndStart', { instanceId: 'legacy', port: 8000 });
  await entered.promise;
  const stop = harness.plugin.stopCurrentServer();
  done.resolve();
  assert.deepEqual(await launch, { ready: false });
  await stop;
  assert.equal(harness.starts(), 0);
});

test('command output captures the running operation and never adopts a later relaunch ID', async (t) => {
  const firstLine = deferred();
  const nextLine = deferred();
  const harness = pluginHarness(t, {
    sendCommand: async (_text, _cwd, log) => {
      log('command-before-relaunch');
      firstLine.resolve();
      await nextLine.promise;
      log('command-after-relaunch');
    },
  });
  const directory = harness.paths.serverDirFor('one');
  serverFiles(directory);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  await harness.plugin.handle('provisionAndStart', { instanceId: 'one', operationId: 'first', port: 8000 });
  const command = harness.plugin.handle('sendCommand', { instanceId: 'one', text: 'synthetic' });
  await firstLine.promise;
  await harness.plugin.stopCurrentServer({ instanceId: 'one', operationId: 'first' });
  await harness.plugin.handle('provisionAndStart', { instanceId: 'one', operationId: 'second', port: 8000 });
  nextLine.resolve();
  await command;
  const lines = harness.events.filter((event) => event.data.message?.startsWith('command-'));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((event) => event.data.instanceId === 'one'
    && event.data.operationId === 'first' && event.data.source === 'command'));
  assert.equal((await harness.plugin.handle('getStatus')).operationId, 'second');
});

test('scan does not erase a live usage session when the server was launched before first scan', async (t) => {
  const harness = pluginHarness(t);
  const directory = harness.paths.serverDirFor('one');
  serverFiles(directory);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  await harness.plugin.handle('provisionAndStart', { instanceId: 'one', operationId: 'running', port: 8000 });
  await harness.plugin.handle('scanInstances');
  const registry = JSON.parse(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'));
  assert.ok(registry.instances.one.sessionStartedAt);
});

test('copy migration forwards preinstall options within its transaction and takeover rejects before writing', async (t) => {
  const calls = [];
  const harness = pluginHarness(t, {
    installPreselectedExtensions: async (directory, selection, options) => {
      calls.push({ directory, selection, options });
      return { installed: ['dice'], skipped: [], commit: () => calls.push('commit'), rollback: async () => calls.push('rollback') };
    },
  });
  const source = path.join(harness.root, 'source');
  serverFiles(source);
  const selection = { revision: 1, extensionIds: ['dice'] };
  await assert.rejects(harness.plugin.handle('migrateInstance', {
    sourcePath: source, instanceId: 'takeover', mode: 'takeover', preinstall: selection, operationId: 'takeover-op',
  }), /takeover source/);
  assert.ok(!fs.existsSync(harness.paths.instanceRegistryPath));
  const result = await harness.plugin.handle('migrateInstance', {
    sourcePath: source, instanceId: 'copied', mode: 'copy', preinstall: selection, operationId: 'copy-op',
  });
  assert.equal(result.success, true);
  assert.equal(calls[0].directory, result.targetPath);
  assert.deepEqual(calls[0].selection, selection);
  assert.equal(calls[0].options.operationId, 'copy-op');
  assert.ok(fs.existsSync(path.join(result.targetPath, 'node_modules')));
  assert.ok(calls.includes('commit'));
  assert.equal(harness.starts(), 0);
  assert.ok(fs.existsSync(path.join(source, 'server.js')));
});

test('provision commits preinstallation only after readiness and reports contextual events', async (t) => {
  const calls = [];
  const harness = pluginHarness(t, {
    installPreselectedExtensions: async (directory, selection, options) => {
      calls.push({ directory, selection, options });
      options.log('synthetic-extension-ready', 'success');
      return { installed: ['dice'], skipped: [], commit: () => calls.push('commit'), rollback: async () => calls.push('rollback') };
    },
  });
  const directory = harness.paths.serverDirFor('one');
  serverFiles(directory);
  fs.mkdirSync(path.join(directory, 'node_modules'));
  const selection = { revision: 1, extensionIds: ['dice'] };
  const result = await harness.plugin.handle('provisionAndStart', {
    instanceId: 'one', operationId: 'install-op', port: 8000, preinstall: selection,
  });
  assert.equal(result.ready, true);
  assert.equal(calls[0].directory, directory);
  assert.deepEqual(calls[0].selection, selection);
  assert.ok(calls.includes('commit'));
  assert.ok(!calls.includes('rollback'));
  const event = harness.events.find((event) => event.data.message === 'synthetic-extension-ready');
  assert.equal(event.data.instanceId, 'one');
  assert.equal(event.data.operationId, 'install-op');
});

test('failed fresh provisioning preserves user files added after target publication', async (t) => {
  let published;
  const harness = pluginHarness(t, {
    installPreselectedExtensions: async (directory) => {
      published = directory;
      fs.writeFileSync(path.join(directory, 'user-note.txt'), 'created while extensions were downloading');
      throw new Error('synthetic extension download failure');
    },
  });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic source archive');
  await assert.rejects(harness.plugin.handle('provisionAndStart', {
    instanceId: 'new-one', operationId: 'failed-new', port: 8000, localZipPath: archive,
    config: defaultRuntimeConfig, preinstall: { revision: 1, extensionIds: ['dice'] },
  }), /contents changed; files were preserved/);
  assert.equal(fs.readFileSync(path.join(published, 'user-note.txt'), 'utf8'), 'created while extensions were downloading');
  assert.ok(fs.existsSync(path.join(published, 'server.js')));
  assert.equal(harness.starts(), 0);
  assert.ok(!fs.existsSync(harness.paths.instanceRegistryPath));
});

test('fresh provisioning can start with unknown content ownership when rollback bounds are exceeded', async (t) => {
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  let fingerprint;
  const harness = pluginHarness(t, {
    directoryContentIdentity: async (directory, signal) => {
      fingerprint = await migration.directoryContentIdentity(directory, signal, { maxBytes: 1 });
      return fingerprint;
    },
  });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic source archive');
  assert.deepEqual(await harness.plugin.handle('provisionAndStart', {
    instanceId: 'small-bound', operationId: 'normal-start', port: 8000,
    localZipPath: archive, config: defaultRuntimeConfig,
  }), { ready: true });
  assert.equal(fingerprint, null);
  assert.equal(harness.starts(), 1);
  assert.ok(fs.existsSync(path.join(harness.paths.serverDirFor('small-bound'), 'server.js')));
});

test('cancelled fresh provisioning does not delete normal user data added while its target was published', async (t) => {
  const entered = deferred();
  const finished = deferred();
  let published;
  const harness = pluginHarness(t, {
    installPreselectedExtensions: async (directory) => {
      published = directory;
      fs.mkdirSync(path.join(directory, 'data'));
      fs.writeFileSync(path.join(directory, 'data', 'chat.json'), '{"addedAfterPublication":true}');
      entered.resolve();
      await finished.promise;
      return { installed: [], skipped: [], commit() {}, rollback: async () => undefined };
    },
  });
  const archive = path.join(harness.root, 'source.zip');
  fs.writeFileSync(archive, 'synthetic source archive');
  const launch = harness.plugin.handle('provisionAndStart', {
    instanceId: 'new-one', operationId: 'cancelled-new', port: 8000, localZipPath: archive,
    config: defaultRuntimeConfig, preinstall: { revision: 1, extensionIds: ['dice'] },
  });
  const preserved = assert.rejects(launch, /contents changed; files were preserved/);
  await entered.promise;
  const stopped = harness.plugin.stopCurrentServer({ instanceId: 'new-one', operationId: 'cancelled-new' });
  finished.resolve();
  await preserved;
  await stopped;
  assert.equal(fs.readFileSync(path.join(published, 'data', 'chat.json'), 'utf8'), '{"addedAfterPublication":true}');
  assert.ok(fs.existsSync(path.join(published, 'server.js')));
  assert.equal(harness.starts(), 0);
});

test('copy migration failure preserves ordinary user data written after publication and leaves its source unchanged', async (t) => {
  let published;
  const harness = pluginHarness(t, {
    installPreselectedExtensions: async (directory) => {
      published = directory;
      fs.writeFileSync(path.join(directory, 'new-user-data.json'), '{"preserve":true}');
      throw new Error('synthetic extension failure');
    },
  });
  const source = path.join(harness.root, 'source');
  serverFiles(source);
  fs.writeFileSync(path.join(source, 'chat.txt'), 'original source');
  await assert.rejects(harness.plugin.handle('migrateInstance', {
    sourcePath: source, instanceId: 'copied', mode: 'copy', operationId: 'copy-op',
    preinstall: { revision: 1, extensionIds: ['dice'] },
  }), /Migration target contents changed; files were preserved/);
  assert.equal(fs.readFileSync(path.join(published, 'new-user-data.json'), 'utf8'), '{"preserve":true}');
  assert.equal(fs.readFileSync(path.join(source, 'chat.txt'), 'utf8'), 'original source');
  assert.ok(!fs.existsSync(harness.paths.instanceRegistryPath));
});

test('normal unregistered or data-only instances are never garbage', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  serverFiles(paths.serverDirFor('forgotten-by-ui'));
  const dataOnly = paths.serverDirFor('data-only');
  fs.mkdirSync(path.join(dataOnly, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dataOnly, 'data', 'chat.json'), '{}');
  fs.mkdirSync(paths.serverDirFor('empty'));
  const { CleanupService } = loader()('src/runtime/cleanup.ts');
  const cleanup = new CleanupService({
    servers: path.join(paths.bootstrapDir, 'servers'), covers: paths.coversDir, temporary: paths.tmpDir, logs: paths.logsDir,
  }, () => ({ records: [], activeDirectories: [] }));
  const scan = await cleanup.scan({ activeInstanceIds: [] });
  assert.deepEqual(scan.items.map((item) => path.basename(item.path)), ['empty']);
  assert.equal((await cleanup.remove({ path: dataOnly, token: scan.items[0].token })).success, false);
  assert.equal((await cleanup.remove(scan.items[0])).success, true);
  assert.ok(fs.existsSync(path.join(dataOnly, 'data', 'chat.json')));
});

test('covers are preserved without a complete reference list and registered stems are always protected', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const registeredCover = path.join(paths.coversDir, 'known--cover-1.png');
  const explicitCover = path.join(paths.coversDir, 'remote.png');
  const orphanCover = path.join(paths.coversDir, 'orphan.png');
  for (const cover of [registeredCover, explicitCover, orphanCover]) fs.writeFileSync(cover, 'picture');
  const { CleanupService } = loader()('src/runtime/cleanup.ts');
  const cleanup = new CleanupService({
    servers: path.join(paths.bootstrapDir, 'servers'), covers: paths.coversDir, temporary: paths.tmpDir, logs: paths.logsDir,
  }, () => ({ records: [{ instanceId: 'known', path: paths.serverDirFor('known') }], activeDirectories: [] }));
  assert.equal((await cleanup.scan()).items.length, 0);
  assert.equal((await cleanup.scan({ activeCoverPaths: ['app://localhost/unparsed.png'] })).items.length, 0);
  const scan = await cleanup.scan({ activeCoverPaths: [explicitCover] });
  assert.deepEqual(scan.items.map((item) => item.path), [orphanCover]);
  cleanup.invalidate();
  assert.equal((await cleanup.remove(scan.items[0])).success, false);
  assert.ok(fs.existsSync(orphanCover));
});

test('garbage capabilities reject forged paths, traversal, changed files, replays and newly active logs', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const stale = path.join(paths.tmpDir, 'stale.zip');
  fs.writeFileSync(stale, 'archive');
  fs.utimesSync(stale, new Date(0), new Date(0));
  const log = path.join(paths.logsDir, 'new.log');
  fs.writeFileSync(log, 'old log');
  const context = { records: [], activeDirectories: [], activeInstanceIds: [] };
  const { CleanupService } = loader()('src/runtime/cleanup.ts');
  const cleanup = new CleanupService({
    servers: path.join(paths.bootstrapDir, 'servers'), covers: paths.coversDir, temporary: paths.tmpDir, logs: paths.logsDir,
  }, () => context);
  let scan = await cleanup.scan();
  const item = scan.items.find((item) => item.path === stale);
  assert.equal((await cleanup.remove({ path: stale })).success, false);
  assert.equal((await cleanup.remove({ path: path.join(root, 'unrelated'), token: item.token })).success, false);
  assert.equal((await cleanup.remove({ path: `${paths.tmpDir}${path.sep}..${path.sep}tmp${path.sep}stale.zip`, token: item.token })).success, false);
  fs.appendFileSync(stale, 'changed');
  assert.equal((await cleanup.remove(item)).success, false);
  scan = await cleanup.scan();
  context.activeInstanceIds.push('new');
  assert.equal((await cleanup.remove(scan.items.find((item) => item.path === log))).success, false);
  assert.ok(fs.existsSync(log));
  fs.utimesSync(stale, new Date(0), new Date(0));
  scan = await cleanup.scan();
  const refreshed = scan.items.find((item) => item.path === stale);
  assert.equal((await cleanup.remove(refreshed)).success, true);
  assert.equal((await cleanup.remove(refreshed)).success, false);
});

test('garbage scan and deletion refuse junctions including a root changed after scan', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'valuable.log'), 'preserve');
  const linked = path.join(paths.logsDir, 'linked');
  fs.symlinkSync(outside, linked, 'junction');
  const { CleanupService } = loader()('src/runtime/cleanup.ts');
  const cleanup = new CleanupService({
    servers: path.join(paths.bootstrapDir, 'servers'), covers: paths.coversDir, temporary: paths.tmpDir, logs: paths.logsDir,
  }, () => ({ records: [], activeDirectories: [] }));
  const log = path.join(paths.logsDir, 'valuable.log');
  fs.writeFileSync(log, 'old log');
  const scan = await cleanup.scan();
  assert.ok(!scan.items.some((item) => item.path === linked));
  const item = scan.items.find((item) => item.path === log);
  fs.unlinkSync(log);
  fs.rmdirSync(linked);
  fs.rmdirSync(paths.logsDir);
  fs.symlinkSync(outside, paths.logsDir, 'junction');
  assert.equal((await cleanup.remove(item)).success, false);
  assert.equal(fs.readFileSync(path.join(outside, 'valuable.log'), 'utf8'), 'preserve');
  fs.rmdirSync(paths.logsDir);
});

test('unchanged instance scan reads one registry snapshot and writes zero replacements', async (t) => {
  const harness = pluginHarness(t);
  for (let index = 0; index < 20; index++) serverFiles(harness.paths.serverDirFor(`instance-${index}`));
  await harness.plugin.handle('scanInstances');
  const before = fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8');
  let reads = 0;
  let writes = 0;
  const countedFs = new Proxy(originalPaths, {
    get(target, key) {
      if (key === 'readFileSync') return (file, ...args) => {
        if (file === harness.paths.instanceRegistryPath) reads++;
        return target.readFileSync(file, ...args);
      };
      if (key === 'renameSync') return (from, to) => {
        if (to === harness.paths.instanceRegistryPath) writes++;
        return target.renameSync(from, to);
      };
      return target[key];
    },
  });
  const repositoryLoad = loader({ './paths': harness.paths, 'node:fs': countedFs });
  const { InstanceRepository, usageForRecord } = repositoryLoad('src/runtime/instances.ts');
  const repository = new InstanceRepository();
  for (const record of repository.list()) {
    repository.register(record.instanceId, record.path);
    usageForRecord(repository.get(record.instanceId));
  }
  repository.commit();
  assert.equal(reads, 1);
  assert.equal(writes, 0);
  assert.equal(fs.readFileSync(harness.paths.instanceRegistryPath, 'utf8'), before);
});

test('atomic registry replacement preserves the old file on rename failure and refuses corrupted data', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const initial = JSON.stringify({ version: 1, instances: {} });
  fs.writeFileSync(paths.instanceRegistryPath, initial);
  const failedFs = new Proxy(fs, {
    get(target, key) {
      if (key === 'renameSync') return () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); };
      return target[key];
    },
  });
  const store = loader({ './paths': paths, 'node:fs': failedFs })('src/runtime/instances.ts');
  assert.throws(() => store.registerInstance('one', paths.serverDirFor('one')), /locked/);
  assert.equal(fs.readFileSync(paths.instanceRegistryPath, 'utf8'), initial);
  assert.ok(!fs.readdirSync(root).some((entry) => entry.includes('.tmp-')));
  fs.writeFileSync(paths.instanceRegistryPath, 'not-json');
  assert.throws(() => store.registerInstance('one', paths.serverDirFor('one')));
  assert.equal(fs.readFileSync(paths.instanceRegistryPath, 'utf8'), 'not-json');
});

test('directory sizing is asynchronous, cached, skips heavy trees and never follows junctions', async (t) => {
  const root = fixture(t);
  const directory = path.join(root, 'data');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(directory);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(directory, 'chat.txt'), '12345');
  fs.writeFileSync(path.join(outside, 'large.txt'), '1234567890');
  fs.mkdirSync(path.join(directory, 'node_modules'));
  fs.writeFileSync(path.join(directory, 'node_modules', 'dependency.js'), '123456');
  const linked = path.join(directory, 'linked');
  fs.symlinkSync(outside, linked, 'junction');
  const { directorySize, invalidateDirectorySize } = loader()('src/runtime/directory-stats.ts');
  assert.equal(await directorySize(directory), 5);
  fs.appendFileSync(path.join(directory, 'chat.txt'), '678');
  assert.equal(await directorySize(directory), 5);
  invalidateDirectorySize(directory);
  assert.equal(await directorySize(directory), 8);
  assert.equal(await directorySize(directory, { includeHeavy: true }), 14);
  fs.rmdirSync(linked);
});

test('supervisor never kills an unrelated process and shuts down only tracked PID trees', async (t) => {
  const root = fixture(t);
  const spawns = fakeSpawns();
  const { ProcessSupervisor } = loader({ 'node:child_process': { spawn: spawns.spawn } })('src/runtime/process-supervisor.ts');
  const supervisor = new ProcessSupervisor();
  const unrelated = fakeChild(900);
  await supervisor.stop(unrelated);
  await supervisor.stopDirectory(root);
  assert.equal(spawns.records.length, 0);
  assert.equal(unrelated.killed, false);
  const owned = fakeChild(901);
  supervisor.track(owned, root);
  // Fake taskkill cannot see a manually supplied child; normal kill confirms exit.
  await supervisor.stop(owned);
  assert.equal(supervisor.owns(owned), false);
  assert.ok(spawns.records.every((record) => record.args[0] === '/PID' && record.args[1] === '901'));
  assert.equal(unrelated.killed, false);
});

test('process capture is bounded, cancellation waits for owned child exit and npm does not retry abort', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const spawns = fakeSpawns();
  const proc = loader({
    './paths': paths, 'node:child_process': { spawn: spawns.spawn },
  })('src/runtime/process.ts');
  const result = proc.runProcess('C:\\bundled\\node.exe', [], { cwd: root });
  spawns.records[0].child.stdout.write(Buffer.alloc(200000, 'a'));
  spawns.records[0].child.stderr.write(Buffer.alloc(200000, 'b'));
  spawns.records[0].child.emit('close', 0);
  const captured = await result;
  assert.equal(captured.stdout.length, 65536);
  assert.equal(captured.stderr.length, 65536);
  const controller = new AbortController();
  const install = proc.runNpmInstall(root, () => undefined, controller.signal);
  controller.abort();
  await assert.rejects(install, { name: 'AbortError' });
  assert.equal(spawns.records.filter((record) => record.args.includes('install')).length, 1);
  assert.ok(!proc.activeProcessDirectories().length);
});

test('an exited child with open pipes cannot trigger taskkill against a reused PID', async (t) => {
  const root = fixture(t);
  const spawns = fakeSpawns();
  const { ProcessSupervisor } = loader({ 'node:child_process': { spawn: spawns.spawn } })('src/runtime/process-supervisor.ts');
  const supervisor = new ProcessSupervisor();
  const exited = fakeChild(999);
  supervisor.track(exited, root);
  exited.exitCode = 0;
  exited.emit('exit', 0);
  const stopping = supervisor.stop(exited);
  setImmediate(() => exited.emit('close', 0));
  await stopping;
  assert.equal(spawns.records.length, 0);
  assert.equal(exited.killed, false);
});

test('command timeout is supervised while output is still open', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const spawns = fakeSpawns();
  const proc = loader({ './paths': paths, 'node:child_process': { spawn: spawns.spawn } })('src/runtime/process.ts');
  const command = proc.runProcess('C:\\bundled\\node.exe', [], { cwd: root, timeout: 20 });
  await assert.rejects(command, /timeout/);
  assert.ok(!proc.activeProcessDirectories().length);
});

test('server invocation does not write scripts and old close cannot clear newer ownership', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const spawns = fakeSpawns();
  const proc = loader({ './paths': paths, 'node:child_process': { spawn: spawns.spawn } })('src/runtime/process.ts');
  fs.writeFileSync(path.join(root, 'start-server.bat'), 'original script');
  let exits = 0;
  const first = proc.startServer(root, 'one', 8000, () => undefined, () => exits++);
  assert.equal(spawns.records[0].command, paths.getNodeExe());
  assert.equal(spawns.records[0].options.windowsHide, true);
  assert.equal(fs.readFileSync(path.join(root, 'start-server.bat'), 'utf8'), 'original script');
  first.emit('close', 0);
  const second = proc.startServer(root, 'two', 8001, () => undefined, () => exits++);
  first.emit('close', 0);
  assert.equal(proc.isServerRunning(), true);
  assert.equal(exits, 1);
  await proc.stopServer();
  assert.equal(proc.isServerRunning(), false);
  assert.equal(exits, 2);
  assert.ok(second);
});

test('server spawn error is handled without an unhandled error event', async (t) => {
  const root = fixture(t);
  const paths = pathsFor(root);
  const logs = [];
  const child = fakeChild(undefined);
  const proc = loader({
    './paths': paths,
    'node:child_process': { spawn: () => child },
  })('src/runtime/process.ts');
  proc.startServer(root, 'missing', 8000, (line) => logs.push(line));
  child.emit('error', Object.assign(new Error('missing executable'), { code: 'ENOENT' }));
  child.emit('close', null);
  assert.equal(proc.isServerRunning(), false);
  assert.ok(logs.some((line) => line.includes('missing executable')));
  await proc.stopAllProcesses();
});

test('line sink preserves UTF-8 across chunks and bounds unterminated lines', () => {
  const { createLineSink } = loader()('src/runtime/logs.ts');
  const lines = [];
  const sink = createLineSink((line) => lines.push(line));
  const multibyte = Buffer.from('\u4e2d\n');
  sink.write(multibyte.subarray(0, 1));
  sink.write(multibyte.subarray(1));
  sink.write(Buffer.alloc(30000, 'x'));
  sink.end();
  assert.equal(lines[0], '\u4e2d');
  assert.ok(lines.every((line) => line.length <= 8192));
});

test('migration refuses existing or overlapping targets and preserves source bytes', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  serverFiles(source);
  fs.writeFileSync(path.join(source, 'secret-note.txt'), 'source remains');
  const existing = path.join(root, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'note.txt'), 'target remains');
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  await assert.rejects(migration.copyMigration(source, existing, source, { includeSecrets: false }), /already exists/);
  await assert.rejects(migration.copyMigration(source, path.join(source, 'nested'), source, { includeSecrets: false }), /overlap/);
  const transaction = await migration.copyMigration(source, path.join(root, 'new-target'), source, { includeSecrets: false });
  transaction.commit();
  await transaction.rollback();
  assert.equal(fs.readFileSync(path.join(source, 'secret-note.txt'), 'utf8'), 'source remains');
  assert.equal(fs.readFileSync(path.join(existing, 'note.txt'), 'utf8'), 'target remains');
  assert.ok(fs.existsSync(path.join(transaction.target, 'server.js')));
});

test('migration validates takeover and filters secrets, dependencies and git in directory and ZIP branches', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  serverFiles(source);
  fs.writeFileSync(path.join(source, 'secrets.json'), 'private');
  for (const name of ['node_modules', '.git']) {
    fs.mkdirSync(path.join(source, name));
    fs.writeFileSync(path.join(source, name, 'excluded.txt'), 'excluded');
  }
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  assert.equal(await migration.resolveTakeoverSource(source), source);
  const copy = await migration.copyMigration(source, path.join(root, 'copy'), source, { includeSecrets: false });
  for (const name of ['secrets.json', 'node_modules', '.git']) assert.ok(!fs.existsSync(path.join(copy.target, name)));
  copy.commit();
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('wrapper/server.js', Buffer.from('// synthetic'));
  zip.addFile('wrapper/package.json', Buffer.from('{"version":"1.19.0"}'));
  zip.addFile('wrapper/secrets.json', Buffer.from('secret'));
  zip.addFile('wrapper/node_modules/dependency.js', Buffer.from('foreign'));
  zip.addFile('wrapper/.git/index', Buffer.from('git'));
  const archive = path.join(root, 'backup.zip');
  zip.writeZip(archive);
  const extracted = await migration.copyMigration(archive, path.join(root, 'extracted'), source, { includeSecrets: false });
  assert.ok(fs.existsSync(path.join(extracted.target, 'server.js')));
  for (const name of ['secrets.json', 'node_modules', '.git']) assert.ok(!fs.existsSync(path.join(extracted.target, name)));
  extracted.commit();
  const invalid = path.join(root, 'invalid');
  fs.mkdirSync(invalid);
  await assert.rejects(migration.resolveTakeoverSource(invalid), /complete/);
});

test('migration abort rolls back only its unique staging and keeps the existing source', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  serverFiles(source);
  const controller = new AbortController();
  controller.abort();
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  const target = path.join(root, 'copy');
  await assert.rejects(migration.copyMigration(source, target, source, { includeSecrets: false, signal: controller.signal }), { name: 'AbortError' });
  assert.ok(!fs.existsSync(target));
  assert.deepEqual(fs.readdirSync(root), ['source']);
});

test('published migration rollback detects same-size ordinary file edits with restored timestamps', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  serverFiles(source);
  fs.writeFileSync(path.join(source, 'chat.txt'), 'original');
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  const transaction = await migration.copyMigration(source, path.join(root, 'copy'), source, { includeSecrets: false });
  const edited = path.join(transaction.target, 'chat.txt');
  const stat = fs.statSync(edited);
  fs.writeFileSync(edited, 'modified');
  fs.utimesSync(edited, stat.atime, stat.mtime);
  assert.equal(fs.statSync(edited).ino, stat.ino);
  assert.equal(fs.statSync(edited).size, stat.size);
  await assert.rejects(transaction.rollback(), /contents changed/);
  assert.equal(fs.readFileSync(edited, 'utf8'), 'modified');
  assert.equal(fs.readFileSync(path.join(source, 'chat.txt'), 'utf8'), 'original');
});

test('migration rollback ownership bounds do not impose a successful-copy capacity limit', async (t) => {
  const root = fixture(t);
  const source = path.join(root, 'source');
  serverFiles(source);
  fs.writeFileSync(path.join(source, 'chat.txt'), 'few bytes');
  const migration = loader({ electron: {} })('src/runtime/migration.ts');
  for (const [index, ownershipBounds] of [{ maxBytes: 1 }, { maxEntries: 1 }].entries()) {
    const transaction = await migration.copyMigration(source, path.join(root, `copy-${index}`), source, {
      includeSecrets: false, ownershipBounds,
    });
    assert.equal(fs.readFileSync(path.join(transaction.target, 'chat.txt'), 'utf8'), 'few bytes');
    assert.equal(await migration.directoryContentIdentity(transaction.target, undefined, ownershipBounds), null);
    await assert.rejects(transaction.rollback(), /content ownership is unknown; files were preserved/);
    assert.ok(fs.existsSync(path.join(transaction.target, 'server.js')));
    assert.equal(fs.readFileSync(path.join(transaction.target, 'chat.txt'), 'utf8'), 'few bytes');
  }
  assert.equal(fs.readFileSync(path.join(source, 'chat.txt'), 'utf8'), 'few bytes');
});

function extensionFixture(t, ids = ['tavern-helper', 'dice'], overrides = {}, queryRunner) {
  const root = fixture(t);
  const server = path.join(root, 'server');
  serverFiles(server);
  fs.writeFileSync(path.join(server, 'config.yaml'), 'dataRoot: ./data\n');
  const repositories = {
    'tavern-helper': 'N0VI028/JS-Slash-Runner',
    littlewhitebox: 'RT15548/LittleWhiteBox',
    'prompt-template': 'zonde306/ST-Prompt-Template',
    dice: 'SillyTavern/Extension-Dice',
  };
  const archives = new Map();
  const extensions = ids.map((id, index) => {
    const repository = repositories[id];
    const commit = String(index + 1).repeat(40);
    const name = `${repository.split('/')[1]}-${commit}`;
    const zip = new (require('adm-zip'))();
    const manifest = {
      display_name: id, version: '1.0.0', js: 'index.js', css: 'style.css', minimum_client_version: '1.13.0',
      ...(overrides[id]?.manifest || {}),
    };
    zip.addFile(`${name}/manifest.json`, Buffer.from(JSON.stringify(manifest)));
    zip.addFile(`${name}/index.js`, Buffer.from('// synthetic extension, never executed'));
    zip.addFile(`${name}/style.css`, Buffer.from('/* synthetic stylesheet */'));
    if (!overrides[id]?.omitLicense) zip.addFile(`${name}/LICENSE`, Buffer.from('Synthetic test license'));
    const buffer = zip.toBuffer();
    archives.set(id, buffer);
    return {
      id, displayName: id, repository, commit, archiveBytes: buffer.byteLength,
      archiveSha256: createHash('sha256').update(buffer).digest('hex'),
      version: '1.0.0', license: 'Synthetic', licensePath: 'LICENSE',
      ...(overrides[id]?.catalog || {}),
    };
  });
  const catalogPath = path.join(root, 'catalog.json');
  fs.writeFileSync(catalogPath, JSON.stringify({ revision: 1, extensions }));
  const paths = pathsFor(root);
  const queries = [];
  const installer = loader({
    './paths': paths,
    './process': {
      runProcess: async (cmd, args, options) => {
        queries.push({ cmd, args, options });
        if (queryRunner) return queryRunner(cmd, args, options);
        return { stdout: JSON.stringify({ dataRoot: './data' }), stderr: '', code: 0 };
      },
    },
    electron: {},
  })('src/runtime/preinstalled-extensions.ts');
  const dependencies = {
    catalogPath,
    download: async (url, destination) => {
      assert.ok(url.startsWith('https://codeload.github.com/'));
      const extension = extensions.find((entry) => url === `https://codeload.github.com/${entry.repository}/zip/${entry.commit}`);
      assert.ok(extension, 'Only pinned allowlisted download URLs are accepted');
      fs.writeFileSync(destination, archives.get(extension.id));
    },
  };
  return { root, server, installer, dependencies, archives, extensions, queries };
}

function yamlQueryRunner(config) {
  return async (_cmd, args, options) => {
    assert.equal(args[0], '-e');
    assert.equal(args[2], options.cwd);
    let stdout = '';
    let parsed = false;
    const sandbox = {
      require: (name) => {
        if (name === 'node:fs') return fs;
        if (name === 'node:path') return path;
        if (name === 'node:module') return {
          createRequire: (filename) => {
            assert.equal(filename, path.join(options.cwd, 'package.json'));
            return (dependency) => {
              assert.equal(dependency, 'yaml');
              return { parse: () => { parsed = true; return config; } };
            };
          },
        };
        throw new Error(`Unexpected query dependency: ${name}`);
      },
      process: { argv: ['bundled-node', args[2]], stdout: { write: (text) => { stdout += text; } } },
    };
    try {
      vm.runInNewContext(args[1], sandbox, { timeout: 1000 });
      return { stdout, stderr: '', code: 0, parsed };
    } catch (error) {
      return { stdout, stderr: error.message, code: 1, parsed };
    }
  };
}

test('actual YAML query rejects scalar and array document roots without creating installation targets', async (t) => {
  for (const config of ['dataRoot: ignored', 42, true, [], [{ dataRoot: './custom' }]]) {
    let result;
    const runQuery = yamlQueryRunner(config);
    const setup = extensionFixture(t, ['dice'], {}, async (...args) => {
      result = await runQuery(...args);
      return result;
    });
    await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
      { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies), /Cannot safely resolve/);
    assert.equal(result.code, 1);
    assert.equal(result.parsed, true);
    assert.match(result.stderr, /mapping/i);
    assert.equal(setup.queries.length, 1);
    assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
    assert.ok(!fs.existsSync(path.join(setup.server, 'custom')));
    assert.deepEqual(fs.readdirSync(setup.server).sort(), ['config.yaml', 'package.json', 'server.js']);
  }
});

test('actual YAML query accepts empty documents, missing config and custom mapping data roots', async (t) => {
  for (const config of [undefined, null, {}, { dataRoot: './custom' }]) {
    let result;
    const runQuery = yamlQueryRunner(config);
    const setup = extensionFixture(t, ['dice'], {}, async (...args) => {
      result = await runQuery(...args);
      return result;
    });
    if (config === undefined) fs.unlinkSync(path.join(setup.server, 'config.yaml'));
    const transaction = await setup.installer.installPreselectedExtensions(setup.server,
      { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies);
    assert.equal(result.code, 0);
    assert.equal(result.parsed, config !== undefined);
    const rootName = config?.dataRoot === './custom' ? 'custom' : 'data';
    assert.ok(fs.existsSync(path.join(setup.server, rootName, 'default-user', 'extensions', 'Extension-Dice', 'manifest.json')));
    if (rootName === 'custom') assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
    await transaction.rollback();
    assert.ok(!fs.existsSync(path.join(setup.server, rootName)));
  }
});

test('preinstall publishes a selected set transactionally and queries YAML only with bundled Node', async (t) => {
  const setup = extensionFixture(t);
  const transaction = await setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper', 'dice'] }, { operationId: 'extensions-1' }, setup.dependencies);
  const extensionsRoot = path.join(setup.server, 'data', 'default-user', 'extensions');
  assert.deepEqual(transaction.installed, ['tavern-helper', 'dice']);
  assert.equal(setup.queries.length, 1);
  assert.equal(setup.queries[0].cmd, 'C:\\bundled\\node.exe');
  assert.deepEqual(setup.queries[0].args.slice(-1), [setup.server]);
  assert.ok(!setup.queries[0].args.some((arg) => arg === 'install' || arg === 'git'));
  assert.ok(fs.existsSync(path.join(extensionsRoot, 'JS-Slash-Runner', 'manifest.json')));
  assert.ok(fs.existsSync(path.join(extensionsRoot, 'Extension-Dice', 'manifest.json')));
  await transaction.rollback();
  assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
});

test('archive extraction rejects traversal, symlinks and entry expansion limits', async (t) => {
  const root = fixture(t);
  const records = [
    { entryName: '../escape.txt', attr: 0, isDirectory: false, header: { size: 1 } },
    { entryName: '/absolute.txt', attr: 0, isDirectory: false, header: { size: 1 } },
    { entryName: 'root/link', attr: 0xa000 << 16, isDirectory: false, header: { size: 1 } },
    { entryName: 'root/oversized.txt', attr: 0, isDirectory: false, header: { size: 1000 } },
  ];
  for (let index = 0; index < records.length; index++) {
    const target = path.join(root, String(index));
    fs.mkdirSync(target);
    const FakeZip = class { getEntries() { return [records[index]]; } };
    const utils = loader({ electron: {}, 'adm-zip': FakeZip })('src/runtime/utils.ts');
    await assert.rejects(utils.unzipToDir('synthetic.zip', target, { maxEntryBytes: 20, maxBytes: 20 }));
    assert.deepEqual(fs.readdirSync(target), []);
  }
  assert.ok(!fs.existsSync(path.join(root, 'escape.txt')));
});

test('download rejects a size overrun and never removes an existing destination', async (t) => {
  const root = fixture(t);
  const destination = path.join(root, 'archive.zip');
  const fakeResponse = () => ({
    ok: true, status: 200, headers: { get: () => '0' },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.alloc(40)));
        controller.close();
      },
    }),
  });
  const utils = loader({ electron: { net: { fetch: async () => fakeResponse() } } })('src/runtime/utils.ts');
  await assert.rejects(utils.downloadFile('https://example.invalid/file.zip', destination, undefined, undefined, 20), /size limit/);
  assert.ok(!fs.existsSync(destination));
  fs.writeFileSync(destination, 'existing archive');
  await assert.rejects(utils.downloadFile('https://example.invalid/file.zip', destination));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing archive');
});

test('preinstall is idempotent and preserves existing extensions and disabled settings', async (t) => {
  const setup = extensionFixture(t);
  const first = await setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper'] }, {}, setup.dependencies);
  first.commit();
  const extensionsRoot = path.join(setup.server, 'data', 'default-user', 'extensions');
  const script = path.join(extensionsRoot, 'JS-Slash-Runner', 'index.js');
  fs.writeFileSync(script, '// user edits');
  const settings = path.join(setup.server, 'data', 'default-user', 'settings.json');
  const disabled = '{"extension_settings":{"disabledExtensions":["third-party/JS-Slash-Runner"]}}';
  fs.writeFileSync(settings, disabled);
  const second = await setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper', 'dice'] }, {}, setup.dependencies);
  assert.deepEqual(second.skipped, ['tavern-helper']);
  assert.deepEqual(second.installed, ['dice']);
  await second.rollback();
  assert.equal(fs.readFileSync(script, 'utf8'), '// user edits');
  assert.equal(fs.readFileSync(settings, 'utf8'), disabled);
  assert.ok(!fs.existsSync(path.join(extensionsRoot, 'Extension-Dice')));
});

test('preinstall rejects selection and incompatible versions before creating any target', async (t) => {
  const setup = extensionFixture(t, ['dice'], { dice: { catalog: { minimumClientVersion: '9.0.0' } } });
  const service = setup.installer.installPreselectedExtensions;
  await assert.rejects(service(setup.server, { revision: 1, extensionIds: ['unknown'] }, {}, setup.dependencies), /selection/);
  await assert.rejects(service(setup.server, { revision: 1, extensionIds: ['dice', 'dice'] }, {}, setup.dependencies), /selection/);
  await assert.rejects(service(setup.server, { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies), /requires/);
  assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
  assert.equal(setup.queries.length, 0);
});

test('preinstall validates archive hash and manifest minimum version before publishing any selection', async (t) => {
  const setup = extensionFixture(t, ['tavern-helper', 'dice'], {
    dice: { manifest: { minimum_client_version: '9.0.0' } },
  });
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper', 'dice'] }, {}, setup.dependencies), /requires/);
  assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
  const corrupted = { ...setup.dependencies, download: async (_url, destination) => fs.writeFileSync(destination, 'corrupted') };
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper'] }, {}, corrupted), /verification/);
  assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
});

test('preinstall validates pinned extension version, license and declared compiled assets', async (t) => {
  const invalidVersions = extensionFixture(t, ['dice'], { dice: { manifest: { version: '2.0.0' } } });
  await assert.rejects(invalidVersions.installer.installPreselectedExtensions(invalidVersions.server,
    { revision: 1, extensionIds: ['dice'] }, {}, invalidVersions.dependencies), /version mismatch/);
  assert.ok(!fs.existsSync(path.join(invalidVersions.server, 'data')));
  const missingLicense = extensionFixture(t, ['dice'], { dice: { omitLicense: true } });
  await assert.rejects(missingLicense.installer.installPreselectedExtensions(missingLicense.server,
    { revision: 1, extensionIds: ['dice'] }, {}, missingLicense.dependencies), /license/);
  assert.ok(!fs.existsSync(path.join(missingLicense.server, 'data')));
  const missingAsset = extensionFixture(t, ['dice'], { dice: { manifest: { js: 'dist/missing.js' } } });
  await assert.rejects(missingAsset.installer.installPreselectedExtensions(missingAsset.server,
    { revision: 1, extensionIds: ['dice'] }, {}, missingAsset.dependencies));
  assert.ok(!fs.existsSync(path.join(missingAsset.server, 'data')));
  const unsafeLicense = extensionFixture(t, ['dice'], { dice: { catalog: { licensePath: '../LICENSE' } } });
  await assert.rejects(unsafeLicense.installer.installPreselectedExtensions(unsafeLicense.server,
    { revision: 1, extensionIds: ['dice'] }, {}, unsafeLicense.dependencies), /Unsafe/);
  assert.equal(unsafeLicense.queries.length, 0);
});

test('preinstall abort removes its staged downloads but does not alter existing extensions', async (t) => {
  const setup = extensionFixture(t);
  const existing = path.join(setup.server, 'data', 'default-user', 'extensions', 'JS-Slash-Runner');
  fs.mkdirSync(existing, { recursive: true });
  fs.writeFileSync(path.join(existing, 'manifest.json'), '{"js":"custom.js"}');
  const controller = new AbortController();
  const dependencies = {
    ...setup.dependencies,
    download: async (_url, destination) => {
      fs.writeFileSync(destination, 'partial archive');
      controller.abort();
    },
  };
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['tavern-helper', 'dice'] }, { signal: controller.signal }, dependencies), { name: 'AbortError' });
  assert.equal(fs.readFileSync(path.join(existing, 'manifest.json'), 'utf8'), '{"js":"custom.js"}');
  assert.deepEqual(fs.readdirSync(path.dirname(existing)), ['JS-Slash-Runner']);
});

test('preinstall rejects external data roots, incomplete existing extensions and junction destinations', async (t) => {
  const setup = extensionFixture(t, ['dice']);
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['dice'] }, {},
    { ...setup.dependencies, resolveDataRoot: async () => setup.root }), /outside/);
  const incomplete = path.join(setup.server, 'data', 'default-user', 'extensions', 'Extension-Dice');
  fs.mkdirSync(incomplete, { recursive: true });
  fs.writeFileSync(path.join(incomplete, 'user-note.txt'), 'preserve');
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies), /incomplete/);
  assert.equal(fs.readFileSync(path.join(incomplete, 'user-note.txt'), 'utf8'), 'preserve');
  fs.rmSync(incomplete, { recursive: true });
  const outside = path.join(setup.root, 'external');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, incomplete, 'junction');
  await assert.rejects(setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies), /Linked/);
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.rmdirSync(incomplete);
});

test('preinstall rollback preserves post-install user edits rather than deleting changed directories', async (t) => {
  const setup = extensionFixture(t, ['dice']);
  const transaction = await setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies);
  const target = path.join(setup.server, 'data', 'default-user', 'extensions', 'Extension-Dice');
  fs.writeFileSync(path.join(target, 'user-data.txt'), 'changed after install');
  await assert.rejects(transaction.rollback(), /changed/);
  assert.equal(fs.readFileSync(path.join(target, 'user-data.txt'), 'utf8'), 'changed after install');
});

test('preinstall rollback detects same-size edits even when the old timestamp is restored', async (t) => {
  const setup = extensionFixture(t, ['dice']);
  const transaction = await setup.installer.installPreselectedExtensions(setup.server,
    { revision: 1, extensionIds: ['dice'] }, {}, setup.dependencies);
  const target = path.join(setup.server, 'data', 'default-user', 'extensions', 'Extension-Dice');
  const script = path.join(target, 'index.js');
  const original = fs.statSync(script);
  const edited = Buffer.alloc(original.size, 'X');
  fs.writeFileSync(script, edited);
  fs.utimesSync(script, original.atimeMs / 1000, original.mtimeMs / 1000);
  const after = fs.statSync(script);
  assert.equal(after.size, original.size);
  assert.equal(after.ino, original.ino);
  assert.ok(Math.abs(after.mtimeMs - original.mtimeMs) < 0.001);
  await assert.rejects(transaction.rollback(), /changed/);
  assert.deepEqual(fs.readFileSync(script), edited);
});

function companionFixture(t, config = { dataRoot: './data' }, fsOverride) {
  const root = fixture(t);
  const server = path.join(root, 'server');
  serverFiles(server);
  fs.writeFileSync(path.join(server, 'config.yaml'), 'dataRoot: ./data\n');
  const defaults = path.join(server, 'default', 'content');
  fs.mkdirSync(defaults, { recursive: true });
  fs.writeFileSync(path.join(defaults, 'settings.json'), '{"power_user":{},"preserve":"default setting"}');
  const paths = pathsFor(root);
  const queries = [];
  const runQuery = yamlQueryRunner(config);
  const service = loader({
    './paths': paths,
    './process': {
      runProcess: async (...args) => {
        queries.push(args);
        return runQuery(...args);
      },
    },
    ...(fsOverride ? { 'node:fs': fsOverride } : {}),
  })('src/runtime/companion-presets.ts');
  const request = { bundleId: 'sc-bordeaux', revision: 1 };
  const presetRoot = path.join(project, 'resources', 'companion-presets');
  const install = () => service.installCompanionPreset(server, request, presetRoot);
  return { root, server, paths, queries, service, request, presetRoot, install };
}

test('companion preset applies real resources to default data and restores only its own writes', async (t) => {
  const setup = companionFixture(t);
  const settings = path.join(setup.server, 'data', 'default-user', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = '{"power_user":{"userCustomKey":"preserve"},"background":{},"preserve":"user setting"}';
  fs.writeFileSync(settings, original);
  const transaction = await setup.install();
  assert.equal(transaction.applied, true);
  const applied = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.equal(applied.power_user.theme, 'SC Bordeaux');
  assert.equal(applied.power_user.userCustomKey, 'preserve');
  assert.equal(applied.preserve, 'user setting');
  assert.equal(setup.queries.length, 1);
  const theme = path.join(setup.server, 'data', 'default-user', 'themes', 'SC Bordeaux.json');
  const wallpaper = path.join(setup.server, 'data', 'default-user', 'backgrounds', 'sillyclient-bg-8k.jpg');
  assert.ok(fs.existsSync(theme));
  assert.ok(fs.existsSync(wallpaper));
  transaction.rollback();
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  assert.ok(!fs.existsSync(theme));
  assert.ok(!fs.existsSync(wallpaper));
});

test('companion preset rejects custom data roots before modifying default or custom files', async (t) => {
  for (const dataRoot of ['./custom', '../external']) {
    const setup = companionFixture(t, { dataRoot });
    await assert.rejects(setup.install(), /dataRoot/);
    assert.deepEqual(fs.readdirSync(setup.server).sort(), ['config.yaml', 'default', 'package.json', 'server.js']);
    assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
    assert.ok(!fs.existsSync(path.join(setup.server, 'custom')));
  }
});

test('companion preset refuses junctions in data, nested targets, marker and default settings ancestry', async (t) => {
  for (const linked of ['data', 'data/default-user/themes', '.sillyclient', 'default/content']) {
    const setup = companionFixture(t);
    const outside = path.join(setup.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'user-note.txt'), 'external user data');
    const target = path.join(setup.server, linked);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.renameSync(target, `${target}.retained`);
    fs.symlinkSync(outside, target, 'junction');
    await assert.rejects(setup.install(), /Linked preset paths/);
    assert.deepEqual(fs.readdirSync(outside), ['user-note.txt']);
    assert.equal(fs.readFileSync(path.join(outside, 'user-note.txt'), 'utf8'), 'external user data');
    assert.ok(!fs.existsSync(path.join(setup.server, '.sillyclient', 'companion-presets', 'sc-bordeaux.json')));
  }
});

test('already applied companion preset is a true no-op even with a later custom dataRoot', async (t) => {
  const setup = companionFixture(t, { dataRoot: './custom' });
  const manifest = JSON.parse(fs.readFileSync(path.join(setup.presetRoot, 'sc-bordeaux', 'manifest.json'), 'utf8'));
  const marker = path.join(setup.server, '.sillyclient', 'companion-presets', 'sc-bordeaux.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const original = JSON.stringify({
    bundleId: 'sc-bordeaux', revision: 1,
    themeSha256: manifest.theme.sha256, wallpaperSha256: manifest.wallpaper.sha256,
  });
  fs.writeFileSync(marker, original);
  const transaction = await setup.install();
  assert.equal(transaction.applied, false);
  assert.equal(setup.queries.length, 0);
  transaction.rollback();
  assert.equal(fs.readFileSync(marker, 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(setup.server, 'data')));
});

test('companion rollback preserves changed settings and same-size theme edits and restores unchanged wallpaper', async (t) => {
  const setup = companionFixture(t);
  const settings = path.join(setup.server, 'data', 'default-user', 'settings.json');
  const theme = path.join(setup.server, 'data', 'default-user', 'themes', 'SC Bordeaux.json');
  const wallpaper = path.join(setup.server, 'data', 'default-user', 'backgrounds', 'sillyclient-bg-8k.jpg');
  for (const file of [settings, theme, wallpaper]) fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(settings, '{"power_user":{},"background":{},"preserve":"user setting"}');
  fs.writeFileSync(theme, 'original user theme');
  fs.writeFileSync(wallpaper, 'original user wallpaper');
  const transaction = await setup.install();
  const installed = fs.statSync(theme);
  const themeEdit = Buffer.alloc(installed.size, 'X');
  fs.writeFileSync(theme, themeEdit);
  fs.utimesSync(theme, installed.atime, installed.mtime);
  fs.writeFileSync(settings, '{"userChangedAfterStart":true}');
  assert.throws(() => transaction.rollback(), /preserved changed files/);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"userChangedAfterStart":true}');
  assert.deepEqual(fs.readFileSync(theme), themeEdit);
  assert.equal(fs.readFileSync(wallpaper, 'utf8'), 'original user wallpaper');
  assert.ok(!fs.existsSync(path.join(setup.server, '.sillyclient', 'companion-presets', 'sc-bordeaux.json')));
});

test('companion atomic write failure never predeletes existing settings and rolls back earlier writes', async (t) => {
  const failingFs = new Proxy(fs, {
    get: (target, property) => property === 'renameSync'
      ? (from, to) => {
        if (path.basename(to) === 'settings.json') throw Object.assign(new Error('synthetic rename failure'), { code: 'EACCES' });
        return fs.renameSync(from, to);
      }
      : target[property],
  });
  const setup = companionFixture(t, { dataRoot: './data' }, failingFs);
  const settings = path.join(setup.server, 'data', 'default-user', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const original = '{"power_user":{},"background":{},"preserve":"existing settings"}';
  fs.writeFileSync(settings, original);
  await assert.rejects(setup.install(), /synthetic rename failure/);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
  assert.ok(!fs.existsSync(path.join(setup.server, 'data', 'default-user', 'themes', 'SC Bordeaux.json')));
  assert.ok(!fs.existsSync(path.join(setup.server, 'data', 'default-user', 'backgrounds', 'sillyclient-bg-8k.jpg')));
});

test('actual four pinned archives install into a synthetic instance without executing their scripts', async (t) => {
  const root = fixture(t);
  const server = path.join(root, 'server');
  serverFiles(server);
  const catalogPath = path.join(project, 'resources', 'preinstalled-extensions', 'catalog.json');
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const archiveRoot = path.resolve(project, '..', '..', 'Local', 'cache', 'preinstalled-extension-audit');
  if (!catalog.extensions.every((record) => fs.existsSync(path.join(archiveRoot, `${record.id}.zip`)))) {
    t.skip('Optional audited archive cache is not present');
    return;
  }
  const installer = loader({ electron: {} })('src/runtime/preinstalled-extensions.ts');
  const transaction = await installer.installPreselectedExtensions(server, {
    revision: 1, extensionIds: catalog.extensions.map((entry) => entry.id),
  }, {}, {
    catalogPath,
    resolveDataRoot: async () => path.join(server, 'data'),
    download: async (url, destination) => {
      const record = catalog.extensions.find((entry) => url === `https://codeload.github.com/${entry.repository}/zip/${entry.commit}`);
      assert.ok(record);
      await fs.promises.copyFile(path.join(archiveRoot, `${record.id}.zip`), destination);
    },
  });
  assert.deepEqual(transaction.installed, catalog.extensions.map((entry) => entry.id));
  assert.equal(transaction.skipped.length, 0);
  for (const record of catalog.extensions) {
    const installed = path.join(server, 'data', 'default-user', 'extensions', record.repository.split('/')[1]);
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, record.version);
    assert.ok(fs.statSync(path.join(installed, record.licensePath)).size > 0);
  }
  await transaction.rollback();
  assert.ok(!fs.existsSync(path.join(server, 'data')));
});
