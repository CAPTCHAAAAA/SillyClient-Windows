/**
 * TarvenEnv 插件 — Windows 实现
 *
 * 从 Android TarvenEnvPlugin.kt + MainActivity.kt 移植。
 * 返回类型严格匹配前端 capacitor-plugin.ts 的接口定义。
 */

import { BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';

import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as utils from './runtime/utils';

// ---------------------------------------------------------------------------
// 导出给 main.ts 用的接口（保持与之前兼容）
// ---------------------------------------------------------------------------

export { getNodeExe, getNpmCli } from './runtime/paths';

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let serverReady = false;
let currentUrl: string | null = null;
let currentPort = 0;

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function isServerReady(): boolean {
  return serverReady;
}

export function cleanup(): void {
  proc.stopServer();
}

export function notify(eventName: string, data: any): void {
  mainWindow?.webContents.send(`tarven:${eventName}`, data);
}

// ---------------------------------------------------------------------------
// IPC 处理入口
// ---------------------------------------------------------------------------

export async function handle(method: string, options: any): Promise<any> {
  switch (method) {
    case 'provisionAndStart':
      return provisionAndStart(options);
    case 'scanInstances':
      return scanInstances();
    case 'getInstanceInfo':
      return getInstanceInfo(options);
    case 'sendCommand':
      return doSendCommand(options);
    case 'setPullToRefresh':
      return Promise.resolve();
    case 'pingUrl':
      return pingUrl(options);
    case 'fetchReleases':
      return fetchReleases();
    case 'pickDirectory':
      return doPickDirectory();
    case 'pickImage':
      return doPickImage(options);
    case 'pickZipFile':
      return doPickZipFile();
    case 'uninstallInstance':
      return uninstallInstance(options);
    case 'cleanGarbage':
      return cleanGarbage(options);
    case 'deleteGarbageItem':
      return deleteGarbageItem(options);
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// 端口检测 — 检查端口是否可用，不可用则递增
// ---------------------------------------------------------------------------

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('node:net');
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort: number, log: (msg: string, level?: string) => void): Promise<number> {
  for (let p = startPort; p < startPort + 100; p++) {
    if (await isPortAvailable(p)) return p;
  }
  log(`端口 ${startPort}-${startPort + 99} 全部不可用，使用默认 ${startPort}`, 'error');
  return startPort;
}

// ---------------------------------------------------------------------------
// provisionAndStart — 配置并启动本地 Node 实例
// 前端期望返回: { ready: boolean }
// ---------------------------------------------------------------------------

async function provisionAndStart(opts: any): Promise<{ ready: boolean }> {
  const { port, instanceId, version, zipballUrl, localZipPath, config } = opts;

  const log = (msg: string, level?: string) => notify('log', { message: msg, level });
  const progress = (pct: number, text?: string) => notify('progress', { percent: pct, stage: text });

  serverReady = false;
  currentPort = port;

  try {
    paths.ensureDirs();

    const targetServerDir = paths.serverDirFor(instanceId);
    if (!fs.existsSync(targetServerDir)) {
      fs.mkdirSync(targetServerDir, { recursive: true });
    }

    const serverJs = path.join(targetServerDir, 'server.js');
    const nodeModules = path.join(targetServerDir, 'node_modules');
    const needInstall = !fs.existsSync(serverJs) || !fs.existsSync(nodeModules);

    if (needInstall) {
      progress(5, '安装中');

      if (localZipPath && fs.existsSync(localZipPath)) {
        log(`从本地 zip 安装: ${localZipPath}`);
        progress(15, '解压本地 zip');
        fs.rmSync(targetServerDir, { recursive: true, force: true });
        fs.mkdirSync(targetServerDir, { recursive: true });
        await utils.unzipToDir(localZipPath, targetServerDir);
        flattenExtractedDir(targetServerDir);
      } else if (zipballUrl) {
        log(`下载: ${zipballUrl}`);
        progress(10, '下载源码');

        const tmpZip = path.join(paths.tmpDir, `${instanceId}.zip`);
        await downloadWithMirrors(zipballUrl, tmpZip, (pct) => {
          progress(10 + Math.floor(pct * 0.4), '下载中');
        }, log);

        progress(50, '解压源码');
        await utils.unzipToDir(tmpZip, targetServerDir);
        flattenExtractedDir(targetServerDir);

        try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
      }

      progress(60, '安装依赖');
      await proc.runNpmInstall(targetServerDir, log);
    }

    // 检测端口可用性，自动切换
    const actualPort = await findAvailablePort(port, log);
    if (actualPort !== port) {
      log(`端口 ${port} 被占用或保留，改用 ${actualPort}`);
    }
    currentPort = actualPort;

    progress(85, '写入配置');
    writeInstanceConfig(targetServerDir, actualPort, config);

    progress(90, '启动服务');
    proc.startServer(targetServerDir, instanceId, actualPort, log);

    progress(95, '等待就绪');
    const ready = await pollUntilReady(actualPort, 180000, log);
    if (!ready) {
      throw new Error('服务启动超时（180s）');
    }

    serverReady = true;
    currentUrl = `http://127.0.0.1:${actualPort}`;
    progress(100, '就绪');
    log('服务就绪', 'success');

    notify('ready', { ready: true, url: currentUrl, port: actualPort });
    return { ready: true };
  } catch (e: any) {
    log(`失败: ${e.message}`, 'error');
    notify('error', { message: e.message });
    return { ready: false };
  }
}

async function downloadWithMirrors(
  originalUrl: string,
  destPath: string,
  onProgress: (pct: number) => void,
  log: (msg: string, level?: string) => void,
): Promise<void> {
  const mirrors = [
    originalUrl,
    originalUrl.replace('https://github.com', 'https://ghfast.top/https://github.com'),
    originalUrl.replace('https://github.com', 'https://gh-proxy.com/https://github.com'),
    originalUrl.replace('https://github.com', 'https://ghproxy.net/https://github.com'),
  ];

  let lastError: Error | null = null;
  for (let i = 0; i < mirrors.length; i++) {
    for (let retry = 0; retry < 2; retry++) {
      try {
        log(`下载 (镜像 ${i + 1}/${mirrors.length}, 重试 ${retry + 1}/2)`);
        await utils.downloadFile(mirrors[i], destPath, onProgress);
        return;
      } catch (e: any) {
        lastError = e;
        log(`下载失败: ${e.message}`, 'error');
      }
    }
  }
  throw lastError || new Error('下载失败');
}

/**
 * zip 解压后通常有一个顶层目录（如 SillyTavern-release/）。
 * 解压前已清空目标目录，所以解压后只会有这一个子目录。
 * 把它的内容提升到父目录即可。
 */
function flattenExtractedDir(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // 只有一个子目录 → 提升它
  if (entries.length === 1 && entries[0].isDirectory()) {
    const subdir = path.join(dir, entries[0].name);
    for (const entry of fs.readdirSync(subdir)) {
      fs.renameSync(path.join(subdir, entry), path.join(dir, entry));
    }
    fs.rmdirSync(subdir);
  }
}

function writeInstanceConfig(serverDir: string, port: number, config: any): void {
  const c = config || {};
  const yaml = [
    `port: ${port}`,
    `listen: ${c.listen ?? true}`,
    `whitelistMode: false`,
    `securityOverride: true`,
    c.ipv4 !== undefined ? `listenIPv4: ${c.ipv4}` : '',
    c.ipv6 !== undefined ? `listenIPv6: ${c.ipv6}` : '',
    c.dnsIpv6 !== undefined ? `dnsPreferIPv6: ${c.dnsIpv6}` : '',
    c.heartbeat !== undefined ? `enableHeartbeat: ${c.heartbeat}` : '',
    c.keepAlive !== undefined ? `autoRestartOnCrash: ${c.keepAlive}` : '',
  ].filter(Boolean).join('\n');

  utils.writeText(path.join(serverDir, 'config.yaml'), yaml);
}

async function pollUntilReady(port: number, timeoutMs: number, log: (msg: string, level?: string) => void): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}`;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await tryConnect(url)) return true;
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function tryConnect(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
  });
}

// ---------------------------------------------------------------------------
// scanInstances — 前端期望: { instances: ScannedInstance[] }
// ScannedInstance: { instanceId, version, sizeBytes, hasServer }
// ---------------------------------------------------------------------------

function scanInstances(): { instances: any[] } {
  const serversDir = path.join(paths.bootstrapDir, 'servers');
  if (!fs.existsSync(serversDir)) return { instances: [] };

  const instances: any[] = [];
  for (const entry of fs.readdirSync(serversDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(serversDir, entry.name);
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      instances.push({
        instanceId: entry.name,
        version: pkg.version || 'unknown',
        sizeBytes: utils.dirSize(dir),
        hasServer: fs.existsSync(path.join(dir, 'server.js')),
      });
    } catch { /* skip */ }
  }

  return { instances };
}

// ---------------------------------------------------------------------------
// getInstanceInfo — 前端期望: InstanceInfo
// { instanceId, version, path, sizeBytes, createdAt, status }
// ---------------------------------------------------------------------------

function getInstanceInfo(opts: any): any {
  const { instanceId, port } = opts;
  const dir = paths.serverDirFor(instanceId);

  if (!fs.existsSync(dir)) {
    return { instanceId, version: 'unknown', path: dir, sizeBytes: 0, createdAt: '—', status: 'not_found' };
  }

  let version = 'unknown';
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      version = pkg.version || 'unknown';
    } catch { /* ignore */ }
  }

  let createdAt = '—';
  try {
    const stat = fs.statSync(dir);
    createdAt = stat.birthtime.toISOString().split('T')[0];
  } catch { /* ignore */ }

  const status = (proc.isServerRunning() && currentPort === port) ? 'running' : 'stopped';

  return {
    instanceId,
    version,
    path: dir,
    sizeBytes: utils.dirSize(dir),
    createdAt,
    status,
  };
}

// ---------------------------------------------------------------------------
// sendCommand — 前端期望: void
// ---------------------------------------------------------------------------

function doSendCommand(opts: any): void {
  const { text } = opts;
  const cwd = path.join(paths.bootstrapDir, 'servers');
  proc.sendCommand(text, cwd, (msg, level) => {
    notify('log', { message: msg, level });
  });
}

// ---------------------------------------------------------------------------
// pingUrl — 前端期望: { online, statusCode?, error? }
// ---------------------------------------------------------------------------

function pingUrl(opts: any): Promise<{ online: boolean; statusCode?: number; error?: string }> {
  return new Promise((resolve) => {
    const { url } = opts;
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.request(url, { method: 'HEAD', timeout: 10000 }, (res: any) => {
      res.destroy();
      resolve({ online: true, statusCode: res.statusCode });
    });

    req.on('error', (e: any) => resolve({ online: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, error: 'timeout' }); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// fetchReleases — 前端期望: { releases: GithubRelease[] }
// GithubRelease: { tag, zipballUrl, prerelease }
// ---------------------------------------------------------------------------

function fetchReleases(): Promise<{ releases: any[] }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/SillyTavern/SillyTavern/releases?per_page=20',
      headers: {
        'User-Agent': 'SillyClient-Windows',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    https.get(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          const releases = raw.map((r: any) => ({
            tag: r.tag_name,
            zipballUrl: r.zipball_url,
            prerelease: r.prerelease,
          }));
          resolve({ releases });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// pickDirectory — 前端期望: { name, path }
// ---------------------------------------------------------------------------

async function doPickDirectory(): Promise<{ name: string; path: string }> {
  if (!mainWindow) return { name: '', path: '' };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { name: '', path: '' };
  }
  const p = result.filePaths[0];
  return { name: path.basename(p), path: p };
}

// ---------------------------------------------------------------------------
// pickImage — 前端期望: { path }
// ---------------------------------------------------------------------------

async function doPickImage(opts: any): Promise<{ path: string }> {
  if (!mainWindow) return { path: '' };
  const { instanceId } = opts;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择封面图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: '' };
  }

  const src = result.filePaths[0];
  const ext = path.extname(src);

  if (!fs.existsSync(paths.coversDir)) {
    fs.mkdirSync(paths.coversDir, { recursive: true });
  }

  // 删除该实例之前的所有封面图（可能扩展名不同），避免残留
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const oldFile = path.join(paths.coversDir, `${instanceId}${oldExt}`);
    if (fs.existsSync(oldFile)) {
      try { fs.unlinkSync(oldFile); } catch { /* ignore */ }
    }
  }

  const dest = path.join(paths.coversDir, `${instanceId}${ext}`);
  utils.copyFile(src, dest);
  return { path: dest };
}

// ---------------------------------------------------------------------------
// pickZipFile — 前端期望: { path, sizeBytes }
// ---------------------------------------------------------------------------

async function doPickZipFile(): Promise<{ path: string; sizeBytes: number }> {
  if (!mainWindow) return { path: '', sizeBytes: 0 };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 zip 文件',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: '', sizeBytes: 0 };
  }

  const p = result.filePaths[0];
  const stat = fs.statSync(p);
  return { path: p, sizeBytes: stat.size };
}

// ---------------------------------------------------------------------------
// uninstallInstance — 前端期望: { success, freedBytes }
// ---------------------------------------------------------------------------

function uninstallInstance(opts: any): { success: boolean; freedBytes: number } {
  const { instanceId } = opts;
  const dir = paths.serverDirFor(instanceId);

  let freedBytes = 0;
  if (fs.existsSync(dir)) {
    freedBytes = utils.dirSize(dir);
    utils.removeDir(dir);
  }

  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const cover = path.join(paths.coversDir, `${instanceId}${ext}`);
    if (fs.existsSync(cover)) {
      try {
        freedBytes += fs.statSync(cover).size;
        fs.unlinkSync(cover);
      } catch { /* ignore */ }
    }
  }

  return { success: true, freedBytes };
}

// ---------------------------------------------------------------------------
// cleanGarbage — 前端期望: { items: GarbageItem[], totalBytes }
// GarbageItem: { path, type, sizeBytes, description }
// ---------------------------------------------------------------------------

function cleanGarbage(opts: any): { items: any[]; totalBytes: number } {
  const { dryRun = true } = opts;
  const items: any[] = [];

  // 孤立实例目录
  const serversDir = path.join(paths.bootstrapDir, 'servers');
  if (fs.existsSync(serversDir)) {
    for (const entry of fs.readdirSync(serversDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(serversDir, entry.name);
      if (!fs.existsSync(path.join(dir, 'package.json'))) {
        items.push({
          path: dir,
          type: 'orphan_instance',
          sizeBytes: utils.dirSize(dir),
          description: `孤立实例: ${entry.name}`,
        });
      }
    }
  }

  // 孤立封面图
  if (fs.existsSync(paths.coversDir)) {
    for (const entry of fs.readdirSync(paths.coversDir)) {
      const fp = path.join(paths.coversDir, entry);
      items.push({
        path: fp,
        type: 'orphan_cover',
        sizeBytes: fs.statSync(fp).size,
        description: `封面图: ${entry}`,
      });
    }
  }

  // 临时文件
  if (fs.existsSync(paths.tmpDir)) {
    for (const entry of fs.readdirSync(paths.tmpDir)) {
      const fp = path.join(paths.tmpDir, entry);
      items.push({
        path: fp,
        type: 'temp_file',
        sizeBytes: fs.statSync(fp).size,
        description: `临时文件: ${entry}`,
      });
    }
  }

  // 缓存（日志）
  if (fs.existsSync(paths.logsDir)) {
    for (const entry of fs.readdirSync(paths.logsDir)) {
      const fp = path.join(paths.logsDir, entry);
      items.push({
        path: fp,
        type: 'cache',
        sizeBytes: fs.statSync(fp).size,
        description: `日志: ${entry}`,
      });
    }
  }

  const totalBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);

  if (!dryRun) {
    for (const item of items) {
      try {
        if (fs.statSync(item.path).isDirectory()) {
          utils.removeDir(item.path);
        } else {
          fs.unlinkSync(item.path);
        }
      } catch { /* ignore */ }
    }
  }

  return { items, totalBytes };
}

// ---------------------------------------------------------------------------
// deleteGarbageItem — 前端期望: { success }
// ---------------------------------------------------------------------------

function deleteGarbageItem(opts: any): { success: boolean } {
  const { path: itemPath } = opts;
  if (!itemPath) return { success: false };

  try {
    if (fs.existsSync(itemPath)) {
      if (fs.statSync(itemPath).isDirectory()) {
        utils.removeDir(itemPath);
      } else {
        fs.unlinkSync(itemPath);
      }
    }
    return { success: true };
  } catch {
    return { success: false };
  }
}
