import assert from 'node:assert/strict';
import { beforeEach, afterEach, test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = process.env.SILLYCLIENT_TEST_HOST_DIST;
const base = process.env.SILLYCLIENT_MIGRATION_TEST_ROOT;
if (!compiled || !base) throw new Error('Set the host build and migration test directories.');

let root, source;
async function put(file, content) {
  const full = path.join(source, file);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

beforeEach(async () => {
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'compat-test-case-'));
  source = path.join(root, 'tavern');
  await fs.mkdir(source, { recursive: true });
});

afterEach(async () => {
  if (path.dirname(root) !== path.resolve(base) || !path.basename(root).startsWith('compat-test-case-')) {
    throw new Error('Unsafe cleanup directory.');
  }
  await fs.rm(root, { recursive: true, force: true });
});

test('empty tavern returns empty report', async () => {
  const { analyzeCompatibility, formatCompatibilitySummary } = require(path.join(compiled, 'runtime/plugin-compatibility.js'));
  const report = await analyzeCompatibility(source);
  assert.equal(report.summary.total, 0);
  assert.match(formatCompatibilitySummary(report), /未检测到第三方扩展/);
});

test('detects native addon dependency with HIGH risk', async () => {
  const { analyzeCompatibility, formatCompatibilitySummary } = require(path.join(compiled, 'runtime/plugin-compatibility.js'));
  await put('plugins/native-plugin/package.json', JSON.stringify({
    name: 'native-plugin',
    main: 'index.js',
    dependencies: { 'better-sqlite3': '^9.0.0' },
  }));
  await put('plugins/native-plugin/index.js', '// code');

  const report = await analyzeCompatibility(source);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.highRisk, 1);
  assert.equal(report.items[0].name, 'native-plugin');
  assert.equal(report.items[0].riskLevel, 'HIGH');
  assert.deepEqual(report.items[0].nativeDependencies, ['better-sqlite3']);
  const summary = formatCompatibilitySummary(report);
  assert.match(summary, /高风险/);
  assert.match(summary, /better-sqlite3/);
});

test('detects missing entry with MEDIUM risk', async () => {
  const { analyzeCompatibility } = require(path.join(compiled, 'runtime/plugin-compatibility.js'));
  await put('plugins/broken-plugin/package.json', JSON.stringify({
    name: 'broken-plugin',
    main: 'non-existent.js',
  }));

  const report = await analyzeCompatibility(source);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.mediumRisk, 1);
  assert.equal(report.items[0].riskLevel, 'MEDIUM');
  assert.equal(report.items[0].entryExists, false);
});

test('healthy third-party extension reports LOW risk', async () => {
  const { analyzeCompatibility, formatCompatibilitySummary } = require(path.join(compiled, 'runtime/plugin-compatibility.js'));
  await put('public/scripts/extensions/third-party/my-ext/manifest.json', '{"name":"my-ext"}');
  await put('public/scripts/extensions/third-party/my-ext/index.js', '// ok');

  const report = await analyzeCompatibility(source);
  assert.equal(report.summary.total, 1);
  assert.equal(report.summary.lowRisk, 1);
  assert.equal(report.items[0].riskLevel, 'LOW');
  assert.match(formatCompatibilitySummary(report), /未发现已知的 Node 22 原生模块兼容隐患/);
});
