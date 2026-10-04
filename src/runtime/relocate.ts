import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as paths from './paths';
import * as instanceStore from './instances';
import { invalidateDirectorySize } from './directory-stats';

export interface LegacyInstanceItem {
  instanceId: string;
  name: string;
  currentPath: string;
  targetPath: string;
  version?: string;
}

export interface RelocateResult {
  success: boolean;
  instanceId: string;
  oldPath: string;
  newPath: string;
  unchanged?: boolean;
}

/** 递归复制目录（支持跨分区） */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

/** 安全移动目录（支持跨驱动器/分区） */
async function moveDirectorySafe(source: string, target: string): Promise<void> {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);

  if (resolvedSource.toLowerCase() === resolvedTarget.toLowerCase()) {
    return;
  }

  if (!fs.existsSync(resolvedSource)) {
    throw new Error(`源实例目录不存在: ${resolvedSource}`);
  }

  const parentDir = path.dirname(resolvedTarget);
  if (!fs.existsSync(parentDir)) {
    await fs.promises.mkdir(parentDir, { recursive: true });
  }

  // 1. 同驱动器尝试快速原子重命名
  try {
    fs.renameSync(resolvedSource, resolvedTarget);
    return;
  } catch (err: any) {
    if (err?.code !== 'EXDEV') {
      throw err;
    }
  }

  // 2. 跨驱动器：复制至临时 staging 目录 -> 校验 -> 重命名 -> 删除源目录
  const staging = path.join(parentDir, `.sillyclient-relocate-${randomUUID()}`);
  try {
    await copyDirRecursive(resolvedSource, staging);

    // 基础完整性校验
    if (!fs.existsSync(path.join(staging, 'package.json'))) {
      throw new Error('迁移校验失败：缺少 package.json');
    }

    fs.renameSync(staging, resolvedTarget);

    // 删除源目录
    await fs.promises.rm(resolvedSource, { recursive: true, force: true });
  } catch (err) {
    if (fs.existsSync(staging)) {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * 检测属于旧版本路径的实例（例如保存在 C 盘 AppData 的 servers 目录）
 */
export async function checkLegacyInstances(): Promise<{ instances: LegacyInstanceItem[] }> {
  const legacyDir = paths.legacyServersDir || path.join(paths.bootstrapDir, 'servers');
  const appInstancesDir = paths.appInstancesDir;
  const legacyCandidates = new Map<string, string>();

  // 1. 检查注册表中已有的实例，看其物理路径是否位于旧目录
  for (const record of instanceStore.listInstanceRecords()) {
    const normRecordPath = path.resolve(record.path).toLowerCase();
    const normLegacyDir = path.resolve(legacyDir).toLowerCase();
    const normAppInstancesDir = path.resolve(appInstancesDir).toLowerCase();

    // 如果位于旧 servers 目录，或者在 tarvenHome 下但不在新的 appInstancesDir 下
    if (
      normRecordPath.startsWith(normLegacyDir) ||
      (normRecordPath.startsWith(path.resolve(paths.tarvenHome).toLowerCase()) &&
        !normRecordPath.startsWith(normAppInstancesDir))
    ) {
      if (fs.existsSync(record.path) && fs.existsSync(path.join(record.path, 'package.json'))) {
        legacyCandidates.set(record.instanceId, record.path);
      }
    }
  }

  // 2. 扫描旧物理目录 legacyServersDir 下未在注册表登记的遗留实例
  if (fs.existsSync(legacyDir)) {
    for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (legacyCandidates.has(instanceId)) continue;
      const fullPath = path.join(legacyDir, entry.name);
      if (fs.existsSync(path.join(fullPath, 'package.json'))) {
        legacyCandidates.set(instanceId, fullPath);
      }
    }
  }

  const items: LegacyInstanceItem[] = [];
  for (const [id, currentPath] of legacyCandidates) {
    const targetPath = path.join(appInstancesDir, id);
    if (path.resolve(currentPath).toLowerCase() === path.resolve(targetPath).toLowerCase()) {
      continue;
    }

    let version = 'unknown';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(currentPath, 'package.json'), 'utf-8'));
      version = pkg.version || 'unknown';
    } catch {
      /* ignore */
    }

    items.push({
      instanceId: id,
      name: id,
      currentPath,
      targetPath,
      version,
    });
  }

  return { instances: items };
}

/**
 * 单个实例无损迁移 / 路径重定位
 * @param activeRunningInstanceId 当前正在运行的实例 ID（防止迁移正在运行的实例）
 */
export async function relocateInstance(
  options: {
    instanceId: string;
    targetPath?: string;
  },
  activeRunningInstanceId?: string | null,
): Promise<RelocateResult> {
  const safeId = paths.normalizeInstanceId(options.instanceId);

  // 1. 运行态保护守卫
  if (activeRunningInstanceId && paths.normalizeInstanceId(activeRunningInstanceId) === safeId) {
    throw new Error('实例正在运行中，请先停止实例再执行迁移！');
  }

  // 2. 获取源实例物理路径
  const record = instanceStore.getInstanceRecord(safeId);
  let sourcePath = record ? record.path : null;

  if (!sourcePath || !fs.existsSync(sourcePath)) {
    // 尝试从 legacyServersDir 或 appInstancesDir 解析
    const legacyPath = path.join(paths.legacyServersDir, safeId);
    const defaultPath = path.join(paths.appInstancesDir, safeId);
    if (fs.existsSync(legacyPath)) {
      sourcePath = legacyPath;
    } else if (fs.existsSync(defaultPath)) {
      sourcePath = defaultPath;
    } else {
      throw new Error(`找不到实例 [${safeId}] 的物理安装目录`);
    }
  }

  const resolvedSource = path.resolve(sourcePath);
  if (!fs.existsSync(path.join(resolvedSource, 'package.json'))) {
    throw new Error(`源目录缺少 package.json，非完整 SillyTavern 实例: ${resolvedSource}`);
  }

  // 3. 计算最终目标路径
  let finalTarget: string;
  if (options.targetPath && typeof options.targetPath === 'string' && options.targetPath.trim()) {
    const cleanTarget = options.targetPath.trim().replace(/^["']|["']$/g, '').trim();
    const resolvedCustom = path.resolve(cleanTarget);
    if (resolvedCustom === path.parse(resolvedCustom).root) {
      throw new Error('不能把磁盘根目录直接设为实例目标目录');
    }
    // 如果用户选择的已经是一个存在的目录，且其内部没有 package.json，则在其下创建子文件夹 safeId
    if (fs.existsSync(resolvedCustom) && !fs.existsSync(path.join(resolvedCustom, 'package.json'))) {
      finalTarget = path.join(resolvedCustom, safeId);
    } else {
      finalTarget = resolvedCustom;
    }
  } else {
    // 默认迁移到客户端统一目录
    finalTarget = path.join(paths.appInstancesDir, safeId);
  }

  const resolvedFinalTarget = path.resolve(finalTarget);

  // 4. 源路径与目标路径一致性检测
  if (resolvedSource.toLowerCase() === resolvedFinalTarget.toLowerCase()) {
    return {
      success: true,
      instanceId: safeId,
      oldPath: resolvedSource,
      newPath: resolvedFinalTarget,
      unchanged: true,
    };
  }

  // 5. 目标冲突检查
  if (fs.existsSync(resolvedFinalTarget)) {
    const entries = fs.readdirSync(resolvedFinalTarget);
    if (entries.length > 0) {
      throw new Error(`目标路径已存在且非空，为保障数据安全已终止迁移: ${resolvedFinalTarget}`);
    }
  }

  // 6. 执行安全无损搬迁
  await moveDirectorySafe(resolvedSource, resolvedFinalTarget);

  // 7. 更新底层注册表 (instances.json)
  instanceStore.registerInstance(
    safeId,
    resolvedFinalTarget,
    record?.createdAt,
    record?.isTakeover,
  );

  // 8. 刷新目录大小缓存
  invalidateDirectorySize(resolvedSource);
  invalidateDirectorySize(resolvedFinalTarget);

  return {
    success: true,
    instanceId: safeId,
    oldPath: resolvedSource,
    newPath: resolvedFinalTarget,
  };
}

/**
 * 批量迁移旧版实例至软件默认实例目录
 */
export async function migrateLegacyInstances(
  options: { instanceIds?: string[] } = {},
  activeRunningInstanceId?: string | null,
): Promise<{ success: boolean; results: RelocateResult[] }> {
  const legacy = await checkLegacyInstances();
  const targetIds = options.instanceIds && options.instanceIds.length > 0
    ? options.instanceIds.map(paths.normalizeInstanceId)
    : legacy.instances.map((i) => i.instanceId);

  const results: RelocateResult[] = [];
  for (const id of targetIds) {
    const res = await relocateInstance({ instanceId: id }, activeRunningInstanceId);
    results.push(res);
  }

  return { success: true, results };
}
