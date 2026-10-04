import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ensureDirs, instanceRegistryPath, normalizeInstanceId } from './paths';

export interface InstanceRecord {
  instanceId: string;
  path: string;
  createdAt: string;
  lastUsedAt?: string;
  totalUsageMs: number;
  sessionStartedAt?: string;
  isTakeover?: boolean;
}

interface InstanceRegistry {
  version: 1;
  instances: Record<string, InstanceRecord>;
}

function emptyRegistry(): InstanceRegistry {
  return { version: 1, instances: Object.create(null) };
}

function registeredDirectory(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('Invalid registered installation path');
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error('Invalid registered installation root');
  return resolved;
}

function readRegistry(): InstanceRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(instanceRegistryPath, 'utf8')) as Partial<InstanceRegistry>;
    if (parsed.version !== 1 || !parsed.instances || typeof parsed.instances !== 'object'
      || Array.isArray(parsed.instances)) {
      throw new Error('Invalid instance registry');
    }
    const records = parsed.instances;
    const instances: Record<string, InstanceRecord> = Object.create(null);
    for (const [key, value] of Object.entries(records)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid instance registry record');
      }
      const record = value as Partial<InstanceRecord>;
      const instanceId = normalizeInstanceId(record.instanceId || key);
      instances[instanceId] = {
        instanceId,
        path: registeredDirectory(record.path),
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : new Date().toISOString(),
        lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : undefined,
        totalUsageMs: Number.isFinite(record.totalUsageMs) ? Math.max(0, Number(record.totalUsageMs)) : 0,
        sessionStartedAt: typeof record.sessionStartedAt === 'string' ? record.sessionStartedAt : undefined,
        isTakeover: record.isTakeover === true,
      };
    }
    return { version: 1, instances };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return emptyRegistry();
    // Never replace a damaged registry with an empty one during a scan.
    throw error;
  }
}

function writeRegistry(registry: InstanceRegistry): void {
  ensureDirs();
  const temporary = `${instanceRegistryPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const descriptor = fs.openSync(temporary, 'wx');
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    // rename replaces the file atomically; a failed rename leaves the old registry intact.
    fs.renameSync(temporary, instanceRegistryPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

/** One synchronous snapshot/commit for an entire discovery pass. */
export class InstanceRepository {
  private readonly registry = readRegistry();
  private readonly original = JSON.stringify(this.registry);

  list(): InstanceRecord[] {
    return Object.values(this.registry.instances);
  }

  get(instanceId: string): InstanceRecord | null {
    return this.registry.instances[normalizeInstanceId(instanceId)] || null;
  }

  register(instanceId: string, instancePath: string, createdAt?: string, isTakeover?: boolean): InstanceRecord {
    const safeId = normalizeInstanceId(instanceId);
    const existing = this.registry.instances[safeId];
    const record: InstanceRecord = {
      instanceId: safeId,
      path: registeredDirectory(instancePath),
      createdAt: existing?.createdAt || createdAt || inferredCreatedAt(instancePath),
      lastUsedAt: existing?.lastUsedAt,
      totalUsageMs: existing?.totalUsageMs || 0,
      sessionStartedAt: existing?.sessionStartedAt,
      isTakeover: isTakeover !== undefined ? isTakeover : existing?.isTakeover === true,
    };
    this.registry.instances[safeId] = record;
    return record;
  }

  finishStaleSessions(activeInstanceIds: string[] = []): void {
    for (const record of this.list()) {
      if (!activeInstanceIds.includes(record.instanceId)) delete record.sessionStartedAt;
    }
  }

  commit(): void {
    if (JSON.stringify(this.registry) !== this.original) writeRegistry(this.registry);
  }
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

export function registerInstance(
  instanceId: string,
  instancePath: string,
  createdAt?: string,
  isTakeover?: boolean,
): InstanceRecord {
  const repository = new InstanceRepository();
  const record = repository.register(instanceId, instancePath, createdAt, isTakeover);
  repository.commit();
  return record;
}

export function beginInstanceUsage(instanceId: string, instancePath: string): InstanceRecord {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const existing = registry.instances[safeId] || {
    instanceId: safeId,
    path: registeredDirectory(instancePath),
    createdAt: inferredCreatedAt(instancePath),
    totalUsageMs: 0,
  };
  const now = new Date().toISOString();
  const record: InstanceRecord = {
    ...existing,
    path: registeredDirectory(instancePath),
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
  return usageForRecord(getInstanceRecord(instanceId));
}

export function usageForRecord(record: InstanceRecord | null): {
  createdAt?: string; lastUsedAt?: string; totalUsageMs: number;
} {
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
