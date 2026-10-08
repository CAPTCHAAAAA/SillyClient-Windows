/**
 * SillyTavern 实例初始化、依赖就绪与启动工作流编排服务
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';

import * as paths from './runtime/paths';
import * as proc from './runtime/process';
import * as utils from './runtime/utils';
import * as instanceStore from './runtime/instances';
import { installCompanionPreset, type CompanionPresetTransaction } from './runtime/companion-presets';
import { checkSignal, delay, type OperationContext } from './runtime/operations';
import { assertPlainPath } from './runtime/cleanup';
import { directoryContentIdentity } from './runtime/migration';
import { ensureInstanceDependencies } from './runtime/dependencies';
import { installPreselectedExtensions, type ExtensionInstallTransaction } from './runtime/preinstalled-extensions';
import { invalidateDirectorySize } from './runtime/directory-stats';
import { findAvailablePort } from './port-finder';
import { downloadWithMirrors, flattenExtractedDir } from './download-provision';
import { resolveInstanceDir } from './instance-query';
import type { ProvisionAndStartParams } from './contracts/ipc-contracts';

export function writeInstanceConfig(serverDir: string, port: number, config: any): void {
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

export function serverLaunchArguments(port: number, config: any): string[] {
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

export async function pollUntilReady(
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

export function tryConnect(url: string, signal?: AbortSignal): Promise<boolean> {
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

export interface ProvisionCallbacks {
  notify: (eventName: string, data: any) => void;
  stopCurrentServerInternal: (emitEvents: boolean) => Promise<void>;
  getCurrentOperationId: () => string | null;
  onServerStarted: (
    instanceId: string,
    operationId: string,
    targetServerDir: string,
    port: number,
  ) => void;
  onServerExited: (
    instanceId: string,
    operationId: string,
  ) => void;
  onServerReady: (
    instanceId: string,
    operationId: string,
    targetServerDir: string,
    port: number,
    url: string,
    createdAt?: string,
  ) => void;
}

export async function executeProvisionWorkflow(
  opts: ProvisionAndStartParams,
  context: OperationContext,
  callbacks: ProvisionCallbacks,
): Promise<{ ready: boolean }> {
  const { zipballUrl, localZipPath, config, installPath, installPathMode, companionPreset } = opts || {};
  const port = opts?.port;
  const safeInstanceId = context.instanceId;
  const eventContext = { instanceId: safeInstanceId, operationId: context.operationId };
  const log = (msg: string, level?: string) => {
    if (!context.signal.aborted) callbacks.notify('log', { message: msg, level, ...eventContext });
  };
  const progress = (pct: number, text?: string) => {
    if (!context.signal.aborted) callbacks.notify('progress', { percent: pct, stage: text, ...eventContext });
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
    await callbacks.stopCurrentServerInternal(true);
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
      progress(60, '安装依赖（首次需1-3分钟）');
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

    if (createdThisRun && !fs.existsSync(path.join(targetServerDir, 'config.yaml'))) {
      writeInstanceConfig(targetServerDir, actualPort, config);
    }
    const args = serverLaunchArguments(actualPort, config);
    progress(90, '启动服务');

    callbacks.onServerStarted(safeInstanceId, context.operationId, targetServerDir, actualPort);

    proc.startServer(targetServerDir, safeInstanceId, actualPort, log, () => {
      callbacks.onServerExited(safeInstanceId, context.operationId);
    }, { args, operationId: context.operationId });

    progress(95, '等待就绪');
    const ready = await pollUntilReady(actualPort, 180000, log, context.signal, connectionHost);
    context.check();
    if (!ready) throw new Error('服务启动超时（180s）');
    if (!proc.isServerRunning() || callbacks.getCurrentOperationId() !== context.operationId) {
      throw new Error('服务在完成启动前已退出');
    }

    const currentUrl = `http://${connectionHost}:${actualPort}`;
    companionPresetTransaction?.commit();
    extensionTransaction?.commit();

    callbacks.onServerReady(safeInstanceId, context.operationId, targetServerDir, actualPort, currentUrl, createdAt);

    progress(100, '就绪');
    log('服务就绪', 'success');

    callbacks.notify('ready', { ready: true, url: currentUrl, port: actualPort, ...eventContext });
    return { ready: true };
  } catch (e: any) {
    if (callbacks.getCurrentOperationId() === context.operationId) {
      await callbacks.stopCurrentServerInternal(false);
    }
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
      callbacks.notify('error', { message: e.message, ...eventContext });
    }
    return { ready: false };
  }
}
