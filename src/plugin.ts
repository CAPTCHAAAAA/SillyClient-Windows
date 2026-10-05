/**
 * TarvenEnv 插件 — Windows 实现
 *
 * 从 Android TarvenEnvPlugin.kt + MainActivity.kt 移植。
 * 返回类型严格匹配前端 capacitor-plugin.ts 的接口定义。
 */

import { BrowserWindow, dialog, net } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import * as nodeNet from 'node:net';
import { randomUUID } from 'node:crypto';

import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as utils from './runtime/utils';
import * as instanceStore from './runtime/instances';
import { installCompanionPreset } from './runtime/companion-presets';
import type { CompanionPresetTransaction } from './runtime/companion-presets';
import { OperationCoordinator, OperationContext, checkSignal, delay } from './runtime/operations';
import { directorySize, invalidateDirectorySize } from './runtime/directory-stats';
import { CleanupService, assertPlainPath } from './runtime/cleanup';
import { copyMigration, directoryContentIdentity, resolveTakeoverSource } from './runtime/migration';
import { ensureInstanceDependencies } from './runtime/dependencies';
import { InstanceMaintenanceService } from './runtime/instance-maintenance';
import { resolveInstanceDataRoot } from './runtime/instance-config';
import { checkLegacyInstances, relocateInstance, migrateLegacyInstances } from './runtime/relocate';
import { renameInstance } from './runtime/rename';
import {
  installPreselectedExtensions, validatePreinstallSelection, ExtensionInstallTransaction,
} from './runtime/preinstalled-extensions';
import {
  clearRemoteBasicAuth,
  getRemoteBasicAuthStatus,
  loadRemoteBasicAuth,
  RemoteBasicAuthCredentials,
  saveRemoteBasicAuth,
} from './remote-auth';
import {
  clearInstancePassword,
  hasInstancePassword,
  listInstancePasswordStatus,
  removeInstancePassword,
  setInstancePassword,
  verifyInstancePassword,
} from './runtime/instance-lock';

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
let currentInstanceId: string | null = null;
let currentServerDir: string | null = null;
let currentOperationId: string | null = null;
const operations = new OperationCoordinator();
let staleUsageSessionsSettled = false;
let usageCheckpointTimer: ReturnType<typeof setInterval> | null = null;
let cleanupCompleted = false;
let cleanupPromise: Promise<void> | null = null;
const garbage = new CleanupService({
  servers: path.join(paths.bootstrapDir, 'servers'),
  covers: paths.coversDir,
  temporary: paths.tmpDir,
  logs: paths.logsDir,
}, () => ({
  records: instanceStore.listInstanceRecords(),
  activeDirectories: [...proc.activeProcessDirectories(), ...(currentServerDir ? [currentServerDir] : [])],
  activeInstanceIds: [currentInstanceId, operations.getActive()?.instanceId].filter((id): id is string => Boolean(id)),
  protectedPaths: [],
}));
const maintenance = new InstanceMaintenanceService({
  resolveInstance(instanceId) {
    const record = instanceStore.getInstanceRecord(instanceId);
    if (!record) throw new Error('只支持已登记的本地实例');
    return {
      directory: record.path, isTakeover: record.isTakeover,
      shared: instanceStore.listInstanceRecords().some((other) => other.instanceId !== record.instanceId
        && path.resolve(other.path).toLowerCase() === path.resolve(record.path).toLowerCase()),
    };
  },
  resolveDataRoot: resolveInstanceDataRoot,
  isBusy: () => cleanupCompleted || !!operations.getActive() || serverReady
    || proc.isServerRunning() || proc.activeProcessDirectories().length > 0,
  commit: (work) => operations.enqueue(work),
});

// ---------------------------------------------------------------------------
// 公开接口
// ---------------------------------------------------------------------------

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
  if (win) {
    cleanupCompleted = false;
    cleanupPromise = null;
  }
}

export function isServerReady(): boolean {
  return serverReady;
}

export function getCurrentUrl(): string | null {
  return currentUrl;
}

export function getCurrentInstanceId(): string | null {
  return currentInstanceId;
}

export function getCurrentOperationId(): string | null {
  return currentOperationId;
}

export function canCloseTavern(options?: { instanceId?: string; operationId?: string }): boolean {
  return !(options?.instanceId || options?.operationId) || matchesRun(options) || operations.matches(options);
}

function matchesRun(options?: { instanceId?: string; operationId?: string }): boolean {
  return Boolean(currentInstanceId) && (!options?.instanceId || options.instanceId === currentInstanceId)
    && (!options?.operationId || options.operationId === currentOperationId);
}

export function stopCurrentServer(options?: { instanceId?: string; operationId?: string }): Promise<void> {
  const scoped = Boolean(options?.instanceId || options?.operationId);
  const runningMatches = matchesRun(options);
  const pendingMatches = operations.matches(options);
  if (scoped && !runningMatches && !pendingMatches) return Promise.resolve();
  operations.cancel(options);
  garbage.invalidate();
  maintenance.invalidate();
  return operations.enqueue(async () => {
    if (!scoped || runningMatches) await stopCurrentServerInternal(true, options);
  });
}

async function stopCurrentServerInternal(
  emitEvents: boolean,
  options?: { instanceId?: string; operationId?: string },
): Promise<void> {
  if ((options?.instanceId || options?.operationId) && !matchesRun(options)) return;
  const stoppedInstanceId = currentInstanceId;
  const stoppedOperationId = currentOperationId;
  await proc.stopServer();
  stopUsageCheckpoint();
  currentInstanceId = null;
  currentServerDir = null;
  currentOperationId = null;
  const usage = stoppedInstanceId ? instanceStore.finishInstanceUsage(stoppedInstanceId) : null;
  serverReady = false;
  currentUrl = null;
  currentPort = 0;
  if (emitEvents) {
    notify('ready', { ready: false, instanceId: stoppedInstanceId, operationId: stoppedOperationId });
    notify('mode', {
      mode: 'launcher',
      tavernRunning: false,
      instanceId: stoppedInstanceId,
      operationId: stoppedOperationId,
      lastUsedAt: usage?.lastUsedAt,
      totalUsageMs: usage?.totalUsageMs,
    });
  }
}

function startUsageCheckpoint(instanceId: string): void {
  stopUsageCheckpoint();
  usageCheckpointTimer = setInterval(() => {
    if (currentInstanceId === instanceId && proc.isServerRunning()) {
      instanceStore.checkpointInstanceUsage(instanceId);
    }
  }, 15000);
}

function stopUsageCheckpoint(): void {
  if (!usageCheckpointTimer) return;
  clearInterval(usageCheckpointTimer);
  usageCheckpointTimer = null;
}

export function cleanup(): Promise<void> {
  if (cleanupPromise) return cleanupPromise;
  cleanupCompleted = true;
  operations.cancel();
  garbage.invalidate();
  maintenance.invalidate();
  cleanupPromise = operations.enqueue(async () => {
    await stopCurrentServerInternal(false);
    await proc.stopAllProcesses();
    mainWindow = null;
  }).catch((error) => {
    cleanupPromise = null;
    cleanupCompleted = false;
    throw error;
  });
  return cleanupPromise;
}

export function notify(eventName: string, data: any): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(`tarven:${eventName}`, data);
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
    case 'closeTavern':
      return stopCurrentServer(options).then(() => ({ success: true }));
    case 'getStatus':
      return {
        mode: 'launcher', serverReady, url: currentUrl,
        instanceId: serverReady ? currentInstanceId : undefined,
        operationId: serverReady ? currentOperationId : undefined,
      };
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
    case 'pickDirectory':
      return doPickDirectory(options);
    case 'pickImage':
      return doPickImage(options);
    case 'pickZipFile':
      return doPickZipFile();
    case 'saveTextFile':
      return doSaveTextFile(options);
    case 'readTextFile':
      return doReadTextFile(options);
    case 'uninstallInstance':
      return uninstallInstance(options);
    case 'cleanGarbage':
      return cleanGarbage(options);
    case 'deleteGarbageItem':
      return deleteGarbageItem(options);
    case 'scanInstanceMaintenance':
      return maintenance.scan(options?.instanceId);
    case 'applyInstanceMaintenance':
      return maintenance.apply(options?.instanceId, options?.scanId, options?.items);
    case 'listInstanceMaintenanceRecovery':
      return maintenance.listRecovery(options?.instanceId);
    case 'restoreInstanceMaintenance':
      return maintenance.restore(options?.instanceId, options?.recoveryId, options?.token);
    case 'migrateInstance':
      return doMigrateInstance(options);
    case 'checkLegacyInstances':
      return checkLegacyInstances();
    case 'relocateInstance':
      return relocateInstance(options, currentInstanceId);
    case 'migrateLegacyInstances':
      return migrateLegacyInstances(options, currentInstanceId);
    case 'renameInstance':
      return renameInstance(options, currentInstanceId);
    case 'setInstancePassword':
      return setInstancePassword(options.instanceId, options.password, options.oldPassword);
    case 'verifyInstancePassword':
      return { valid: verifyInstancePassword(options.instanceId, options.password) };
    case 'hasInstancePassword':
      return { hasPassword: hasInstancePassword(options.instanceId) };
    case 'clearInstancePassword':
      return clearInstancePassword(options.instanceId, options.oldPassword);
    case 'listInstancePasswordStatus':
      return listInstancePasswordStatus();
    default:
      throw new Error(`未知方法: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// 端口检测 — 检查端口是否可用，不可用则递增
// ---------------------------------------------------------------------------

function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = nodeNet.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

async function findAvailablePort(
  startPort: number,
  log: (msg: string, level?: string) => void,
  signal?: AbortSignal,
  host = '127.0.0.1',
): Promise<number> {
  for (let p = startPort; p < Math.min(65536, startPort + 100); p++) {
    checkSignal(signal);
    if (await isPortAvailable(p, host)) return p;
  }
  log(`端口 ${startPort}-${Math.min(65535, startPort + 99)} 全部不可用`, 'error');
  throw new Error('No available server port');
}

// ---------------------------------------------------------------------------
// provisionAndStart — 配置并启动本地 Node 实例
// 前端期望返回: { ready: boolean }
// ---------------------------------------------------------------------------

async function provisionAndStart(opts: any): Promise<{ ready: boolean }> {
  if (cleanupCompleted) throw new Error('Application is shutting down');
  const preinstall = validatePreinstallSelection(opts?.preinstall);
  const safeInstanceId = paths.normalizeInstanceId(opts?.instanceId || '');
  garbage.invalidate();
  maintenance.invalidate();
  try {
    return await operations.runLatest(safeInstanceId, opts?.operationId,
      (context) => provisionInstance({ ...opts, preinstall }, context));
  } catch (error: any) {
    if (error?.name === 'AbortError') return { ready: false };
    throw error;
  }
}

async function provisionInstance(opts: any, context: OperationContext): Promise<{ ready: boolean }> {
  const { zipballUrl, localZipPath, config, installPath, installPathMode, companionPreset } = opts || {};
  const port = opts?.port;
  const safeInstanceId = context.instanceId;
  const eventContext = { instanceId: safeInstanceId, operationId: context.operationId };
  const log = (msg: string, level?: string) => {
    if (!context.signal.aborted) notify('log', { message: msg, level, ...eventContext });
  };
  const progress = (pct: number, text?: string) => {
    if (!context.signal.aborted) notify('progress', { percent: pct, stage: text, ...eventContext });
  };
  let createdThisRun = false;
  let targetServerDir = '';
  let stagingDirectory = '';
  let createdDirectoryIdentity = '';
  let createdContentIdentity: string | null = null;
  let temporaryArchive = '';
  let companionPresetTransaction: CompanionPresetTransaction | null = null;
  let extensionTransaction: ExtensionInstallTransaction | null = null;

  try {
    context.check();
    serverLaunchArguments(port, config);
    targetServerDir = resolveInstanceDir(safeInstanceId, installPath, installPathMode);
    const existingOtherRecord = instanceStore.listInstanceRecords().find(
      (r) => r.instanceId !== safeInstanceId && path.resolve(r.path).toLowerCase() === path.resolve(targetServerDir).toLowerCase()
    );
    if (existingOtherRecord) {
      throw new Error(`目标路径已由其他实例「${existingOtherRecord.instanceId}」登记使用`);
    }
    const record = instanceStore.getInstanceRecord(safeInstanceId);
    const targetExisted = fs.existsSync(targetServerDir);
    if (record && !targetExisted) {
      throw new Error('Registered installation directory is missing; its original path was preserved');
    }
    if (targetExisted) {
      const stat = await assertPlainPath(targetServerDir);
      if (!stat.isDirectory()) throw new Error('Installation path is not a directory');
    }
    const serverJs = path.join(targetServerDir, 'server.js');
    const packageJson = path.join(targetServerDir, 'package.json');
    const needSource = !fs.existsSync(serverJs) || !fs.existsSync(packageJson);
    if (record?.isTakeover) {
      if (companionPreset) throw new Error('Theme presets cannot modify a takeover source');
      if (opts.preinstall?.extensionIds.length) throw new Error('Preinstalled extensions cannot modify a takeover source');
      if (needSource) throw new Error('Takeover source is incomplete; source files were preserved');
    }
    if (needSource && targetExisted && fs.readdirSync(targetServerDir).length) {
      throw new Error('Refusing to replace an incomplete nonempty instance directory');
    }
    context.check();
    paths.ensureDirs();
    await stopCurrentServerInternal(true);
    context.check();
    if (!targetExisted) {
      fs.mkdirSync(path.dirname(targetServerDir), { recursive: true });
      await assertPlainPath(path.dirname(targetServerDir));
    }
    const createdAt = record?.createdAt
      || (needSource ? new Date().toISOString() : undefined);

    if (needSource) {
      stagingDirectory = path.join(path.dirname(targetServerDir), `.sillyclient-stage-${randomUUID()}`);
      fs.mkdirSync(stagingDirectory);
      progress(5, '安装中');
      if (localZipPath) {
        if (!fs.existsSync(localZipPath)) throw new Error('选择的本地压缩包不存在');
        log(`从本地 zip 安装: ${localZipPath}`);
        progress(15, '解压本地 zip');
        await utils.unzipToDir(localZipPath, stagingDirectory, { signal: context.signal });
        context.check();
        flattenExtractedDir(stagingDirectory);
      } else if (zipballUrl) {
        log(`下载: ${zipballUrl}`);
        progress(10, '下载源码');
        temporaryArchive = path.join(paths.tmpDir, `${safeInstanceId}-${randomUUID()}.zip`);
        await downloadWithMirrors(zipballUrl, temporaryArchive, (pct) => {
          progress(10 + Math.floor(pct * 0.4), '下载中');
        }, log, context.signal);
        context.check();
        progress(50, '解压源码');
        await utils.unzipToDir(temporaryArchive, stagingDirectory, { signal: context.signal });
        context.check();
        flattenExtractedDir(stagingDirectory);
        await fs.promises.rm(temporaryArchive, { force: true });
        temporaryArchive = '';
      } else {
        throw new Error('未获取到 SillyTavern 当前版本，请检查网络后重试');
      }
      if (!fs.existsSync(path.join(stagingDirectory, 'server.js'))
        || !fs.existsSync(path.join(stagingDirectory, 'package.json'))) {
        throw new Error('下载内容不完整，未找到 SillyTavern 启动文件');
      }
    }
    const installationDirectory = stagingDirectory || targetServerDir;
    if (!fs.existsSync(path.join(installationDirectory, 'node_modules'))) {
      progress(60, '安装依赖');
    }
    await ensureInstanceDependencies(installationDirectory, log, {
      signal: context.signal, isTakeover: record?.isTakeover,
    });
    context.check();
    if (stagingDirectory) {
      if (targetExisted) {
        await assertPlainPath(targetServerDir);
        // rmdir refuses a directory populated after our initial check.
        await fs.promises.rmdir(targetServerDir);
      } else if (fs.existsSync(targetServerDir)) {
        throw new Error('Installation target appeared while preparing the source');
      }
      context.check();
      createdContentIdentity = await directoryContentIdentity(stagingDirectory, context.signal);
      context.check();
      await fs.promises.rename(stagingDirectory, targetServerDir);
      stagingDirectory = '';
      createdThisRun = true;
      const stat = fs.lstatSync(targetServerDir);
      createdDirectoryIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      invalidateDirectorySize(targetServerDir);
    }
    if (companionPreset) {
      progress(82, '应用主题预设');
      companionPresetTransaction = await installCompanionPreset(targetServerDir, companionPreset, undefined, {
        signal: context.signal,
      });
      log(companionPresetTransaction.applied ? '已应用 SC Bordeaux 主题预设' : 'SC Bordeaux 主题预设已就绪');
    }
    if (opts.preinstall?.extensionIds.length) {
      progress(83, '安装预设扩展');
      extensionTransaction = await installPreselectedExtensions(targetServerDir, opts.preinstall, {
        signal: context.signal,
        operationId: context.operationId,
        log,
        progress: (percent, stage) => progress(83 + Math.floor(percent * 0.06), stage),
      });
    }
    context.check();
    const ipv6Only = config?.ipv4 === false && config?.ipv6 === true;
    const connectionHost = ipv6Only ? '[::1]' : '127.0.0.1';
    const actualPort = await findAvailablePort(port, log, context.signal, ipv6Only ? '::1' : '127.0.0.1');
    context.check();
    if (actualPort !== port) log(`端口 ${port} 被占用或保留，改用 ${actualPort}`);
    currentPort = actualPort;
    // CLI overrides preserve existing config, custom dataRoot, authentication and scripts.
    // A new source without config receives only the existing launcher defaults.
    if (createdThisRun && !fs.existsSync(path.join(targetServerDir, 'config.yaml'))) {
      writeInstanceConfig(targetServerDir, actualPort, config);
    }
    const args = serverLaunchArguments(actualPort, config);
    progress(90, '启动服务');
    currentInstanceId = safeInstanceId;
    currentServerDir = targetServerDir;
    currentOperationId = context.operationId;
    proc.startServer(targetServerDir, safeInstanceId, actualPort, log, () => {
      if (currentInstanceId !== safeInstanceId || currentOperationId !== context.operationId) return;
      stopUsageCheckpoint();
      currentInstanceId = null;
      currentServerDir = null;
      currentOperationId = null;
      serverReady = false;
      currentUrl = null;
      currentPort = 0;
      const usage = instanceStore.finishInstanceUsage(safeInstanceId);
      if (!cleanupCompleted) {
        notify('ready', { ready: false, ...eventContext });
        notify('mode', {
          mode: 'launcher', tavernRunning: false, ...eventContext,
          lastUsedAt: usage?.lastUsedAt, totalUsageMs: usage?.totalUsageMs,
        });
      }
    }, { args, operationId: context.operationId });
    progress(95, '等待就绪');
    const ready = await pollUntilReady(actualPort, 180000, log, context.signal, connectionHost);
    context.check();
    if (!ready) throw new Error('服务启动超时（180s）');
    if (!proc.isServerRunning() || currentInstanceId !== safeInstanceId || currentOperationId !== context.operationId) {
      throw new Error('服务在完成启动前已退出');
    }
    serverReady = true;
    currentUrl = `http://${connectionHost}:${actualPort}`;
    instanceStore.registerInstance(safeInstanceId, targetServerDir, createdAt);
    instanceStore.beginInstanceUsage(safeInstanceId, targetServerDir);
    startUsageCheckpoint(safeInstanceId);
    companionPresetTransaction?.commit();
    extensionTransaction?.commit();
    progress(100, '就绪');
    log('服务就绪', 'success');

    notify('ready', { ready: true, url: currentUrl, port: actualPort, ...eventContext });
    return { ready: true };
  } catch (e: any) {
    if (currentOperationId === context.operationId) await stopCurrentServerInternal(false);
    await extensionTransaction?.rollback();
    companionPresetTransaction?.rollback();
    if (temporaryArchive) await fs.promises.rm(temporaryArchive, { force: true });
    if (stagingDirectory) {
      await assertPlainPath(stagingDirectory, true);
      if (proc.activeProcessDirectories().includes(stagingDirectory)) throw new Error('Staging process has not exited');
      await utils.removeDirWithRetries(stagingDirectory);
    }
    if (createdThisRun && targetServerDir) {
      const stat = await assertPlainPath(targetServerDir, true);
      if (`${stat.dev}:${stat.ino}:${stat.birthtimeMs}` !== createdDirectoryIdentity) {
        throw new Error('Installation target ownership changed; incomplete files preserved');
      }
      if (proc.activeProcessDirectories().includes(targetServerDir)) throw new Error('Installation process has not exited');
      if (createdContentIdentity === null) {
        throw new Error('Installation target content ownership is unknown; files were preserved');
      }
      if (await directoryContentIdentity(targetServerDir) !== createdContentIdentity) {
        throw new Error('Installation target contents changed; files were preserved');
      }
      await utils.removeDirWithRetries(targetServerDir);
    }
    if (!context.signal.aborted) {
      log(`失败: ${e.message}`, 'error');
      notify('error', { message: e.message, ...eventContext });
    }
    return { ready: false };
  }
}

function resolveInstanceDir(instanceId: string, installPath?: string, installPathMode?: paths.InstallPathMode): string {
  const recorded = instanceStore.getInstanceRecord(instanceId)?.path;
  if (installPath !== undefined || installPathMode !== undefined) {
    const selected = paths.serverDirFor(instanceId, installPath, installPathMode);
    if (recorded) {
      if (installPath?.trim() && path.resolve(selected).toLowerCase() !== path.resolve(recorded).toLowerCase()) {
        throw new Error('Selected installation path conflicts with the registered instance');
      }
      return recorded;
    }
    return selected;
  }
  // Missing registrations retain their original path, never a same-ID default.
  if (recorded) return recorded;
  const defaultDir = paths.serverDirFor(instanceId);
  if (fs.existsSync(defaultDir)) return defaultDir;
  if (instanceId.startsWith('local-')) {
    const fallbackId = instanceId.replace('local-', 'new-');
    const fallbackRecord = instanceStore.getInstanceRecord(fallbackId)?.path;
    if (fallbackRecord) return fallbackRecord;
    const fallbackDir = paths.serverDirFor(fallbackId);
    if (fs.existsSync(fallbackDir)) return fallbackDir;
  } else if (instanceId.startsWith('new-')) {
    const fallbackId = instanceId.replace('new-', 'local-');
    const fallbackRecord = instanceStore.getInstanceRecord(fallbackId)?.path;
    if (fallbackRecord) return fallbackRecord;
    const fallbackDir = paths.serverDirFor(fallbackId);
    if (fs.existsSync(fallbackDir)) return fallbackDir;
  }
  return defaultDir;
}

async function downloadWithMirrors(
  originalUrl: string,
  destPath: string,
  onProgress: (pct: number) => void,
  log: (msg: string, level?: string) => void,
  signal?: AbortSignal,
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
      checkSignal(signal);
      try {
        log(`下载 (镜像 ${i + 1}/${mirrors.length}, 重试 ${retry + 1}/2)`);
        await utils.downloadFile(mirrors[i], destPath, onProgress, signal);
        checkSignal(signal);
        return;
      } catch (e: any) {
        checkSignal(signal);
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
  while (true) {
    if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'package.json'))) break;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    const subdir = path.join(dir, entries[0].name);
    const tempHolder = path.join(path.dirname(dir), `.flatten-${randomUUID()}`);
    fs.renameSync(subdir, tempHolder);
    try {
      for (const entry of fs.readdirSync(tempHolder)) {
        fs.renameSync(path.join(tempHolder, entry), path.join(dir, entry));
      }
    } finally {
      if (fs.existsSync(tempHolder)) {
        fs.rmSync(tempHolder, { recursive: true, force: true });
      }
    }
  }
}

function writeInstanceConfig(serverDir: string, port: number, config: any): void {
  const c = config || {};
  const yaml = [
    `port: ${port}`,
    `listen: ${c.listen ?? true}`,
    `whitelistMode: false`,
    `securityOverride: true`,
    'protocol:',
    `  ipv4: ${c.ipv4 ?? true}`,
    `  ipv6: ${c.ipv6 ?? false}`,
    c.dnsIpv6 !== undefined ? `dnsPreferIPv6: ${c.dnsIpv6}` : '',
    c.heartbeat !== undefined ? `heartbeatInterval: ${c.heartbeat}` : '',
    c.keepAlive !== undefined ? `enableKeepAlive: ${c.keepAlive}` : '',
  ].filter(Boolean).join('\n');

  utils.writeText(path.join(serverDir, 'config.yaml'), yaml);
}

function serverLaunchArguments(port: number, config: any): string[] {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port');
  if (config !== undefined && (!config || typeof config !== 'object' || Array.isArray(config))) {
    throw new Error('Invalid runtime configuration: expected an object');
  }
  if (config !== undefined) {
    const prototype = Object.getPrototypeOf(config);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Invalid runtime configuration: expected a plain object');
    }
  }
  const supportedKeys = ['listen', 'ipv4', 'ipv6', 'dnsIpv6', 'keepAlive', 'heartbeat'];
  for (const key of Object.keys(config || {})) {
    if (!supportedKeys.includes(key)) throw new Error(`Unknown runtime configuration key: ${key}`);
  }
  const args = ['--port', String(port), '--browserLaunchEnabled', 'false'];
  const flags: [string, string, unknown][] = [
    ['listen', 'listen', config?.listen],
    ['ipv4', 'enableIPv4', config?.ipv4],
    ['ipv6', 'enableIPv6', config?.ipv6],
    ['dnsIpv6', 'dnsPreferIPv6', config?.dnsIpv6],
    ['keepAlive', 'enableKeepAlive', config?.keepAlive],
  ];
  for (const [key, name, value] of flags) {
    if (value === undefined) continue;
    if (typeof value !== 'boolean') throw new Error(`Invalid runtime flag: ${key}`);
    args.push(`--${name}`, String(value));
  }
  const heartbeat = config?.heartbeat;
  if (heartbeat !== undefined) {
    if (!Number.isInteger(heartbeat) || heartbeat < 0 || heartbeat > 2147483647) {
      throw new Error('Invalid heartbeat interval');
    }
    args.push('--heartbeatInterval', String(heartbeat));
  }
  if (config?.ipv4 === false && config?.ipv6 === false) throw new Error('At least one IP protocol must be enabled');
  if (config?.ipv6 === false && config?.ipv4 === undefined) args.push('--enableIPv4', 'true');
  if (config?.ipv4 === false && config?.ipv6 === undefined) {
    throw new Error('IPv6 must be explicitly enabled when IPv4 is disabled');
  }
  return args;
}

async function pollUntilReady(
  port: number,
  timeoutMs: number,
  log: (msg: string, level?: string) => void,
  signal?: AbortSignal,
  host = '127.0.0.1',
): Promise<boolean> {
  const start = Date.now();
  const url = `http://${host}:${port}`;
  while (Date.now() - start < timeoutMs) {
    checkSignal(signal);
    if (!proc.isServerRunning()) return false;
    try {
      if (await tryConnect(url, signal)) return true;
    } catch {
      checkSignal(signal);
    }
    await delay(200, signal);
  }
  return false;
}

function tryConnect(url: string, signal?: AbortSignal): Promise<boolean> {
  checkSignal(signal);
  return new Promise((resolve) => {
    const req = http.get(url, { signal }, (res) => {
      res.destroy();
      // A protected existing instance is ready even if it requests authentication.
      resolve(res.statusCode !== undefined
        && (res.statusCode < 400 || [401, 403].includes(res.statusCode)));
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
  const repository = new instanceStore.InstanceRepository();
  if (!staleUsageSessionsSettled) {
    repository.finishStaleSessions(currentInstanceId ? [currentInstanceId] : []);
    staleUsageSessionsSettled = true;
  }
  const candidates = new Map<string, string>();
  for (const record of repository.list()) {
    candidates.set(record.instanceId, record.path);
  }
  const appInstancesDir = paths.appInstancesDir || path.join(paths.bootstrapDir, 'instances');
  const legacyServersDir = paths.legacyServersDir || path.join(paths.bootstrapDir, 'servers');
  // 1. 扫描软件目录下的 instances/ 目录
  if (appInstancesDir && fs.existsSync(appInstancesDir)) {
    for (const entry of fs.readdirSync(appInstancesDir, { withFileTypes: true })) {
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (!entry.isDirectory() || candidates.has(instanceId)) continue;
      candidates.set(instanceId, path.join(appInstancesDir, entry.name));
    }
  }
  // 2. 兼容扫描旧版 C 盘下的 servers/ 目录
  if (legacyServersDir && fs.existsSync(legacyServersDir)) {
    for (const entry of fs.readdirSync(legacyServersDir, { withFileTypes: true })) {
      const instanceId = paths.normalizeInstanceId(entry.name);
      if (!entry.isDirectory() || candidates.has(instanceId)) continue;
      candidates.set(instanceId, path.join(legacyServersDir, entry.name));
    }
  }
  const instances: any[] = [];
  for (const [instanceId, dir] of candidates) {
    const packageJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const record = repository.register(instanceId, dir);
      const usage = instanceStore.usageForRecord(record);
      instances.push({
        instanceId,
        version: pkg.version || 'unknown',
        path: dir,
        sizeBytes: 0, // 启动自检不阻塞递归扫描磁盘；具体大小在关于页由 getInstanceInfo 获取
        hasServer: fs.existsSync(path.join(dir, 'server.js')),
        createdAt: usage.createdAt,
        lastUsedAt: usage.lastUsedAt,
        totalUsageMs: usage.totalUsageMs,
      });
    } catch { /* skip */ }
  }
  repository.commit();
  return { instances };
}

// ---------------------------------------------------------------------------
// getInstanceInfo — 前端期望: InstanceInfo
// { instanceId, version, path, sizeBytes, createdAt, status }
// ---------------------------------------------------------------------------

async function getInstanceInfo(opts: any): Promise<any> {
  const { instanceId, installPath, installPathMode, port } = opts;
  const safeInstanceId = paths.normalizeInstanceId(instanceId);
  const dir = resolveInstanceDir(safeInstanceId, installPath, installPathMode);

  if (!fs.existsSync(dir)) {
    return {
      instanceId: safeInstanceId,
      version: 'unknown',
      path: dir,
      sizeBytes: 0,
      createdAt: '',
      lastUsedAt: '',
      totalUsageMs: 0,
      status: 'not_found',
    };
  }

  let version = 'unknown';
  if (fs.existsSync(path.join(dir, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
      version = pkg.version || 'unknown';
    } catch { /* ignore */ }
  }

  const record = instanceStore.registerInstance(safeInstanceId, dir);
  const usage = instanceStore.usageForRecord(record);
  const status = (proc.isServerRunning() && currentInstanceId === safeInstanceId && currentPort === port)
    ? 'running'
    : 'stopped';

  return {
    instanceId: safeInstanceId,
    version,
    path: dir,
    sizeBytes: await directorySize(dir),
    createdAt: usage.createdAt || '',
    lastUsedAt: usage.lastUsedAt || '',
    totalUsageMs: usage.totalUsageMs,
    status,
  };
}

// ---------------------------------------------------------------------------
// sendCommand — 前端期望: void
// ---------------------------------------------------------------------------

async function doSendCommand(opts: any): Promise<void> {
  const { text, instanceId } = opts;
  const normalizedId = typeof instanceId === 'string' ? instanceId.trim() : '';
  const commandOperationId = normalizedId === currentInstanceId ? currentOperationId || undefined : opts?.operationId;
  const commandContext = { instanceId: normalizedId || undefined, operationId: commandOperationId, source: 'command' };
  if (!normalizedId) {
    notify('log', { message: '缺少实例标识，无法打开实例终端', level: 'error', ...commandContext });
    return;
  }
  const cwd = resolveInstanceDir(normalizedId);
  if (!fs.existsSync(cwd)) {
    notify('log', { message: `实例目录不存在：${normalizedId}`, level: 'error', ...commandContext });
    return;
  }
  await proc.sendCommand(text, cwd, (msg, level) => {
    notify('log', { message: msg, level, ...commandContext });
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

// ---------------------------------------------------------------------------
// pickDirectory — 前端期望: { name, path }
// ---------------------------------------------------------------------------

async function doPickDirectory(options?: { purpose?: 'installation' | 'source' }): Promise<{
  name: string; path: string; installPathMode?: 'root' | 'exact';
}> {
  const purpose = options?.purpose;
  if (purpose !== undefined && purpose !== 'installation' && purpose !== 'source') {
    throw new Error('Invalid directory picker purpose');
  }
  if (!mainWindow || mainWindow.isDestroyed()) return { name: '', path: '' };
  const result = await dialog.showOpenDialog(mainWindow, {
    ...(purpose === 'installation' ? { title: '选择实例安装根目录' } : {}),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { name: '', path: '' };
  }
  const p = result.filePaths[0];
  return {
    name: path.basename(p), path: p,
    ...(purpose === 'installation' ? { installPathMode: 'root' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// pickImage — 前端期望: { path }
// ---------------------------------------------------------------------------

async function doPickImage(opts: any): Promise<{ path: string; url?: string }> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('主窗口不可用，无法打开图片选择器');
  }
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
  const ext = path.extname(src).toLowerCase();

  if (!fs.existsSync(paths.coversDir)) {
    fs.mkdirSync(paths.coversDir, { recursive: true });
  }

  const dest = path.join(
    paths.coversDir,
    `${instanceId}--cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );
  garbage.invalidate();
  maintenance.invalidate();
  await assertPlainPath(paths.coversDir);
  utils.replaceFile(src, dest);
  // Old covers may still be referenced by another card or an unsaved editor.
  // Cleanup is the only owner of orphan-cover deletion.
  return {
    path: dest,
    url: `app://localhost/__sillyclient_cover__/${encodeURIComponent(path.basename(dest))}`,
  };
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
// saveTextFile — 前端期望: Promise<void>
// ---------------------------------------------------------------------------

async function doSaveTextFile(opts: any): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('主窗口不可用，无法打开保存位置');
  }
  if (opts?.content == null) {
    throw new Error('缺少导出内容');
  }

  const rawName = typeof opts.fileName === 'string' ? opts.fileName : '';
  const safeName = rawName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[._]+/, '')
    .trim()
    .slice(0, 180) || 'sillyclient-export.json';

  paths.ensureDirs();
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出',
    defaultPath: path.join(paths.tmpDir, safeName),
  });
  if (result.canceled || !result.filePath) return;

  const temporary = path.join(
    path.dirname(result.filePath),
    `.sillyclient-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, String(opts.content), 'utf8');
    utils.replaceFile(temporary, result.filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// ---------------------------------------------------------------------------
// readTextFile — 前端期望: Promise<{ content: string; fileName: string }>
// ---------------------------------------------------------------------------

async function doReadTextFile(opts: any): Promise<{ content: string; fileName: string }> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('主窗口不可用');
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择导入文件',
    filters: [
      { name: 'JSON 备份文件', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    throw new Error('cancelled');
  }
  const filePath = result.filePaths[0];
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return {
    content,
    fileName: path.basename(filePath)
  };
}

// ---------------------------------------------------------------------------
// uninstallInstance — 前端期望: { success, freedBytes }
// ---------------------------------------------------------------------------

async function uninstallInstance(opts: any): Promise<{ success: boolean; freedBytes: number }> {
  const instanceId = paths.normalizeInstanceId(opts?.instanceId || '');
  operations.cancel({ instanceId });
  garbage.invalidate();
  maintenance.invalidate();
  return operations.enqueue(() => uninstallInstanceInternal(opts, instanceId));
}

async function uninstallInstanceInternal(opts: any, instanceId: string): Promise<{ success: boolean; freedBytes: number }> {
  const dir = resolveInstanceDir(instanceId, opts?.installPath, opts?.installPathMode);
  const records = instanceStore.listInstanceRecords();
  const record = records.find((entry) => entry.instanceId === instanceId);
  const registeredPath = record?.path;
  const defaultPath = paths.serverDirFor(instanceId);
  const resolvedDir = path.resolve(dir).toLowerCase();
  const isKnownPath = resolvedDir === path.resolve(defaultPath).toLowerCase()
    || (registeredPath && resolvedDir === path.resolve(registeredPath).toLowerCase());
  if (resolvedDir === path.parse(resolvedDir).root.toLowerCase()) throw new Error('Cannot remove a filesystem root');
  if (fs.existsSync(dir) && !isKnownPath) {
    throw new Error('拒绝删除未登记且无法识别的目录');
  }

  const sharedDirectory = records.some((entry) => entry.instanceId !== instanceId
    && path.resolve(entry.path).toLowerCase() === resolvedDir);
  if (currentInstanceId === instanceId || (!sharedDirectory && currentServerDir === dir)) {
    await stopCurrentServerInternal(true);
  }
  if (!sharedDirectory) await proc.stopServerForDirectory(dir);

  const isTakeover = record?.isTakeover === true || sharedDirectory;

  let freedBytes = 0;
  if (!isTakeover && fs.existsSync(dir)) {
    await assertPlainPath(dir, true);
    freedBytes = await directorySize(dir, { includeHeavy: true, fresh: true });
    await utils.removeDirWithRetries(dir);
    invalidateDirectorySize(dir);
  }

  const cleanupFailures: string[] = [];
  if (fs.existsSync(paths.coversDir)) {
    for (const entry of fs.readdirSync(paths.coversDir)) {
      const ext = path.extname(entry).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) continue;
      if (path.basename(entry, ext) !== instanceId && !entry.startsWith(`${instanceId}--cover-`)) continue;
      const cover = path.join(paths.coversDir, entry);
      try {
        const stat = await assertPlainPath(cover);
        fs.unlinkSync(cover);
        freedBytes += stat.size;
      } catch (error: any) { cleanupFailures.push(`Cover: ${error.message}`); }
    }
  }

  const logFile = path.join(paths.logsDir, `${instanceId}.log`);
  if (fs.existsSync(logFile)) {
    try {
      const size = (await assertPlainPath(logFile)).size;
      fs.rmSync(logFile, { force: true });
      freedBytes += size;
    } catch (error: any) { cleanupFailures.push(`Log: ${error.message}`); }
  }
  const temporaryArchive = path.join(paths.tmpDir, `${instanceId}.zip`);
  if (fs.existsSync(temporaryArchive)) {
    try {
      const size = (await assertPlainPath(temporaryArchive)).size;
      fs.rmSync(temporaryArchive, { force: true });
      freedBytes += size;
    } catch (error: any) { cleanupFailures.push(`Archive: ${error.message}`); }
  }

  if (!isTakeover && fs.existsSync(dir)) throw new Error(`实例目录未能彻底删除：${dir}`);
  if (cleanupFailures.length) throw new Error(`Instance data removed but auxiliary cleanup failed: ${cleanupFailures.join('; ')}`);
  instanceStore.removeInstanceRecord(instanceId);
  removeInstancePassword(instanceId);

  return { success: true, freedBytes };
}

// ---------------------------------------------------------------------------
// cleanGarbage — 前端期望: { items: GarbageItem[], totalBytes }
// GarbageItem: { path, type, sizeBytes, description }
// ---------------------------------------------------------------------------

async function cleanGarbage(opts: any): Promise<any> {
  const options = opts || {};
  return operations.enqueue(async () => {
    const scanned = await garbage.scan(options);
    if (options.dryRun !== false) return scanned;
    let freedBytes = 0;
    const failures: { path: string; error?: string }[] = [];
    for (const item of scanned.items) {
      const result = await garbage.remove(item);
      if (result.success) freedBytes += item.sizeBytes;
      else failures.push({ path: item.path, error: result.error });
    }
    return { ...scanned, success: failures.length === 0, freedBytes, failures };
  });
}

// ---------------------------------------------------------------------------
// deleteGarbageItem — 前端期望: { success }
// ---------------------------------------------------------------------------

function deleteGarbageItem(opts: any): Promise<{ success: boolean; error?: string }> {
  return operations.enqueue(() => garbage.remove(opts || {}));
}

// ---------------------------------------------------------------------------
// doMigrateInstance — 数据迁移
// ---------------------------------------------------------------------------

async function doMigrateInstance(options: any): Promise<{ success: boolean; instanceId: string; targetPath?: string }> {
  if (cleanupCompleted) throw new Error('Application is shutting down');
  const preinstall = validatePreinstallSelection(options?.preinstall);
  if (options?.mode === 'takeover' && preinstall?.extensionIds.length) {
    throw new Error('Preinstalled extensions cannot modify a takeover source');
  }
  const instanceId = paths.normalizeInstanceId(options?.instanceId || `migrated-${Date.now()}`);
  garbage.invalidate();
  maintenance.invalidate();
  return operations.runLatest(instanceId, options?.operationId,
    (context) => migrateInstanceInternal({ ...options, preinstall }, context));
}

async function migrateInstanceInternal(
  options: any,
  context: OperationContext,
): Promise<{ success: boolean; instanceId: string; targetPath?: string }> {
  const { sourcePath, targetPath, instanceId = `migrated-${Date.now()}`, mode = 'copy', includeSecrets = false } = options || {};
  const cleanSourcePath = (typeof sourcePath === 'string') ? sourcePath.trim().replace(/^["']|["']$/g, '').trim() : '';
  if (!cleanSourcePath) throw new Error('缺少来源路径');

  const safeInstanceId = context.instanceId;
  const targetDir = paths.serverDirFor(safeInstanceId, targetPath, 'exact');

  context.check();
  if (instanceStore.getInstanceRecord(safeInstanceId)) throw new Error('Instance is already registered');
  const eventContext = { instanceId: safeInstanceId, operationId: context.operationId };
  const migrationEvent = (eventName: string, data: any) => {
    if (!context.signal.aborted) notify(eventName, { ...data, ...eventContext });
  };
  migrationEvent('log', { message: `【数据迁移】开始${mode === 'takeover' ? '原地接管' : '复制迁移'}: ${cleanSourcePath}`, level: 'info' });
  migrationEvent('progress', { percent: 10, stage: 'Validating migration source' });

  if (mode === 'takeover') {
    const realTakeoverPath = await resolveTakeoverSource(cleanSourcePath);
    context.check();
    instanceStore.registerInstance(safeInstanceId, realTakeoverPath, undefined, true);
    migrationEvent('progress', { percent: 100, stage: 'Takeover complete' });
    migrationEvent('log', { message: `【成功】已原地接管目录: ${realTakeoverPath}`, level: 'success' });
    return { success: true, instanceId: safeInstanceId, targetPath: realTakeoverPath };
  }
  if (mode !== 'copy') throw new Error('Unknown migration mode');
  migrationEvent('progress', { percent: 30, stage: 'Copying and verifying data' });
  const transaction = await copyMigration(cleanSourcePath, targetDir,
    path.join(paths.bootstrapDir, 'servers', 'default'), { includeSecrets, signal: context.signal });
  let extensions: ExtensionInstallTransaction | null = null;
  try {
    context.check();
    if (options.preinstall?.extensionIds.length) {
      const log = (message: string, level?: string) => migrationEvent('log', { message, level });
      migrationEvent('progress', { percent: 75, stage: 'Preparing base runtime dependencies' });
      await ensureInstanceDependencies(transaction.target, log, { signal: context.signal });
      context.check();
      extensions = await installPreselectedExtensions(transaction.target, options.preinstall, {
        signal: context.signal,
        operationId: context.operationId,
        log,
        progress: (percent, stage) => migrationEvent('progress', { percent: 80 + Math.floor(percent * 0.19), stage }),
      });
    }
    context.check();
    instanceStore.registerInstance(safeInstanceId, transaction.target, undefined, false);
    transaction.commit();
    extensions?.commit();
    invalidateDirectorySize(transaction.target);
    migrationEvent('progress', { percent: 100, stage: 'Migration verified' });
    migrationEvent('log', { message: `【成功】数据迁移完成，实例 [${safeInstanceId}] 已就绪！`, level: 'success' });
    return { success: true, instanceId: safeInstanceId, targetPath: transaction.target };
  } catch (error) {
    await extensions?.rollback();
    await transaction.rollback();
    throw error;
  }
}
