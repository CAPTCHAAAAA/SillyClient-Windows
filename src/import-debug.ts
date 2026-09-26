import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beginImport, cancelImport, defaultImportDirectory, IMPORT_NOTICES, isImportRunning } from './windows-import';
import type { ImportRequest, ImportStatus } from './windows-import';
import { discoverLocalTaverns } from './runtime/auto-discover';

let window: BrowserWindow | null = null;
let busy = false;
let handlersInstalled = false;
const html = path.join(__dirname, '..', 'resources', 'import-debug', 'index.html');

function authorize(event: IpcMainInvokeEvent): BrowserWindow {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== pathToFileURL(html).href) {
    throw new Error('Invalid import window.');
  }
  return window;
}

export function showImportDebugWindow(launcher: BrowserWindow, runtimeBusy: () => boolean): void {
  if (window && !window.isDestroyed()) {
    window.show();
    window.focus();
    return;
  }
  if (!handlersInstalled) {
    handlersInstalled = true;
    ipcMain.handle('import-debug:defaults', event => {
      authorize(event);
      return { destination: defaultImportDirectory(), notices: IMPORT_NOTICES };
    });
    ipcMain.handle('import-debug:discover', async event => {
      authorize(event);
      return discoverLocalTaverns();
    });
    ipcMain.handle('import-debug:choose', async (event, field: unknown) => {
      const owner = authorize(event);
      if (busy) return null;
      if (field === 'zip') {
        const selected = await dialog.showOpenDialog(owner, {
          title: '选择旧酒馆备份 ZIP 压缩包',
          properties: ['openFile'],
          filters: [{ name: 'ZIP 压缩包 (*.zip)', extensions: ['zip'] }],
        });
        return selected.canceled ? null : selected.filePaths[0];
      }
      const titles: Record<string, string> = {
        source: '选择旧酒馆文件夹，或其中的 data 文件夹',
        destination: '选择导入副本的保存文件夹',
      };
      if (typeof field !== 'string' || !Object.hasOwn(titles, field)) throw new Error('Invalid directory field.');
      const selected = await dialog.showOpenDialog(owner, { title: titles[field], properties: ['openDirectory'] });
      return selected.canceled ? null : selected.filePaths[0];
    });

    ipcMain.handle('import-debug:cancel', event => {
      authorize(event);
      if (busy) cancelImport();
    });
    ipcMain.handle('import-debug:start', async (event, input: unknown) => {
      const owner = authorize(event);
      if (busy || isImportRunning()) throw new Error('已有导入任务正在进行。');
      if (!input || typeof input !== 'object') throw new Error('Invalid import request.');
      const request: ImportRequest = {};
      const mode = (input as Record<string, unknown>).mode;
      if (mode !== 'copy' && mode !== 'in-place') throw new Error('请选择复制迁移或原地接管。');
      request.mode = mode;
      for (const key of ['source', 'runtimeRoot', 'destination'] as const) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value !== 'string' || value.length > 32767 || value.includes('\0')) {
          throw new Error('Invalid import path.');
        }
        if (value.trim()) request[key] = value.trim();
      }
      if (!request.source) throw new Error('请选择旧酒馆文件夹。');
      if (mode === 'copy' && !request.destination) throw new Error('请选择导入副本的保存文件夹。');
      busy = true;
      try {
        await beginImport(owner, runtimeBusy, request, (status: ImportStatus) => {
          if (!owner.isDestroyed()) owner.webContents.send('import-debug:status', status);
        }, owner.getParentWindow() || owner);
      } finally {
        busy = false;
      }
    });
  }
  window = new BrowserWindow({
    parent: launcher, width: 660, height: 430, minWidth: 520, minHeight: 400,
    title: '目录导入 · 调试', autoHideMenuBar: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'import-debug-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (busy) {
      event.preventDefault();
      cancelImport();
    }
  });
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => window?.show());
  void window.loadFile(html);
}
