import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as paths from './paths';
import * as instanceStore from './instances';
import { renameInstancePassword } from './instance-lock';
import { invalidateDirectorySize } from './directory-stats';

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

export interface RenameInstanceContext {
  activeDirectories?: string[];
  renameImpl?: (oldPath: string, newPath: string) => Promise<void>;
  retryDelaysMs?: number[];
}

const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DEFAULT_RETRY_DELAYS_MS = [150, 300, 500, 800, 1200];

function isPathOccupiedByActiveProcess(targetDir: string, activeDirectories?: string[]): boolean {
  if (!activeDirectories?.length) return false;
  const normalizedTarget = path.resolve(targetDir).toLowerCase();
  const targetPrefix = normalizedTarget.endsWith(path.sep) ? normalizedTarget : `${normalizedTarget}${path.sep}`;
  return activeDirectories.some((dir) => {
    if (!dir) return false;
    const normalizedActive = path.resolve(dir).toLowerCase();
    return normalizedActive === normalizedTarget || normalizedActive.startsWith(targetPrefix);
  });
}

async function renameWithRetries(
  fromPath: string,
  toPath: string,
  renameImpl: (oldPath: string, newPath: string) => Promise<void>,
  retryDelaysMs: number[],
): Promise<void> {
  const maxAttempts = retryDelaysMs.length + 1;
  let lastError: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await renameImpl(fromPath, toPath);
      return;
    } catch (error: any) {
      lastError = error;
      const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
      if (!RETRYABLE_RENAME_CODES.has(code) || attempt >= retryDelaysMs.length) {
        if (RETRYABLE_RENAME_CODES.has(code)) {
          const wrapped = new Error(
            `无法重命名实例目录（${code}）：目录或其中文件正被其他程序（如文件资源管理器、终端或杀毒软件）占用，请关闭相关窗口后重试`,
          ) as NodeJS.ErrnoException;
          wrapped.code = code;
          throw wrapped;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
  throw lastError;
}

/**
 * 重命名实例并同步修改底层物理存储文件夹与注册表
 *
 * 核心规则：
 * 1. 运行态与目录占用防护：如果实例正在运行或仍有终端/后台进程以该目录为 cwd，拒绝重命名；
 * 2. 同盘同父目录原子重命名（含 Windows 句柄释放退避重试）：保持在原父目录，仅修改末级文件夹名；
 * 3. 目录冲突校验：如目标文件夹已存在则阻断；
 * 4. 注册表原子同步与缓存失效：移除旧 ID，写入新 ID 与新路径，并失效目录大小缓存；
 * 5. 支持 Windows 大小写重命名（经中间安全缓冲目录过渡，失败自动回滚）。
 */
export async function renameInstance(
  options: RenameInstanceOptions,
  activeRunningInstanceId?: string | null,
  context?: RenameInstanceContext,
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
      for (const root of paths.candidateInstanceRoots()) {
        const candidate = path.join(root, safeOldId);
        if (fs.existsSync(candidate)) {
          sourcePath = candidate;
          break;
        }
      }
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        throw new Error(`找不到实例 [${safeOldId}] 的物理存储目录（已搜索当前存储根、安装目录与旧版隐藏目录）`);
      }
    }
  }

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`源目录不存在: ${resolvedSource}`);
  }
  if (isPathOccupiedByActiveProcess(resolvedSource, context?.activeDirectories)) {
    throw new Error('实例目录仍有终端或后台进程占用，请等待命令结束或关闭终端后重试');
  }

  // 3. 计算新目标文件夹路径（保持在同一个父目录下）
  const parentDir = path.dirname(resolvedSource);
  const newPath = path.join(parentDir, safeNewId);
  const resolvedNewPath = path.resolve(newPath);
  const renameImpl = context?.renameImpl ?? fs.promises.rename;
  const retryDelaysMs = context?.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

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
    await renameWithRetries(resolvedSource, tempHolder, renameImpl, retryDelaysMs);
    try {
      await renameWithRetries(tempHolder, resolvedNewPath, renameImpl, retryDelaysMs);
    } catch (error) {
      try {
        if (fs.existsSync(tempHolder) && !fs.existsSync(resolvedSource)) {
          await renameWithRetries(tempHolder, resolvedSource, renameImpl, retryDelaysMs);
        }
      } catch {
        // Best-effort rollback only
      }
      throw error;
    }
  } else {
    // 目标路径不同：检查目标文件夹是否已存在
    if (fs.existsSync(resolvedNewPath)) {
      throw new Error(`目标目录已存在，无法重命名: ${resolvedNewPath}`);
    }
    await renameWithRetries(resolvedSource, resolvedNewPath, renameImpl, retryDelaysMs);
  }

  // 5. 更新注册表 (instances.json) 并失效目录大小缓存
  const existingRecord = instanceStore.getInstanceRecord(safeOldId);
  instanceStore.removeInstanceRecord(safeOldId);
  instanceStore.registerInstance(
    safeNewId,
    resolvedNewPath,
    existingRecord?.createdAt,
    existingRecord?.isTakeover,
  );
  renameInstancePassword(safeOldId, safeNewId);
  invalidateDirectorySize(resolvedSource);
  invalidateDirectorySize(resolvedNewPath);

  return {
    success: true,
    oldId: safeOldId,
    newId: safeNewId,
    oldPath: resolvedSource,
    newPath: resolvedNewPath,
  };
}
