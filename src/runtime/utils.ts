/**
 * 文件工具
 *
 * 从 Android RuntimeFileUtils.kt 移植。
 * 去掉 chmod（Windows 无需）、Asset 操作（Windows 无 APK assets）。
 * 保留 unzip（含 Zip Slip 防护）、copy、目录大小计算等。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { net } from 'electron';
import { checkSignal } from './operations';

/** 解压 zip 到目标目录（对应 Android unzipStream，含 Zip Slip 防护） */
export async function unzipToDir(
  zipPath: string,
  destDir: string,
  options: {
    signal?: AbortSignal;
    filter?: (segments: string[]) => boolean;
    maxEntries?: number;
    maxBytes?: number;
    maxEntryBytes?: number;
  } = {},
): Promise<void> {
  checkSignal(options.signal);
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const root = path.resolve(destDir);
  const entries = zip.getEntries();
  if (entries.length > (options.maxEntries ?? 100000)) throw new Error('Archive has too many entries');
  for (const entry of entries) {
    const declared = Number(entry.header.size);
    if (!Number.isFinite(declared) || declared < 0 || declared > (options.maxEntryBytes ?? 512 * 1024 * 1024)) {
      throw new Error('Archive entry size limit exceeded');
    }
  }
  let extractedBytes = 0;
  for (const entry of entries) {
    checkSignal(options.signal);
    const name = String(entry.entryName).replace(/\\/g, '/');
    const segments = name.split('/').filter(Boolean);
    if (segments.includes('..') || segments.some((segment) => segment.includes(':'))
      || name.startsWith('/') || (entry.attr >>> 16 & 0xf000) === 0xa000) {
      throw new Error('Unsafe archive entry');
    }
    if (options.filter && !options.filter(segments)) continue;
    const destination = path.resolve(root, ...segments);
    const relative = path.relative(root, destination);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Archive entry escapes target');
    if (entry.isDirectory) {
      await fs.promises.mkdir(destination, { recursive: true });
    } else {
      extractedBytes += Number(entry.header.size);
      if (!Number.isFinite(extractedBytes) || extractedBytes > (options.maxBytes ?? 16 * 1024 * 1024 * 1024)) {
        throw new Error('Archive expanded size limit exceeded');
      }
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      // Refuse overwriting an existing file. Callers extract only into owned staging.
      const data = await new Promise<Buffer>((resolve, reject) => {
        entry.getDataAsync((buffer: Buffer, error?: Error) => error ? reject(error) : resolve(buffer));
      });
      checkSignal(options.signal);
      if (data.byteLength !== Number(entry.header.size)) throw new Error('Archive entry size mismatch');
      await fs.promises.writeFile(destination, data, { flag: 'wx' });
    }
  }
}

/** 下载文件（对应 Android downloadFile，含进度回调） */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
  signal?: AbortSignal,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<void> {
  checkSignal(signal);
  const downloadSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(300000)])
    : AbortSignal.timeout(300000);
  const response = await net.fetch(url, {
    headers: {
      'User-Agent': 'SillyClient-Windows',
    },
    signal: downloadSignal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  if (total > maxBytes) {
    await response.body.cancel();
    throw new Error('Download size limit exceeded');
  }
  const reader = response.body.getReader();
  let received = 0;
  const body = async function* () {
    try {
      while (true) {
        checkSignal(downloadSignal);
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) throw new Error('Download size limit exceeded');
        if (total && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100)));
        yield Buffer.from(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  const output = createWriteStream(destPath, { flags: 'wx' });
  let createdOutput = false;
  output.once('open', () => { createdOutput = true; });
  try {
    await pipeline(Readable.from(body()), output, { signal: downloadSignal });
    checkSignal(signal);
  } catch (error) {
    if (createdOutput) await fs.promises.rm(destPath, { force: true });
    throw error;
  }
}

/** 复制文件 */
export function copyFile(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
}

/** 用临时文件替换目标，支持 Windows 上连续覆盖同名封面。 */
export function replaceFile(src: string, dest: string): void {
  const temporary = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.copyFileSync(src, temporary);
    fs.rmSync(dest, { force: true });
    fs.renameSync(temporary, dest);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/** 递归复制目录 */
export function copyDir(src: string, dest: string): void {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFile(srcPath, destPath);
    }
  }
}

/** 计算目录大小（字节），默认跳过 node_modules 和 .git 避免递归 30000+ 文件引起严重主线程阻塞 */
export function dirSize(dirPath: string, includeHeavy = false): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!includeHeavy && (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.cache')) {
        continue;
      }
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += dirSize(fullPath, includeHeavy);
      } else {
        try {
          size += fs.statSync(fullPath).size;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return size;
}

/** 递归删除目录 */
export function removeDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Windows 进程释放文件句柄可能稍有延迟，删除实例时等待并验证目录确实消失。 */
export async function removeDirWithRetries(dirPath: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!fs.existsSync(dirPath)) return;
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // 下一轮继续等待被释放的句柄。
    }
    if (!fs.existsSync(dirPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (fs.existsSync(dirPath)) throw new Error(`目录仍被占用：${dirPath}`);
}

/** 格式化文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** 写文本文件 */
export function writeText(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content, 'utf-8');
}

/** 读文本文件 */
export function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** 判断路径是否存在 */
export function exists(p: string): boolean {
  return fs.existsSync(p);
}
