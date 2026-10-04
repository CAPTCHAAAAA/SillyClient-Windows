import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as paths from './paths';
import * as instanceStore from './instances';

export interface RenameInstanceOptions {
  instanceId: string;
  newName: string;
  installPath?: string;
}

export interface RenameInstanceResult {
  success: boolean;
  oldId: string;
  newId: string;
  oldPath: string;
  newPath: string;
}

/**
 * 重命名实例并同步修改底层物理存储文件夹与注册表
 *
 * 核心规则：
 * 1. 运行态严密防护：如果实例正在运行，拒绝重命名；
 * 2. 同盘同父目录原子重命名：保持在原父目录，仅修改末级文件夹名；
 * 3. 目录冲突校验：如目标文件夹已存在则阻断；
 * 4. 注册表原子同步：移除旧 ID，写入新 ID 与新路径；
 * 5. 支持 Windows 大小写重命名（经中间安全缓冲目录过渡）。
 */
export async function renameInstance(
  options: RenameInstanceOptions,
  activeRunningInstanceId?: string | null,
): Promise<RenameInstanceResult> {
  const safeOldId = paths.normalizeInstanceId(options.instanceId);
  const trimmedNewName = (options.newName || '').trim();

  if (!trimmedNewName) {
    throw new Error('实例新名称不能为空');
  }

  const safeNewId = paths.normalizeInstanceId(trimmedNewName);
  if (!safeNewId || safeNewId === '.' || safeNewId === '..') {
    throw new Error('实例新名称不合法');
  }

  // 1. 运行态安全守卫
  if (activeRunningInstanceId && paths.normalizeInstanceId(activeRunningInstanceId) === safeOldId) {
    throw new Error('实例正在运行中，请先停止实例再执行重命名！');
  }

  // 2. 定位当前源目录
  const record = instanceStore.getInstanceRecord(safeOldId);
  let sourcePath = record ? record.path : null;

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    if (options.installPath && fs.existsSync(options.installPath)) {
      sourcePath = options.installPath;
    } else {
      const defaultPath = path.join(paths.appInstancesDir, safeOldId);
      const legacyPath = path.join(paths.legacyServersDir, safeOldId);
      if (fs.existsSync(defaultPath)) {
        sourcePath = defaultPath;
      } else if (fs.existsSync(legacyPath)) {
        sourcePath = legacyPath;
      } else {
        throw new Error(`找不到实例 [${safeOldId}] 的物理存储目录`);
      }
    }
  }

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`源目录不存在: ${resolvedSource}`);
  }

  // 3. 计算新目标文件夹路径（保持在同一个父目录下）
  const parentDir = path.dirname(resolvedSource);
  const newPath = path.join(parentDir, safeNewId);
  const resolvedNewPath = path.resolve(newPath);

  // 4. 执行文件系统重命名
  if (resolvedSource.toLowerCase() === resolvedNewPath.toLowerCase()) {
    if (resolvedSource === resolvedNewPath && safeOldId === safeNewId) {
      // 路径与 ID 完全相同，无需移动文件
      return {
        success: true,
        oldId: safeOldId,
        newId: safeNewId,
        oldPath: resolvedSource,
        newPath: resolvedNewPath,
      };
    }
    // 仅大小写变化：Windows NTFS 不区分大小写，使用临时过渡目录安全重命名
    const tempHolder = path.join(parentDir, `.rename-tmp-${randomUUID()}`);
    await fs.promises.rename(resolvedSource, tempHolder);
    await fs.promises.rename(tempHolder, resolvedNewPath);
  } else {
    // 目标路径不同：检查目标文件夹是否已存在
    if (fs.existsSync(resolvedNewPath)) {
      throw new Error(`目标目录已存在，无法重命名: ${resolvedNewPath}`);
    }
    await fs.promises.rename(resolvedSource, resolvedNewPath);
  }

  // 5. 更新注册表 (instances.json)
  const existingRecord = instanceStore.getInstanceRecord(safeOldId);
  instanceStore.removeInstanceRecord(safeOldId);
  instanceStore.registerInstance(
    safeNewId,
    resolvedNewPath,
    existingRecord?.createdAt,
    existingRecord?.isTakeover,
  );

  return {
    success: true,
    oldId: safeOldId,
    newId: safeNewId,
    oldPath: resolvedSource,
    newPath: resolvedNewPath,
  };
}
