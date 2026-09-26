import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { MigrationError } from './data-migration';

export interface ZipImportOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number, message: string) => void;
}

export interface ZipExtractResult {
  stagingDir: string;
  tavernRoot: string;
  cleanup: () => Promise<void>;
}

const MAX_ZIP_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024 * 1024; // 20 GB 保护上限

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function hasTavernRuntime(dir: string): Promise<boolean> {
  const hasPkg = await fileExists(path.join(dir, 'package.json'));
  const hasServer = await fileExists(path.join(dir, 'server.js'));
  return hasPkg && hasServer;
}

export async function locateTavernRoot(extractedDir: string): Promise<string> {
  if (await hasTavernRuntime(extractedDir)) {
    return extractedDir;
  }

  // 检查第一层子目录
  try {
    const entries = await fs.readdir(extractedDir, { withFileTypes: true });
    const subdirs = entries.filter(e => e.isDirectory());

    for (const subdir of subdirs) {
      const candidate = path.join(extractedDir, subdir.name);
      if (await hasTavernRuntime(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }

  throw new MigrationError('INVALID_ZIP_STRUCTURE',
    '选中的 ZIP 压缩包内未找到 SillyTavern 程序文件（根目录或子文件夹下需包含 package.json 和 server.js）。');
}

export async function extractAndValidateZip(
  zipFilePath: string,
  stagingParent: string,
  options: ZipImportOptions = {},
): Promise<ZipExtractResult> {
  if (options.signal?.aborted) throw new MigrationError('CANCELLED', '操作已取消。');

  const stat = await fs.stat(zipFilePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new MigrationError('ENOENT', `ZIP 压缩包不存在或不是有效文件：${zipFilePath}`);
  }

  if (!zipFilePath.toLowerCase().endsWith('.zip')) {
    throw new MigrationError('INVALID_ZIP_EXTENSION', '所选文件不是 .zip 格式压缩包。');
  }

  const stagingDir = path.join(stagingParent, `zip-extract-${randomUUID()}`);
  await fs.mkdir(stagingDir, { recursive: true });

  const cleanup = async () => {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    options.onProgress?.(5, '正在读取并校验 ZIP 归档…');
    const zip = new AdmZip(zipFilePath);
    const entries = zip.getEntries();

    if (entries.length > MAX_ZIP_ENTRIES) {
      throw new MigrationError('ZIP_OVERFLOW', `ZIP 条目数超过安全上限（${MAX_ZIP_ENTRIES}）。`);
    }

    let totalUncompressed = 0;
    for (const entry of entries) {
      totalUncompressed += entry.header.size;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        throw new MigrationError('ZIP_BOMB_PREVENTION', 'ZIP 解压容量超过安全保护上限 (20GB)。');
      }

      // 严格防御 Zip Slip 路径穿越
      const sanitizedName = entry.entryName.replace(/\\/g, '/');
      const resolvedTarget = path.resolve(stagingDir, sanitizedName);
      if (!resolvedTarget.startsWith(path.resolve(stagingDir) + path.sep) && resolvedTarget !== path.resolve(stagingDir)) {
        throw new MigrationError('ZIP_SLIP_ATTACK', `ZIP 包含非法的相对路径条目: ${entry.entryName}`);
      }
    }

    // 执行解压
    const totalEntries = entries.length;
    let extractedCount = 0;

    for (const entry of entries) {
      if (options.signal?.aborted) throw new MigrationError('CANCELLED', '解压已取消。');

      const entryName = entry.entryName.replace(/\\/g, '/');
      const targetPath = path.resolve(stagingDir, entryName);

      if (entry.isDirectory) {
        await fs.mkdir(targetPath, { recursive: true });
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const content = entry.getData();
        await fs.writeFile(targetPath, content);
      }

      extractedCount++;
      if (extractedCount % 100 === 0 || extractedCount === totalEntries) {
        const percent = Math.min(90, Math.floor(5 + (extractedCount / totalEntries) * 85));
        options.onProgress?.(percent, `正在解压文件 (${extractedCount}/${totalEntries})…`);
      }
    }

    options.onProgress?.(95, '正在定位酒馆根目录…');
    const tavernRoot = await locateTavernRoot(stagingDir);

    options.onProgress?.(100, '解压与结构定位完成。');
    return {
      stagingDir,
      tavernRoot,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
