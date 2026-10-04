const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 加载编译后的模块
const paths = require('../dist/runtime/paths');
const instanceStore = require('../dist/runtime/instances');
const relocate = require('../dist/runtime/relocate');

test('relocateInstance rejects running instance', async () => {
  await assert.rejects(
    async () => {
      await relocate.relocateInstance({ instanceId: 'test-inst-1' }, 'test-inst-1');
    },
    { message: /实例正在运行中/ }
  );
});

test('relocateInstance moves files and updates registry', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-relocate-test-'));
  const sourceDir = path.join(tmpRoot, 'source-inst');
  const targetDir = path.join(tmpRoot, 'target-inst');

  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ name: 'test-inst', version: '1.12.0' }), 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'server.js'), 'console.log("hello");', 'utf-8');
  fs.mkdirSync(path.join(sourceDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'data', 'chat.json'), '{"history":[]}', 'utf-8');

  // 登记实例
  const instanceId = 'test-unit-relocate';
  instanceStore.registerInstance(instanceId, sourceDir);

  // 执行迁移
  const result = await relocate.relocateInstance({
    instanceId,
    targetPath: targetDir,
  });

  assert.equal(result.success, true);
  assert.equal(result.instanceId, instanceId);
  assert.equal(result.oldPath.toLowerCase(), sourceDir.toLowerCase());
  assert.equal(result.newPath.toLowerCase(), targetDir.toLowerCase());

  // 验证源目录已被清理，目标目录完整保留
  assert.equal(fs.existsSync(sourceDir), false);
  assert.equal(fs.existsSync(path.join(targetDir, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'server.js')), true);
  assert.equal(fs.existsSync(path.join(targetDir, 'data', 'chat.json')), true);

  // 验证底层注册表已更新
  const record = instanceStore.getInstanceRecord(instanceId);
  assert.ok(record);
  assert.equal(record.path.toLowerCase(), targetDir.toLowerCase());

  // 清理
  instanceStore.removeInstanceRecord(instanceId);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('checkLegacyInstances discovers legacy server candidates', async () => {
  const res = await relocate.checkLegacyInstances();
  assert.ok(Array.isArray(res.instances));
});
