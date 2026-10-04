const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 加载编译后的模块 (测试前需 npm run build)
const paths = require('../dist/runtime/paths');
const instanceStore = require('../dist/runtime/instances');
const rename = require('../dist/runtime/rename');

test('renameInstance rejects running instance', async () => {
  await assert.rejects(
    async () => {
      await rename.renameInstance({ instanceId: 'test-inst-1', newName: 'test-inst-2' }, 'test-inst-1');
    },
    { message: /实例正在运行中/ }
  );
});

test('renameInstance renames folder on disk and updates registry', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rename-test-'));
  const oldDir = path.join(tmpRoot, 'old-folder');
  const newDir = path.join(tmpRoot, 'new-folder');

  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'package.json'), JSON.stringify({ name: 'old-inst' }), 'utf-8');
  fs.writeFileSync(path.join(oldDir, 'server.js'), 'console.log("running");', 'utf-8');

  const oldId = 'old-folder';
  instanceStore.registerInstance(oldId, oldDir);

  const res = await rename.renameInstance({
    instanceId: oldId,
    newName: 'new-folder',
  });

  assert.equal(res.success, true);
  assert.equal(res.oldId, 'old-folder');
  assert.equal(res.newId, 'new-folder');
  assert.equal(res.newPath.toLowerCase(), newDir.toLowerCase());

  // 验证磁盘上的老文件夹已不存在，新文件夹完整存在
  assert.equal(fs.existsSync(oldDir), false);
  assert.equal(fs.existsSync(newDir), true);
  assert.equal(fs.existsSync(path.join(newDir, 'package.json')), true);

  // 验证注册表已同步更新
  assert.equal(instanceStore.getInstanceRecord(oldId), null);
  const newRecord = instanceStore.getInstanceRecord('new-folder');
  assert.ok(newRecord);
  assert.equal(newRecord.path.toLowerCase(), newDir.toLowerCase());

  // 清理
  instanceStore.removeInstanceRecord('new-folder');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('renameInstance rejects existing target directory', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rename-test-conflict-'));
  const oldDir = path.join(tmpRoot, 'inst-a');
  const existingDir = path.join(tmpRoot, 'inst-b');

  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(existingDir, { recursive: true });

  instanceStore.registerInstance('inst-a', oldDir);

  await assert.rejects(
    async () => {
      await rename.renameInstance({ instanceId: 'inst-a', newName: 'inst-b' });
    },
    { message: /目标目录已存在/ }
  );

  instanceStore.removeInstanceRecord('inst-a');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
