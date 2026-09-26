import * as fs from 'node:fs';
import * as path from 'node:path';

import { ensureDirs, instanceRegistryPath, normalizeInstanceId } from './paths';

export interface InstanceRecord {
  instanceId: string;
  path: string;
  createdAt: string;
  lastUsedAt?: string;
  totalUsageMs: number;
  sessionStartedAt?: string;
  managementMode?: 'in-place';
  dataRoot?: string;
}

interface InstanceRegistry {
  version: 1;
  instances: Record<string, InstanceRecord>;
}

function emptyRegistry(): InstanceRegistry {
  return { version: 1, instances: {} };
}

function readRegistry(strict = true): InstanceRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceRegistryPath, 'utf8')) as Partial<InstanceRegistry>;
    if (strict && (parsed.version !== 1 || !parsed.instances || typeof parsed.instances !== 'object'
        || Array.isArray(parsed.instances))) throw new Error('实例记录异常，已停止文件操作。');
    const records = parsed.instances && typeof parsed.instances === 'object' ? parsed.instances : {};
    const instances: Record<string, InstanceRecord> = {};
    for (const [key, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object') {
        if (strict) throw new Error('实例记录异常，已停止文件操作。');
        continue;
      }
      const record = value as Partial<InstanceRecord>;
      if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) {
        if (strict) throw new Error('实例路径异常，已停止文件操作。');
        continue;
      }
      if (strict && record.managementMode === 'in-place'
          && (typeof record.dataRoot !== 'string' || !path.isAbsolute(record.dataRoot))) {
        throw new Error('接管记录异常，已停止文件操作。');
      }
      if (strict && record.managementMode !== undefined && record.managementMode !== 'in-place') {
        throw new Error('未知实例管理方式，已停止文件操作。');
      }
      const instanceId = normalizeInstanceId(record.instanceId || key);
      if (strict && (key !== instanceId || Object.hasOwn(instances, instanceId))) {
        throw new Error('实例标识异常，已停止文件操作。');
      }
      instances[instanceId] = {
        instanceId,
        path: path.resolve(record.path),
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined,
        totalUsageMs: Number.isFinite(record.totalUsageMs) ? Math.max(0, Number(record.totalUsageMs)) : 0,
        sessionStartedAt: typeof record.sessionStartedAt === 'string' ? record.sessionStartedAt : undefined,
        ...(record.managementMode === 'in-place' ? {
          managementMode: 'in-place' as const,
          dataRoot: typeof record.dataRoot === 'string' ? path.resolve(record.dataRoot) : undefined,
        } : {}),
      };
    }
    return { version: 1, instances };
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return emptyRegistry();
  }
}

function writeRegistry(registry: InstanceRegistry): void {
  ensureDirs();
  const temporary = `${instanceRegistryPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, instanceRegistryPath);
}

function inferredCreatedAt(instancePath: string): string {
  try {
    const stat = fs.statSync(instancePath);
    const time = stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime;
    return time.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

export function getInstanceRecord(instanceId: string): InstanceRecord | null {
  const safeId = normalizeInstanceId(instanceId);
  return readRegistry().instances[safeId] || null;
}

export function listInstanceRecords(): InstanceRecord[] {
  return Object.values(readRegistry().instances);
}

export function finishStaleUsageSessions(): void {
  const registry = readRegistry();
  let changed = false;
  for (const record of Object.values(registry.instances)) {
    if (!record.sessionStartedAt) continue;
    // 正常运行时会定时结算。进程异常退出后不把离线时间误计为使用时长。
    delete record.sessionStartedAt;
    changed = true;
  }
  if (changed) writeRegistry(registry);
}

export function registerInstance(instanceId: string, instancePath: string, createdAt?: string): InstanceRecord {
  const safeId = normalizeInstanceId(instanceId);
  const resolvedPath = path.resolve(instancePath);
  const registry = readRegistry(true);
  const existing = registry.instances[safeId];
  if (existing?.managementMode === 'in-place' && resolvedPath !== existing.path) {
    throw new Error('接管实例不能改指其他目录，请先解除接管。');
  }
  if (existing?.managementMode !== 'in-place') assertNotAttachedPath(resolvedPath);
  const record: InstanceRecord = {
    ...existing,
    instanceId: safeId,
    path: resolvedPath,
    createdAt: existing?.createdAt || createdAt || inferredCreatedAt(resolvedPath),
    lastUsedAt: existing?.lastUsedAt,
    totalUsageMs: existing?.totalUsageMs || 0,
    sessionStartedAt: existing?.sessionStartedAt,
  };
  const isUnchanged = existing
    && existing.instanceId === record.instanceId
    && existing.path === record.path
    && existing.createdAt === record.createdAt
    && existing.lastUsedAt === record.lastUsedAt
    && existing.totalUsageMs === record.totalUsageMs
    && existing.sessionStartedAt === record.sessionStartedAt
    && existing.managementMode === record.managementMode
    && existing.dataRoot === record.dataRoot;
  if (!isUnchanged) {
    registry.instances[safeId] = record;
    writeRegistry(registry);
  }
  return record;
}

export function registerImportedInstance(instanceId: string, instancePath: string): InstanceRecord {
  if (fs.existsSync(instanceRegistryPath)) {
    const registry = JSON.parse(fs.readFileSync(instanceRegistryPath, 'utf8')) as InstanceRegistry;
    if (registry.version !== 1 || !registry.instances || typeof registry.instances !== 'object'
        || Array.isArray(registry.instances)) {
      throw new Error('现有实例记录格式异常，已停止导入注册。');
    }
    for (const [id, record] of Object.entries(registry.instances)) {
      if (!record || typeof record.path !== 'string' || !path.isAbsolute(record.path)
          || id !== normalizeInstanceId(record.instanceId || id)) {
        throw new Error('现有实例记录损坏，已停止导入注册。');
      }
    }
    if (registry.instances[normalizeInstanceId(instanceId)]) {
      throw new Error('实例标识已存在，不能覆盖。');
    }
  }
  return registerInstance(instanceId, instancePath);
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function canonicalPath(directory: string): string {
  const resolved = path.resolve(directory);
  let ancestor = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  return path.resolve(fs.realpathSync(ancestor), ...missing);
}

function pathsOverlap(a: string, b: string): boolean {
  return [path.resolve(a), canonicalPath(a)].some(left =>
    [path.resolve(b), canonicalPath(b)].some(right => within(left, right) || within(right, left)));
}

export function assertNotAttachedPath(directory: string): void {
  for (const record of Object.values(readRegistry(true).instances)) {
    if (record.managementMode !== 'in-place') continue;
    for (const protectedPath of [record.path, record.dataRoot!]) {
      if (pathsOverlap(protectedPath, directory)) {
        throw new Error('该路径包含原地接管的文件或数据，禁止修改或删除；请仅解除接管。');
      }
    }
  }
}

export function registerAttachedInstance(instanceId: string, directory: string, dataRoot: string): InstanceRecord {
  const registry = readRegistry(true);
  const safeId = normalizeInstanceId(instanceId);
  if (registry.instances[safeId]) throw new Error('实例标识已存在。');
  for (const record of Object.values(registry.instances)) {
    if ([record.path, record.dataRoot].some(existing => existing
        && [directory, dataRoot].some(candidate => pathsOverlap(existing, candidate)))) {
      throw new Error('该目录或数据已经属于已登记的实例，不能重复接管。');
    }
  }
  const record: InstanceRecord = {
    instanceId: safeId, path: path.resolve(directory), dataRoot: path.resolve(dataRoot),
    managementMode: 'in-place', createdAt: inferredCreatedAt(directory), totalUsageMs: 0,
  };
  registry.instances[safeId] = record;
  writeRegistry(registry);
  return record;
}

export function beginInstanceUsage(instanceId: string, instancePath: string): InstanceRecord {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const existing = registry.instances[safeId] || {
    instanceId: safeId,
    path: path.resolve(instancePath),
    createdAt: inferredCreatedAt(instancePath),
    totalUsageMs: 0,
  };
  if (existing.managementMode === 'in-place' && path.resolve(instancePath) !== existing.path) {
    throw new Error('接管实例的使用记录不能改指其他目录。');
  }
  const now = new Date().toISOString();
  const record: InstanceRecord = {
    ...existing,
    path: path.resolve(instancePath),
    lastUsedAt: now,
    sessionStartedAt: now,
  };
  registry.instances[safeId] = record;
  writeRegistry(registry);
  return record;
}

export function checkpointInstanceUsage(instanceId: string): InstanceRecord | null {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const record = registry.instances[safeId];
  if (!record?.sessionStartedAt) return record || null;
  const startedAt = Date.parse(record.sessionStartedAt);
  const now = Date.now();
  if (Number.isFinite(startedAt)) record.totalUsageMs += Math.max(0, now - startedAt);
  record.sessionStartedAt = new Date(now).toISOString();
  registry.instances[safeId] = record;
  writeRegistry(registry);
  return record;
}

export function finishInstanceUsage(instanceId: string): InstanceRecord | null {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const record = registry.instances[safeId];
  if (!record) return null;
  if (record.sessionStartedAt) {
    const startedAt = Date.parse(record.sessionStartedAt);
    if (Number.isFinite(startedAt)) {
      record.totalUsageMs += Math.max(0, Date.now() - startedAt);
    }
    delete record.sessionStartedAt;
    registry.instances[safeId] = record;
    writeRegistry(registry);
  }
  return record;
}

export function getInstanceUsage(instanceId: string): {
  createdAt?: string;
  lastUsedAt?: string;
  totalUsageMs: number;
} {
  const record = getInstanceRecord(instanceId);
  if (!record) return { totalUsageMs: 0 };
  let totalUsageMs = record.totalUsageMs;
  if (record.sessionStartedAt) {
    const startedAt = Date.parse(record.sessionStartedAt);
    if (Number.isFinite(startedAt)) totalUsageMs += Math.max(0, Date.now() - startedAt);
  }
  return {
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    totalUsageMs,
  };
}

export function removeInstanceRecord(instanceId: string): void {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  if (!(safeId in registry.instances)) return;
  delete registry.instances[safeId];
  writeRegistry(registry);
}
