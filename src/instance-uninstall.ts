/**
 * 实例彻底卸载与附属文件清理业务服务
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as utils from './runtime/utils';
import * as instanceStore from './runtime/instances';
import { assertPlainPath } from './runtime/cleanup';
import { directorySize, invalidateDirectorySize } from './runtime/directory-stats';
import { removeInstancePassword } from './runtime/instance-lock';
import { resolveInstanceDir } from './instance-query';
import type {
  UninstallInstanceParams,
  UninstallInstanceResult,
} from './contracts/ipc-contracts';

export async function uninstallInstanceInternal(
  opts: UninstallInstanceParams | undefined,
  instanceId: string,
  stopRunningServerIfMatching: (targetDir: string) => Promise<void>,
): Promise<UninstallInstanceResult> {
  const dir = resolveInstanceDir(instanceId, opts?.installPath, opts?.installPathMode);
  const records = instanceStore.listInstanceRecords();
  const record = records.find((entry) => entry.instanceId === instanceId);
  const registeredPath = record?.path;
  const defaultPath = paths.serverDirFor(instanceId);
  const resolvedDir = path.resolve(dir).toLowerCase();
  const isKnownPath = resolvedDir === path.resolve(defaultPath).toLowerCase()
    || (registeredPath && resolvedDir === path.resolve(registeredPath).toLowerCase());
  if (resolvedDir === path.parse(resolvedDir).root.toLowerCase()) {
    throw new Error('Cannot remove a filesystem root');
  }
  if (fs.existsSync(dir) && !isKnownPath) {
    throw new Error('拒绝删除未登记且无法识别的目录');
  }

  const sharedDirectory = records.some((entry) => entry.instanceId !== instanceId
    && path.resolve(entry.path).toLowerCase() === resolvedDir);

  await stopRunningServerIfMatching(dir);
  if (!sharedDirectory) await proc.stopServerForDirectory(dir);

  const isTakeover = record?.isTakeover === true || sharedDirectory;

  let freedBytes = 0;
  if (!isTakeover && fs.existsSync(dir)) {
    await assertPlainPath(dir, true);
    freedBytes = await directorySize(dir, { includeHeavy: true, fresh: true });
    await utils.removeDirWithRetries(dir);
    invalidateDirectorySize(dir);
  }

  const cleanupFailures: string[] = [];
  if (fs.existsSync(paths.coversDir)) {
    for (const entry of fs.readdirSync(paths.coversDir)) {
      const ext = path.extname(entry).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) continue;
      if (path.basename(entry, ext) !== instanceId && !entry.startsWith(`${instanceId}--cover-`)) continue;
      const cover = path.join(paths.coversDir, entry);
      try {
        const stat = await assertPlainPath(cover);
        fs.unlinkSync(cover);
        freedBytes += stat.size;
      } catch (error: any) {
        cleanupFailures.push(`Cover: ${error.message}`);
      }
    }
  }

  const logFile = path.join(paths.logsDir, `${instanceId}.log`);
  if (fs.existsSync(logFile)) {
    try {
      const size = (await assertPlainPath(logFile)).size;
      fs.rmSync(logFile, { force: true });
      freedBytes += size;
    } catch (error: any) {
      cleanupFailures.push(`Log: ${error.message}`);
    }
  }
  const temporaryArchive = path.join(paths.tmpDir, `${instanceId}.zip`);
  if (fs.existsSync(temporaryArchive)) {
    try {
      const size = (await assertPlainPath(temporaryArchive)).size;
      fs.rmSync(temporaryArchive, { force: true });
      freedBytes += size;
    } catch (error: any) {
      cleanupFailures.push(`Archive: ${error.message}`);
    }
  }

  if (!isTakeover && fs.existsSync(dir)) throw new Error(`实例目录未能彻底删除：${dir}`);
  if (cleanupFailures.length) {
    throw new Error(`Instance data removed but auxiliary cleanup failed: ${cleanupFailures.join('; ')}`);
  }
  instanceStore.removeInstanceRecord(instanceId);
  removeInstancePassword(instanceId);

  return { success: true, freedBytes };
}
