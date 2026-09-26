import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PluginCompatibilityItem {
  name: string;
  type: 'server-plugin' | 'client-extension';
  relativePath: string;
  hasPackageJson: boolean;
  entryExists: boolean;
  nativeDependencies: string[];
  deprecatedDependencies: string[];
  riskLevel: RiskLevel;
  warnings: string[];
  suggestions: string[];
}

export interface PluginCompatibilityReport {
  items: PluginCompatibilityItem[];
  summary: {
    total: number;
    serverPlugins: number;
    clientExtensions: number;
    highRisk: number;
    mediumRisk: number;
    lowRisk: number;
  };
}

const KNOWN_NATIVE_MODULES = new Set([
  'better-sqlite3',
  'sqlite3',
  'sharp',
  'canvas',
  'node-pty',
  'bcrypt',
  're2',
  'leveldown',
  'ffi-napi',
  'ref-napi',
  'bufferutil',
  'utf-8-validate',
]);

const KNOWN_DEPRECATED_MODULES = new Set([
  'request',
  'request-promise',
  'querystring',
  'nomnom',
]);

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function scanServerPlugins(pluginsRoot: string): Promise<PluginCompatibilityItem[]> {
  const items: PluginCompatibilityItem[] = [];
  if (!await dirExists(pluginsRoot)) return items;

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pluginDir = path.join(pluginsRoot, entry.name);
    const item: PluginCompatibilityItem = {
      name: entry.name,
      type: 'server-plugin',
      relativePath: path.join('plugins', entry.name),
      hasPackageJson: false,
      entryExists: false,
      nativeDependencies: [],
      deprecatedDependencies: [],
      riskLevel: 'LOW',
      warnings: [],
      suggestions: [],
    };

    const pkgPath = path.join(pluginDir, 'package.json');
    let mainEntry = 'index.js';
    if (await fileExists(pkgPath)) {
      item.hasPackageJson = true;
      try {
        const raw = await fs.readFile(pkgPath, 'utf8');
        const pkg = JSON.parse(raw);
        if (pkg.main && typeof pkg.main === 'string') mainEntry = pkg.main;

        const allDeps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.optionalDependencies,
        };

        for (const dep of Object.keys(allDeps)) {
          if (KNOWN_NATIVE_MODULES.has(dep.toLowerCase())) {
            item.nativeDependencies.push(dep);
          }
          if (KNOWN_DEPRECATED_MODULES.has(dep.toLowerCase())) {
            item.deprecatedDependencies.push(dep);
          }
        }
      } catch {
        item.warnings.push('package.json 格式损坏或无法解析');
        item.riskLevel = 'MEDIUM';
      }
    } else {
      item.warnings.push('缺少 package.json，此插件可能没有独立的 npm 依赖');
    }

    // 检查入口文件
    const possibleEntries = [mainEntry, 'index.js', 'index.cjs', 'server.js', 'main.js'];
    for (const testEntry of possibleEntries) {
      if (await fileExists(path.join(pluginDir, testEntry))) {
        item.entryExists = true;
        break;
      }
    }
    if (!item.entryExists) {
      item.warnings.push(`未找到有效入口文件（尝试了 ${possibleEntries.join(', ')}）`);
      if (item.riskLevel === 'LOW') item.riskLevel = 'MEDIUM';
    }

    // 检查是否有 native 编译构建配置或预编译二进制
    if (await fileExists(path.join(pluginDir, 'binding.gyp'))) {
      if (!item.nativeDependencies.includes('binding.gyp')) {
        item.nativeDependencies.push('binding.gyp');
      }
    }

    if (item.nativeDependencies.length > 0) {
      item.riskLevel = 'HIGH';
      item.warnings.push(`检测到原生 C/C++ 模块依赖：${item.nativeDependencies.join(', ')}`);
      item.suggestions.push('Node 22 环境可能需要本机 C++ 构建工具链，或在迁移后手动重装兼容版本。');
    }

    if (item.deprecatedDependencies.length > 0) {
      item.warnings.push(`使用了已废弃的旧依赖：${item.deprecatedDependencies.join(', ')}`);
      if (item.riskLevel === 'LOW') item.riskLevel = 'MEDIUM';
    }

    items.push(item);
  }

  return items;
}

async function scanClientExtensions(extensionsRoot: string): Promise<PluginCompatibilityItem[]> {
  const items: PluginCompatibilityItem[] = [];
  if (!await dirExists(extensionsRoot)) return items;

  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(extensionsRoot, { withFileTypes: true });
  } catch {
    return items;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extensionsRoot, entry.name);
    const item: PluginCompatibilityItem = {
      name: entry.name,
      type: 'client-extension',
      relativePath: path.join('public/scripts/extensions/third-party', entry.name),
      hasPackageJson: false,
      entryExists: false,
      nativeDependencies: [],
      deprecatedDependencies: [],
      riskLevel: 'LOW',
      warnings: [],
      suggestions: [],
    };

    const pkgPath = path.join(extDir, 'package.json');
    if (await fileExists(pkgPath)) item.hasPackageJson = true;

    // 前端扩展通常有 index.js 或 manifest.json
    const possibleEntries = ['index.js', 'manifest.json', 'main.js', 'extension.js'];
    for (const testEntry of possibleEntries) {
      if (await fileExists(path.join(extDir, testEntry))) {
        item.entryExists = true;
        break;
      }
    }
    if (!item.entryExists) {
      item.warnings.push('缺少 index.js 或 manifest.json');
      item.riskLevel = 'MEDIUM';
    }

    items.push(item);
  }

  return items;
}

export async function analyzeCompatibility(sourceRoot: string): Promise<PluginCompatibilityReport> {
  const serverPlugins = await scanServerPlugins(path.join(sourceRoot, 'plugins'));
  const clientExtensions = await scanClientExtensions(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'));

  const items = [...serverPlugins, ...clientExtensions];
  let highRisk = 0;
  let mediumRisk = 0;
  let lowRisk = 0;

  for (const item of items) {
    if (item.riskLevel === 'HIGH') highRisk++;
    else if (item.riskLevel === 'MEDIUM') mediumRisk++;
    else lowRisk++;
  }

  return {
    items,
    summary: {
      total: items.length,
      serverPlugins: serverPlugins.length,
      clientExtensions: clientExtensions.length,
      highRisk,
      mediumRisk,
      lowRisk,
    },
  };
}

export function formatCompatibilitySummary(report: PluginCompatibilityReport): string {
  const { summary, items } = report;
  if (summary.total === 0) return '未检测到第三方扩展或服务器插件。';

  const lines: string[] = [
    `检测到 ${summary.serverPlugins} 个服务器插件、${summary.clientExtensions} 个前端扩展。`,
  ];

  if (summary.highRisk > 0) {
    lines.push(`⚠️ 发现 ${summary.highRisk} 个高风险插件（包含原生 C++ 模块，Node 22 下需关注兼容性）：`);
    for (const item of items.filter(i => i.riskLevel === 'HIGH')) {
      lines.push(`  • ${item.name}：${item.warnings.join('；')}`);
    }
  }

  if (summary.mediumRisk > 0) {
    lines.push(`ℹ️ 发现 ${summary.mediumRisk} 个中风险插件：`);
    for (const item of items.filter(i => i.riskLevel === 'MEDIUM')) {
      lines.push(`  • ${item.name}：${item.warnings.join('；')}`);
    }
  }

  if (summary.highRisk === 0 && summary.mediumRisk === 0) {
    lines.push('✅ 所有扩展与插件结构完整，未发现已知的 Node 22 原生模块兼容隐患。');
  }

  return lines.join('\n');
}
