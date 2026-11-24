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

test('renameInstance rejects when an active child process holds the directory', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rename-active-'));
  const oldDir = path.join(tmpRoot, 'inst-busy');
  fs.mkdirSync(oldDir, { recursive: true });
  instanceStore.registerInstance('inst-busy', oldDir);

  try {
    await assert.rejects(
      async () => {
        await rename.renameInstance(
          { instanceId: 'inst-busy', newName: 'inst-renamed' },
          null,
          { activeDirectories: [oldDir] },
        );
      },
      { message: /仍有终端或后台进程占用/ },
    );
    assert.equal(fs.existsSync(oldDir), true);
  } finally {
    instanceStore.removeInstanceRecord('inst-busy');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('renameInstance retries transient EPERM and reports clear occupied hint when exhausted', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rename-eperm-'));
  const oldDir = path.join(tmpRoot, 'inst-retry');
  const newDir = path.join(tmpRoot, 'inst-after');
  fs.mkdirSync(oldDir, { recursive: true });
  instanceStore.registerInstance('inst-retry', oldDir);

  try {
    let attempts = 0;
    const res = await rename.renameInstance(
      { instanceId: 'inst-retry', newName: 'inst-after' },
      null,
      {
        retryDelaysMs: [1, 1, 1],
        renameImpl: async (from, to) => {
          attempts += 1;
          if (attempts < 3) {
            const err = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
            err.code = 'EPERM';
            throw err;
          }
          await fs.promises.rename(from, to);
        },
      },
    );
    assert.equal(res.success, true);
    assert.equal(attempts, 3);
    assert.equal(fs.existsSync(newDir), true);

    await assert.rejects(
      async () => {
        await rename.renameInstance(
          { instanceId: 'inst-after', newName: 'inst-locked' },
          null,
          {
            retryDelaysMs: [1, 1],
            renameImpl: async () => {
              const err = new Error('EPERM: locked');
              err.code = 'EPERM';
              throw err;
            },
          },
        );
      },
      (err) => err.code === 'EPERM' && /无法重命名实例目录（EPERM）/.test(err.message) && /占用/.test(err.message),
    );
  } finally {
    instanceStore.removeInstanceRecord('inst-retry');
    instanceStore.removeInstanceRecord('inst-after');
    instanceStore.removeInstanceRecord('inst-locked');
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
