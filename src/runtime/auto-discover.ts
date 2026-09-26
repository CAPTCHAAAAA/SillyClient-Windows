import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface DiscoveredTavern {
  name: string;
  path: string;
  version: string;
  dataRoot: string;
  hasUserData: boolean;
}

export interface DiscoverOptions {
  customRoots?: string[];
  maxResults?: number;
  signal?: AbortSignal;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function inspectCandidate(candidatePath: string): Promise<DiscoveredTavern | null> {
  try {
    const pkgFile = path.join(candidatePath, 'package.json');
    const serverFile = path.join(candidatePath, 'server.js');

    const [pkgStat, serverStat] = await Promise.all([
      fs.stat(pkgFile).catch(() => null),
      fs.stat(serverFile).catch(() => null),
    ]);

    if (!pkgStat || !pkgStat.isFile() || !serverStat || !serverStat.isFile()) {
      return null;
    }

    const pkgContent = await fs.readFile(pkgFile, 'utf8');
    const pkg = JSON.parse(pkgContent);

    const name = String(pkg.name || '').toLowerCase();
    const version = String(pkg.version || 'unknown');

    // 检查是否是 SillyTavern
    if (!name.includes('sillytavern') && !name.includes('tavern') && !name.includes('sillyclient')) {
      // 如果 package.json name 不直接包含，但存在 server.js 并且有 data 目录也做包容
      const dataDir = path.join(candidatePath, 'data');
      if (!await isDirectory(dataDir)) return null;
    }

    const dataRoot = path.join(candidatePath, 'data');
    let hasUserData = false;
    if (await isDirectory(dataRoot)) {
      const defaultUser = path.join(dataRoot, 'default-user');
      hasUserData = await isDirectory(defaultUser);
    }

    const displayName = path.basename(candidatePath) || 'SillyTavern';

    return {
      name: displayName,
      path: path.resolve(candidatePath),
      version,
      dataRoot,
      hasUserData,
    };
  } catch {
    return null;
  }
}

export async function discoverLocalTaverns(options: DiscoverOptions = {}): Promise<DiscoveredTavern[]> {
  const results: DiscoveredTavern[] = [];
  const seenPaths = new Set<string>();
  const maxResults = options.maxResults ?? 20;

  function addResult(item: DiscoveredTavern): boolean {
    const normalized = path.normalize(item.path).toLowerCase();
    if (seenPaths.has(normalized)) return false;
    seenPaths.add(normalized);
    results.push(item);
    return results.length >= maxResults;
  }

  // 1. 如果提供了自定义测试路径
  if (options.customRoots && options.customRoots.length > 0) {
    for (const root of options.customRoots) {
      if (options.signal?.aborted) break;
      const direct = await inspectCandidate(root);
      if (direct && addResult(direct)) return results;

      if (await isDirectory(root)) {
        try {
          const entries = await fs.readdir(root, { withFileTypes: true });
          for (const entry of entries) {
            if (options.signal?.aborted) break;
            if (entry.isDirectory()) {
              const child = await inspectCandidate(path.join(root, entry.name));
              if (child && addResult(child)) return results;
            }
          }
        } catch {
          // ignore
        }
      }
    }
    return results;
  }

  // 2. 真实系统常见路径探测
  const candidateDirectories: string[] = [];

  const userProfile = process.env.USERPROFILE || process.env.HOME;
  if (userProfile) {
    candidateDirectories.push(
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Downloads'),
      path.join(userProfile, 'Documents'),
    );
  }

  // 常见盘符探测
  const drives = ['C:', 'D:', 'E:', 'F:'];
  const commonFolders = ['', 'AI', 'Tools', 'Software', 'Games', 'Programs'];

  for (const drive of drives) {
    for (const folder of commonFolders) {
      const base = folder ? path.join(drive + path.sep, folder) : (drive + path.sep);
      candidateDirectories.push(
        path.join(base, 'SillyTavern'),
        path.join(base, 'sillytavern'),
        path.join(base, 'SillyTavern-master'),
        path.join(base, 'SillyTavern-Launcher'),
        path.join(base, '酒馆'),
      );
    }
  }

  // 检查固定位置候选
  for (const candidate of candidateDirectories) {
    if (options.signal?.aborted) break;
    const direct = await inspectCandidate(candidate);
    if (direct && addResult(direct)) return results;
  }

  // 在 Desktop / Downloads 下扫描第一层子目录，查找包含 SillyTavern 的文件夹
  if (userProfile) {
    const scanDirs = [
      path.join(userProfile, 'Desktop'),
      path.join(userProfile, 'Downloads'),
    ];
    for (const dir of scanDirs) {
      if (options.signal?.aborted) break;
      if (!await isDirectory(dir)) continue;
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (options.signal?.aborted) break;
          if (entry.isDirectory()) {
            const nameLower = entry.name.toLowerCase();
            if (nameLower.includes('silly') || nameLower.includes('tavern') || nameLower.includes('酒馆')) {
              const found = await inspectCandidate(path.join(dir, entry.name));
              if (found && addResult(found)) return results;
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return results;
}
