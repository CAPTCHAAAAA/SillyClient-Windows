import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { assertPlainPath } from './cleanup';
import { checkSignal } from './operations';
import * as paths from './paths';
import * as instanceStore from './instances';
import * as proc from './process';

const EXTENSIONS_ROOT = 'public/scripts/extensions/third-party';
const WEBPACK_CACHE = 'data/_webpack';
const OPTIONAL_FILES = ['secrets.json', 'config.yaml', 'config.yml'];
const TMP_PREFIX = '.sc-import-tmp-';

export interface ArchiveImportSummary {
  importEntries: number;
  importBytes: number;
  skippedEntries: number;
  skippedBytes: number;
  hasSecrets: boolean;
  hasConfig: boolean;
  wrapperPrefix: string;
  importable: boolean;
}

export interface ArchiveImportOutcome {
  imported: number;
  bytes: number;
  skipped: number;
}

interface PlannedEntry {
  entry: any;
  targetRelativePath: string;
}

interface PlanResult {
  summary: ArchiveImportSummary;
  included: PlannedEntry[];
}

function normalizeZipPath(raw: string): string {
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

function validateEntryPath(name: string): string {
  const normalized = normalizeZipPath(name);
  if (!normalized || normalized.length > 4096) {
    throw new Error('压缩包条目路径无效');
  }
  const segments = normalized.split('/');
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes(':'))) {
    throw new Error('压缩包包含不安全的相对路径或非法字符');
  }
  return normalized;
}

function detectWrapperPrefix(entries: Array<{ path: string; isDirectory: boolean }>): string {
  if (entries.length === 0) return '';
  const firstPath = entries[0].path;
  const root = firstPath.split('/')[0];
  if (['data', 'public', 'src', 'node_modules', 'plugins', 'default-user'].includes(root)) {
    return '';
  }
  const prefix = `${root}/`;
  if (entries.some((e) => e.path !== root && !e.path.startsWith(prefix))) {
    return '';
  }
  if (entries.some((e) => e.path === root && !e.isDirectory)) {
    return '';
  }
  const hasInstanceRoot = entries.some((e) => {
    const p = e.path.slice(prefix.length);
    return ['server.js', 'package.json', 'config.yaml'].includes(p)
      || p.startsWith('data/')
      || (p === 'data' && e.isDirectory);
  });
  return hasInstanceRoot ? prefix : '';
}

function isUserData(p: string): boolean {
  if (p === 'data' || p.startsWith('data/')) {
    return p !== WEBPACK_CACHE && !p.startsWith(`${WEBPACK_CACHE}/`);
  }
  if (p === 'plugins' || p.startsWith('plugins/')) return true;
  if (p === EXTENSIONS_ROOT || p.startsWith(`${EXTENSIONS_ROOT}/`)) return true;
  if (['public', 'public/scripts', 'public/scripts/extensions'].includes(p)) return true;
  return false;
}

function isHostMetadata(p: string): boolean {
  return p === '.sc-identity'
    || p === '.sillyclient-dependencies-pending'
    || p.startsWith('.sillyclient-');
}

function planArchive(
  archivePath: string,
  includeOptional = false,
  signal?: AbortSignal,
): PlanResult {
  checkSignal(signal);
  if (!fs.existsSync(archivePath)) {
    throw new Error('压缩包文件不存在');
  }
  const stat = fs.statSync(archivePath);
  if (!stat.isFile() || stat.size < 22 || stat.size > 2 * 1024 * 1024 * 1024) {
    throw new Error('压缩包缺失、不是普通文件或超过 2GB 大小上限');
  }

  const zip = new AdmZip(archivePath);
  const rawEntries = zip.getEntries();
  if (rawEntries.length === 0 || rawEntries.length > 131072) {
    throw new Error('压缩包条目数量异常');
  }

  const entries: Array<{ entry: any; path: string; isDirectory: boolean }> = [];
  const seenPaths = new Set<string>();
  let declaredBytes = 0;

  for (const entry of rawEntries) {
    checkSignal(signal);
    const validPath = validateEntryPath(entry.entryName);
    const lower = validPath.toLowerCase();
    if (seenPaths.has(lower)) {
      throw new Error(`压缩包包含重复路径: ${validPath}`);
    }
    seenPaths.add(lower);

    const size = Number(entry.header.size);
    if (!Number.isFinite(size) || size < 0 || size > 512 * 1024 * 1024) {
      throw new Error('压缩包单文件体积异常');
    }
    declaredBytes += size;
    if (declaredBytes > 4 * 1024 * 1024 * 1024) {
      throw new Error('压缩包解压总大小超过 4GB 上限');
    }

    entries.push({
      entry,
      path: validPath,
      isDirectory: entry.isDirectory,
    });
  }

  const wrapperPrefix = detectWrapperPrefix(entries);
  let importEntries = 0;
  let importBytes = 0;
  let skippedEntries = 0;
  let skippedBytes = 0;
  let hasSecrets = false;
  let hasConfig = false;
  const included: PlannedEntry[] = [];

  for (const item of entries) {
    if (item.isDirectory && wrapperPrefix && item.path === wrapperPrefix.slice(0, -1)) {
      continue;
    }
    const relative = wrapperPrefix ? item.path.slice(wrapperPrefix.length) : item.path;
    if (!relative) continue;
    if (isHostMetadata(relative)) continue;

    const isOptional = OPTIONAL_FILES.includes(relative);
    if (isOptional) {
      if (relative === 'secrets.json') hasSecrets = true;
      else hasConfig = true;

      if (includeOptional) {
        included.push({ entry: item.entry, targetRelativePath: relative });
        importEntries++;
        importBytes += Number(item.entry.header.size);
      } else {
        skippedEntries++;
        skippedBytes += Number(item.entry.header.size);
      }
      continue;
    }

    if (isUserData(relative)) {
      included.push({ entry: item.entry, targetRelativePath: relative });
      importEntries++;
      importBytes += Number(item.entry.header.size);
    } else {
      skippedEntries++;
      skippedBytes += Number(item.entry.header.size);
    }
  }

  const summary: ArchiveImportSummary = {
    importEntries,
    importBytes,
    skippedEntries,
    skippedBytes,
    hasSecrets,
    hasConfig,
    wrapperPrefix,
    importable: importEntries > 0,
  };

  return { summary, included };
}

export async function inspectImportArchive(
  archivePath: string,
  signal?: AbortSignal,
): Promise<ArchiveImportSummary> {
  const planned = planArchive(archivePath, false, signal);
  return planned.summary;
}

export function resolveInstanceDir(instanceId: string, installPath?: string): string {
  if (installPath) {
    const resolved = path.resolve(installPath);
    if (fs.existsSync(resolved) && fs.existsSync(path.join(resolved, 'server.js'))) {
      return resolved;
    }
  }
  const record = instanceStore.getInstanceRecord(instanceId);
  if (record?.path && fs.existsSync(record.path)) {
    return path.resolve(record.path);
  }
  return paths.serverDirFor(instanceId, installPath);
}

export async function importInstanceData(options: {
  instanceId: string;
  installPath?: string;
  archivePath: string;
  includeOptional?: boolean;
  operationId?: string;
  signal?: AbortSignal;
}): Promise<ArchiveImportOutcome> {
  checkSignal(options.signal);
  const targetDir = resolveInstanceDir(options.instanceId, options.installPath);
  if (!fs.existsSync(targetDir) || !fs.existsSync(path.join(targetDir, 'server.js'))) {
    throw new Error('实例目录不存在或尚未完成安装');
  }

  // 确保实例未处于运行状态
  const activeDirs = proc.activeProcessDirectories();
  if (activeDirs.some((d) => path.resolve(d).toLowerCase() === targetDir.toLowerCase())) {
    throw new Error('实例正在运行，请先停止实例后再导入数据');
  }

  const planned = planArchive(options.archivePath, Boolean(options.includeOptional), options.signal);
  if (!planned.summary.importable) {
    throw new Error('压缩包里没有可导入的实例数据（需要 data/ 或第三方扩展）');
  }

  let imported = 0;
  let bytes = 0;

  for (const item of planned.included) {
    checkSignal(options.signal);
    const targetFile = path.resolve(targetDir, item.targetRelativePath);
    const rel = path.relative(targetDir, targetFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`导入路径逃逸实例目录: ${item.targetRelativePath}`);
    }

    if (item.entry.isDirectory) {
      await fs.promises.mkdir(targetFile, { recursive: true });
      continue;
    }

    const parentDir = path.dirname(targetFile);
    await fs.promises.mkdir(parentDir, { recursive: true });

    const tempFile = path.join(parentDir, `${TMP_PREFIX}${randomUUID()}`);
    try {
      const data = item.entry.getData();
      await fs.promises.writeFile(tempFile, data);
      checkSignal(options.signal);

      // 原子替换目标文件
      try {
        await fs.promises.rename(tempFile, targetFile);
      } catch {
        // Windows 平台遇到已存在文件可能会报 EPERM 或 EEXIST，先移除目标再重命名
        if (fs.existsSync(targetFile)) {
          await fs.promises.rm(targetFile, { force: true });
        }
        await fs.promises.rename(tempFile, targetFile);
      }

      imported++;
      bytes += data.length;
    } catch (err) {
      if (fs.existsSync(tempFile)) {
        try { await fs.promises.rm(tempFile, { force: true }); } catch {}
      }
      throw err;
    }
  }

  return {
    imported,
    bytes,
    skipped: planned.summary.skippedEntries,
  };
}

export async function exportInstance(options: {
  instanceId: string;
  installPath?: string;
  signal?: AbortSignal;
}): Promise<{ path: string; bytes: number }> {
  checkSignal(options.signal);
  const directory = resolveInstanceDir(options.instanceId, options.installPath);
  if (!fs.existsSync(directory) || !fs.existsSync(path.join(directory, 'server.js'))) {
    throw new Error('实例目录不存在或尚未完成安装');
  }

  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const targetDir = path.join(downloadsDir, 'SillyClient-导出');
  await fs.promises.mkdir(targetDir, { recursive: true });

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const baseName = path.basename(directory);
  const zipFile = path.join(targetDir, `${baseName}-${stamp}.zip`);

  const zip = new AdmZip();

  function walk(current: string, base: string) {
    const list = fs.readdirSync(current);
    for (const file of list) {
      checkSignal(options.signal);
      if (['.git', 'node_modules', '.cache'].includes(file)
        || file.startsWith('.sillyclient-')
        || file.startsWith('.sc-import-tmp-')) {
        continue;
      }
      const full = path.join(current, file);
      const rel = path.relative(base, full).replace(/\\/g, '/');
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        zip.addFile(`${rel}/`, Buffer.alloc(0));
        walk(full, base);
      } else if (stat.isFile()) {
        zip.addLocalFile(full, path.dirname(rel).replace(/\\/g, '/'));
      }
    }
  }

  walk(directory, directory);
  zip.writeZip(zipFile);

  const finalStat = fs.statSync(zipFile);
  return {
    path: zipFile,
    bytes: finalStat.size,
  };
}
