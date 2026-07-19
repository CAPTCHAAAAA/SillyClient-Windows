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
export const usrDir = path.join(tarvenHome, 'usr');
export const coversDir = path.join(tarvenHome, 'covers');
export const tmpDir = path.join(tarvenHome, 'tmp');
export const logsDir = path.join(tarvenHome, 'logs');

export function serverDirFor(instanceId: string): string {
  const safeId = instanceId
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80) || 'default';
  return path.join(bootstrapDir, 'servers', safeId);
}

export function ensureDirs(): void {
  for (const d of [tarvenHome, bootstrapDir, usrDir, coversDir, tmpDir, logsDir]) {
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
