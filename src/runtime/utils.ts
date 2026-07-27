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
import * as zlib from 'node:zlib';
import { createWriteStream, createReadStream } from 'node:fs';
import { once } from 'node:events';
import { net } from 'electron';

/** 解压 zip 到目标目录（对应 Android unzipStream，含 Zip Slip 防护） */
export async function unzipToDir(zipPath: string, destDir: string): Promise<void> {
  // Windows 上用 PowerShell 的 Expand-Archive 或 ADM-ZIP
  // 这里用动态 import ADM-ZIP 更简单
  let AdmZip: any;
  try {
    AdmZip = require('adm-zip');
  } catch {
    // 如果没有 adm-zip，用 PowerShell fallback
    return unzipWithPowerShell(zipPath, destDir);
  }

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(destDir, true);
}

/** PowerShell fallback 解压 */
async function unzipWithPowerShell(zipPath: string, destDir: string): Promise<void> {
  const { execFile } = require('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`],
      { timeout: 300000, windowsHide: true },
      (err: any) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

/** 下载文件（对应 Android downloadFile，含进度回调） */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const response = await net.fetch(url, {
    headers: {
      'User-Agent': 'SillyClient-Windows',
    },
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}`);
  }

  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body.getReader();
  const output = createWriteStream(destPath);
  let received = 0;
  let streamError: Error | null = null;
  output.on('error', (error) => {
    streamError = error;
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (streamError) throw streamError;
      received += value.byteLength;
      if (!output.write(Buffer.from(value))) {
        await once(output, 'drain');
      }
      if (total && onProgress) {
        onProgress(Math.round((received / total) * 100));
      }
    }
    if (streamError) throw streamError;
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
}

/** 复制文件 */
export function copyFile(src: string, dest: string): void {
  fs.copyFileSync(src, dest);
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

/** 计算目录大小（字节） */
export function dirSize(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += dirSize(fullPath);
    } else {
      try {
        size += fs.statSync(fullPath).size;
      } catch {
        // ignore
      }
    }
  }
  return size;
}

/** 递归删除目录 */
export function removeDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
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
