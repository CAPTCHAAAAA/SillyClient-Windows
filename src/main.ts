import { app, BrowserWindow, ipcMain, protocol, shell, Menu, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Plugin and paths modules are implemented by separate sub-agents.
// @ts-ignore — module './plugin' is created separately; suppresses resolution error until it exists.
import * as pluginModule from './plugin';
// @ts-ignore — module './runtime/paths' is created separately.
import * as pathsModule from './runtime/paths';

// ---------------------------------------------------------------------------
// Module contracts (defensive: these modules are implemented by other agents)
// ---------------------------------------------------------------------------

interface PluginContract {
  handle(method: string, options: any): Promise<any>;
  setMainWindow?(win: BrowserWindow | null): void;
  notify?(eventName: string, data: any): void;
  isServerReady?(): boolean;
  getCurrentUrl?(): string | null;
  stopCurrentServer?(): void;
  cleanup?(): void;
}

interface PathsContract {
  getFrontendDistDir?(): string | null;
  bootstrapDir?: string;
}

const plugin = pluginModule as unknown as PluginContract;
const paths = pathsModule as unknown as PathsContract;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_PROTOCOL = 'app';
const FILE_PROTOCOL = 'capacitor-file';
const DEFAULT_BG = '#070408';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let tavernWindow: BrowserWindow | null = null;
let currentTavernUrl: string | null = null;
let topColorTimer: ReturnType<typeof setInterval> | null = null;
let frontendDistDir: string | null = null;

// ---------------------------------------------------------------------------
// Register privileged schemes — MUST be called before app.ready
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  {
    scheme: FILE_PROTOCOL,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

// ---------------------------------------------------------------------------
// Event push helpers
// ---------------------------------------------------------------------------

function pushEvent(eventName: string, data: any): void {
  mainWindow?.webContents.send(`tarven:${eventName}`, data);
}

function pushMode(mode: 'launcher' | 'tavern'): void {
  pushEvent('mode', { mode });
}

// ---------------------------------------------------------------------------
// Frontend dist resolution
// ---------------------------------------------------------------------------

function resolveFrontendDist(): string | null {
  const fromPaths = paths.getFrontendDistDir?.() ?? null;
  if (fromPaths && fs.existsSync(fromPaths)) return fromPaths;
  return null;
}

// ---------------------------------------------------------------------------
// Custom protocol: app:// (serves frontend dist with SPA fallback)
// ---------------------------------------------------------------------------

function registerAppProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    if (!frontendDistDir) {
      return new Response('Frontend dist not found', { status: 503 });
    }

    const url = new URL(request.url);
    const reqPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    // Path traversal guard
    const resolved = path.resolve(frontendDistDir, reqPath || '.');
    if (!resolved.startsWith(frontendDistDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    let filePath = resolved;
    let exists = false;
    try {
      const stat = fs.statSync(filePath);
      exists = !stat.isDirectory();
    } catch {
      exists = false;
    }

    if (!exists) {
      // SPA fallback: no-extension paths serve index.html
      const ext = path.extname(reqPath);
      if (ext) {
        return new Response('Not found', { status: 404 });
      }
      filePath = path.join(frontendDistDir, 'index.html');
    }

    try {
      const data = await fs.promises.readFile(filePath);
      const mime = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Internal error', { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------
// Custom protocol: capacitor-file:// (serves local files for convertFileSrc)
// ---------------------------------------------------------------------------

function registerCapacitorFileProtocol(): void {
  protocol.handle(FILE_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      let filePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      // On Windows the pathname looks like "C:/Users/..." — Node.js accepts forward slashes
      if (!path.isAbsolute(filePath)) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }

      const data = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime } });
    } catch {
      return new Response('Internal error', { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: true,
    backgroundColor: DEFAULT_BG,
    title: 'SillyClient',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadURL(`${APP_PROTOCOL}://localhost/`);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    pushMode('launcher');
  });

  mainWindow.on('resize', () => {
    // tavern 是独立窗口，无需同步
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  plugin.setMainWindow?.(mainWindow);
}

// ---------------------------------------------------------------------------
// Tavern window — 独立窗口
// ---------------------------------------------------------------------------

function enterImmersive(url: string): void {
  destroyTavernWindow();

  const [px, py, pw, ph] = mainWindow
    ? [...mainWindow.getPosition(), ...mainWindow.getSize()]
    : [100, 100, 1280, 800];

  tavernWindow = new BrowserWindow({
    width: pw,
    height: ph,
    x: px + 30,  // 轻微偏移，叠加效果
    y: py + 30,
    minWidth: 800,
    minHeight: 600,
    frame: true,
    backgroundColor: DEFAULT_BG,
    title: 'SillyTavern',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:tavern',
    },
  });

  // 外部链接在系统浏览器打开
  tavernWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  tavernWindow.webContents.on('did-finish-load', () => {
    startTopColorPoll();
  });

  tavernWindow.on('closed', () => {
    stopTopColorPoll();
    tavernWindow = null;
    currentTavernUrl = null;
    // 不切换 mode，主窗口一直在 launcher 模式
  });

  currentTavernUrl = url;
  tavernWindow.loadURL(url);
  tavernWindow.show();
  tavernWindow.focus();

  // 主窗口保持可见，不隐藏
}

function exitImmersive(): void {
  stopTopColorPoll();
  destroyTavernWindow();
  currentTavernUrl = null;

  if (mainWindow) {
    mainWindow.focus();
  }
}

function destroyTavernWindow(): void {
  if (!tavernWindow) return;
  stopTopColorPoll();
  const win = tavernWindow;
  tavernWindow = null;
  try { win.destroy(); } catch { /* ignore */ }
}

function reloadTavern(): void {
  if (tavernWindow) {
    tavernWindow.webContents.reload();
  }
}

async function clearTavernData(): Promise<void> {
  try {
    await session.fromPartition('persist:tavern').clearStorageData();
    if (tavernWindow) {
      await tavernWindow.webContents.session.clearCache();
      tavernWindow.webContents.clearHistory();
    }
  } catch {
    // ignore
  }
}

function getStatus(): { mode: string; url: string | null; serverReady: boolean } {
  return {
    mode: tavernWindow ? 'tavern' : 'launcher',
    url: currentTavernUrl || plugin.getCurrentUrl?.() || null,
    serverReady: plugin.isServerReady?.() ?? false,
  };
}

// ---------------------------------------------------------------------------
// Top color sampling (simplified for Windows)
// ---------------------------------------------------------------------------

function startTopColorPoll(): void {
  stopTopColorPoll();
  topColorTimer = setInterval(() => {
    sampleTopColor().catch(() => {});
  }, 1500);
}

function stopTopColorPoll(): void {
  if (topColorTimer) {
    clearInterval(topColorTimer);
    topColorTimer = null;
  }
}

async function sampleTopColor(): Promise<void> {
  if (!tavernWindow) return;
  try {
    const script = `
      (function() {
        try {
          var el = document.elementFromPoint(window.innerWidth / 2, 2);
          if (!el) el = document.body;
          var bg = window.getComputedStyle(el).backgroundColor;
          if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') {
            bg = window.getComputedStyle(document.body).backgroundColor;
          }
          return bg;
        } catch (e) {
          return null;
        }
      })()
    `;
    const result = await tavernWindow.webContents.executeJavaScript(script);
    if (result && typeof result === 'string') {
      const hex = rgbToHex(result);
      if (hex) {
        tavernWindow.setBackgroundColor(hex);
      }
    }
  } catch {
    // ignore sampling errors
  }
}

function rgbToHex(rgb: string): string | null {
  const match = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) return null;
  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle('tarven-env', async (_event, payload: { method: string; options?: any }) => {
    const { method, options } = payload || {};

    // Window/view methods handled locally (need BrowserWindow access)
    switch (method) {
      case 'enterImmersive':
        enterImmersive(options?.url || '');
        return { success: true };

      case 'exitImmersive':
        exitImmersive();
        return { success: true };

      case 'returnToTavern': {
        const url = currentTavernUrl || plugin.getCurrentUrl?.();
        if (!url || !plugin.isServerReady?.()) {
          throw new Error('当前没有正在运行的实例');
        }
        enterImmersive(url);
        return { success: true };
      }

      case 'closeTavern':
        exitImmersive();
        plugin.stopCurrentServer?.();
        return { success: true };

      case 'reloadTavern':
        reloadTavern();
        return { success: true };

      case 'clearWebViewData':
        await clearTavernData();
        return { success: true };

      case 'getStatus':
        return getStatus();

      case 'getSafeInsets':
        // Windows 无挖孔，返回标题栏高度（约 32px）让前端停止轮询
        return { top: 32, bottom: 0, left: 0, right: 0 };

      default:
        // All other methods routed to plugin module
        return await plugin.handle(method, options);
    }
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  frontendDistDir = resolveFrontendDist();

  if (!frontendDistDir) {
    console.error(
      '[SillyClient] frontend-dist is missing. Build the shared UI, then run npm run sync:frontend.',
    );
  }

  registerAppProtocol();
  registerCapacitorFileProtocol();
  registerIpc();

  Menu.setApplicationMenu(null);
  createMainWindow();
});

app.on('window-all-closed', () => {
  stopTopColorPoll();
  destroyTavernWindow();
  plugin.cleanup?.();
  app.quit();
});

app.on('before-quit', () => {
  stopTopColorPoll();
  destroyTavernWindow();
  plugin.cleanup?.();
});
