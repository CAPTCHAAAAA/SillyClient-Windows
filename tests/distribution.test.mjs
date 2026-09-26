import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDistribution } from '../src/runtime/distribution.ts';

test('production identity is unchanged', () => {
  assert.deepEqual(resolveDistribution({ name: 'sillyclient-windows' }), {
    isTest: false, appId: 'com.sillyclient', productName: 'SillyClient', dataDirectoryName: 'SillyClient',
  });
});

test('migration trial has a separate identity and data directory', () => {
  const trial = resolveDistribution({ name: 'sillyclient-windows-migration-test', sillyClientChannel: 'migration-test' });
  const stable = resolveDistribution({ name: 'sillyclient-windows' });
  assert.equal(trial.isTest, true);
  assert.notEqual(trial.appId, stable.appId);
  assert.notEqual(trial.dataDirectoryName, stable.dataDirectoryName);
  assert.equal(trial.productName, 'SillyClient Migration Test');
});

test('incomplete or unknown distribution metadata never falls back to production data', () => {
  for (const metadata of [
    {}, { name: 'sillyclient-windows-migration-test' },
    { name: 'sillyclient-windows', sillyClientChannel: 'migration-test' },
    { name: 'sillyclient-windows', sillyClientChannel: 'unknown' },
  ]) {
    assert.throws(() => resolveDistribution(metadata), /Unrecognized distribution/);
  }
});
