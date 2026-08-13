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
}

interface InstanceRegistry {
  version: 1;
  instances: Record<string, InstanceRecord>;
}

function emptyRegistry(): InstanceRegistry {
  return { version: 1, instances: {} };
}

function readRegistry(): InstanceRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceRegistryPath, 'utf8')) as Partial<InstanceRegistry>;
    const records = parsed.instances && typeof parsed.instances === 'object' ? parsed.instances : {};
    const instances: Record<string, InstanceRecord> = {};
    for (const [key, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Partial<InstanceRecord>;
      if (typeof record.path !== 'string' || !path.isAbsolute(record.path)) continue;
      const instanceId = normalizeInstanceId(record.instanceId || key);
      instances[instanceId] = {
        instanceId,
        path: path.resolve(record.path),
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined,
        totalUsageMs: Number.isFinite(record.totalUsageMs) ? Math.max(0, Number(record.totalUsageMs)) : 0,
        sessionStartedAt: typeof record.sessionStartedAt === 'string' ? record.sessionStartedAt : undefined,
      };
    }
    return { version: 1, instances };
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(registry: InstanceRegistry): void {
  ensureDirs();
  const temporary = `${instanceRegistryPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  fs.rmSync(instanceRegistryPath, { force: true });
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
  const registry = readRegistry();
  const existing = registry.instances[safeId];
  const record: InstanceRecord = {
    instanceId: safeId,
    path: resolvedPath,
    createdAt: existing?.createdAt || createdAt || inferredCreatedAt(resolvedPath),
    lastUsedAt: existing?.lastUsedAt,
    totalUsageMs: existing?.totalUsageMs || 0,
    sessionStartedAt: existing?.sessionStartedAt,
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
