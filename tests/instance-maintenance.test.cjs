const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash, randomUUID } = require('node:crypto');
const ts = require('typescript');

const project = path.resolve(__dirname, '..');
const temporaryRoot = path.resolve(project, '..', '..', 'Local', '\u4e34\u65f6');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

function loader(overrides = {}) {
  const modules = new Map();
  function load(file) {
    const filename = path.resolve(project, file);
    if (modules.has(filename)) return modules.get(filename).exports;
    const loaded = new Module(filename, module);
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    modules.set(filename, loaded);
    loaded.require = name => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), `${name}.ts`));
      return Module.createRequire(filename)(name);
    };
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    });
    loaded._compile(output.outputText, filename);
    return loaded.exports;
  }
  return load;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fixture(t, overrides = {}) {
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'windows-maintenance-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${temporaryRoot}${path.sep}windows-maintenance-`));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const instanceId = 'instance-a';
  const directory = path.join(root, 'instances', instanceId);
  const user = path.join(directory, 'data', 'default-user');
  const globalExtensions = path.join(directory, 'public', 'scripts', 'extensions', 'third-party');
  fs.mkdirSync(user, { recursive: true });
  fs.mkdirSync(globalExtensions, { recursive: true });
  const controls = {
    busy: false, now: Date.now(), beforeCommit: undefined,
    dataRoot: path.join(directory, 'data'), takeover: false, shared: false,
    commitDurations: [], resolvingWhileCommitting: false, inCommit: false,
  };
  const { InstanceMaintenanceService } = loader(overrides)('src/runtime/instance-maintenance.ts');
  const service = new InstanceMaintenanceService({
    resolveInstance(id) {
      if (id !== instanceId) throw new Error('Unknown instance');
      return { directory, isTakeover: controls.takeover, shared: controls.shared };
    },
    resolveDataRoot: async () => {
      controls.resolvingWhileCommitting ||= controls.inCommit;
      return controls.dataRoot;
    },
    isBusy: () => controls.busy,
    now: () => controls.now,
    commit: async work => {
      if (controls.beforeCommit) await controls.beforeCommit();
      controls.inCommit = true;
      const started = performance.now();
      try { return await work(); }
      finally {
        controls.commitDurations.push(performance.now() - started);
        controls.inCommit = false;
      }
    },
  });
  const broken = (name = 'incomplete', global = false) => {
    const target = path.join(global ? globalExtensions : path.join(user, 'extensions'), name);
    write(path.join(target, 'README.md'), 'synthetic incomplete extension');
    return target;
  };
  const settings = (disabled = ['third-party/missing-a', 'third-party/missing-b', 'builtin']) => {
    const file = path.join(user, 'settings.json');
    write(file, JSON.stringify({
      extension_settings: { disabledExtensions: disabled, customSettings: { preserve: true } },
      selectedCharacter: 'synthetic-character', unrelated: { value: 42 },
    }, null, 4));
    return file;
  };
  const cache = () => {
    const target = path.join(directory, '.sillyclient-maintenance', 'download-cache', randomUUID());
    const bytes = Buffer.from('synthetic archive');
    write(path.join(target, 'download.zip'), bytes);
    write(path.join(target, 'owner.json'), JSON.stringify({
      revision: 1, owner: 'sillyclient', instanceId, payload: 'download.zip', sizeBytes: bytes.length, sha256: sha(bytes),
    }));
    const date = new Date(controls.now - 2 * 24 * 60 * 60_000);
    fs.utimesSync(path.join(target, 'download.zip'), date, date);
    fs.utimesSync(path.join(target, 'owner.json'), date, date);
    fs.utimesSync(target, date, date);
    return target;
  };
  const apply = (scan, items = scan.items) => service.apply(instanceId, scan.scanId,
    items.map(({ id, token }) => ({ id, token })));
  return { root, directory, user, globalExtensions, instanceId, controls, service, broken, settings, cache, apply };
}

test('scan preserves healthy extensions without git and optional or relative entry declarations', async t => {
  const f = fixture(t);
  write(path.join(f.user, 'extensions', 'healthy', 'manifest.json'), '{"js":"./index.js","css":"dist/main.css"}');
  write(path.join(f.user, 'extensions', 'healthy', 'index.js'), '// valid');
  write(path.join(f.user, 'extensions', 'healthy', 'dist', 'main.css'), 'body {}');
  write(path.join(f.globalExtensions, 'optional', 'manifest.json'), '{"name":"Optional"}');
  write(path.join(f.user, 'chats', 'important.jsonl'), 'synthetic chat');
  write(path.join(f.user, 'characters', 'important.png'), 'synthetic character');
  write(path.join(f.user, 'secrets.json'), 'synthetic credentials');
  const scan = await f.service.scan(f.instanceId);
  assert.deepEqual(scan.items, []);
  for (const name of ['chats/important.jsonl', 'characters/important.png', 'secrets.json']) {
    assert.ok(fs.existsSync(path.join(f.user, name)));
  }
});

test('scan scopes all ordinary users and global extensions with suspected items unselected', async t => {
  const f = fixture(t);
  f.broken('global-broken', true);
  f.broken('user-broken');
  write(path.join(f.directory, 'data', 'another-user', 'extensions', 'missing-entry', 'manifest.json'), '{"js":"missing.js"}');
  const scan = await f.service.scan(f.instanceId);
  assert.equal(scan.items.length, 3);
  assert.ok(scan.items.every(item => item.kind === 'broken_extension' && !item.defaultSelected && item.confidence === 'suspected'));
});

test('only exactly owned old download caches are selected and unknown ZIPs remain', async t => {
  const f = fixture(t);
  const owned = f.cache();
  const unknown = path.join(f.directory, '.sillyclient-maintenance', 'download-cache', randomUUID());
  write(path.join(unknown, 'download.zip'), 'unknown archive');
  write(path.join(f.directory, 'tmp', 'unknown.zip'), 'unknown');
  const fresh = f.cache();
  fs.utimesSync(path.join(fresh, 'download.zip'), new Date(f.controls.now), new Date(f.controls.now));
  const scan = await f.service.scan(f.instanceId);
  assert.equal(scan.items.length, 1);
  assert.equal(scan.items[0].relativePath, path.relative(f.directory, owned).replace(/\\/g, '/'));
  assert.equal(scan.items[0].defaultSelected, true);
  const result = await f.apply(scan);
  assert.equal(result.freedBytes, 0);
  assert.ok(result.quarantinedBytes > 0);
  assert.equal(fs.existsSync(owned), false);
  assert.ok(fs.existsSync(path.join(unknown, 'download.zip')));
  assert.ok(fs.existsSync(path.join(f.directory, 'tmp', 'unknown.zip')));
});

test('extension quarantine and one-use recovery restore exact bytes without deleting user data', async t => {
  const f = fixture(t);
  const target = f.broken();
  const original = fs.readFileSync(path.join(target, 'README.md'));
  const result = await f.apply(await f.service.scan(f.instanceId));
  assert.equal(result.success, true);
  assert.equal(result.freedBytes, 0);
  const list = await f.service.listRecovery(f.instanceId);
  assert.equal(list.items.length, 1);
  const recovery = list.items[0];
  assert.equal(recovery.canRestore, true);
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, true);
  assert.deepEqual(fs.readFileSync(path.join(target, 'README.md')), original);
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, false);
  assert.deepEqual((await f.service.listRecovery(f.instanceId)).items, []);
});

test('stale references are exact opt-in removals, grouped per settings file, with byte-exact undo', async t => {
  const f = fixture(t);
  f.broken('installed');
  const settings = f.settings(['third-party/missing-a', 'third-party/missing-b', 'third-party/installed', 'builtin', '../unsafe']);
  const original = fs.readFileSync(settings);
  const scan = await f.service.scan(f.instanceId);
  const refs = scan.items.filter(item => item.kind === 'stale_extension_reference');
  assert.equal(refs.length, 2);
  assert.ok(refs.every(item => !item.defaultSelected));
  const result = await f.apply(scan, refs);
  assert.equal(result.recoveryIds.length, 1);
  const output = JSON.parse(fs.readFileSync(settings));
  assert.deepEqual(output.extension_settings.disabledExtensions, ['third-party/installed', 'builtin', '../unsafe']);
  assert.deepEqual(output.unrelated, { value: 42 });
  assert.deepEqual(output.extension_settings.customSettings, { preserve: true });
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, true);
  assert.deepEqual(fs.readFileSync(settings), original);
});

test('settings edited after maintenance disable restoration and remain unchanged', async t => {
  const f = fixture(t);
  const file = f.settings();
  await f.apply(await f.service.scan(f.instanceId));
  fs.appendFileSync(file, ' ');
  const changed = fs.readFileSync(file);
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, false);
  assert.match(recovery.conflict, /设置/);
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, false);
  assert.deepEqual(fs.readFileSync(file), changed);
});

test('a same-name extension blocks restore without overwriting either copy', async t => {
  const f = fixture(t);
  const target = f.broken();
  await f.apply(await f.service.scan(f.instanceId));
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  write(path.join(target, 'new.txt'), 'new user extension');
  const result = await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token);
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new user extension');
  assert.ok(fs.existsSync(path.join(f.directory, '.sillyclient-maintenance', 'recovery', recovery.recoveryId, 'payload', 'README.md')));
});

test('concurrent apply cannot replay a capability while first inspection is awaiting', async t => {
  const f = fixture(t);
  f.broken();
  const scan = await f.service.scan(f.instanceId);
  const results = await Promise.allSettled([f.apply(scan), f.apply(scan)]);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.success).length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
});

test('expired scans, foreign tokens, duplicate tokens, and wrong instance are refused', async t => {
  const f = fixture(t);
  f.broken();
  const scan = await f.service.scan(f.instanceId);
  await assert.rejects(f.service.apply(f.instanceId, scan.scanId, [{ id: scan.items[0].id, token: 'foreign' }]));
  await assert.rejects(f.apply(scan, [scan.items[0], scan.items[0]]));
  await assert.rejects(f.service.apply('instance-b', scan.scanId, [{ id: scan.items[0].id, token: scan.items[0].token }]));
  f.controls.now = scan.expiresAt;
  await assert.rejects(f.apply(scan));
});

test('expired or wrong-scope recovery tokens preserve quarantine contents', async t => {
  const f = fixture(t);
  f.broken();
  await f.apply(await f.service.scan(f.instanceId));
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal((await f.service.restore('other', recovery.recoveryId, recovery.token)).success, false);
  f.controls.now += 5 * 60_000;
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, false);
});

test('busy, takeover, shared, and custom dataRoot fail closed', async t => {
  const f = fixture(t);
  for (const key of ['busy', 'takeover', 'shared']) {
    f.controls[key] = true;
    await assert.rejects(f.service.scan(f.instanceId));
    f.controls[key] = false;
  }
  f.controls.dataRoot = path.join(f.root, 'custom-data');
  await assert.rejects(f.service.scan(f.instanceId));
});

test('whole-batch preflight preserves every item if any item changed since scan', async t => {
  const f = fixture(t);
  const changed = f.broken('changed');
  f.broken('unchanged');
  const scan = await f.service.scan(f.instanceId);
  fs.appendFileSync(path.join(changed, 'README.md'), ' user edit');
  await assert.rejects(f.apply(scan));
  assert.ok(fs.existsSync(changed));
  assert.ok(fs.existsSync(path.join(f.user, 'extensions', 'unchanged')));
  assert.deepEqual((await f.service.listRecovery(f.instanceId)).items, []);
});

test('nested content changed immediately before commit is not quarantined', async t => {
  const f = fixture(t);
  const target = f.broken();
  write(path.join(target, 'nested', 'user.txt'), 'first');
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => fs.appendFileSync(path.join(target, 'nested', 'user.txt'), ' new');
  const result = await f.apply(scan);
  assert.equal(result.success, false);
  assert.ok(fs.existsSync(target));
  assert.equal(fs.readFileSync(path.join(target, 'nested', 'user.txt'), 'utf8'), 'first new');
});

test('settings changed immediately before publication are not overwritten', async t => {
  const f = fixture(t);
  const file = f.settings();
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => fs.appendFileSync(file, '  ');
  const result = await f.apply(scan);
  assert.equal(result.success, false);
  assert.ok(fs.readFileSync(file, 'utf8').endsWith('  '));
});

test('newly installed extensions protect their previous disabled reference', async t => {
  const f = fixture(t);
  const file = f.settings(['third-party/missing-a']);
  const original = fs.readFileSync(file);
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => write(path.join(f.user, 'extensions', 'missing-a', 'manifest.json'), '{}');
  assert.equal((await f.apply(scan)).success, false);
  assert.deepEqual(fs.readFileSync(file), original);
});

test('lifecycle invalidation during inspection cancels final publication', async t => {
  const f = fixture(t);
  const target = f.broken();
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => f.service.invalidate();
  assert.equal((await f.apply(scan)).success, false);
  assert.ok(fs.existsSync(target));
});

test('dataRoot changes during commit prevent old-scope mutation', async t => {
  const f = fixture(t);
  const target = f.broken();
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => {
    f.controls.dataRoot = path.join(f.root, 'changed-root');
    write(path.join(f.directory, 'config.yaml'), 'dataRoot: ../changed-root\n');
  };
  assert.equal((await f.apply(scan)).success, false);
  assert.ok(fs.existsSync(target));
});

test('recovery payload and record tampering after listing are refused', async t => {
  for (const target of ['payload', 'record']) {
    const f = fixture(t);
    f.broken();
    await f.apply(await f.service.scan(f.instanceId));
    const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
    const folder = path.join(f.directory, '.sillyclient-maintenance', 'recovery', recovery.recoveryId);
    fs.appendFileSync(target === 'payload' ? path.join(folder, 'payload', 'README.md') : path.join(folder, 'record.json'), ' ');
    assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, false);
  }
});

test('settings backup modified before listing is visible but not restorable', async t => {
  const f = fixture(t);
  f.settings();
  await f.apply(await f.service.scan(f.instanceId));
  const [first] = (await f.service.listRecovery(f.instanceId)).items;
  const backup = path.join(f.directory, '.sillyclient-maintenance', 'recovery', first.recoveryId, 'payload');
  fs.appendFileSync(backup, ' ');
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, false);
  assert.match(recovery.conflict, /备份/);
});

test('missing recovery payload stays visible as unavailable instead of disappearing', async t => {
  const f = fixture(t);
  f.broken();
  await f.apply(await f.service.scan(f.instanceId));
  const [first] = (await f.service.listRecovery(f.instanceId)).items;
  const payload = path.resolve(f.directory, '.sillyclient-maintenance', 'recovery', first.recoveryId, 'payload');
  assert.ok(payload.startsWith(`${f.directory}${path.sep}.sillyclient-maintenance${path.sep}recovery${path.sep}`));
  fs.rmSync(payload, { recursive: true });
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, false);
  assert.match(recovery.conflict, /不可用/);
});

test('native Windows directory rename refuses a same-name destination appearing during rename',
  { skip: process.platform !== 'win32' }, async t => {
    let intercept;
    const wrappedFs = {
      ...fs,
      promises: { ...fs.promises, rename: async (from, to) => {
        if (intercept) await intercept(from, to);
        return fs.promises.rename(from, to);
      } },
    };
    const f = fixture(t, { 'node:fs': wrappedFs });
    const target = f.broken();
    await f.apply(await f.service.scan(f.instanceId));
    const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
    intercept = (_from, to) => {
      if (to === target) fs.mkdirSync(target);
    };
    assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, false);
    assert.deepEqual(fs.readdirSync(target), []);
    assert.ok(fs.existsSync(path.join(f.directory, '.sillyclient-maintenance', 'recovery', recovery.recoveryId, 'payload')));
  });

test('linked extension directories and linked ancestors never expose an outside candidate', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  write(path.join(outside, 'important.txt'), 'preserve');
  try { fs.symlinkSync(outside, path.join(f.globalExtensions, 'linked'), 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host does not permit junction fixtures'); return; }
    throw error;
  }
  assert.deepEqual((await f.service.scan(f.instanceId)).items, []);
  assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'preserve');
});

test('late commit failure preserves one item while other preflighted items can succeed', async t => {
  const f = fixture(t);
  const changed = f.broken('changed');
  const unchanged = f.broken('unchanged');
  const scan = await f.service.scan(f.instanceId);
  f.controls.beforeCommit = () => {
    if (fs.existsSync(changed)) fs.appendFileSync(path.join(changed, 'README.md'), ' later edit');
  };
  const result = await f.apply(scan);
  assert.equal(result.success, false);
  assert.equal(result.results.filter(item => item.success).length, 1);
  assert.equal(result.results.filter(item => !item.success).length, 1);
  assert.ok(fs.existsSync(changed));
  assert.equal(fs.existsSync(unchanged), false);
  assert.equal(result.recoveryIds.length, 1);
});

test('near-budget trees use bounded batched metadata and never launch configuration parsing inside commit', async t => {
  const f = fixture(t);
  const target = f.broken();
  for (let index = 0; index < 2600; index++) write(path.join(target, `file-${index}.txt`), 'x');
  const scan = await f.service.scan(f.instanceId);
  assert.equal(scan.items.length, 1);
  const started = performance.now();
  const result = await f.apply(scan);
  assert.equal(result.success, true);
  assert.equal(f.controls.resolvingWhileCommitting, false);
  assert.equal(f.controls.commitDurations.length, 1);
  t.diagnostic(JSON.stringify({ files: 2601, applyMs: performance.now() - started,
    commitMs: f.controls.commitDurations[0] }));
});

test('invalid JSON error results do not include the original settings or backup contents', async t => {
  const f = fixture(t);
  f.settings();
  await f.apply(await f.service.scan(f.instanceId));
  const [first] = (await f.service.listRecovery(f.instanceId)).items;
  const record = path.join(f.directory, '.sillyclient-maintenance', 'recovery', first.recoveryId, 'record.json');
  write(record, '{"synthetic-secret":"do-not-echo" BROKEN}');
  const result = await f.service.restore(f.instanceId, first.recoveryId, first.token);
  assert.equal(result.success, false);
  assert.equal(result.error.includes('do-not-echo'), false);
});

test('cache ownership marker, payload and directory must all be older than the protection period', async t => {
  const f = fixture(t);
  const old = f.cache();
  for (const component of ['owner.json', 'download.zip', '.']) {
    const target = f.cache();
    fs.utimesSync(path.join(target, component), new Date(f.controls.now), new Date(f.controls.now));
  }
  const future = f.cache();
  fs.utimesSync(path.join(future, 'owner.json'), new Date(f.controls.now + 60_000), new Date(f.controls.now + 60_000));
  const scan = await f.service.scan(f.instanceId);
  assert.deepEqual(scan.items.map(item => item.relativePath), [
    path.relative(f.directory, old).replace(/\\/g, '/'),
  ]);
});

test('a nested edit during rename reports failure while safely retaining the actual recoverable bytes', async t => {
  let target;
  const wrappedFs = {
    ...fs,
    promises: { ...fs.promises, rename: async (from, to) => {
      await fs.promises.rename(from, to);
      if (from === target && path.basename(to) === 'payload') {
        fs.appendFileSync(path.join(to, 'README.md'), ' concurrent user edit');
      }
    } },
  };
  const f = fixture(t, { 'node:fs': wrappedFs });
  target = f.broken();
  const original = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
  const result = await f.apply(await f.service.scan(f.instanceId));
  assert.equal(result.success, false);
  assert.equal(result.results[0].success, false);
  assert.equal(result.recoveryIds.length, 1);
  assert.equal(result.quarantinedBytes, Buffer.byteLength(`${original} concurrent user edit`));
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, true);
  assert.equal(recovery.sizeBytes, result.quarantinedBytes);
  const record = JSON.parse(fs.readFileSync(path.join(f.directory, '.sillyclient-maintenance', 'recovery',
    recovery.recoveryId, 'record.json')));
  assert.notEqual(record.snapshot.digest, record.originalSnapshot.digest);
  assert.equal(record.originalSnapshot.sizeBytes, Buffer.byteLength(original));
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, true);
  assert.equal(fs.readFileSync(path.join(target, 'README.md'), 'utf8'), `${original} concurrent user edit`);
});

test('a replaced quarantine directory is never signed as the originally inspected recovery', async t => {
  let target;
  const wrappedFs = {
    ...fs,
    promises: { ...fs.promises, rename: async (from, to) => {
      await fs.promises.rename(from, to);
      if (from === target && path.basename(to) === 'payload') {
        fs.renameSync(to, `${to}.original`);
        write(path.join(to, 'README.md'), 'replacement directory');
      }
    } },
  };
  const f = fixture(t, { 'node:fs': wrappedFs });
  target = f.broken();
  const result = await f.apply(await f.service.scan(f.instanceId));
  assert.equal(result.success, false);
  assert.equal(result.quarantinedBytes, 0);
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, false);
  assert.equal(recovery.token, '');
  const folder = path.join(f.directory, '.sillyclient-maintenance', 'recovery', recovery.recoveryId);
  assert.equal(fs.readFileSync(path.join(folder, 'payload.original', 'README.md'), 'utf8'), 'synthetic incomplete extension');
  assert.equal(fs.readFileSync(path.join(folder, 'payload', 'README.md'), 'utf8'), 'replacement directory');
});

test('post-publication size overflow is visible as unavailable and never receives a restore token', async t => {
  let target;
  const wrappedFs = {
    ...fs,
    promises: { ...fs.promises, rename: async (from, to) => {
      await fs.promises.rename(from, to);
      if (from === target && path.basename(to) === 'payload') {
        const descriptor = fs.openSync(path.join(to, 'large.bin'), 'wx');
        try { fs.writeSync(descriptor, Buffer.from('x'), 0, 1, 32 * 1024 * 1024); }
        finally { fs.closeSync(descriptor); }
      }
    } },
  };
  const f = fixture(t, { 'node:fs': wrappedFs });
  target = f.broken();
  const result = await f.apply(await f.service.scan(f.instanceId));
  assert.equal(result.success, false);
  assert.equal(result.quarantinedBytes, 0);
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal(recovery.canRestore, false);
  assert.equal(recovery.token, '');
  assert.match(recovery.conflict, /无法安全校验/);
});

test('successful restore archives history without deleting the exact settings backup', async t => {
  const f = fixture(t);
  const file = f.settings();
  const original = fs.readFileSync(file);
  await f.apply(await f.service.scan(f.instanceId));
  const [recovery] = (await f.service.listRecovery(f.instanceId)).items;
  assert.equal((await f.service.restore(f.instanceId, recovery.recoveryId, recovery.token)).success, true);
  const active = path.join(f.directory, '.sillyclient-maintenance', 'recovery', recovery.recoveryId);
  const historical = path.join(f.directory, '.sillyclient-maintenance', 'recovery-history', recovery.recoveryId);
  assert.equal(fs.existsSync(active), false);
  assert.deepEqual(fs.readFileSync(path.join(historical, 'payload')), original);
  assert.equal(JSON.parse(fs.readFileSync(path.join(historical, 'record.json'))).state, 'restored');
  fs.renameSync(historical, active);
  assert.deepEqual((await f.service.listRecovery(f.instanceId)).items, []);
  assert.equal(fs.existsSync(active), false);
  assert.deepEqual(fs.readFileSync(path.join(historical, 'payload')), original);
});

test('streamed recovery enumeration returns inspected records with a warning instead of failing on excess entries', async t => {
  let recoveryRoot;
  const wrappedFs = {
    ...fs,
    promises: { ...fs.promises, opendir: async directory => {
      if (directory !== recoveryRoot) return fs.promises.opendir(directory);
      const [active] = await fs.promises.readdir(directory, { withFileTypes: true });
      return {
        async *[Symbol.asyncIterator]() {
          yield active;
          for (let index = 0; index < 8193; index++) {
            yield { name: `unknown-${index}`, isDirectory: () => true };
          }
        },
      };
    } },
  };
  const f = fixture(t, { 'node:fs': wrappedFs });
  f.broken();
  await f.apply(await f.service.scan(f.instanceId));
  recoveryRoot = path.join(f.directory, '.sillyclient-maintenance', 'recovery');
  const result = await f.service.listRecovery(f.instanceId);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].canRestore, true);
  assert.ok(result.warnings.some(warning => warning.includes('安全限额')));
});

test('unpublished prepared placeholders do not hide a later active recovery behind the item limit', async t => {
  let recoveryRoot;
  let activeId;
  const wrappedFs = {
    ...fs,
    promises: { ...fs.promises, opendir: async directory => {
      if (directory !== recoveryRoot) return fs.promises.opendir(directory);
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of entries.filter(value => value.name !== activeId)) yield entry;
          yield entries.find(value => value.name === activeId);
        },
      };
    } },
  };
  const f = fixture(t, { 'node:fs': wrappedFs });
  f.broken();
  const result = await f.apply(await f.service.scan(f.instanceId));
  [activeId] = result.recoveryIds;
  recoveryRoot = path.join(f.directory, '.sillyclient-maintenance', 'recovery');
  const original = JSON.parse(fs.readFileSync(path.join(recoveryRoot, activeId, 'record.json')));
  for (let index = 0; index < 256; index++) {
    const recoveryId = randomUUID();
    write(path.join(recoveryRoot, recoveryId, 'record.json'),
      JSON.stringify({ ...original, recoveryId, state: 'prepared' }));
  }
  const list = await f.service.listRecovery(f.instanceId);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].recoveryId, activeId);
  assert.equal(list.items[0].canRestore, true);
  assert.equal(list.warnings.length, 256);
  assert.equal((await f.service.restore(f.instanceId, activeId, list.items[0].token)).success, true);
});
