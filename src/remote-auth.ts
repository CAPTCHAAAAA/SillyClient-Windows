import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RemoteBasicAuthCredentials {
  username: string;
  password: string;
}

type CredentialFile = Record<string, string>;

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'remote-basic-auth.json');
}

function readCredentialFile(): CredentialFile {
  const target = credentialPath();
  if (!fs.existsSync(target)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as CredentialFile
      : {};
  } catch {
    return {};
  }
}

function writeCredentialFile(store: CredentialFile): void {
  const target = credentialPath();
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
}

function validateInstanceId(instanceId: string): string {
  const normalized = String(instanceId || '').trim();
  if (!normalized) throw new Error('instanceId required');
  return normalized;
}

export function loadRemoteBasicAuth(instanceId: string): RemoteBasicAuthCredentials | null {
  const id = validateInstanceId(instanceId);
  const encrypted = readCredentialFile()[id];
  if (!encrypted) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储当前不可用');
  }

  try {
    const plaintext = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
    const credentials = JSON.parse(plaintext) as RemoteBasicAuthCredentials;
    if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') {
      throw new Error('invalid credentials');
    }
    return credentials;
  } catch {
    throw new Error('远程连接凭据无法解密，请重新保存账号和密码');
  }
}

export function saveRemoteBasicAuth(
  instanceId: string,
  username: string,
  password?: string,
): RemoteBasicAuthCredentials {
  const id = validateInstanceId(instanceId);
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) throw new Error('Basic Auth 用户名不能为空');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows 安全存储当前不可用');
  }

  const existing = password === undefined ? loadRemoteBasicAuth(id) : null;
  const resolvedPassword = password ?? existing?.password;
  if (resolvedPassword === undefined) throw new Error('Basic Auth 密码不能为空');

  const credentials = { username: normalizedUsername, password: resolvedPassword };
  const encrypted = safeStorage.encryptString(JSON.stringify(credentials)).toString('base64');
  const store = readCredentialFile();
  store[id] = encrypted;
  writeCredentialFile(store);
  return credentials;
}

export function clearRemoteBasicAuth(instanceId: string): void {
  const id = validateInstanceId(instanceId);
  const store = readCredentialFile();
  if (!(id in store)) return;
  delete store[id];
  writeCredentialFile(store);
}

export function getRemoteBasicAuthStatus(instanceId: string): { configured: boolean; username?: string } {
  const credentials = loadRemoteBasicAuth(instanceId);
  return credentials
    ? { configured: true, username: credentials.username }
    : { configured: false };
}
