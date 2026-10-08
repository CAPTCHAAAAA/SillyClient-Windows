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

export function resolveInstanceDir(
  instanceId: string,
  installPath?: string,
  installPathMode?: paths.InstallPathMode,
): string {
  const recorded = instanceStore.getInstanceRecord(instanceId)?.path;
  if (installPath !== undefined || installPathMode !== undefined) {
    const selected = paths.serverDirFor(instanceId, installPath, installPathMode);
    if (recorded) {
      if (installPath?.trim() && path.resolve(selected).toLowerCase() !== path.resolve(recorded).toLowerCase()) {
        throw new Error('Selected installation path conflicts with the registered instance');
      }
      return recorded;
    }
    return selected;
  }
  // Missing registrations retain their original path, never a same-ID default.
  if (recorded) return recorded;
  const defaultDir = paths.serverDirFor(instanceId);
  if (fs.existsSync(defaultDir)) return defaultDir;
  if (instanceId.startsWith('local-')) {
    const fallbackId = instanceId.replace('local-', 'new-');
    const fallbackRecord = instanceStore.getInstanceRecord(fallbackId)?.path;
    if (fallbackRecord) return fallbackRecord;
    const fallbackDir = paths.serverDirFor(fallbackId);
    if (fs.existsSync(fallbackDir)) return fallbackDir;
  } else if (instanceId.startsWith('new-')) {
    const fallbackId = instanceId.replace('new-', 'local-');
    const fallbackRecord = instanceStore.getInstanceRecord(fallbackId)?.path;
    if (fallbackRecord) return fallbackRecord;
    const fallbackDir = paths.serverDirFor(fallbackId);
    if (fs.existsSync(fallbackDir)) return fallbackDir;
  }
  return defaultDir;
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
  const appInstancesDir = paths.appInstancesDir || path.join(paths.bootstrapDir, 'instances');
  const legacyServersDir = paths.legacyServersDir || path.join(paths.bootstrapDir, 'servers');
  // 1. 扫描软件目录下的 instances/ 目录
  if (appInstancesDir && fs.existsSync(appInstancesDir)) {
    for (const entry of fs.readdirSync(appInstancesDir, { withFileTypes: true })) {
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (!entry.isDirectory() || candidates.has(instanceId)) continue;
      candidates.set(instanceId, path.join(appInstancesDir, entry.name));
    }
  }
  // 2. 兼容扫描旧版 C 盘下的 servers/ 目录
  if (legacyServersDir && fs.existsSync(legacyServersDir)) {
    for (const entry of fs.readdirSync(legacyServersDir, { withFileTypes: true })) {
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (!entry.isDirectory() || candidates.has(instanceId)) continue;
      candidates.set(instanceId, path.join(legacyServersDir, entry.name));
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
