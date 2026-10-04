const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
const compilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  esModuleInterop: true,
};

function compiledSource(file) {
  const filename = path.join(project, file);
  return ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions, fileName: filename,
  }).outputText;
}

function loadPolicy() {
  const filename = path.join(project, 'src/external-navigation.ts');
  const loaded = new Module(filename, module);
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(compiledSource('src/external-navigation.ts'), filename);
  return loaded.exports;
}

function mainHarness(mode = 'webview') {
  const windows = [];
  const externalCalls = [];
  const authReads = [];
  const intervals = new Set();
  const errors = [];
  const ipc = new Map();
  const app = new EventEmitter();
  const pluginState = { ready: false, url: null, instanceId: null };
  let ready;
  let externalError;
  let externalWaiter;
  Object.assign(app, {
    whenReady: () => ({ then: (callback) => { ready = callback; } }),
    getPath: () => 'C:\\synthetic\\sillyclient-test',
    setAppUserModelId() {},
    commandLine: { appendSwitch() {} },
    quit() {},
  });
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.loads = [];
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '', origin: 'null' },
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler: (handler) => { this.popup = handler; },
        send() {},
        reload() {},
      });
      windows.push(this);
    }
    loadURL(url) {
      this.loads.push(url);
      const parsed = new URL(url);
      Object.assign(this.webContents.mainFrame, {
        url,
        origin: parsed.protocol === 'app:' ? `app://${parsed.host}` : parsed.origin,
      });
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    getPosition() { return [0, 0]; }
    getSize() { return [1280, 800]; }
    show() {}
    focus() {}
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const fakeFs = {
    existsSync: () => false,
    readFileSync: () => JSON.stringify({ contentOpenMode: mode }),
    mkdirSync() {},
    writeFileSync() {},
    rmSync() {},
    renameSync() {},
  };
  const plugin = {
    setMainWindow() {},
    isServerReady: () => pluginState.ready,
    getCurrentUrl: () => pluginState.url,
    getCurrentInstanceId: () => pluginState.instanceId,
    getCurrentOperationId: () => null,
    handle: async () => undefined,
    cleanup: async () => undefined,
  };
  const imports = {
    electron: {
      app,
      BrowserWindow: FakeWindow,
      ipcMain: { handle: (channel, handler) => ipc.set(channel, handler) },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      Menu: { setApplicationMenu() {} },
      shell: { openExternal: async (url) => {
        externalCalls.push(url);
        if (externalError) throw externalError;
        await externalWaiter;
      } },
      session: { fromPartition: () => ({ clearStorageData: async () => undefined }) },
    },
    'node:fs': fakeFs,
    'node:path': path,
    './plugin': plugin,
    './runtime/paths': { getFrontendDistDir: () => null },
    './remote-auth': { loadRemoteBasicAuth: (id) => { authReads.push(id); return null; } },
    './external-navigation': loadPolicy(),
  };
  vm.runInNewContext(compiledSource('src/main.ts'), {
    require: (name) => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected main-process import: ${name}`);
      return imports[name];
    },
    module: { exports: {} },
    exports: {},
    __dirname: path.join(project, 'src'),
    process: { platform: 'win32' },
    URL,
    Buffer,
    Response,
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args) },
    setTimeout: () => Symbol('unused-timeout'),
    setInterval: (callback) => {
      const id = Symbol('interval');
      intervals.add(id);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  }, { timeout: 1000 });
  ready();
  const launcher = windows[0];
  const sender = () => ({
    sender: launcher.webContents, senderFrame: launcher.webContents.mainFrame,
  });
  return {
    windows, externalCalls, authReads, intervals, errors, launcher, pluginState, sender,
    failExternal: (error) => { externalError = error; },
    delayExternal: () => {
      let resolve;
      externalWaiter = new Promise((done) => { resolve = done; });
      return resolve;
    },
    invoke: (method, options, event = sender()) => ipc.get('tarven-env')(event, { method, options }),
  };
}

function navigation(contents, eventName, url, isMainFrame = true) {
  let prevented = false;
  contents.emit(eventName, {
    url, isMainFrame, preventDefault: () => { prevented = true; },
  });
  return prevented;
}

test('HTTP URL policy normalizes valid absolute addresses without changing path, query or hash', () => {
  const { parseHttpUrl } = loadPolicy();
  assert.equal(parseHttpUrl(' HTTPS://Example.COM:443/docs?q=one#two ').href, 'https://example.com/docs?q=one#two');
  assert.equal(parseHttpUrl('http://127.0.0.1:8000/').href, 'http://127.0.0.1:8000/');
  assert.equal(parseHttpUrl('http://[::1]:8000/').href, 'http://[::1]:8000/');
});

test('HTTP URL policy rejects credentials, non-web handlers and ambiguous or malformed addresses', () => {
  const { parseHttpUrl } = loadPolicy();
  for (const value of [
    undefined, null, false, 10, {}, '', '   ', '/docs', '//example.com',
    'javascript:alert(1)', 'data:text/html,test', 'file:///C:/test', 'mailto:test@example.com',
    'app://localhost/', 'https://user@example.com/', 'http://user:password@example.com/',
    'https://example.com:70000/', 'http://', 'http:///example.com', 'https:/example.com',
    'https://example.com\\@attacker.test/', 'https://exa\nmple.com/', 'https://example.com/\0',
  ]) {
    assert.equal(parseHttpUrl(value), null, String(value));
  }
});

test('HTTP URL policy rejects raw empty user-info and literal whitespace before URL normalization', () => {
  const { parseHttpUrl } = loadPolicy();
  for (const value of [
    'https://@example.test/', 'https://:@example.test/', 'http://@example.test/',
    'https://example.test/path space', 'https://example.test/?q=space value',
    'https://example.test/#space mark',
  ]) {
    assert.equal(parseHttpUrl(value), null, value);
  }
  assert.equal(parseHttpUrl('https://example.test/path@here?q=a@b#@here').href,
    'https://example.test/path@here?q=a@b#@here');
  assert.equal(parseHttpUrl('https://example.test/path%20space').href, 'https://example.test/path%20space');
});

test('tavern policy allows same-origin paths and normalized default ports', () => {
  const { decideTavernNavigation } = loadPolicy();
  for (const [base, target] of [
    ['http://example.com/start', 'http://EXAMPLE.com:80/next?q=1#hash'],
    ['https://example.com:443/start', 'https://example.com/next'],
    ['http://[::1]:8000/start', 'http://[::1]:8000/next'],
  ]) {
    assert.deepEqual(decideTavernNavigation(target, base, true), { action: 'allow' });
  }
});

test('tavern policy sends scheme, port and host changes externally and blocks unsafe top-level URLs', () => {
  const { decideTavernNavigation } = loadPolicy();
  for (const target of [
    'https://example.com/next', 'http://example.com:8000/next', 'http://other.test/next',
  ]) {
    assert.deepEqual(decideTavernNavigation(target, 'http://example.com/', true), {
      action: 'external', url: target,
    });
  }
  for (const target of ['file:///C:/test', 'javascript:alert(1)', 'https://user:pw@example.com/']) {
    assert.deepEqual(decideTavernNavigation(target, 'http://example.com/', true), { action: 'block' });
  }
});

test('tavern policy preserves only same-origin blob top-level navigation without external dispatch', () => {
  const { decideTavernNavigation } = loadPolicy();
  for (const [base, target] of [
    ['https://tavern.test/', 'blob:https://tavern.test:443/instance-download'],
    ['http://tavern.test:80/start', 'blob:http://TAVERN.test/instance-download'],
    ['http://[::1]:8000/', 'blob:http://[::1]:8000/instance-download'],
  ]) {
    assert.deepEqual(decideTavernNavigation(target, base, true), { action: 'allow' });
  }
  for (const target of [
    'blob:https://other.test/download', 'blob:https://tavern.test:8000/download',
    'blob:http://tavern.test/download', 'blob:null/download',
    'blob:https://@tavern.test/download', 'blob:https://:@tavern.test/download',
    'blob:https://tavern.test/download space', 'blob:javascript:alert(1)',
    'blob: https://tavern.test/download', 'blob:\thttps://tavern.test/download',
  ]) {
    assert.deepEqual(decideTavernNavigation(target, 'https://tavern.test/', true), { action: 'block' });
  }
});

test('subframe policy is untouched even for cross-origin and non-web URLs', () => {
  const { decideTavernNavigation, decideLauncherNavigation } = loadPolicy();
  for (const target of ['https://other.test/', 'about:blank', 'data:text/html,test']) {
    assert.deepEqual(decideTavernNavigation(target, 'http://example.com/', false), { action: 'allow' });
    assert.deepEqual(decideLauncherNavigation(target, false), { action: 'allow' });
  }
});

test('launcher policy accepts only its exact app scheme, host and port internally', () => {
  const { isLauncherUrl, decideLauncherNavigation } = loadPolicy();
  for (const target of ['app://localhost', 'app://localhost/', 'app://localhost/settings?q=1#hash']) {
    assert.equal(isLauncherUrl(target), true);
    assert.deepEqual(decideLauncherNavigation(target, true), { action: 'allow' });
  }
  for (const target of [
    'app://localhost.evil/', 'app://user@localhost/', 'app://localhost:8000/',
    'file:///C:/test', 'javascript:alert(1)', 'capacitor-file:///C:/test',
  ]) {
    assert.equal(isLauncherUrl(target), false);
    assert.deepEqual(decideLauncherNavigation(target, true), { action: 'block' });
  }
  assert.deepEqual(decideLauncherNavigation('https://example.com/docs', true), {
    action: 'external', url: 'https://example.com/docs',
  });
});

test('launcher URL policy rejects raw empty user-info and invalid whitespace', () => {
  const { isLauncherUrl, decideLauncherNavigation } = loadPolicy();
  for (const value of [
    'app://@localhost/', 'app://:@localhost/', 'app://localhost/path space',
    'app://localhost/?q=space value', 'app://local\nhost/', ' app://localhost/',
  ]) {
    assert.equal(isLauncherUrl(value), false, value);
    assert.deepEqual(decideLauncherNavigation(value, true), { action: 'block' });
  }
  assert.equal(isLauncherUrl('app://localhost/path@here?q=a@b'), true);
});

test('new external IPC accepts only the live launcher main frame and app origin', async () => {
  const harness = mainHarness();
  await harness.invoke('openExternalUrl', { url: 'https://example.com/docs' });
  assert.deepEqual(harness.externalCalls, ['https://example.com/docs']);
  const authorized = harness.sender();
  for (const event of [
    { sender: {}, senderFrame: authorized.senderFrame },
    { sender: authorized.sender, senderFrame: { ...authorized.senderFrame } },
    { sender: authorized.sender, senderFrame: null },
  ]) {
    await assert.rejects(harness.invoke('openExternalUrl', { url: 'https://other.test/' }, event), /launcher|启动器/i);
  }
  const original = { ...authorized.senderFrame };
  for (const url of [
    'app://localhost.evil/', 'app://user@localhost/', 'app://localhost:8000/', 'https://localhost/',
    'app://@localhost/', 'app://:@localhost/', 'app://localhost/path space',
  ]) {
    authorized.senderFrame.url = url;
    await assert.rejects(harness.invoke('openExternalUrl', { url: 'https://other.test/' }), /launcher|启动器/i);
  }
  Object.assign(authorized.senderFrame, original, { origin: 'https://other.test' });
  await assert.rejects(harness.invoke('openExternalUrl', { url: 'https://other.test/' }), /launcher|启动器/i);
  Object.assign(authorized.senderFrame, original);
  harness.launcher.destroy();
  await assert.rejects(harness.invoke('openExternalUrl', { url: 'https://other.test/' }), /launcher|启动器/i);
  assert.deepEqual(harness.externalCalls, ['https://example.com/docs']);
});

test('external IPC rejects unsafe URLs without opening a browser or mutating an active tavern', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'http://127.0.0.1:8000/', instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  const status = await harness.invoke('getStatus');
  for (const url of [
    'javascript:alert(1)', 'file:///C:/test', 'https://user:pw@example.com/', null,
    'https://@example.test/', 'https://:@example.test/', 'https://example.test/path space',
  ]) {
    await assert.rejects(harness.invoke('openExternalUrl', { url }), (error) => {
      assert.match(error.message, /HTTP/i);
      assert.equal(error.message.includes('example.test'), false);
      assert.equal(error.message.includes('user:pw'), false);
      return true;
    });
  }
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(await harness.invoke('getStatus'), status);
  assert.deepEqual(harness.externalCalls, []);
  assert.deepEqual(harness.authReads, ['local-instance']);
});

test('external IPC and identity-free immersive compatibility preserve the current view in both content modes', async () => {
  const harness = mainHarness();
  const initialUrl = 'http://127.0.0.1:8000/';
  await harness.invoke('enterImmersive', { url: initialUrl, instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  for (const mode of ['webview', 'browser']) {
    await harness.invoke('setContentOpenMode', { mode });
    await harness.invoke('openExternalUrl', { url: 'https://example.com/project' });
    await harness.invoke('enterImmersive', { url: 'https://example.com/legacy' });
    assert.equal(tavern.destroyed, false);
    assert.deepEqual(tavern.loads, [initialUrl]);
    assert.equal(harness.windows.length, 2);
  }
  assert.deepEqual(harness.authReads, ['local-instance']);
  assert.deepEqual(harness.externalCalls, [
    'https://example.com/project', 'https://example.com/legacy',
    'https://example.com/project', 'https://example.com/legacy',
  ]);
  await harness.invoke('setContentOpenMode', { mode: 'webview' });
  Object.assign(harness.pluginState, { ready: true, url: 'http://127.0.0.1:9000/', instanceId: 'other-instance' });
  await harness.invoke('returnToTavern');
  assert.deepEqual(harness.windows[2].loads, [initialUrl]);
  assert.deepEqual(harness.authReads, ['local-instance', 'local-instance']);
});

test('immersive validation and browser failures occur before replacing the current view', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://tavern.test/', instanceId: 'current-instance' });
  const tavern = harness.windows[1];
  for (const mode of ['webview', 'browser']) {
    await harness.invoke('setContentOpenMode', { mode });
    for (const url of ['file:///C:/test', 'https://user:pw@other.test/']) {
      await assert.rejects(harness.invoke('enterImmersive', { url, instanceId: 'next-instance' }), /HTTP/i);
      assert.equal(tavern.destroyed, false);
    }
  }
  harness.failExternal(new Error('synthetic browser failure'));
  await assert.rejects(harness.invoke('enterImmersive', {
    url: 'https://other.test/', instanceId: 'next-instance',
  }), /synthetic browser failure/);
  await assert.rejects(harness.invoke('openExternalUrl', { url: 'https://other.test/' }), /synthetic browser failure/);
  await assert.rejects(harness.invoke('enterImmersive', { url: 'https://other.test/' }), /synthetic browser failure/);
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(harness.authReads, ['current-instance']);
});

test('a delayed explicit browser-open request cannot replace a newer tavern view', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://first.test/', instanceId: 'first-instance' });
  await harness.invoke('setContentOpenMode', { mode: 'browser' });
  const release = harness.delayExternal();
  const older = harness.invoke('enterImmersive', { url: 'https://browser.test/', instanceId: 'browser-instance' });
  await harness.invoke('setContentOpenMode', { mode: 'webview' });
  await harness.invoke('enterImmersive', { url: 'https://newer.test/', instanceId: 'newer-instance' });
  const newer = harness.windows[2];
  release();
  await older;
  assert.equal(newer.destroyed, false);
  const status = await harness.invoke('getStatus');
  assert.equal(status.mode, 'tavern');
  assert.equal(status.url, 'https://newer.test/');
  assert.deepEqual(harness.authReads, ['first-instance', 'newer-instance']);
});

test('exit invalidates a delayed explicit browser-open request without restoring its instance identity', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://first.test/', instanceId: 'first-instance' });
  await harness.invoke('setContentOpenMode', { mode: 'browser' });
  const release = harness.delayExternal();
  const older = harness.invoke('enterImmersive', { url: 'https://browser.test/', instanceId: 'browser-instance' });
  await harness.invoke('exitImmersive');
  release();
  await older;
  const status = await harness.invoke('getStatus');
  assert.equal(status.mode, 'launcher');
  assert.equal(status.url, null);
});

test('tavern redirects and page navigation only send cross-origin main frames to the browser', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'http://tavern.test/', instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  assert.equal(tavern.webContents.listenerCount('will-frame-navigate'), 0);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    assert.equal(navigation(tavern.webContents, eventName, 'http://tavern.test:80/next'), false);
    assert.equal(navigation(tavern.webContents, eventName, 'https://external.test/'), true);
    assert.equal(navigation(tavern.webContents, eventName, 'https://external.test/frame', false), false);
    assert.equal(navigation(tavern.webContents, eventName, 'javascript:alert(1)'), true);
    assert.equal(navigation(tavern.webContents, eventName, 'https://user:pw@external.test/'), true);
  }
  assert.deepEqual(harness.externalCalls, ['https://external.test/', 'https://external.test/']);
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(tavern.loads, ['http://tavern.test/']);
});

test('same-origin blob download navigation remains internal and no blob reaches the shell', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://tavern.test/', instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  for (const eventName of ['will-navigate', 'will-redirect']) {
    assert.equal(navigation(tavern.webContents, eventName, 'blob:https://tavern.test:443/download'), false);
    assert.equal(navigation(tavern.webContents, eventName, 'blob:https://other.test/download'), true);
    assert.equal(navigation(tavern.webContents, eventName, 'blob:null/download'), true);
  }
  assert.equal(tavern.popup({ url: 'blob:https://tavern.test/download' }).action, 'deny');
  await assert.rejects(harness.invoke('openExternalUrl', { url: 'blob:https://tavern.test/download' }), /HTTP/i);
  assert.equal(tavern.webContents.listenerCount('will-frame-navigate'), 0);
  assert.equal(tavern.webContents.listenerCount('will-download'), 0);
  assert.deepEqual(harness.externalCalls, []);
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(tavern.loads, ['https://tavern.test/']);
  assert.deepEqual(harness.authReads, ['local-instance']);
});

test('tavern popups always deny new windows and open only valid HTTP pages without replacing the tavern', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://tavern.test/', instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  for (const mode of ['webview', 'browser']) {
    await harness.invoke('setContentOpenMode', { mode });
    for (const url of ['https://external.test/project', 'https://tavern.test/same-origin']) {
      assert.equal(tavern.popup({ url }).action, 'deny');
    }
    for (const url of ['javascript:alert(1)', 'file:///C:/test', 'https://user:pw@external.test/', 'about:blank']) {
      assert.equal(tavern.popup({ url }).action, 'deny');
    }
  }
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(tavern.loads, ['https://tavern.test/']);
  assert.equal(harness.windows.length, 2);
  assert.deepEqual(harness.externalCalls, [
    'https://external.test/project', 'https://tavern.test/same-origin',
    'https://external.test/project', 'https://tavern.test/same-origin',
  ]);
});

test('launcher keeps app navigation internal, denies popups and ignores subframes', () => {
  const harness = mainHarness();
  assert.equal(harness.launcher.webContents.listenerCount('will-frame-navigate'), 0);
  for (const eventName of ['will-navigate', 'will-redirect']) {
    assert.equal(navigation(harness.launcher.webContents, eventName, 'app://localhost/settings'), false);
    assert.equal(navigation(harness.launcher.webContents, eventName, 'https://external.test/'), true);
    assert.equal(navigation(harness.launcher.webContents, eventName, 'https://external.test/frame', false), false);
    assert.equal(navigation(harness.launcher.webContents, eventName, 'app://localhost.evil/'), true);
  }
  assert.equal(harness.launcher.popup({ url: 'https://external.test/popup' }).action, 'deny');
  assert.equal(harness.launcher.popup({ url: 'app://localhost/settings' }).action, 'deny');
  assert.equal(harness.launcher.popup({ url: 'file:///C:/test' }).action, 'deny');
  assert.deepEqual(harness.externalCalls, [
    'https://external.test/', 'https://external.test/', 'https://external.test/popup',
  ]);
  assert.deepEqual(harness.launcher.loads, ['app://localhost/']);
  assert.equal(harness.windows.length, 1);
});

test('navigation and popup browser failures are handled without changing the active view or leaking the target', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://tavern.test/', instanceId: 'local-instance' });
  const tavern = harness.windows[1];
  harness.failExternal(new Error('synthetic failure with sensitive details'));
  assert.equal(navigation(tavern.webContents, 'will-redirect', 'https://external.test/private'), true);
  assert.equal(tavern.popup({ url: 'https://external.test/private' }).action, 'deny');
  await new Promise(setImmediate);
  const navigationErrors = harness.errors.filter((args) => String(args[0]).includes('system browser'));
  assert.equal(navigationErrors.length, 2);
  assert.equal(JSON.stringify(navigationErrors).includes('external.test'), false);
  assert.equal(JSON.stringify(navigationErrors).includes('sensitive'), false);
  assert.equal(tavern.destroyed, false);
  assert.deepEqual(tavern.loads, ['https://tavern.test/']);
});

test('obsolete tavern callbacks cannot clear or restart polling for the new current view', async () => {
  const harness = mainHarness();
  await harness.invoke('enterImmersive', { url: 'https://first.test/', instanceId: 'first-instance' });
  const first = harness.windows[1];
  await harness.invoke('enterImmersive', { url: 'https://second.test/', instanceId: 'second-instance' });
  const second = harness.windows[2];
  first.webContents.emit('did-finish-load');
  first.emit('closed');
  assert.equal(harness.intervals.size, 0);
  const status = await harness.invoke('getStatus');
  assert.equal(status.mode, 'tavern');
  assert.equal(status.url, 'https://second.test/');
  assert.equal(second.destroyed, false);
  second.webContents.emit('did-finish-load');
  assert.equal(harness.intervals.size, 1);
});
