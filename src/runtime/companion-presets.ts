import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface CompanionPresetRequest {
  bundleId: 'sc-bordeaux';
  revision: number;
}

export interface CompanionPresetTransaction {
  applied: boolean;
  commit(): void;
  rollback(): void;
}

interface PresetAsset {
  source: string;
  target: string;
  sha256: string;
}

interface PresetManifest {
  schema: string;
  version: number;
  bundleId: string;
  revision: number;
  displayName: string;
  theme: PresetAsset;
  wallpaper: PresetAsset & { width: number; height: number };
  settings: {
    themeName: string;
    background: Record<string, unknown>;
  };
}

const BUNDLE_ID = 'sc-bordeaux';
const REVISION = 1;
const THEME_HASH = 'AB0207DE9DD970557D428B47DBA8BD0859B3FA5FC6FD0050011ECF30BCA16E70';
const WALLPAPER_HASH = '7B17E76B5F726B33D36B04C79DAE40DF5E47CF35835C79C273AF10DBEA07FD1A';
const THEME_TARGET = 'data/default-user/themes/SC Bordeaux.json';
const WALLPAPER_TARGET = 'data/default-user/backgrounds/sillyclient-bg-8k.jpg';

function bundledPresetRoot(): string {
  const productionRoot = path.join(process.resourcesPath, 'companion-presets');
  if (fs.existsSync(productionRoot)) return productionRoot;
  return path.join(__dirname, '..', '..', 'resources', 'companion-presets');
}

function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('预设资源路径无效');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('预设资源路径越界');
  }
  return resolved;
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').toUpperCase();
}

function readJsonObject(filePath: string, label: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error: any) {
    throw new Error(`${label} 无法读取: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 格式无效`);
  }
  return parsed as Record<string, any>;
}

function writeAtomic(filePath: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, data);
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch {
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function restoreFile(filePath: string, previous: Buffer | null): void {
  if (previous === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  writeAtomic(filePath, previous);
}

function validateManifest(manifest: PresetManifest, request: CompanionPresetRequest): void {
  if (request.bundleId !== BUNDLE_ID || request.revision !== REVISION) {
    throw new Error('不支持的主题预设版本');
  }
  if (
    manifest.schema !== 'sillyclient.companion-preset'
    || manifest.version !== 1
    || manifest.bundleId !== BUNDLE_ID
    || manifest.revision !== REVISION
    || manifest.theme.target !== THEME_TARGET
    || manifest.wallpaper.target !== WALLPAPER_TARGET
    || manifest.theme.sha256.toUpperCase() !== THEME_HASH
    || manifest.wallpaper.sha256.toUpperCase() !== WALLPAPER_HASH
  ) {
    throw new Error('内置主题预设清单校验失败');
  }
}

function noOpTransaction(): CompanionPresetTransaction {
  return { applied: false, commit() {}, rollback() {} };
}

export function installCompanionPreset(
  serverDir: string,
  request: CompanionPresetRequest,
  presetRoot = bundledPresetRoot(),
): CompanionPresetTransaction {
  const bundleRoot = resolveInside(presetRoot, request.bundleId);
  const manifest = readJsonObject(resolveInside(bundleRoot, 'manifest.json'), '内置主题预设清单') as unknown as PresetManifest;
  validateManifest(manifest, request);

  const themeSource = resolveInside(bundleRoot, manifest.theme.source);
  const wallpaperSource = resolveInside(bundleRoot, manifest.wallpaper.source);
  const themeBytes = fs.readFileSync(themeSource);
  const wallpaperBytes = fs.readFileSync(wallpaperSource);
  if (sha256(themeBytes) !== THEME_HASH || sha256(wallpaperBytes) !== WALLPAPER_HASH) {
    throw new Error('内置主题预设资源校验失败');
  }

  const themeSettings = JSON.parse(themeBytes.toString('utf8')) as Record<string, unknown>;
  if (!themeSettings || typeof themeSettings !== 'object' || themeSettings.name !== manifest.settings.themeName) {
    throw new Error('内置主题文件格式无效');
  }

  const markerPath = path.join(serverDir, '.sillyclient', 'companion-presets', `${BUNDLE_ID}.json`);
  if (fs.existsSync(markerPath)) {
    try {
      const marker = readJsonObject(markerPath, '主题预设标记');
      if (
        marker.bundleId === BUNDLE_ID
        && marker.revision === REVISION
        && marker.themeSha256 === THEME_HASH
        && marker.wallpaperSha256 === WALLPAPER_HASH
      ) {
        return noOpTransaction();
      }
    } catch {
      // 损坏或旧版标记会被本次完整安装替换。
    }
  }

  const settingsPath = path.join(serverDir, 'data', 'default-user', 'settings.json');
  const defaultSettingsPath = path.join(serverDir, 'default', 'content', 'settings.json');
  const settingsBasePath = fs.existsSync(settingsPath) ? settingsPath : defaultSettingsPath;
  if (!fs.existsSync(settingsBasePath)) {
    throw new Error('SillyTavern 默认设置模板不存在');
  }
  const settings = readJsonObject(settingsBasePath, 'SillyTavern 设置');
  const powerUser = settings.power_user && typeof settings.power_user === 'object' && !Array.isArray(settings.power_user)
    ? settings.power_user as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(themeSettings)) {
    if (key !== 'name' && key !== '__proto__' && key !== 'constructor' && key !== 'prototype') {
      powerUser[key] = value;
    }
  }
  powerUser.theme = manifest.settings.themeName;
  powerUser.theme_fallback = manifest.settings.themeName;
  settings.power_user = powerUser;
  const currentBackground = settings.background && typeof settings.background === 'object' && !Array.isArray(settings.background)
    ? settings.background as Record<string, unknown>
    : {};
  settings.background = { ...currentBackground, ...manifest.settings.background };

  const themeTarget = resolveInside(serverDir, manifest.theme.target);
  const wallpaperTarget = resolveInside(serverDir, manifest.wallpaper.target);
  const touched = [themeTarget, wallpaperTarget, settingsPath, markerPath].map(filePath => ({
    filePath,
    previous: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  }));

  let active = true;
  const rollback = () => {
    if (!active) return;
    for (const snapshot of [...touched].reverse()) restoreFile(snapshot.filePath, snapshot.previous);
    active = false;
  };

  try {
    writeAtomic(themeTarget, themeBytes);
    writeAtomic(wallpaperTarget, wallpaperBytes);
    writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    writeAtomic(markerPath, `${JSON.stringify({
      schema: 'sillyclient.companion-preset-applied',
      version: 1,
      bundleId: BUNDLE_ID,
      revision: REVISION,
      themeSha256: THEME_HASH,
      wallpaperSha256: WALLPAPER_HASH,
      appliedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (error) {
    rollback();
    throw error;
  }

  return {
    applied: true,
    commit() { active = false; },
    rollback,
  };
}
