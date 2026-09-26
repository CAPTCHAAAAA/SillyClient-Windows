import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import fs from 'node:fs/promises';
import { rmdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleUrl = process.env.SILLYCLIENT_MIGRATION_MODULE
  ? pathToFileURL(process.env.SILLYCLIENT_MIGRATION_MODULE)
  : new URL('../src/runtime/data-migration.ts', import.meta.url);
const { inspectMigrationSource, copyMigrationData, migrationSummary } = await import(moduleUrl.href);

if (!process.env.SILLYCLIENT_MIGRATION_TEST_ROOT) {
  throw new Error('Set SILLYCLIENT_MIGRATION_TEST_ROOT to a local temporary test directory.');
}
const base = path.resolve(process.env.SILLYCLIENT_MIGRATION_TEST_ROOT);
const cli = process.env.SILLYCLIENT_MIGRATION_CLI
  || fileURLToPath(new URL('../scripts/data-migration.mjs', import.meta.url));
let root;
let source;
let destination;

async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

async function snapshot(directory) {
  const entries = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        entries.push([path.relative(directory, absolute), createHash('sha256').update(await fs.readFile(absolute)).digest('hex')]);
      }
    }
  }
  await walk(directory);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'migration-case-'));
  source = path.join(root, 'old-tavern');
  destination = path.join(root, 'new-data-copy');
  await put(path.join(source, 'package.json'), JSON.stringify({ name: 'sillytavern', version: '1.13.4' }));
  await put(path.join(source, 'server.js'), 'throw new Error("Source code must never be executed by migration");');
  await put(path.join(source, 'config.yaml'), 'dataRoot: ./data\nlisten: true\nbasicAuthUser:\n  password: PRIVATE_CONFIG_TOKEN\n');
  await put(path.join(source, 'data', 'default-user', 'settings.json'), '{"theme":"test"}');
  await put(path.join(source, 'data', 'default-user', 'characters', 'hero.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await put(path.join(source, 'data', 'default-user', 'chats', 'hero', 'chat.jsonl'), '{"user_name":"test"}\n{"mes":"hello"}\n');
  await put(path.join(source, 'data', 'default-user', 'groups', 'group.json'), '{"id":"group","members":["hero.png"]}');
  await put(path.join(source, 'data', 'default-user', 'group chats', 'group.jsonl'), '{"mes":"group hello"}\n');
  await put(path.join(source, 'data', 'default-user', 'worlds', 'lore.json'), '{"entries":{}}');
  await put(path.join(source, 'data', 'default-user', 'secrets.json'), '{"api_key":"PRIVATE_API_TOKEN"}');
  await put(path.join(source, 'data', 'second-user', 'settings.json'), '{"theme":"another"}');
  await put(path.join(source, 'data', '_storage', 'account-record'), '{"handle":"second-user"}');
  await fs.mkdir(path.join(source, 'data', 'default-user', 'backgrounds'));
});

afterEach(async () => {
  if (!root) return;
  const resolved = path.resolve(root);
  if (!resolved.startsWith(`${base}${path.sep}`) || path.dirname(resolved) !== base
      || !path.basename(resolved).startsWith('migration-case-')) {
    throw new Error('Refusing cleanup outside the newly created test directory.');
  }
  await fs.rm(resolved, { recursive: true, force: true });
});

test('inspection recognizes multiple users, retains hidden data, and does not modify the source', async () => {
  const before = await snapshot(source);
  const plan = await inspectMigrationSource(source);
  assert.equal(plan.sourceVersion, '1.13.4');
  assert.deepEqual(plan.users, ['default-user', 'second-user']);
  assert.equal(plan.files.length, 8);
  assert.equal(plan.excluded.length, 1);
  assert.ok(plan.files.some(file => file.relativePath === '_storage/account-record'));
  const summary = JSON.stringify(migrationSummary(plan));
  assert.ok(!summary.includes('PRIVATE_'));
  assert.ok(!summary.includes('chat.jsonl'));
  assert.deepEqual(await snapshot(source), before);
  await assert.rejects(fs.access(destination));
});

test('copy preserves bytes and empty directories, verifies every included file, and never copies code or config', async () => {
  const before = await snapshot(source);
  const result = await copyMigrationData(source, destination, { sourceStopped: true });
  assert.equal(result.status, 'verified-data-copy');
  assert.equal(result.registeredAsInstance, false);
  assert.equal(result.filesCopied, 8);
  const report = JSON.parse(await fs.readFile(result.reportPath, 'utf8'));
  assert.equal(report.files.length, 8);
  assert.equal(report.registeredAsInstance, false);
  for (const file of report.files) {
    const targetBytes = await fs.readFile(path.join(destination, 'data', ...file.relativePath.split('/')));
    assert.equal(createHash('sha256').update(targetBytes).digest('hex'), file.sha256);
    assert.deepEqual(targetBytes, await fs.readFile(path.join(source, 'data', ...file.relativePath.split('/'))));
  }
  assert.ok((await fs.stat(path.join(destination, 'data', 'default-user', 'backgrounds'))).isDirectory());
  for (const excluded of ['server.js', 'config.yaml', 'package.json', '.sillyclient-migration-incomplete']) {
    await assert.rejects(fs.access(path.join(destination, excluded)));
  }
  await assert.rejects(fs.access(path.join(destination, 'data', 'default-user', 'secrets.json')));
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'));
  assert.deepEqual(await snapshot(source), before);
});

test('known secrets require explicit inclusion and never appear in the report', async () => {
  const result = await copyMigrationData(source, destination, { sourceStopped: true, includeSecrets: true });
  assert.equal(result.filesCopied, 9);
  assert.equal(await fs.readFile(path.join(destination, 'data', 'default-user', 'secrets.json'), 'utf8'),
    '{"api_key":"PRIVATE_API_TOKEN"}');
  assert.ok(!(await fs.readFile(result.reportPath, 'utf8')).includes('PRIVATE_API_TOKEN'));
});

test('quoted YAML custom data root with comments is parsed structurally', async () => {
  await fs.rename(path.join(source, 'data'), path.join(source, 'my data'));
  await fs.writeFile(path.join(source, 'config.yaml'), '# custom location\ndataRoot: "./my data" # comment\nlisten: false\n');
  const plan = await inspectMigrationSource(source);
  assert.equal(plan.dataRoot, path.join(source, 'my data'));
  const result = await copyMigrationData(source, destination, { sourceStopped: true });
  assert.equal(result.filesCopied, 8);
});

test('external data root requires consent for inspection and copying', async () => {
  const external = path.join(root, 'external-data');
  await fs.rename(path.join(source, 'data'), external);
  await fs.writeFile(path.join(source, 'config.yaml'), 'dataRoot: ../external-data\n');
  await assert.rejects(inspectMigrationSource(source), { code: 'EXTERNAL_DATA_ROOT' });
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'EXTERNAL_DATA_ROOT' });
  const before = await snapshot(external);
  assert.equal((await inspectMigrationSource(source, { allowExternalData: true })).externalDataRoot, true);
  await copyMigrationData(source, destination, { sourceStopped: true, allowExternalData: true });
  assert.deepEqual(await snapshot(external), before);
});

test('an explicit data root override supports old launcher arguments', async () => {
  await fs.rename(path.join(source, 'data'), path.join(source, 'cli-data'));
  const plan = await inspectMigrationSource(source, { dataRoot: './cli-data' });
  assert.equal(plan.dataRoot, path.join(source, 'cli-data'));
});

test('invalid YAML is rejected without echoing private contents', async () => {
  await fs.writeFile(path.join(source, 'config.yaml'), 'dataRoot: [PRIVATE_CONFIG_TOKEN\n');
  await assert.rejects(inspectMigrationSource(source), error =>
    error.code === 'INVALID_CONFIG' && !error.message.includes('PRIVATE_CONFIG_TOKEN'));
});

test('YAML aliases, duplicate keys, and non-string dataRoot fail closed', async () => {
  for (const yaml of ['path: &root ./data\ndataRoot: *root\n', 'dataRoot: ./data\ndataRoot: ./other\n', 'dataRoot: 42\n']) {
    await fs.writeFile(path.join(source, 'config.yaml'), yaml);
    await assert.rejects(inspectMigrationSource(source), { code: 'INVALID_CONFIG' });
  }
});

test('unrecognized projects and legacy data versions are rejected', async () => {
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"another-project","version":"1.13.4"}');
  await assert.rejects(inspectMigrationSource(source), { code: 'NOT_SILLYTAVERN' });
  for (const version of ['1.11.9', '2.0.0', 'unknown']) {
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'sillytavern', version }));
    await assert.rejects(inspectMigrationSource(source), { code: 'UNSUPPORTED_VERSION' });
  }
});

test('metadata size is bounded and malformed JSON is never echoed', async () => {
  await fs.writeFile(path.join(source, 'package.json'), '{"private":"PRIVATE_JSON_TOKEN"');
  await assert.rejects(inspectMigrationSource(source), error =>
    error.code === 'INVALID_METADATA' && !error.message.includes('PRIVATE_JSON_TOKEN'));
  await fs.writeFile(path.join(source, 'package.json'), ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(inspectMigrationSource(source), { code: 'METADATA_TOO_LARGE' });
});

test('empty or unrecognized data trees cannot be reported as migrated', async () => {
  const empty = path.join(source, 'empty-data');
  await fs.mkdir(empty);
  await assert.rejects(inspectMigrationSource(source, { dataRoot: empty }), { code: 'NO_USER_DATA' });
});

test('copy refuses to run without source-stop confirmation', async () => {
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: false }), { code: 'SOURCE_STOP_REQUIRED' });
  await assert.rejects(fs.access(destination));
});

test('existing destinations, even empty directories, are never overwritten', async () => {
  await fs.mkdir(destination);
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'DESTINATION_EXISTS' });
  await put(path.join(destination, 'keep.txt'), 'keep this');
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'DESTINATION_EXISTS' });
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'keep this');
});

test('source/destination overlap is rejected in both directions', async () => {
  const before = await snapshot(source);
  for (const target of [path.join(source, 'copy'), source, root]) {
    await assert.rejects(copyMigrationData(source, target, { sourceStopped: true }), { code: 'OVERLAPPING_PATHS' });
  }
  assert.deepEqual(await snapshot(source), before);
});

test('dataRoot cannot be the installation or its parent', async () => {
  await assert.rejects(inspectMigrationSource(source, { dataRoot: '.' }), { code: 'INVALID_DATA_ROOT' });
  await assert.rejects(inspectMigrationSource(source, { dataRoot: '..', allowExternalData: true }), { code: 'INVALID_DATA_ROOT' });
});

test('junctions inside source data are rejected without reading or modifying the linked directory', async () => {
  const external = path.join(root, 'outside');
  await put(path.join(external, 'keep.txt'), 'must remain');
  await fs.symlink(external, path.join(source, 'data', 'default-user', 'linked'), 'junction');
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'LINK_NOT_SUPPORTED' });
  assert.equal(await fs.readFile(path.join(external, 'keep.txt'), 'utf8'), 'must remain');
  await assert.rejects(fs.access(destination));
});

test('junction source roots and destination parents are rejected', async () => {
  const linkedSource = path.join(root, 'linked-source');
  await fs.symlink(source, linkedSource, 'junction');
  await assert.rejects(inspectMigrationSource(linkedSource), { code: 'LINK_NOT_SUPPORTED' });
  const parent = path.join(root, 'actual-parent');
  const linkedParent = path.join(root, 'linked-parent');
  await fs.mkdir(parent);
  await fs.symlink(parent, linkedParent, 'junction');
  await assert.rejects(copyMigrationData(source, path.join(linkedParent, 'target'), { sourceStopped: true }),
    { code: 'LINK_NOT_SUPPORTED' });
  assert.deepEqual(await fs.readdir(parent), []);
});

test('insufficient free space prevents creation of the destination', async t => {
  t.mock.method(fs, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'INSUFFICIENT_SPACE' });
  await assert.rejects(fs.access(destination));
});

test('cancellation before and during copying leaves the source intact and removes only the new destination', async () => {
  const before = await snapshot(source);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true, signal: aborted.signal }), { code: 'CANCELLED' });
  const controller = new AbortController();
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true, signal: controller.signal,
    onProgress(progress) { if (progress.completedFiles >= 1) controller.abort(); },
  }), { code: 'CANCELLED' });
  await assert.rejects(fs.access(destination));
  assert.deepEqual(await snapshot(source), before);
});

test('new source files during copying invalidate the copy and trigger cleanup', async () => {
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (progress.phase === 'verifying') {
        writeFileSync(path.join(source, 'data', 'default-user', 'new-file.txt'), 'concurrent write');
      }
    },
  }), { code: 'SOURCE_CHANGED' });
  await assert.rejects(fs.access(destination));
  assert.equal(await fs.readFile(path.join(source, 'data', 'default-user', 'new-file.txt'), 'utf8'), 'concurrent write');
});

test('source configuration changes invalidate the copy', async () => {
  let mutated = false;
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (progress.phase === 'verifying') {
        mutated = true;
        writeFileSync(path.join(source, 'config.yaml'), 'dataRoot: ./data\nlisten: false\n');
      }
    },
  }), { code: 'SOURCE_CHANGED' });
  assert.ok(mutated);
  await assert.rejects(fs.access(destination));
});

test('a source file rewritten before its turn is detected and is not reverted by cleanup', async () => {
  const file = path.join(source, 'data', 'second-user', 'settings.json');
  let mutated = false;
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (!mutated && progress.phase === 'copying' && progress.completedFiles === 1) {
        writeFileSync(file, '{"concurrent":"change"}');
        mutated = true;
      }
    },
  }), { code: 'SOURCE_CHANGED' });
  assert.ok(mutated);
  assert.equal(await fs.readFile(file, 'utf8'), '{"concurrent":"change"}');
  await assert.rejects(fs.access(destination));
});

test('write errors after partial copying clean only the owned destination', async t => {
  const before = await snapshot(source);
  const open = fs.open;
  let writtenFiles = 0;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    if (args[1] === 'wx' && ++writtenFiles === 2) {
      const handle = await open(...args);
      handle.write = async () => { throw Object.assign(new Error('simulated full disk'), { code: 'ENOSPC' }); };
      return handle;
    }
    return await open(...args);
  });
  await assert.rejects(copyMigrationData(source, destination, { sourceStopped: true }), { code: 'INSUFFICIENT_SPACE' });
  mocked.mock.restore();
  assert.equal(writtenFiles, 2);
  await assert.rejects(fs.access(destination));
  assert.deepEqual(await snapshot(source), before);
});

test('partial operating-system writes do not truncate files', async t => {
  const open = fs.open;
  let shortWrites = 0;
  const mocked = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    if (args[1] === 'wx') {
      const write = handle.write.bind(handle);
      handle.write = async (buffer, offset, length, position) => {
        shortWrites += 1;
        return await write(buffer, offset, Math.min(length, 3), position);
      };
    }
    return handle;
  });
  const result = await copyMigrationData(source, destination, { sourceStopped: true });
  mocked.mock.restore();
  assert.ok(shortWrites > result.filesCopied);
  assert.equal(await fs.readFile(path.join(destination, 'data', 'default-user', 'settings.json'), 'utf8'), '{"theme":"test"}');
});

test('destination tampering is caught by the final checksum pass', async () => {
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (progress.phase === 'verifying') {
        writeFileSync(path.join(destination, 'data', 'default-user', 'settings.json'), '{"tampered":true}');
      }
    },
  }), { code: 'VERIFY_FAILED' });
  await assert.rejects(fs.access(destination));
});

test('unexpected destination entries prevent a successful result', async () => {
  for (const relative of ['data/default-user/unexpected.txt', 'unexpected.txt']) {
    await assert.rejects(copyMigrationData(source, destination, {
      sourceStopped: true,
      onProgress(progress) {
        if (progress.phase === 'verifying') writeFileSync(path.join(destination, relative), 'unexpected data');
      },
    }), { code: 'VERIFY_FAILED' });
    await assert.rejects(fs.access(destination));
  }
});

test('missing empty destination directories prevent a successful result', async () => {
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (progress.phase === 'verifying') rmdirSync(path.join(destination, 'data', 'default-user', 'backgrounds'));
    },
  }), { code: 'VERIFY_FAILED' });
  await assert.rejects(fs.access(destination));
});

test('cleanup fails closed if destination ownership changes', async () => {
  const controller = new AbortController();
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true, signal: controller.signal,
    onProgress(progress) {
      if (progress.phase === 'copying' && progress.completedFiles === 1) {
        writeFileSync(path.join(destination, '.sillyclient-migration-incomplete'), 'no longer owned');
        controller.abort();
      }
    },
  }), { code: 'CLEANUP_REQUIRED' });
  assert.ok((await fs.stat(destination)).isDirectory());
  assert.equal(await fs.readFile(path.join(destination, '.sillyclient-migration-incomplete'), 'utf8'), 'no longer owned');
});

test('successful completion also requires intact destination ownership', async () => {
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true,
    onProgress(progress) {
      if (progress.phase === 'verifying') {
        writeFileSync(path.join(destination, '.sillyclient-migration-incomplete'), 'ownership changed');
      }
    },
  }), { code: 'CLEANUP_REQUIRED' });
  await assert.rejects(fs.access(path.join(destination, 'migration-report.json')));
  assert.ok((await fs.stat(destination)).isDirectory());
});

test('a cleanup permission error is reported without falsely claiming rollback', async t => {
  const before = await snapshot(source);
  const remove = fs.rm;
  const mocked = t.mock.method(fs, 'rm', async (...args) => {
    if (args[0] === destination) throw Object.assign(new Error('simulated access denied'), { code: 'EACCES' });
    return await remove(...args);
  });
  const controller = new AbortController();
  await assert.rejects(copyMigrationData(source, destination, {
    sourceStopped: true, signal: controller.signal,
    onProgress(progress) { if (progress.completedFiles === 1) controller.abort(); },
  }), { code: 'CLEANUP_REQUIRED' });
  mocked.mock.restore();
  assert.ok((await fs.stat(destination)).isDirectory());
  assert.deepEqual(await snapshot(source), before);
});

test('extension code and dependency trees are explicitly excluded', async () => {
  await put(path.join(source, 'data', 'default-user', 'extensions', 'third-party', 'index.js'), 'doNotExecute();');
  await put(path.join(source, 'data', 'default-user', 'node_modules', 'package', 'index.js'), 'doNotCopy();');
  await put(path.join(source, 'public', 'scripts', 'extensions', 'third-party', 'plugin.js'), 'doNotCopy();');
  const plan = await inspectMigrationSource(source);
  assert.equal(migrationSummary(plan).excluded.extensionDirectories, 1);
  assert.equal(migrationSummary(plan).excluded.runtimeDirectories, 1);
  assert.ok(plan.warnings.some(warning => warning.includes('Global third-party')));
  await copyMigrationData(source, destination, { sourceStopped: true });
  await assert.rejects(fs.access(path.join(destination, 'data', 'default-user', 'extensions')));
  await assert.rejects(fs.access(path.join(destination, 'public')));
});

test('large files are copied without truncation across multiple buffers', async () => {
  const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
  await put(path.join(source, 'data', 'default-user', 'backgrounds', 'large.bin'), bytes);
  const result = await copyMigrationData(source, destination, { sourceStopped: true });
  assert.deepEqual(await fs.readFile(path.join(destination, 'data', 'default-user', 'backgrounds', 'large.bin')), bytes);
  assert.equal(result.filesCopied, 9);
});

test('Unicode, spaces, dotfiles and zero-byte data survive copying', async () => {
  const relative = 'default-user/chats/\u89d2\u8272 name/\u7a7a\u767d.jsonl';
  await put(path.join(source, 'data', relative), '');
  await put(path.join(source, 'data', 'default-user', '.hidden'), 'hidden data');
  const result = await copyMigrationData(source, destination, { sourceStopped: true });
  assert.equal(result.filesCopied, 10);
  assert.equal((await fs.stat(path.join(destination, 'data', relative))).size, 0);
  assert.equal(await fs.readFile(path.join(destination, 'data', 'default-user', '.hidden'), 'utf8'), 'hidden data');
});

test('CLI inspect and copy use the same engine without echoing source contents', async () => {
  const before = await snapshot(source);
  const inspected = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'inspect', source], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).files, 8);
  assert.ok(!inspected.stdout.includes('PRIVATE_'));
  const rejected = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'copy', source, destination], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.ok(rejected.stderr.includes('SOURCE_STOP_REQUIRED'));
  const copied = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'copy', source, destination, '--source-stopped'], { encoding: 'utf8' });
  assert.equal(copied.status, 0, copied.stderr);
  assert.equal(JSON.parse(copied.stdout).registeredAsInstance, false);
  assert.deepEqual(await snapshot(source), before);
});
