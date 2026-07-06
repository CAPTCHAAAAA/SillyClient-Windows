import { app, BrowserWindow, ipcMain, protocol, WebContentsView, shell, Menu, session } from 'electron';
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
let tavernView: WebContentsView | null = null;
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
  // 1. Ask paths module (preferred — may know the exact build location)
  const fromPaths = paths.getFrontendDistDir?.() ?? null;
  if (fromPaths && fs.existsSync(fromPaths)) return fromPaths;

  // 2. Local copy under web/capacitor-ui/dist (production build)
  const localCandidate = path.join(__dirname, '..', 'web', 'capacitor-ui', 'dist');
  if (fs.existsSync(localCandidate)) return localCandidate;

  // 3. Android sibling directory (development: share the same frontend build)
  const androidCandidate = path.join(
    __dirname, '..', '..', 'SillyClient_Android', 'App', 'web', 'capacitor-ui', 'dist',
  );
  if (fs.existsSync(androidCandidate)) return androidCandidate;

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
    syncTavernViewBounds();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  plugin.setMainWindow?.(mainWindow);
}

// ---------------------------------------------------------------------------
// Immersive mode (tavern view via WebContentsView)
// ---------------------------------------------------------------------------

function syncTavernViewBounds(): void {
  if (!tavernView || !mainWindow) return;
  const [width, height] = mainWindow.getContentSize();
  tavernView.setBounds({ x: 0, y: 0, width, height });
}

function enterImmersive(url: string): void {
  if (!mainWindow) return;

  destroyTavernView();

  tavernView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:tavern',
    },
  });

  syncTavernViewBounds();
  mainWindow.contentView.addChildView(tavernView);

  // Open external links in system browser
  tavernView.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: 'deny' };
  });

  tavernView.webContents.on('did-finish-load', () => {
    startTopColorPoll();
  });

  currentTavernUrl = url;
  tavernView.webContents.loadURL(url);

  pushMode('tavern');
}

function exitImmersive(): void {
  stopTopColorPoll();
  destroyTavernView();
  currentTavernUrl = null;

  if (mainWindow) {
    mainWindow.setBackgroundColor(DEFAULT_BG);
  }

  pushMode('launcher');
}

function destroyTavernView(): void {
  if (!tavernView) return;
  const view = tavernView;
  tavernView = null;
  try {
    mainWindow?.contentView.removeChildView(view);
  } catch {
    // ignore
  }
  try {
    const wc = view.webContents as any;
    if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed()) {
      if (typeof wc.destroy === 'function') wc.destroy();
    }
  } catch {
    // ignore
  }
}

function reloadTavern(): void {
  if (tavernView) {
    tavernView.webContents.reload();
  }
}

async function clearTavernData(): Promise<void> {
  if (!tavernView) return;
  try {
    await session.fromPartition('persist:tavern').clearStorageData();
    await tavernView.webContents.session.clearCache();
    tavernView.webContents.clearHistory();
  } catch {
    // ignore
  }
}

function getStatus(): { mode: string; url: string | null; serverReady: boolean } {
  return {
    mode: tavernView ? 'tavern' : 'launcher',
    url: currentTavernUrl,
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
  if (!tavernView || !mainWindow) return;
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
    const result = await tavernView.webContents.executeJavaScript(script);
    if (result && typeof result === 'string') {
      const hex = rgbToHex(result);
      if (hex) {
        mainWindow.setBackgroundColor(hex);
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

      case 'reloadTavern':
        reloadTavern();
        return { success: true };

      case 'clearWebViewData':
        await clearTavernData();
        return { success: true };

      case 'getStatus':
        return getStatus();

      case 'getSafeInsets':
        // Windows has no notch/status-bar cutout; return zero insets
        return { top: 0, bottom: 0, left: 0, right: 0 };

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
      '[SillyClient] Frontend dist not found. Build capacitor-ui first:\n' +
      '  cd web/capacitor-ui && pnpm build\n' +
      '  or ensure SillyClient_Android/App/web/capacitor-ui/dist exists.',
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
  destroyTavernView();
  plugin.cleanup?.();
  app.quit();
});

app.on('before-quit', () => {
  stopTopColorPoll();
  destroyTavernView();
  plugin.cleanup?.();
});
