/**
 * TarvenEnv 插件 — Windows 实现
 *
 * 从 Android TarvenEnvPlugin.kt + MainActivity.kt 移植。
 * 不重写逻辑，仅做平台 API 替换：
 * - Android SAF 文件选择器 → Electron dialog
 * - Android ContentResolver → Node.js fs
 * - Android WebStorage → Electron session
 * - .so 伪装二进制 → 系统 node.exe
 * - /system/bin/sh → cmd.exe
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
// 状态
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let serverReady = false;
let currentUrl: string | null = null;
let currentPort = 0;

// ---------------------------------------------------------------------------
// 公开接口（供 main.ts 调用）
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

/** 事件推送 */
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
      return { success: true }; // Windows 上无下拉刷新
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
// provisionAndStart — 配置并启动本地 Node 实例
// 对应 Android MainActivity.kt provisionAndStart (324-426)
// ---------------------------------------------------------------------------

async function provisionAndStart(opts: any): Promise<{ success: boolean; error?: string }> {
  const {
    port,
    instanceId,
    version,
    zipballUrl,
    localZipPath,
    config,
  } = opts;

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

    // 需要安装的情况：server.js 或 node_modules 不存在
    const needInstall = !fs.existsSync(serverJs) || !fs.existsSync(nodeModules);

    if (needInstall) {
      progress(5, '安装中');

      // 优先本地 zip 导入
      if (localZipPath && fs.existsSync(localZipPath)) {
        log(`从本地 zip 安装: ${localZipPath}`);
        progress(15, '解压本地 zip');
        await utils.unzipToDir(localZipPath, targetServerDir);
      } else if (zipballUrl) {
        // 从 GitHub release 下载
        log(`下载: ${zipballUrl}`);
        progress(10, '下载源码');

        const tmpZip = path.join(paths.tmpDir, `${instanceId}.zip`);
        await downloadWithMirrors(zipballUrl, tmpZip, (pct) => {
          progress(10 + Math.floor(pct * 0.4), '下载中');
        }, log);

        progress(50, '解压源码');
        await utils.unzipToDir(tmpZip, targetServerDir);

        // 解压后可能有子目录（如 SillyTavern-1.12.x/），需要提升
        flattenExtractedDir(targetServerDir);

        // 清理临时 zip
        try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
      }

      // npm install
      progress(60, '安装依赖');
      await proc.runNpmInstall(targetServerDir, log);
    }

    // 写 config.yaml（对应 Android writeInstanceConfig）
    progress(85, '写入配置');
    writeInstanceConfig(targetServerDir, port, config);

    // 启动服务端
    progress(90, '启动服务');
    proc.startServer(targetServerDir, instanceId, port, log);

    // 轮询就绪
    progress(95, '等待就绪');
    const ready = await pollUntilReady(port, 180000, log);
    if (!ready) {
      throw new Error('服务启动超时（180s）');
    }

    serverReady = true;
    currentUrl = `http://127.0.0.1:${port}`;
    progress(100, '就绪');
    log('服务就绪', 'success');

    notify('ready', { ready: true, url: currentUrl, port });
    return { success: true };
  } catch (e: any) {
    log(`失败: ${e.message}`, 'error');
    notify('error', { message: e.message });
    return { success: false, error: e.message };
  }
}

/** 多镜像下载（对应 Android downloadAndExtractGithubRelease） */
async function downloadWithMirrors(
  originalUrl: string,
  destPath: string,
  onProgress: (pct: number) => void,
  log: (msg: string, level?: string) => void,
): Promise<void> {
  // 镜像列表（对应 Android 的镜像重试逻辑）
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

/** 解压后子目录提升（如 SillyTavern-1.12.x/ → 当前目录） */
function flattenExtractedDir(dir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    const subdir = path.join(dir, entries[0].name);
    const subEntries = fs.readdirSync(subdir);
    for (const entry of subEntries) {
      const src = path.join(subdir, entry);
      const dest = path.join(dir, entry);
      fs.renameSync(src, dest);
    }
    fs.rmdirSync(subdir);
  }
}

/** 写 config.yaml（对应 Android writeInstanceConfig） */
function writeInstanceConfig(serverDir: string, port: number, config: any): void {
  const yaml = [
    `port: ${port}`,
    `listen: ${config?.listen ?? true}`,
    `whitelistMode: false`,
    `securityOverride: true`,
    `listen: ${config?.listen ?? true}`,
    config?.ipv4 !== undefined ? `listenIPv4: ${config.ipv4}` : '',
    config?.ipv6 !== undefined ? `listenIPv6: ${config.ipv6}` : '',
    config?.dnsIpv6 !== undefined ? `dnsPreferIPv6: ${config.dnsIpv6}` : '',
    config?.heartbeat !== undefined ? `enableHeartbeat: ${config.heartbeat}` : '',
    config?.keepAlive !== undefined ? `autoRestartOnCrash: ${config.keepAlive}` : '',
  ].filter(Boolean).join('\n');

  utils.writeText(path.join(serverDir, 'config.yaml'), yaml);
}

/** 轮询直到 HTTP 就绪（对应 Android pollUntilReady） */
async function pollUntilReady(port: number, timeoutMs: number, log: (msg: string, level?: string) => void): Promise<boolean> {
  const start = Date.now();
  const url = `http://127.0.0.1:${port}`;

  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await tryConnect(url);
      if (ok) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** HTTP 探测（对应 Android tryConnect — 2xx-4xx 算就绪） */
function tryConnect(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// scanInstances — 扫描本地已安装实例
// 对应 Android MainActivity.kt scanInstances
// ---------------------------------------------------------------------------

function scanInstances(): any[] {
  const serversDir = path.join(paths.bootstrapDir, 'servers');
  if (!fs.existsSync(serversDir)) return [];

  const instances: any[] = [];
  const entries = fs.readdirSync(serversDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(serversDir, entry.name);
    const packageJsonPath = path.join(dir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      instances.push({
        instanceId: entry.name,
        name: pkg.name || entry.name,
        version: pkg.version || 'unknown',
        dir,
        size: utils.dirSize(dir),
      });
    } catch {
      // skip invalid package.json
    }
  }

  return instances;
}

// ---------------------------------------------------------------------------
// getInstanceInfo — 读取实例详情
// ---------------------------------------------------------------------------

function getInstanceInfo(opts: any): any {
  const { instanceId, port } = opts;
  const dir = paths.serverDirFor(instanceId);

  if (!fs.existsSync(dir)) {
    return { found: false };
  }

  const packageJsonPath = path.join(dir, 'package.json');
  let version = 'unknown';
  let name = instanceId;

  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      version = pkg.version || 'unknown';
      name = pkg.name || instanceId;
    } catch { /* ignore */ }
  }

  return {
    found: true,
    instanceId,
    name,
    version,
    dir,
    size: utils.dirSize(dir),
    running: proc.isServerRunning() && currentPort === port,
    port,
  };
}

// ---------------------------------------------------------------------------
// sendCommand — 向 shell 发送命令
// ---------------------------------------------------------------------------

function doSendCommand(opts: any): { success: boolean } {
  const { text } = opts;
  const cwd = path.join(paths.bootstrapDir, 'servers') || process.cwd();
  proc.sendCommand(text, cwd, (msg, level) => {
    notify('log', { message: msg, level });
  });
  return { success: true };
}

// ---------------------------------------------------------------------------
// pingUrl — HTTP HEAD 探测远程实例
// ---------------------------------------------------------------------------

function pingUrl(opts: any): Promise<{ online: boolean; statusCode?: number }> {
  return new Promise((resolve) => {
    const { url } = opts;
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.request(url, { method: 'HEAD', timeout: 10000 }, (res: any) => {
      res.destroy();
      resolve({ online: true, statusCode: res.statusCode });
    });

    req.on('error', () => resolve({ online: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ online: false });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// fetchReleases — 拉 GitHub releases 列表
// ---------------------------------------------------------------------------

function fetchReleases(): Promise<any[]> {
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
          const releases = JSON.parse(data);
          resolve(releases.map((r: any) => ({
            tagName: r.tag_name,
            name: r.name,
            publishedAt: r.published_at,
            zipballUrl: r.zipball_url,
            tarballUrl: r.tarball_url,
            body: r.body,
            prerelease: r.prerelease,
          })));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// pickDirectory — 系统目录选择器
// 对应 Android ACTION_OPEN_DOCUMENT_TREE
// ---------------------------------------------------------------------------

async function doPickDirectory(): Promise<{ path: string | null }> {
  if (!mainWindow) return { path: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return { path: result.canceled ? null : result.filePaths[0] };
}

// ---------------------------------------------------------------------------
// pickImage — 系统图片选择器 → 复制到 covers/
// 对应 Android MainActivity.copyCoverImage
// ---------------------------------------------------------------------------

async function doPickImage(opts: any): Promise<{ coverPath: string | null }> {
  if (!mainWindow) return { coverPath: null };
  const { instanceId } = opts;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择封面图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { coverPath: null };
  }

  const src = result.filePaths[0];
  const ext = path.extname(src);
  const dest = path.join(paths.coversDir, `${instanceId}${ext}`);

  if (!fs.existsSync(paths.coversDir)) {
    fs.mkdirSync(paths.coversDir, { recursive: true });
  }

  utils.copyFile(src, dest);
  return { coverPath: dest };
}

// ---------------------------------------------------------------------------
// pickZipFile — 系统文件选择器选 zip
// ---------------------------------------------------------------------------

async function doPickZipFile(): Promise<{ path: string | null }> {
  if (!mainWindow) return { path: null };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 zip 文件',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });

  return { path: result.canceled ? null : result.filePaths[0] };
}

// ---------------------------------------------------------------------------
// uninstallInstance — 删除实例目录 + 封面
// ---------------------------------------------------------------------------

function uninstallInstance(opts: any): { success: boolean } {
  const { instanceId } = opts;
  const dir = paths.serverDirFor(instanceId);

  if (fs.existsSync(dir)) {
    utils.removeDir(dir);
  }

  // 删除封面图
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const cover = path.join(paths.coversDir, `${instanceId}${ext}`);
    if (fs.existsSync(cover)) {
      try { fs.unlinkSync(cover); } catch { /* ignore */ }
    }
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// cleanGarbage — 扫描孤立文件/缓存
// ---------------------------------------------------------------------------

function cleanGarbage(opts: any): any[] {
  const { dryRun = true } = opts;
  const items: any[] = [];

  // 1. 孤立实例目录（servers/ 下不在 localStorage 中的）
  const serversDir = path.join(paths.bootstrapDir, 'servers');
  if (fs.existsSync(serversDir)) {
    for (const entry of fs.readdirSync(serversDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      // 简单扫描，前端会过滤已知实例
      const dir = path.join(serversDir, entry.name);
      const pkgJson = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgJson)) {
        items.push({
          type: 'orphan_instance',
          path: dir,
          size: utils.dirSize(dir),
          label: `孤立实例: ${entry.name}`,
        });
      }
    }
  }

  // 2. 孤立封面图
  if (fs.existsSync(paths.coversDir)) {
    for (const entry of fs.readdirSync(paths.coversDir)) {
      const ext = path.extname(entry);
      const id = path.basename(entry, ext);
      items.push({
        type: 'orphan_cover',
        path: path.join(paths.coversDir, entry),
        size: fs.statSync(path.join(paths.coversDir, entry)).size,
        label: `封面图: ${entry}`,
      });
    }
  }

  // 3. 临时文件
  if (fs.existsSync(paths.tmpDir)) {
    for (const entry of fs.readdirSync(paths.tmpDir)) {
      const fp = path.join(paths.tmpDir, entry);
      items.push({
        type: 'temp',
        path: fp,
        size: fs.statSync(fp).size,
        label: `临时文件: ${entry}`,
      });
    }
  }

  // 4. 日志文件
  if (fs.existsSync(paths.logsDir)) {
    for (const entry of fs.readdirSync(paths.logsDir)) {
      const fp = path.join(paths.logsDir, entry);
      items.push({
        type: 'log',
        path: fp,
        size: fs.statSync(fp).size,
        label: `日志: ${entry}`,
      });
    }
  }

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

  return items;
}

// ---------------------------------------------------------------------------
// deleteGarbageItem — 按路径删除垃圾项
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
