/**
 * 原生系统文件与目录选择对话框服务
 */

import { BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from './runtime/paths';
import * as utils from './runtime/utils';
import { assertPlainPath } from './runtime/cleanup';
import type {
  PickDirectoryParams,
  PickDirectoryResult,
  PickImageParams,
  PickImageResult,
  PickZipFileResult,
} from './contracts/ipc-contracts';

export async function pickDirectoryDialog(
  window: BrowserWindow | null,
  options?: PickDirectoryParams,
): Promise<PickDirectoryResult> {
  const purpose = options?.purpose;
  if (purpose !== undefined && purpose !== 'installation' && purpose !== 'source') {
    throw new Error('Invalid directory picker purpose');
  }
  if (!window || window.isDestroyed()) return { name: '', path: '' };

  const result = await dialog.showOpenDialog(window, {
    ...(purpose === 'installation' ? { title: '选择实例安装根目录' } : {}),
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { name: '', path: '' };
  }
  const p = result.filePaths[0];
  return {
    name: path.basename(p),
    path: p,
    ...(purpose === 'installation' ? { installPathMode: 'root' as const } : {}),
  };
}

export async function pickImageDialog(
  window: BrowserWindow | null,
  options: PickImageParams,
  onInvalidate?: () => void,
): Promise<PickImageResult> {
  if (!window || window.isDestroyed()) {
    throw new Error('主窗口不可用，无法打开图片选择器');
  }
  const rawInstanceId = typeof options?.instanceId === 'string' ? options.instanceId : '';
  const instanceId = rawInstanceId
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80) || 'default';

  const result = await dialog.showOpenDialog(window, {
    title: '选择封面图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: '' };
  }

  const src = result.filePaths[0];
  const ext = path.extname(src).toLowerCase();

  if (!fs.existsSync(paths.coversDir)) {
    fs.mkdirSync(paths.coversDir, { recursive: true });
  }

  const dest = path.join(
    paths.coversDir,
    `${instanceId}--cover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`,
  );

  onInvalidate?.();
  await assertPlainPath(paths.coversDir);
  utils.replaceFile(src, dest);

  return {
    path: dest,
    url: `app://localhost/__sillyclient_cover__/${encodeURIComponent(path.basename(dest))}`,
  };
}

export async function pickZipFileDialog(
  window: BrowserWindow | null,
): Promise<PickZipFileResult> {
  if (!window || window.isDestroyed()) return { path: '', sizeBytes: 0 };

  const result = await dialog.showOpenDialog(window, {
    title: '选择 zip 文件',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { path: '', sizeBytes: 0 };
  }

  const p = result.filePaths[0];
  const stat = fs.statSync(p);
  return { path: p, sizeBytes: stat.size };
}

export async function pickSaveZipFileDialog(
  window: BrowserWindow | null,
  defaultFileName: string,
): Promise<{ canceled: boolean; filePath?: string }> {
  if (!window || window.isDestroyed()) return { canceled: true };

  const result = await dialog.showSaveDialog(window, {
    title: '选择导出 ZIP 保存位置',
    defaultPath: defaultFileName,
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  return { canceled: false, filePath: result.filePath };
}

