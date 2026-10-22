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
/**
 * 无用户选定目标时的导出落点。
 *
 * 铁律：自动/兜底导出只能写进软件自己的数据目录，绝不私自使用用户的
 * Downloads、Desktop、Documents 等个人存储路径。放在 tarvenHome 下还有
 * 一个额外好处：安装目录（INSTDIR）会被 NSIS 更新整目录清空，而这里不会，
 * 备份才能真正起到「保证数据完整性」的作用。
 */
export const exportsDir = path.join(tarvenHome, 'exports');
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

export const appSettingsPath = path.join(tarvenHome, 'app-settings.json');

export interface AppSettingsDocument {
  instancesRoot?: string;
}

export function loadAppSettings(): AppSettingsDocument {
  try {
    if (fs.existsSync(appSettingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(appSettingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Corrupt or unreadable file falls back to empty defaults
  }
  return {};
}

export function saveAppSettings(doc: AppSettingsDocument): void {
  const content = JSON.stringify(doc, null, 2);
  if (!fs.existsSync(tarvenHome)) fs.mkdirSync(tarvenHome, { recursive: true });
  const staging = path.join(tarvenHome, `.sillyclient-settings-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(staging, content, 'utf8');
    fs.renameSync(staging, appSettingsPath);
  } catch {
    fs.writeFileSync(appSettingsPath, content, 'utf8');
  } finally {
    try {
      if (fs.existsSync(staging)) fs.unlinkSync(staging);
    } catch {
      // Ignore
    }
  }
}

/**
 * 当前生效实例存储根：仅来自用户在创建/迁移/搬迁流程中显式选择并登记的文件夹
 * （app-settings.json → instancesRoot）。无默认路径铁律——未配置时返回 null，
 * 绝不回落到安装目录或任何软件预设位置（安装目录是安装器更新/卸载的施工区）。
 */
export function getInstancesRoot(): string | null {
  const settings = loadAppSettings();
  const configured = settings.instancesRoot?.trim().replace(/^["']|["']$/g, '').trim();
  if (configured && path.isAbsolute(configured)) return configured;
  return null;
}

export function getAppSettings(): {
  configuredInstancesRoot?: string;
} {
  const settings = loadAppSettings();
  const configured = settings.instancesRoot?.trim().replace(/^["']|["']$/g, '').trim();
  return configured ? { configuredInstancesRoot: configured } : {};
}

export function setInstancesRoot(options?: { path?: string }): {
  instancesRoot: string | null;
  configured: boolean;
} {
  const requested = options?.path?.trim()?.replace(/^["']|["']$/g, '').trim();
  if (!requested) {
    const settings = loadAppSettings();
    delete settings.instancesRoot;
    saveAppSettings(settings);
    return {
      instancesRoot: null,
      configured: false,
    };
  }

  if (!path.isAbsolute(requested)) {
    throw new Error('存储路径必须使用本机绝对路径');
  }
  if (requested === path.parse(requested).root) {
    throw new Error('不能把磁盘根目录直接设为实例存储路径');
  }

  try {
    if (!fs.existsSync(requested)) fs.mkdirSync(requested, { recursive: true });
  } catch (err: any) {
    throw new Error(`无法创建指定的存储路径: ${err?.message || err}`);
  }

  const settings = loadAppSettings();
  settings.instancesRoot = requested;
  saveAppSettings(settings);

  return {
    instancesRoot: requested,
    configured: true,
  };
}

/**
 * 全部已知实例根位置（探测专用，绝不创建目录）：
 * 当前生效存储根 → 安装目录默认根（1.10+ 历史落点）→ AppData 回退根（安装目录不可写时的历史落点）
 * → 旧版隐藏 servers 目录（≤1.9.x 落点）。扫描、启动解析与迁移源定位统一以此为准，
 * 任何位置创建的实例都不会因为"落点模型换代"而失联。
 */
export function candidateInstanceRoots(): string[] {
  const candidates = [
    getInstancesRoot(),
    path.join(appRootDir, 'instances'),
    path.join(tarvenHome, 'instances'),
    legacyServersDir,
  ];
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = path.resolve(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(candidate);
  }
  return roots;
}

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
  // 未指定路径时没有默认落点：仅当用户已显式登记存储根时才可推导，
  // 否则必须拒绝——绝不让实例静默落入安装目录等施工区。
  const configuredRoot = getInstancesRoot();
  if (!configuredRoot) {
    throw new Error('尚未配置实例存储位置，请先选择实例存放文件夹');
  }
  return path.join(configuredRoot, safeId);
}

export function ensureDirs(): void {
  for (const d of [tarvenHome, bootstrapDir, usrDir, coversDir, tmpDir, logsDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
  const configuredRoot = getInstancesRoot();
  if (configuredRoot && !fs.existsSync(configuredRoot)) {
    try {
      fs.mkdirSync(configuredRoot, { recursive: true });
    } catch {
      // 配置根暂时不可写（如可移动磁盘未挂载）：登记保持不变，使用时再报错。
    }
  }
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
