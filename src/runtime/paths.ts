/**
 * Windows 运行时路径管理
 *
 * 核心设计：内置 Node.js 运行时（runtime/node/node.exe），即开即用。
 * 不搜索系统 PATH，不依赖用户安装 Node.js。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// 数据目录（%LOCALAPPDATA%/SillyClient/tarven/...）
// ---------------------------------------------------------------------------

const LOCAL_APP = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

export const sillyClientHome = path.join(LOCAL_APP, 'SillyClient');
export const tarvenHome = path.join(sillyClientHome, 'tarven');
export const bootstrapDir = path.join(tarvenHome, 'bootstrap');
export const legacyServersDir = path.join(bootstrapDir, 'servers');
export const usrDir = path.join(tarvenHome, 'usr');
export const coversDir = path.join(tarvenHome, 'covers');
export const tmpDir = path.join(tarvenHome, 'tmp');
export const logsDir = path.join(tarvenHome, 'logs');
export const instanceRegistryPath = path.join(tarvenHome, 'instances.json');
export const instancePasswordsPath = path.join(tarvenHome, 'instance-passwords.json');

/**
 * 软件根目录：
 * 打包后（生产环境）：process.resourcesPath 的父目录，即安装根目录（例如 D:\SillyClient\）
 * 开发环境：项目仓库根目录
 */
export const appRootDir = ((): string => {
  if (process.resourcesPath) {
    return path.dirname(process.resourcesPath);
  }
  return path.resolve(__dirname, '..', '..');
})();

/**
 * 默认实例存储目录：
 * 统一置于软件运行根目录下的 instances/ 文件夹（不在 C 盘 AppData/Local 隐藏）
 * 若由于权限问题不可写，优雅回退至 tarvenHome/instances
 */
export const appInstancesDir = ((): string => {
  const dir = path.join(appRootDir, 'instances');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = path.join(tarvenHome, 'instances');
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
})();

export function normalizeInstanceId(instanceId: string): string {
  return instanceId
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 100) || 'default';
}

export type InstallPathMode = 'root' | 'exact';

export function serverDirFor(instanceId: string, installPath?: string, installPathMode?: InstallPathMode): string {
  const safeId = normalizeInstanceId(instanceId);
  if (installPathMode !== undefined && installPathMode !== 'root' && installPathMode !== 'exact') {
    throw new Error('Invalid installation path mode');
  }
  if (installPath !== undefined && typeof installPath !== 'string') {
    throw new Error('Invalid installation path');
  }
  const supplied = installPath?.trim() || '';
  const cleanPath = supplied.replace(/^["']|["']$/g, '').trim();
  if (!cleanPath && (supplied || installPathMode === 'root'
    || (installPathMode !== undefined && installPath !== undefined))) {
    throw new Error('Installation path is empty');
  }
  if (cleanPath) {
    if (!path.isAbsolute(cleanPath)) {
      throw new Error('安装目录必须使用绝对路径');
    }
    const resolved = path.resolve(cleanPath);
    if (installPathMode === 'root') return path.join(resolved, safeId);
    if (resolved === path.parse(resolved).root) {
      throw new Error('不能把磁盘根目录直接设为实例目录');
    }
    if (installPathMode === 'exact') return resolved;
    // Older clients did not distinguish a selected parent from an exact path.
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) throw new Error('指定的安装路径不是目录');

      const isExistingInstance = fs.existsSync(path.join(resolved, 'server.js'))
        && fs.existsSync(path.join(resolved, 'package.json'));
      if (isExistingInstance) return resolved;

      // 目录选择器返回的是已存在父目录，在其中创建独立实例目录。
      return path.join(resolved, safeId);
    }
    return resolved;
  }
  // 未指定路径时的默认路径：
  // 严格保存在软件根目录下的 instances/ 文件夹内，绝不默认写入 C 盘 AppData
  return path.join(appInstancesDir, safeId);
}

export function ensureDirs(): void {
  for (const d of [tarvenHome, bootstrapDir, usrDir, coversDir, tmpDir, logsDir, appInstancesDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  const serversDir = path.join(bootstrapDir, 'servers');
  if (!fs.existsSync(serversDir)) fs.mkdirSync(serversDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 内置 Node.js 运行时
// ---------------------------------------------------------------------------

/** 内置 runtime/node 目录
 *  开发环境: 项目根/runtime/node
 *  生产环境: resources/runtime/node（通过 extraResources 复制，不经过 asar 打包）
 */
const bundledNodeDir = ((): string => {
  // 生产环境：extraResources 将 runtime/node 复制到 resources/runtime/node
  // 不在 app.asar 内，spawn 可以直接执行
  if (process.resourcesPath) {
    const prodPath = path.join(process.resourcesPath, 'runtime', 'node');
    if (fs.existsSync(prodPath)) return prodPath;
  }
  // 开发环境
  return path.join(__dirname, '..', '..', 'runtime', 'node');
})();

/** node.exe 路径（始终用内置的） */
export function getNodeExe(): string {
  return path.join(bundledNodeDir, 'node.exe');
}

/** npm-cli.js 路径（用 node.exe 执行它来跑 npm 命令） */
export function getNpmCli(): string {
  return path.join(bundledNodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

// ---------------------------------------------------------------------------
// 前端构建产物
// ---------------------------------------------------------------------------

export function getFrontendDistDir(): string | null {
  const bundled = path.join(__dirname, '..', '..', 'frontend-dist');
  if (fs.existsSync(bundled)) return bundled;
  return null;
}
