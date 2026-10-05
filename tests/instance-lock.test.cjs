const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Point to compiled JS in dist
const {
  setInstancePassword,
  verifyInstancePassword,
  hasInstancePassword,
  clearInstancePassword,
  renameInstancePassword,
  removeInstancePassword,
  listInstancePasswordStatus,
} = require('../dist/runtime/instance-lock');

const { instancePasswordsPath } = require('../dist/runtime/paths');

test('instance-lock unit tests', async (t) => {
  // Backup existing passwords file if any
  let originalContent = null;
  if (fs.existsSync(instancePasswordsPath)) {
    originalContent = fs.readFileSync(instancePasswordsPath, 'utf8');
  }

  t.after(() => {
    if (originalContent !== null) {
      fs.writeFileSync(instancePasswordsPath, originalContent, 'utf8');
    } else if (fs.existsSync(instancePasswordsPath)) {
      fs.rmSync(instancePasswordsPath, { force: true });
    }
  });

  const testId = `test-inst-${Date.now()}`;
  const testId2 = `${testId}-renamed`;

  await t.test('hasInstancePassword returns false for non-existent instance', () => {
    assert.equal(hasInstancePassword(testId), false);
    assert.equal(verifyInstancePassword(testId, 'any-pass'), true); // No password set = allowed
  });

  await t.test('setInstancePassword sets new password', () => {
    const res = setInstancePassword(testId, 'secret123');
    assert.equal(res.success, true);
    assert.equal(res.hasPassword, true);
    assert.equal(hasInstancePassword(testId), true);
  });

  await t.test('verifyInstancePassword verifies password correctly', () => {
    assert.equal(verifyInstancePassword(testId, 'secret123'), true);
    assert.equal(verifyInstancePassword(testId, 'wrongpass'), false);
    assert.equal(verifyInstancePassword(testId, ''), false);
  });

  await t.test('setInstancePassword requires correct old password when updating', () => {
    assert.throws(() => {
      setInstancePassword(testId, 'newsecret456', 'wrongold');
    }, /原访问密码错误/);

    const res = setInstancePassword(testId, 'newsecret456', 'secret123');
    assert.equal(res.success, true);
    assert.equal(verifyInstancePassword(testId, 'newsecret456'), true);
    assert.equal(verifyInstancePassword(testId, 'secret123'), false);
  });

  await t.test('renameInstancePassword moves password to new id', () => {
    renameInstancePassword(testId, testId2);
    assert.equal(hasInstancePassword(testId), false);
    assert.equal(hasInstancePassword(testId2), true);
    assert.equal(verifyInstancePassword(testId2, 'newsecret456'), true);
  });

  await t.test('listInstancePasswordStatus lists active passwords', () => {
    const status = listInstancePasswordStatus();
    assert.equal(status[testId2], true);
  });

  await t.test('clearInstancePassword clears password with old password verification', () => {
    assert.throws(() => {
      clearInstancePassword(testId2, 'wrongpass');
    }, /原访问密码错误/);

    const res = clearInstancePassword(testId2, 'newsecret456');
    assert.equal(res.success, true);
    assert.equal(hasInstancePassword(testId2), false);
  });

  await t.test('removeInstancePassword cleans up cleanly', () => {
    setInstancePassword(testId, 'pwd999');
    assert.equal(hasInstancePassword(testId), true);
    removeInstancePassword(testId);
    assert.equal(hasInstancePassword(testId), false);
  });
});
