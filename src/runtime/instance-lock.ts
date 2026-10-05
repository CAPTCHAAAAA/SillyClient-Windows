import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { instancePasswordsPath, normalizeInstanceId, ensureDirs } from './paths';

export interface PasswordRecord {
  salt: string;
  hash: string;
  updatedAt: string;
}

interface PasswordRegistry {
  version: 1;
  passwords: Record<string, PasswordRecord>;
}

function emptyRegistry(): PasswordRegistry {
  return { version: 1, passwords: Object.create(null) };
}

function readRegistry(): PasswordRegistry {
  try {
    if (!fs.existsSync(instancePasswordsPath)) return emptyRegistry();
    const parsed = JSON.parse(fs.readFileSync(instancePasswordsPath, 'utf8')) as Partial<PasswordRegistry>;
    if (parsed.version !== 1 || !parsed.passwords || typeof parsed.passwords !== 'object') {
      return emptyRegistry();
    }
    const passwords: Record<string, PasswordRecord> = Object.create(null);
    for (const [key, value] of Object.entries(parsed.passwords)) {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as any).salt === 'string' &&
        typeof (value as any).hash === 'string'
      ) {
        const id = normalizeInstanceId(key);
        passwords[id] = {
          salt: (value as any).salt,
          hash: (value as any).hash,
          updatedAt: typeof (value as any).updatedAt === 'string' ? (value as any).updatedAt : new Date().toISOString(),
        };
      }
    }
    return { version: 1, passwords };
  } catch {
    return emptyRegistry();
  }
}

function writeRegistry(registry: PasswordRegistry): void {
  ensureDirs();
  const dir = path.dirname(instancePasswordsPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const temporary = `${instancePasswordsPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, instancePasswordsPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function computeHash(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 10000, 32, 'sha256').toString('hex');
}

export function hasInstancePassword(instanceId: string): boolean {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  return Boolean(registry.passwords[safeId]);
}

export function verifyInstancePassword(instanceId: string, password: string): boolean {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const record = registry.passwords[safeId];
  if (!record) return true; // 未设置密码则无需解锁
  if (typeof password !== 'string') return false;
  const computed = computeHash(password, record.salt);
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(record.hash, 'hex'));
}

export function setInstancePassword(
  instanceId: string,
  newPassword?: string,
  oldPassword?: string,
): { success: boolean; hasPassword: boolean } {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const existing = registry.passwords[safeId];

  // 若已有密码，修改或清除时必须先校验旧密码
  if (existing) {
    if (!oldPassword || !verifyInstancePassword(safeId, oldPassword)) {
      throw new Error('原访问密码错误，无法更改或解除');
    }
  }

  const cleanPassword = (newPassword || '').trim();
  if (!cleanPassword) {
    // 清除密码保护
    if (existing) {
      delete registry.passwords[safeId];
      writeRegistry(registry);
    }
    return { success: true, hasPassword: false };
  }

  // 设置新密码
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = computeHash(cleanPassword, salt);
  registry.passwords[safeId] = {
    salt,
    hash,
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(registry);
  return { success: true, hasPassword: true };
}

export function clearInstancePassword(
  instanceId: string,
  oldPassword?: string,
): { success: boolean } {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  const existing = registry.passwords[safeId];
  if (!existing) return { success: true };

  if (!oldPassword || !verifyInstancePassword(safeId, oldPassword)) {
    throw new Error('原访问密码错误，无法解除密码保护');
  }

  delete registry.passwords[safeId];
  writeRegistry(registry);
  return { success: true };
}

export function renameInstancePassword(oldId: string, newId: string): void {
  const safeOldId = normalizeInstanceId(oldId);
  const safeNewId = normalizeInstanceId(newId);
  if (safeOldId === safeNewId) return;
  const registry = readRegistry();
  const record = registry.passwords[safeOldId];
  if (!record) return;
  delete registry.passwords[safeOldId];
  registry.passwords[safeNewId] = record;
  writeRegistry(registry);
}

export function removeInstancePassword(instanceId: string): void {
  const safeId = normalizeInstanceId(instanceId);
  const registry = readRegistry();
  if (!registry.passwords[safeId]) return;
  delete registry.passwords[safeId];
  writeRegistry(registry);
}

export function listInstancePasswordStatus(): Record<string, boolean> {
  const registry = readRegistry();
  const result: Record<string, boolean> = {};
  for (const id of Object.keys(registry.passwords)) {
    result[id] = true;
  }
  return result;
}
