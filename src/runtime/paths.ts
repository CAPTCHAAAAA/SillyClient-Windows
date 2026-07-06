/**
 * Windows 运行时路径管理
 *
 * 从 Android RuntimePaths.kt 移植，适配 Windows 文件系统。
 * Android 用 filesDir/tarven，Windows 用 %LOCALAPPDATA%/SillyClient。
 * Android 把 node/git 等 .so 伪装成 jniLibs，Windows 直接用系统 PATH 中的 node.exe。
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

/** 系统中 node.exe 路径 */
let _nodeBin: string | null = null;
let _isElectronNode = false;

export function getNodeBin(): string {
  if (_nodeBin) return _nodeBin;
  // 优先用系统安装的 Node.js
  const systemNode = findInPath('node.exe');
  if (systemNode) {
    _nodeBin = systemNode;
    _isElectronNode = false;
    return _nodeBin;
  }
  // 回退到 Electron 内置 Node（需 ELECTRON_RUN_AS_NODE=1）
  _nodeBin = process.execPath;
  _isElectronNode = true;
  return _nodeBin;
}

/** 是否使用 Electron 内置 Node（而非系统 node.exe） */
export function isElectronNode(): boolean {
  if (!_nodeBin) getNodeBin();
  return _isElectronNode;
}

export function getNpmBin(): string {
  if (!isElectronNode()) {
    // 系统 node：npm 通常在同目录
    const nodeDir = path.dirname(getNodeBin());
    const npmCmd = path.join(nodeDir, 'npm.cmd');
    if (fs.existsSync(npmCmd)) return npmCmd;
  }
  // Electron Node 或系统 npm 不在 node 目录：用 npx 或全局 npm
  const systemNpm = findInPath('npm.cmd');
  if (systemNpm) return systemNpm;
  // 最后回退：用 node 运行 npm-cli.js
  return 'npm';
}

/** 在 PATH 中查找可执行文件 */
function findInPath(name: string): string | null {
  const PATH = process.env.PATH || '';
  const exts = (process.env.PATHEXT || '.EXE').split(';');
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
  // 1. 本项目 web/capacitor-ui/dist
  const local = path.join(__dirname, '..', '..', 'web', 'capacitor-ui', 'dist');
  if (fs.existsSync(local)) return local;

  // 2. 安卓端共享（开发模式）
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
