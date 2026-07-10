/**
 * Windows 运行时路径管理
 *
 * 从 Android RuntimePaths.kt 移植，适配 Windows 文件系统。
 * Android 用 filesDir/tarven，Windows 用 %LOCALAPPDATA%/SillyClient。
 *
 * Node.js 运行时集成在应用 runtime/node 目录中，即开即用，不依赖系统安装。
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

/** SillyClient 根目录：%LOCALAPPDATA%/SillyClient */
export const sillyClientHome = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'SillyClient',
);

/** tarven 运行时目录（与 Android 保持一致命名） */
export const tarvenHome = path.join(sillyClientHome, 'tarven');

/** bootstrap 目录：启动脚本、服务端源码 */
export const bootstrapDir = path.join(tarvenHome, 'bootstrap');

/** 服务端源码目录（多实例隔离） */
export const serverDir = path.join(bootstrapDir, 'server');

/** 单实例服务端目录 */
export function serverDirFor(instanceId: string): string {
  return path.join(bootstrapDir, 'servers', instanceId);
}

/** usr 目录：npm 缓存等 */
export const usrDir = path.join(tarvenHome, 'usr');

/** 封面图目录 */
export const coversDir = path.join(tarvenHome, 'covers');

/** 临时文件目录 */
export const tmpDir = path.join(tarvenHome, 'tmp');

/** 日志目录 */
export const logsDir = path.join(tarvenHome, 'logs');

// ---------------------------------------------------------------------------
// 内置 Node.js 运行时（不依赖系统安装）
// ---------------------------------------------------------------------------

/** 内置 Node.js 运行时目录 */
function getBundledNodeDir(): string {
  // 开发模式: __dirname = dist/runtime/
  // 生产模式: __dirname = resources/app/dist/runtime/
  // runtime/node/ 在项目根目录下
  return path.join(__dirname, '..', '..', 'runtime', 'node');
}

let _nodeBin: string | null = null;

/**
 * 获取 node.exe 路径 — 始终使用内置运行时
 */
export function getNodeBin(): string {
  if (_nodeBin) return _nodeBin;

  const bundledDir = getBundledNodeDir();
  const bundledNode = path.join(bundledDir, 'node.exe');

  if (fs.existsSync(bundledNode)) {
    _nodeBin = bundledNode;
    return _nodeBin;
  }

  // 后备：开发模式下可能 runtime/node 还没准备好，用系统 node
  const systemNode = findInPath('node', ['.exe']);
  if (systemNode) {
    _nodeBin = systemNode;
    return _nodeBin;
  }

  // 最后后备：Electron 内置 Node
  _nodeBin = process.execPath;
  return _nodeBin;
}

/** 是否使用 Electron 内置 Node（仅在极端后备情况） */
export function isElectronNode(): boolean {
  if (!_nodeBin) getNodeBin();
  return _nodeBin === process.execPath;
}

/**
 * 获取 npm 路径 — 优先用 npm-cli.js（通过内置 node 运行）
 */
export function getNpmBin(): string {
  const nodeDir = getBundledNodeDir();

  // 1. 内置 node_modules/npm/bin/npm-cli.js（最可靠）
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(npmCli)) return npmCli;

  // 2. 内置 npm.cmd
  const npmCmd = path.join(nodeDir, 'npm.cmd');
  if (fs.existsSync(npmCmd)) return npmCmd;

  // 3. 系统 PATH 中的 npm.cmd
  const systemNpm = findInPath('npm', ['.cmd']);
  if (systemNpm) return systemNpm;

  return 'npm';
}

/**
 * 在 PATH 中查找可执行文件（后备用）
 */
function findInPath(name: string, preferredExts?: string[]): string | null {
  const PATH = process.env.PATH || '';
  const exts = preferredExts || (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';');

  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

/** 确保所有目录存在 */
export function ensureDirs(): void {
  for (const dir of [tarvenHome, bootstrapDir, serverDir, usrDir, coversDir, tmpDir, logsDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  // servers 目录
  const serversDir = path.join(bootstrapDir, 'servers');
  if (!fs.existsSync(serversDir)) {
    fs.mkdirSync(serversDir, { recursive: true });
  }
}

/** 获取前端构建产物目录 */
export function getFrontendDistDir(): string | null {
  // 1. 打包后的 frontend-dist（生产环境）
  const bundled = path.join(__dirname, '..', '..', 'frontend-dist');
  if (fs.existsSync(bundled)) return bundled;

  // 2. 本项目 web/capacitor-ui/dist（开发模式，junction 链接）
  const local = path.join(__dirname, '..', '..', 'web', 'capacitor-ui', 'dist');
  if (fs.existsSync(local)) return local;

  // 3. 安卓端共享（开发模式）
  const android = path.join(
    __dirname, '..', '..', '..', 'SillyClient_Android', 'App', 'web', 'capacitor-ui', 'dist',
  );
  if (fs.existsSync(android)) return android;

  return null;
}

/** bootstrap 脚本目录 */
export const scriptsDir = path.join(bootstrapDir, 'scripts');

/** start-server.bat 路径 */
export const startServerScript = path.join(scriptsDir, 'start-server.bat');
