/**
 * TarvenEnv 插件 — Windows 门面与 IPC 调度中心 (Facade & Dispatcher)
 *
 * 状态：FROZEN（2026-10-09 起终态冻结，此路线为最完美解，严禁随意改动！）
 * 详见权威冻结准则：docs/WINDOWS-BACKEND-ARCHITECTURE-FREEZE.md
 *
 * 职责：
 * 1. 维护 Electron 宿主与 SillyTavern 实例运行态生命周期、窗口通知与定时 checkpoint；
 * 2. 接收 IPC 请求，强类型路由并委托给专门的领域服务执行；
 * 3. 统一全局协调器（OperationCoordinator、CleanupService、InstanceMaintenanceService）。
 * 4. 保持代码量极简（<=300行），严禁在此处内联长业务逻辑。
 */

import { BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as instanceStore from './runtime/instances';
import { OperationCoordinator } from './runtime/operations';
import { CleanupService } from './runtime/cleanup';
import { InstanceMaintenanceService } from './runtime/instance-maintenance';
import { resolveInstanceDataRoot } from './runtime/instance-config';
import { checkLegacyInstances, relocateInstance, migrateLegacyInstances } from './runtime/relocate';
import { renameInstance } from './runtime/rename';
import { validatePreinstallSelection } from './runtime/preinstalled-extensions';
import {
  clearRemoteBasicAuth,
  getRemoteBasicAuthStatus,
  saveRemoteBasicAuth,
} from './remote-auth';
import {
  clearInstancePassword,
  hasInstancePassword,
  listInstancePasswordStatus,
  setInstancePassword,
  verifyInstancePassword,
} from './runtime/instance-lock';
import {
  inspectImportArchive,
  importInstanceData,
  exportInstance,
} from './runtime/instance-import';

// 引入解耦后的独立领域服务
import { pickDirectoryDialog, pickImageDialog, pickZipFileDialog } from './system-dialogs';
import { saveTextFileSafely, readTextFileSafely } from './file-system-ops';
import { pingUrl } from './network-probe';
import { fetchReleases } from './download-provision';
import { executeCleanGarbage, executeDeleteGarbageItem } from './garbage-collector';
import { scanInstances as scanInstancesService, getInstanceInfo as getInstanceInfoService, resolveInstanceDir } from './instance-query';
import { uninstallInstanceInternal } from './instance-uninstall';
import { migrateInstanceInternal } from './instance-migrate';
import { executeProvisionWorkflow } from './provision-workflow';

// 导出与原模块完全兼容的工具方法
export { getNodeExe, getNpmCli } from './runtime/paths';

// ---------------------------------------------------------------------------
// 运行时状态与生命周期
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
      directory: record.path,
      isTakeover: record.isTakeover,
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
// 公开生命周期接口
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
// 业务执行与协调流程
// ---------------------------------------------------------------------------

async function provisionAndStart(opts: any): Promise<{ ready: boolean }> {
  if (cleanupCompleted) throw new Error('Application is shutting down');
  const preinstall = validatePreinstallSelection(opts?.preinstall);
  const safeInstanceId = paths.normalizeInstanceId(opts?.instanceId || '');
  garbage.invalidate();
  maintenance.invalidate();
  try {
    return await operations.runLatest(safeInstanceId, opts?.operationId,
      (context) => executeProvisionWorkflow({ ...opts, preinstall }, context, {
        notify,
        stopCurrentServerInternal,
        getCurrentOperationId: () => currentOperationId,
        onServerStarted: (id, opId, dir, port) => {
          currentInstanceId = id;
          currentServerDir = dir;
          currentOperationId = opId;
          currentPort = port;
        },
        onServerExited: (id, opId) => {
          if (currentInstanceId !== id || currentOperationId !== opId) return;
          stopUsageCheckpoint();
          currentInstanceId = null;
          currentServerDir = null;
          currentOperationId = null;
          serverReady = false;
          currentUrl = null;
          currentPort = 0;
          const usage = instanceStore.finishInstanceUsage(id);
          if (!cleanupCompleted) {
            const eventContext = { instanceId: id, operationId: opId };
            notify('ready', { ready: false, ...eventContext });
            notify('mode', {
              mode: 'launcher',
              tavernRunning: false,
              ...eventContext,
              lastUsedAt: usage?.lastUsedAt,
              totalUsageMs: usage?.totalUsageMs,
            });
          }
        },
        onServerReady: (id, _opId, dir, port, url, createdAt) => {
          serverReady = true;
          currentUrl = url;
          currentPort = port;
          instanceStore.registerInstance(id, dir, createdAt);
          instanceStore.beginInstanceUsage(id, dir);
          startUsageCheckpoint(id);
        },
      }));
  } catch (error: any) {
    if (error?.name === 'AbortError') return { ready: false };
    throw error;
  }
}

async function doSendCommand(opts: any): Promise<void> {
  const { text, instanceId } = opts || {};
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

async function uninstallInstance(opts: any): Promise<{ success: boolean; freedBytes: number }> {
  const instanceId = paths.normalizeInstanceId(opts?.instanceId || '');
  operations.cancel({ instanceId });
  garbage.invalidate();
  maintenance.invalidate();
  return operations.enqueue(() => uninstallInstanceInternal(opts, instanceId, async (dir) => {
    const records = instanceStore.listInstanceRecords();
    const sharedDirectory = records.some((entry) => entry.instanceId !== instanceId
      && path.resolve(entry.path).toLowerCase() === path.resolve(dir).toLowerCase());
    if (currentInstanceId === instanceId || (!sharedDirectory && currentServerDir === dir)) {
      await stopCurrentServerInternal(true);
    }
  }));
}

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
    (context) => migrateInstanceInternal({ ...options, preinstall }, context, notify));
}

// ---------------------------------------------------------------------------
// IPC 处理入口 (Dispatcher)
// ---------------------------------------------------------------------------

export async function handle(method: string, options: any): Promise<any> {
  switch (method) {
    case 'provisionAndStart':
      return provisionAndStart(options);
    case 'scanInstances':
      return scanInstancesService(
        currentInstanceId,
        () => staleUsageSessionsSettled,
        () => { staleUsageSessionsSettled = true; },
      );
    case 'closeTavern':
      return stopCurrentServer(options).then(() => ({ success: true }));
    case 'getStatus':
      return {
        mode: 'launcher',
        serverReady,
        url: currentUrl,
        instanceId: serverReady ? currentInstanceId : undefined,
        operationId: serverReady ? currentOperationId : undefined,
      };
    case 'getInstanceInfo':
      return getInstanceInfoService(options, currentInstanceId, currentPort);
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
    case 'getAppSettings':
      return paths.getAppSettings();
    case 'setInstancesRoot':
      return paths.setInstancesRoot(options);
    case 'pickDirectory':
      return pickDirectoryDialog(mainWindow, options);
    case 'pickImage':
      return pickImageDialog(mainWindow, options, () => {
        garbage.invalidate();
        maintenance.invalidate();
      });
    case 'pickZipFile':
      return pickZipFileDialog(mainWindow);
    case 'inspectImportArchive':
      return inspectImportArchive(options.archivePath);
    case 'importInstanceData':
      return importInstanceData(options);
    case 'exportInstance':
      return exportInstance(options);
    case 'saveTextFile':
      return saveTextFileSafely(mainWindow, options);
    case 'readTextFile':
      return readTextFileSafely(mainWindow, options);
    case 'uninstallInstance':
      return uninstallInstance(options);
    case 'cleanGarbage':
      return executeCleanGarbage(garbage, operations, options);
    case 'deleteGarbageItem':
      return executeDeleteGarbageItem(garbage, operations, options);
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
