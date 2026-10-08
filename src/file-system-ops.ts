/**
 * 安全文本导出保存与读取服务
 */

import { BrowserWindow, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as paths from './runtime/paths';
import * as utils from './runtime/utils';
import type {
  SaveTextFileParams,
  ReadTextFileParams,
  ReadTextFileResult,
} from './contracts/ipc-contracts';

export async function saveTextFileSafely(
  window: BrowserWindow | null,
  options: SaveTextFileParams,
): Promise<void> {
  if (!window || window.isDestroyed()) {
    throw new Error('主窗口不可用，无法打开保存位置');
  }
  if (options?.content == null) {
    throw new Error('缺少导出内容');
  }

  const rawName = typeof options.fileName === 'string' ? options.fileName : '';
  const safeName = rawName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[._]+/, '')
    .trim()
    .slice(0, 180) || 'sillyclient-export.json';

  paths.ensureDirs();
  const result = await dialog.showSaveDialog(window, {
    title: '导出',
    defaultPath: path.join(paths.tmpDir, safeName),
  });
  if (result.canceled || !result.filePath) return;

  const temporary = path.join(
    path.dirname(result.filePath),
    `.sillyclient-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, String(options.content), 'utf8');
    utils.replaceFile(temporary, result.filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function readTextFileSafely(
  window: BrowserWindow | null,
  _options?: ReadTextFileParams,
): Promise<ReadTextFileResult> {
  if (!window || window.isDestroyed()) {
    throw new Error('主窗口不可用');
  }
  const result = await dialog.showOpenDialog(window, {
    title: '选择导入文件',
    filters: [
      { name: 'JSON 备份文件', extensions: ['json'] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    throw new Error('cancelled');
  }
  const filePath = result.filePaths[0];
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return {
    content,
    fileName: path.basename(filePath),
  };
}
