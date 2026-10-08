/**
 * SillyClient Windows - Electron 主进程宿主
 *
 * 状态：FROZEN（2026-10-09 起终态冻结，此路线为最完美解，严禁随意改动！）
 * 详见权威冻结准则：docs/WINDOWS-BACKEND-ARCHITECTURE-FREEZE.md
 */

import {
  app, BrowserWindow, ipcMain, protocol, shell, Menu, session,
  type IpcMainInvokeEvent, type WebContents,
} from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as plugin from './plugin';
import * as paths from './runtime/paths';
import { loadRemoteBasicAuth } from './remote-auth';
import {
  decideLauncherNavigation, decideTavernNavigation, isLauncherUrl, parseHttpUrl,
  type NavigationDecision,
} from './external-navigation';
import type {
  ContentOpenMode,
  GetStatusResult,
} from './contracts/ipc-contracts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_PROTOCOL = 'app';
const FILE_PROTOCOL = 'capacitor-file';
const COVER_ROUTE_PREFIX = '__sillyclient_cover__/';
const APP_USER_MODEL_ID = 'com.sillyclient';
const DEFAULT_BG = '#070408';
const WINDOW_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

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
let currentTavernInstanceId: string | null = null;
let tavernViewRevision = 0;
let topColorTimer: ReturnType<typeof setInterval> | null = null;
let lastTopColorHex: string | null = null;
let samplingTopColor = false;
let frontendDistDir: string | null = null;
let contentOpenMode: ContentOpenMode = 'webview';

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
  const win = mainWindow;
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(`tarven:${eventName}`, data);
}

function pushMode(mode: 'launcher' | 'tavern'): void {
  pushEvent('mode', { mode });
}

// ---------------------------------------------------------------------------
// Frontend dist resolution
// ---------------------------------------------------------------------------

function resolveFrontendDist(): string | null {
  const fromPaths = paths.getFrontendDistDir();
  if (fromPaths && fs.existsSync(fromPaths)) return fromPaths;
  return null;
}

const frontendFileCache = new Map<string, { data: Buffer; mime: string; cacheControl: string }>();

function preloadFrontendDist(distDir: string): void {
  frontendFileCache.clear();
  try {
    const walk = (currentDir: string, relativePrefix: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(fullPath, relPath);
        } else {
          try {
            const data = fs.readFileSync(fullPath);
            const ext = path.extname(entry.name).toLowerCase();
            const mime = MIME_TYPES[ext] || 'application/octet-stream';
            // Vite 哈希静态资源和字体完全不可变，开启强缓存以激活 Chromium V8 Bytecode 缓存
            const isImmutable = relPath.startsWith('assets/') || relPath.startsWith('fonts/');
            const cacheControl = isImmutable
              ? 'public, max-age=31536000, immutable'
              : 'no-cache';
            frontendFileCache.set(relPath, { data, mime, cacheControl });
          } catch {
            // ignore
          }
        }
      }
    };
    walk(distDir, '');
  } catch (e) {
    console.error('[SillyClient] Failed to preload frontend dist', e);
  }
}

// ---------------------------------------------------------------------------
// Custom protocol: app:// (serves frontend dist with in-memory V8 cache)
// ---------------------------------------------------------------------------

function registerAppProtocol(): void {
  protocol.handle(APP_PROTOCOL, async (request) => {
    if (!frontendDistDir) {
      return new Response('Frontend dist not found', { status: 503 });
    }

    const url = new URL(request.url);
    const reqPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    if (reqPath.startsWith(COVER_ROUTE_PREFIX)) {
      const requestedName = reqPath.slice(COVER_ROUTE_PREFIX.length);
      const fileName = path.basename(requestedName);
      const coversDir = paths.coversDir;
      const ext = path.extname(fileName).toLowerCase();
      if (
        !coversDir
        || !fileName
        || fileName !== requestedName
        || !['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)
      ) {
        return new Response('Forbidden', { status: 403 });
      }

      const filePath = path.join(coversDir, fileName);
      try {
        const data = await fs.promises.readFile(filePath);
        return new Response(new Uint8Array(data), {
          headers: {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    // 内存极速匹配 (0ms 零磁盘 IO，直接内存命中)
    const cached = frontendFileCache.get(reqPath || 'index.html');
    if (cached) {
      return new Response(new Uint8Array(cached.data), {
        headers: {
          'Content-Type': cached.mime,
          'Cache-Control': cached.cacheControl,
        },
      });
    }

    // SPA fallback (无扩展名路径返回 index.html)
    const fallback = frontendFileCache.get('index.html');
    if (fallback && !path.extname(reqPath)) {
      return new Response(new Uint8Array(fallback.data), {
        headers: {
          'Content-Type': fallback.mime,
          'Cache-Control': fallback.cacheControl,
        },
      });
    }

    // 路径遍历检查与磁盘兜底
    const resolved = path.resolve(frontendDistDir, reqPath || '.');
    if (!resolved.startsWith(frontendDistDir)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(resolved);
      const mime = MIME_TYPES[path.extname(resolved)] || 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('Not found', { status: 404 });
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
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': mime,
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    } catch {
      return new Response('Internal error', { status: 500 });
    }
  });
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

function validatedExternalUrl(value: unknown): string {
  const target = parseHttpUrl(value);
  if (!target) throw new Error('Only absolute HTTP(S) URLs without credentials are supported');
  return target.href;
}

async function openExternalUrl(value: unknown): Promise<void> {
  await shell.openExternal(validatedExternalUrl(value));
}

function dispatchExternalNavigation(url: string): void {
  void openExternalUrl(url).catch(() => {
    console.error('[SillyClient] Failed to open an external page in the system browser.');
  });
}

function installNavigationPolicy(
  contents: WebContents,
  decide: (url: unknown, isMainFrame: boolean) => NavigationDecision,
  isCurrent: () => boolean,
): void {
  const navigate = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
    if (!isCurrent()) return;
    const decision = decide(event.url, event.isMainFrame === true);
    if (decision.action === 'allow') return;
    event.preventDefault();
    if (decision.action === 'external') dispatchExternalNavigation(decision.url);
  };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
  contents.setWindowOpenHandler(({ url }) => {
    const target = isCurrent() ? parseHttpUrl(url) : null;
    if (target) dispatchExternalNavigation(target.href);
    return { action: 'deny' };
  });
}

function requireLauncherCaller(event: IpcMainInvokeEvent): void {
  const win = mainWindow;
  const frame = event.senderFrame;
  if (
    !win || win.isDestroyed() || win.webContents.isDestroyed()
    || event.sender !== win.webContents || !frame || frame !== win.webContents.mainFrame
    || !isLauncherUrl(frame.url) || !isLauncherUrl(frame.origin)
  ) {
    throw new Error('External URL calls must come from the launcher main frame');
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: true,
    backgroundColor: DEFAULT_BG,
    title: 'SillyClient',
    icon: WINDOW_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const win = mainWindow;
  installNavigationPolicy(
    win.webContents, decideLauncherNavigation,
    () => mainWindow === win && !win.isDestroyed(),
  );
  mainWindow.loadURL(`${APP_PROTOCOL}://localhost/`);

  let shown = false;
  const showWindow = () => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
  };

  mainWindow.once('ready-to-show', showWindow);
  // 400ms 保底显示，杜绝冷启动等待
  setTimeout(showWindow, 400);

  mainWindow.webContents.on('did-finish-load', () => {
    pushMode('launcher');
  });

  mainWindow.on('closed', () => {
    plugin.setMainWindow(null);
    mainWindow = null;
  });

  plugin.setMainWindow(mainWindow);
}

// ---------------------------------------------------------------------------
// Tavern window — 独立窗口
// ---------------------------------------------------------------------------

function preferencesPath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

function loadPreferences(): void {
  try {
    const stored = JSON.parse(fs.readFileSync(preferencesPath(), 'utf8'));
    if (stored.contentOpenMode === 'webview' || stored.contentOpenMode === 'browser') {
      contentOpenMode = stored.contentOpenMode;
    }
  } catch {
    contentOpenMode = 'webview';
  }
}

function saveContentOpenMode(mode: ContentOpenMode): ContentOpenMode {
  if (mode !== 'webview' && mode !== 'browser') {
    throw new Error('不支持的打开方式');
  }

  contentOpenMode = mode;
  const target = preferencesPath();
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify({ contentOpenMode: mode }, null, 2)}\n`, 'utf8');
  fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);
  return mode;
}

async function enterImmersive(url: unknown, instanceId?: unknown): Promise<void> {
  const targetUrl = validatedExternalUrl(url);
  if (instanceId != null && typeof instanceId !== 'string') {
    throw new Error('instanceId must be a string');
  }
  const identity = typeof instanceId === 'string' ? instanceId.trim() : '';

  // Legacy project-link calls must not replace a running instance's view or identity.
  if (!identity) {
    await openExternalUrl(targetUrl);
    return;
  }
  const revision = ++tavernViewRevision;
  if (contentOpenMode === 'browser') {
    await openExternalUrl(targetUrl);
    if (revision !== tavernViewRevision) return;
    destroyTavernWindow();
    currentTavernUrl = targetUrl;
    currentTavernInstanceId = identity;
    mainWindow?.focus();
    return;
  }

  destroyTavernWindow();
  currentTavernUrl = targetUrl;
  currentTavernInstanceId = identity;

  const [px, py, pw, ph] = mainWindow
    ? [...mainWindow.getPosition(), ...mainWindow.getSize()]
    : [100, 100, 1280, 800];

  const win = new BrowserWindow({
    width: pw,
    height: ph,
    x: px + 30,  // 轻微偏移，叠加效果
    y: py + 30,
    minWidth: 800,
    minHeight: 600,
    frame: true,
    backgroundColor: DEFAULT_BG,
    title: 'SillyTavern',
    icon: WINDOW_ICON,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:tavern',
    },
  });
  tavernWindow = win;

  const credentials = loadRemoteBasicAuth(identity);
  const targetOrigin = new URL(targetUrl).origin;
  let authAttempted = false;

  win.webContents.on('login', (event, details, authInfo, callback) => {
    if (!credentials || authInfo.isProxy || authAttempted) return;
    try {
      if (new URL(details.url).origin !== targetOrigin) return;
    } catch {
      return;
    }

    event.preventDefault();
    authAttempted = true;
    callback(credentials.username, credentials.password);
  });

  installNavigationPolicy(
    win.webContents,
    (navigationUrl, isMainFrame) => decideTavernNavigation(navigationUrl, targetUrl, isMainFrame),
    () => tavernWindow === win && !win.isDestroyed(),
  );

  win.webContents.on('did-finish-load', () => {
    if (tavernWindow !== win || win.isDestroyed()) return;
    startTopColorPoll();
  });

  win.on('closed', () => {
    if (tavernWindow !== win) return;
    tavernViewRevision++;
    stopTopColorPoll();
    tavernWindow = null;
    currentTavernUrl = null;
    currentTavernInstanceId = null;
    // 不切换 mode，主窗口一直在 launcher 模式
  });

  win.loadURL(targetUrl);
  win.show();
  win.focus();

  // 主窗口保持可见，不隐藏
}

function exitImmersive(): void {
  tavernViewRevision++;
  stopTopColorPoll();
  destroyTavernWindow();
  currentTavernUrl = null;
  currentTavernInstanceId = null;

  if (mainWindow) {
    mainWindow.focus();
  }
}

function destroyTavernWindow(): void {
  if (!tavernWindow) return;
  stopTopColorPoll();
  lastTopColorHex = null;
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

function getStatus(): GetStatusResult {
  const serverReady = plugin.isServerReady();
  return {
    mode: tavernWindow ? 'tavern' : 'launcher',
    url: serverReady ? plugin.getCurrentUrl() || null : currentTavernUrl,
    serverReady,
    instanceId: serverReady ? plugin.getCurrentInstanceId() || undefined : undefined,
    operationId: serverReady ? plugin.getCurrentOperationId() || undefined : undefined,
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
  if (samplingTopColor) return;
  samplingTopColor = true;
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
      if (hex && hex !== lastTopColorHex) {
        lastTopColorHex = hex;
        tavernWindow.setBackgroundColor(hex);
      }
    }
  } catch {
    // ignore sampling errors
  } finally {
    samplingTopColor = false;
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
  ipcMain.handle('tarven-env', async (event, payload: { method: string; options?: any }) => {
    const { method, options } = payload || {};

    // Window/view methods handled locally (need BrowserWindow access)
    switch (method) {
      case 'openExternalUrl':
        requireLauncherCaller(event);
        await openExternalUrl(options?.url);
        return;

      case 'enterImmersive':
        await enterImmersive(options?.url || '', options?.instanceId);
        return { success: true };

      case 'exitImmersive':
        exitImmersive();
        return { success: true };

      case 'returnToTavern': {
        const url = currentTavernUrl || plugin.getCurrentUrl();
        const instanceId = currentTavernInstanceId || plugin.getCurrentInstanceId();
        if (!url || !plugin.isServerReady()) {
          throw new Error('当前没有正在运行的实例');
        }
        await enterImmersive(url, instanceId || undefined);
        return { success: true };
      }

      case 'getContentOpenMode':
        return { mode: contentOpenMode };

      case 'setContentOpenMode':
        return { mode: saveContentOpenMode(options?.mode) };

      case 'closeTavern':
        if (plugin.canCloseTavern(options) === false) return { success: true };
        exitImmersive();
        await plugin.stopCurrentServer(options);
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

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  // 消除 Windows 原生窗口遮挡判断造成的 200-500ms 延迟，开启硬件 GPU 光栅化加速
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

app.whenReady().then(() => {
  frontendDistDir = resolveFrontendDist();
  loadPreferences();

  if (frontendDistDir) {
    preloadFrontendDist(frontendDistDir);
  } else {
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

let cleanupCompleted = false;
let cleanupInProgress = false;

async function cleanupBeforeQuit(): Promise<void> {
  tavernViewRevision++;
  stopTopColorPoll();
  destroyTavernWindow();
  await plugin.cleanup();
  cleanupCompleted = true;
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', (event) => {
  if (cleanupCompleted) return;
  event.preventDefault();
  if (cleanupInProgress) return;
  cleanupInProgress = true;
  cleanupBeforeQuit().then(() => {
    app.quit();
  }).catch((error) => {
    cleanupInProgress = false;
    console.error('[SillyClient] Failed to stop owned processes before quit:', error);
  });
});
