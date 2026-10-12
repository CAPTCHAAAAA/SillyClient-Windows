/**
 * 实例元数据探测、自检扫描与路径解析服务
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as instanceStore from './runtime/instances';
import { directorySize } from './runtime/directory-stats';
import type {
  GetInstanceInfoParams,
  InstanceInfo,
  ScannedInstance,
} from './contracts/ipc-contracts';

/** 同一实例 ID 的历史前缀变体（local- ↔ new- 过渡期产物）。 */
function instanceIdVariants(safeId: string): string[] {
  if (safeId.startsWith('local-')) return [safeId, `new-${safeId.slice('local-'.length)}`];
  if (safeId.startsWith('new-')) return [safeId, `local-${safeId.slice('new-'.length)}`];
  return [safeId];
}

/**
 * 无注册表记录时的全位置探测：在当前生效根、全部历史落点与旧版隐藏目录下
 * 寻找同名（含 ID 变体）实例目录。仅认领包含 package.json 的完整实例，
 * 命中即补登记注册表，修复旧版升级（无注册表时代）造成的实例失联。
 */
function discoverUnregisteredInstanceDir(safeId: string): string | null {
  for (const root of paths.candidateInstanceRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const candidateId of instanceIdVariants(safeId)) {
      const candidate = path.join(root, candidateId);
      if (!fs.existsSync(path.join(candidate, 'package.json'))) continue;
      try {
        if (fs.statSync(candidate).isDirectory()) return candidate;
      } catch { /* ignore unreadable candidates */ }
    }
  }
  return null;
}

export function resolveInstanceDir(
  instanceId: string,
  installPath?: string,
  installPathMode?: paths.InstallPathMode,
): string {
  const safeId = paths.normalizeInstanceId(instanceId);
  const selected = installPath !== undefined || installPathMode !== undefined
    ? paths.serverDirFor(safeId, installPath, installPathMode)
    : undefined;
  const recorded = instanceStore.getInstanceRecord(safeId)?.path;

  if (recorded) {
    // 注册表权威：登记位置仍然存在时一律以注册表为准——前端卡片残留的旧路径
    // （如迁移完成后未刷新的隐藏目录地址）静默自愈，绝不因此报错阻断启动。
    if (fs.existsSync(recorded)) return recorded;
    // 登记位置已丢失：永不认领同名其他目录（其中可能是完全不同的数据），
    // 仅当调用方显式给出一个仍然存在的卡片路径时，原地治愈并补登记。
    if (selected && !!installPath?.trim()
      && path.resolve(selected).toLowerCase() !== path.resolve(recorded).toLowerCase()
      && fs.existsSync(selected)) {
      instanceStore.registerInstance(safeId, selected);
      return selected;
    }
    return recorded;
  }

  if (selected) {
    // 显式路径不提前登记：无效选择（如指向文件）由后续校验拒绝，
    // 登记只发生在启动成功或信息确认之后，绝不污染注册表。
    return selected;
  }

  // 无记录、无显式路径（旧版升级失联实例）：先查 ID 变体的注册记录，再做全位置磁盘探测。
  for (const variantId of instanceIdVariants(safeId)) {
    if (variantId === safeId) continue;
    const variantRecord = instanceStore.getInstanceRecord(variantId)?.path;
    if (variantRecord) return variantRecord;
  }
  const discovered = discoverUnregisteredInstanceDir(safeId);
  if (discovered) {
    instanceStore.registerInstance(safeId, discovered);
    return discovered;
  }
  return paths.serverDirFor(safeId);
}

export function scanInstances(
  currentInstanceId: string | null,
  isSettled: () => boolean,
  onSettle: () => void,
): { instances: ScannedInstance[] } {
  const repository = new instanceStore.InstanceRepository();
  if (!isSettled()) {
    repository.finishStaleSessions(currentInstanceId ? [currentInstanceId] : []);
    onSettle();
  }
  const candidates = new Map<string, string>();
  for (const record of repository.list()) {
    candidates.set(record.instanceId, record.path);
  }
  // 注册表权威优先；随后按候选根顺序（当前生效根 → 安装目录默认根 → AppData 回退根 →
  // 旧版隐藏 servers 目录）补充发现，同名实例先登记者优先——旧版隐藏目录中的实例
  // 会被发现并补登记，但绝不遮蔽已登记记录或新落点中的同名实例。
  for (const root of paths.candidateInstanceRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (!entry.isDirectory() || candidates.has(instanceId)) continue;
      candidates.set(instanceId, path.join(root, entry.name));
    }
  }
  const instances: ScannedInstance[] = [];
  for (const [instanceId, dir] of candidates) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const record = repository.register(instanceId, dir);
      const usage = instanceStore.usageForRecord(record);
      instances.push({
        instanceId,
        version: pkg.version || 'unknown',
        path: dir,
        sizeBytes: 0, // 启动自检不阻塞递归扫描磁盘；具体大小在关于页由 getInstanceInfo 获取
        hasServer: fs.existsSync(path.join(dir, 'server.js')),
        createdAt: usage.createdAt,
        lastUsedAt: usage.lastUsedAt,
        totalUsageMs: usage.totalUsageMs,
      });
    } catch { /* skip */ }
  }
  repository.commit();
  return { instances };
}

export async function getInstanceInfo(
  opts: GetInstanceInfoParams,
  currentInstanceId: string | null,
  currentPort: number,
): Promise<InstanceInfo> {
  const { instanceId, installPath, installPathMode, port } = opts;
  const safeInstanceId = paths.normalizeInstanceId(instanceId);
  const dir = resolveInstanceDir(safeInstanceId, installPath, installPathMode);

  if (!fs.existsSync(dir)) {
    return {
      instanceId: safeInstanceId,
      version: 'unknown',
      path: dir,
      sizeBytes: 0,
      createdAt: '',
      lastUsedAt: '',
      totalUsageMs: 0,
      status: 'not_found',
    };
  }

  let version = 'unknown';
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      version = pkg.version || 'unknown';
    } catch { /* ignore */ }
  }

  const record = instanceStore.registerInstance(safeInstanceId, dir);
  const usage = instanceStore.usageForRecord(record);
  const status = (proc.isServerRunning() && currentInstanceId === safeInstanceId && currentPort === port)
    ? 'running'
    : 'stopped';

  return {
    instanceId: safeInstanceId,
    version,
    path: dir,
    sizeBytes: await directorySize(dir),
    createdAt: usage.createdAt || '',
    lastUsedAt: usage.lastUsedAt || '',
    totalUsageMs: usage.totalUsageMs,
    status,
  };
}
