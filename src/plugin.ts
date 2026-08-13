/**
 * TarvenEnv 插件 — Windows 实现
 *
 * 从 Android TarvenEnvPlugin.kt + MainActivity.kt 移植。
 * 返回类型严格匹配前端 capacitor-plugin.ts 的接口定义。
 */

import { app, BrowserWindow, dialog, net } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';

import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as utils from './runtime/utils';
import {
  clearRemoteBasicAuth,
  getRemoteBasicAuthStatus,
  loadRemoteBasicAuth,
  RemoteBasicAuthCredentials,
  saveRemoteBasicAuth,
} from './remote-auth';

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

export function getCurrentUrl(): string | null {
  return currentUrl;
}

export function stopCurrentServer(): void {
  proc.stopServer();
  serverReady = false;
  currentUrl = null;
  currentPort = 0;
  notify('ready', { ready: false });
  notify('mode', { mode: 'launcher', tavernRunning: false });
}

export function cleanup(): void {
  proc.stopServer();
  serverReady = false;
  currentUrl = null;
  currentPort = 0;
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
    case 'setRemoteBasicAuth': {
      const credentials = saveRemoteBasicAuth(options.instanceId, options.username, options.password);
      return { configured: true, username: credentials.username };
    }
    case 'getRemoteBasicAuthStatus':
      return getRemoteBasicAuthStatus(options.instanceId);
    case 'clearRemoteBasicAuth':
      clearRemoteBasicAuth(options.instanceId);
      return { success: true };
    case 'fetchReleases':
      return fetchReleases();
    case 'checkAppUpdate':
      return checkAppUpdate();
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
  let createdThisRun = false;
  let targetServerDir = '';
  let temporaryArchive = '';

  try {
    paths.ensureDirs();

    targetServerDir = paths.serverDirFor(instanceId);
    if (!fs.existsSync(targetServerDir)) {
      fs.mkdirSync(targetServerDir, { recursive: true });
    }

    const serverJs = path.join(targetServerDir, 'server.js');
    const nodeModules = path.join(targetServerDir, 'node_modules');
    const needInstall = !fs.existsSync(serverJs) || !fs.existsSync(nodeModules);

    if (needInstall) {
      createdThisRun = true;
      progress(5, '安装中');
      fs.rmSync(targetServerDir, { recursive: true, force: true });
      fs.mkdirSync(targetServerDir, { recursive: true });

      if (localZipPath) {
        if (!fs.existsSync(localZipPath)) {
          throw new Error('选择的本地压缩包不存在');
        }
        log(`从本地 zip 安装: ${localZipPath}`);
        progress(15, '解压本地 zip');
        await utils.unzipToDir(localZipPath, targetServerDir);
        flattenExtractedDir(targetServerDir);
      } else if (zipballUrl) {
        log(`下载: ${zipballUrl}`);
        progress(10, '下载源码');

        temporaryArchive = path.join(paths.tmpDir, `${instanceId}.zip`);
        await downloadWithMirrors(zipballUrl, temporaryArchive, (pct) => {
          progress(10 + Math.floor(pct * 0.4), '下载中');
        }, log);

        progress(50, '解压源码');
        await utils.unzipToDir(temporaryArchive, targetServerDir);
        flattenExtractedDir(targetServerDir);

        try { fs.unlinkSync(temporaryArchive); } catch { /* ignore */ }
        temporaryArchive = '';
      } else {
        throw new Error('未获取到 SillyTavern 当前版本，请检查网络后重试');
      }

      if (!fs.existsSync(serverJs) || !fs.existsSync(path.join(targetServerDir, 'package.json'))) {
        throw new Error('下载内容不完整，未找到 SillyTavern 启动文件');
      }

      progress(60, '安装依赖');
      await proc.runNpmInstall(targetServerDir, log);
      if (!fs.existsSync(nodeModules)) {
        throw new Error('运行依赖安装未完成');
      }
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
    if (temporaryArchive) {
      try { fs.unlinkSync(temporaryArchive); } catch { /* ignore */ }
    }
    if (createdThisRun && targetServerDir) {
      fs.rmSync(targetServerDir, { recursive: true, force: true });
    }
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
    `https://ghfast.top/${originalUrl}`,
    `https://gh-proxy.com/${originalUrl}`,
    `https://ghproxy.net/${originalUrl}`,
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
  const { text, instanceId } = opts;
  const normalizedId = typeof instanceId === 'string' ? instanceId.trim() : '';
  if (!normalizedId) {
    notify('log', { message: '缺少实例标识，无法打开实例终端', level: 'error' });
    return;
  }
  const cwd = paths.serverDirFor(normalizedId);
  if (!fs.existsSync(cwd)) {
    notify('log', { message: `实例目录不存在：${normalizedId}`, level: 'error' });
    return;
  }
  proc.sendCommand(text, cwd, (msg, level) => {
    notify('log', { message: msg, level });
  });
}

// ---------------------------------------------------------------------------
// pingUrl — 前端期望: { online, statusCode?, authRequired?, error? }
// ---------------------------------------------------------------------------

interface PingResult {
  online: boolean;
  statusCode?: number;
  authRequired?: boolean;
  error?: string;
}

function probeUrl(
  target: URL,
  authOrigin: string,
  credentials: RemoteBasicAuthCredentials | null,
  redirects = 0,
): Promise<PingResult> {
  return new Promise((resolve) => {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ online: false, error: '连接地址必须使用 HTTP 或 HTTPS' });
      return;
    }

    const protocol = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    if (credentials && target.origin === authOrigin) {
      headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
    }

    const req = protocol.request(target, { method: 'HEAD', timeout: 10000, headers }, (res: any) => {
      const statusCode = Number(res.statusCode || 0);
      const location = res.headers.location as string | undefined;
      res.destroy();

      if (statusCode >= 300 && statusCode < 400 && location && redirects < 5) {
        const redirected = new URL(location, target);
        void probeUrl(redirected, authOrigin, credentials, redirects + 1).then(resolve);
        return;
      }

      if (statusCode === 401) {
        resolve({
          online: false,
          statusCode,
          authRequired: true,
          error: credentials
            ? 'Basic Auth 验证失败，请检查账号和密码'
            : '该地址需要 Basic Auth 账号和密码',
        });
        return;
      }

      resolve({ online: statusCode >= 200 && statusCode <= 499, statusCode });
    });

    req.on('error', (e: any) => resolve({ online: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, error: 'timeout' }); });
    req.end();
  });
}

function pingUrl(opts: any): Promise<PingResult> {
  try {
    const target = new URL(String(opts.url || ''));
    const hasTransientCredentials = typeof opts.username === 'string' && typeof opts.password === 'string';
    const credentials = hasTransientCredentials
      ? { username: opts.username, password: opts.password }
      : opts.instanceId ? loadRemoteBasicAuth(String(opts.instanceId)) : null;
    return probeUrl(target, target.origin, credentials);
  } catch (error: any) {
    return Promise.resolve({ online: false, error: error?.message || String(error) });
  }
}

// ---------------------------------------------------------------------------
// fetchReleases — 前端期望: { releases: GithubRelease[] }
// GithubRelease: { tag, zipballUrl, prerelease }
// ---------------------------------------------------------------------------

async function fetchReleases(): Promise<{ releases: any[] }> {
  const apiUrl = 'https://api.github.com/repos/SillyTavern/SillyTavern/releases?per_page=20';
  const candidates = [
    apiUrl,
    `https://gh-proxy.com/${apiUrl}`,
  ];
  let lastError: Error | null = null;

  for (const [index, url] of candidates.entries()) {
    try {
      const response = await net.fetch(url, {
      headers: {
        'User-Agent': 'SillyClient-Windows',
        'Accept': 'application/vnd.github+json',
      },
        signal: AbortSignal.timeout(index === 0 ? 8000 : 15000),
      });
      const payload = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const raw = JSON.parse(payload);
      if (!Array.isArray(raw)) {
        throw new Error('GitHub 返回了无法识别的版本数据');
      }

      const releases = raw.filter((release: any) => release.tag_name && release.zipball_url)
        .map((release: any) => ({
          tag: release.tag_name,
          zipballUrl: release.zipball_url,
          prerelease: release.prerelease,
        }));
      if (releases.length === 0) {
        throw new Error('GitHub 未返回可用的 SillyTavern 版本');
      }
      return { releases };
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    const response = await net.fetch(
      'https://data.jsdelivr.com/v1/package/gh/SillyTavern/SillyTavern',
      {
        headers: {
          'User-Agent': 'SillyClient-Windows',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    const raw = await response.json() as any;
    if (!response.ok || !Array.isArray(raw?.versions)) {
      throw new Error(`jsDelivr HTTP ${response.status}`);
    }

    const releases = raw.versions.slice(0, 20).map((version: string) => ({
      tag: version,
      zipballUrl: `https://github.com/SillyTavern/SillyTavern/archive/refs/tags/${encodeURIComponent(version)}.zip`,
      prerelease: version.includes('-'),
    }));
    if (releases.length > 0) {
      return { releases };
    }
  } catch (error: any) {
    lastError = error instanceof Error ? error : new Error(String(error));
  }

  throw new Error(`无法获取 SillyTavern 版本：${lastError?.message || '网络请求失败'}`);
}

// checkAppUpdate — 检查 SillyClient 主仓库的最新正式版本。
async function checkAppUpdate(): Promise<{
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  publishedAt?: string;
}> {
  const currentVersion = app.getVersion();
  const apiUrl = 'https://api.github.com/repos/CAPTCHAAAAA/SillyClient/releases/latest';
  let release: any = null;
  let lastError: Error | null = null;
  for (const [index, url] of [apiUrl, `https://gh-proxy.com/${apiUrl}`].entries()) {
    try {
      const response = await net.fetch(url, {
        headers: {
          'User-Agent': 'SillyClient-Windows',
          'Accept': 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(index === 0 ? 8000 : 15000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      release = await response.json() as any;
      if (release?.tag_name) break;
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
      release = null;
    }
  }

  let latestVersion = String(release?.tag_name || '').replace(/^v/i, '').trim();
  let releaseUrl = typeof release?.html_url === 'string' ? release.html_url : undefined;
  let publishedAt = typeof release?.published_at === 'string' ? release.published_at : undefined;
  if (!latestVersion) {
    try {
      const response = await net.fetch('https://data.jsdelivr.com/v1/package/gh/CAPTCHAAAAA/SillyClient', {
        headers: {
          'User-Agent': 'SillyClient-Windows',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });
      const metadata = await response.json() as any;
      if (!response.ok || !Array.isArray(metadata?.versions) || metadata.versions.length === 0) {
        throw new Error(`jsDelivr HTTP ${response.status}`);
      }
      latestVersion = String(metadata.versions[0] || '').replace(/^v/i, '').trim();
      releaseUrl = 'https://github.com/CAPTCHAAAAA/SillyClient/releases/latest';
      publishedAt = undefined;
    } catch (error: any) {
      const fallbackError = error instanceof Error ? error : new Error(String(error));
      throw new Error(`无法检查 SillyClient 更新：${fallbackError.message || lastError?.message || '网络请求失败'}`);
    }
  }
  if (!latestVersion) throw new Error('未找到最新版本');
  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareVersions(currentVersion, latestVersion) < 0,
    releaseUrl,
    publishedAt,
  };
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/i, '').split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
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
  const rawInstanceId = typeof opts?.instanceId === 'string' ? opts.instanceId : '';
  const instanceId = rawInstanceId.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80) || 'default';

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

  const dest = path.join(paths.coversDir, `${instanceId}${ext}`);
  const tempDest = `${dest}.tmp-${Date.now()}`;
  utils.copyFile(src, tempDest);
  fs.renameSync(tempDest, dest);
  // 新封面已经成功落盘后再清理旧扩展名，避免复制失败导致卡片丢图。
  for (const oldExt of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const oldFile = path.join(paths.coversDir, `${instanceId}${oldExt}`);
    if (oldFile !== dest && fs.existsSync(oldFile)) {
      try { fs.unlinkSync(oldFile); } catch { /* ignore */ }
    }
  }
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
