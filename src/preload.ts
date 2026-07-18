import { ipcRenderer } from 'electron';

// ===========================================================================
// preload.ts — Capacitor-to-Electron IPC shim
//
// This script runs before the page loads (contextIsolation: false, sandbox: false).
// It installs a fake `window.Capacitor` object that mimics the Capacitor runtime
// so the frontend's `@capacitor/core` bundle works unchanged.
//
// Key mechanism:
//   @capacitor/core's initCapacitorGlobal(win) does:
//     win.Capacitor = createCapacitor(win)
//   createCapacitor reads win.Capacitor (our shim) and tries to overwrite
//   registerPlugin, getPlatform, etc. via assignment.
//   We protect these with Object.defineProperty (getter + no-op setter) so the
//   overwrites are swallowed and our implementations persist.
//
//   The exported `registerPlugin` in @capacitor/core is:
//     const registerPlugin = Capacitor.registerPlugin  // (index.js line 207)
//   which reads from window.Capacitor.registerPlugin — our version.
//   So the frontend's `registerPlugin('TarvenEnv')` goes through OUR code.
// ===========================================================================

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type IpcListenerHandler = (_event: unknown, data: unknown) => void;

interface TrackedListener {
  eventName: string;
  channel: string;
  handler: IpcListenerHandler;
}

// ---------------------------------------------------------------------------
// IPC-backed TarvenEnv plugin proxy
//
// Returned by registerPlugin('TarvenEnv'). Every property access returns a
// function that invokes the main process via IPC. addListener is special-cased
// to set up ipcRenderer.on() listeners.
// ---------------------------------------------------------------------------

function createTarvenPlugin(): Record<string, any> {
  const tracked: TrackedListener[] = [];

  return new Proxy({} as Record<string, any>, {
    get(_target, prop) {
      // --- Handle non-string props (Symbols etc.) ---
      if (typeof prop !== 'string') {
        if (prop === Symbol.toPrimitive) return () => '[object TarvenEnvPlugin]';
        return undefined;
      }

      // --- Prevent Promise chain interference ---
      // If the proxy is accidentally awaited, "then" must be undefined
      // so the Promise resolves to the proxy itself, not a method result.
      if (prop === 'then') return undefined;
      if (prop === '$$typeof') return undefined;  // React ref check
      if (prop === 'toJSON') return () => ({});   // JSON.stringify guard

      // --- addListener: register an IPC event listener ---
      // Frontend usage: const handle = await TarvenEnv.addListener('log', cb)
      //                  handle.remove()
      if (prop === 'addListener') {
        return (eventName: string, listenerFunc: (data: any) => void): Promise<{ remove: () => void }> => {
          const channel = `tarven:${eventName}`;
          const handler: IpcListenerHandler = (_event, data) => listenerFunc(data);
          ipcRenderer.on(channel, handler);
          tracked.push({ eventName, channel, handler });

          return Promise.resolve({
            remove: () => {
              ipcRenderer.removeListener(channel, handler);
              const idx = tracked.findIndex((t) => t.handler === handler);
              if (idx >= 0) tracked.splice(idx, 1);
            },
          });
        };
      }

      // --- removeAllListeners: remove all tracked listeners ---
      if (prop === 'removeAllListeners') {
        return (): Promise<void> => {
          for (const t of tracked) {
            ipcRenderer.removeListener(t.channel, t.handler);
          }
          tracked.length = 0;
          return Promise.resolve();
        };
      }

      // --- removeListener: best-effort removal by event name ---
      if (prop === 'removeListener') {
        return (eventName: string, _listenerFunc?: (data: any) => void): Promise<void> => {
          const channel = `tarven:${eventName}`;
          for (let i = tracked.length - 1; i >= 0; i--) {
            if (tracked[i].eventName === eventName) {
              ipcRenderer.removeListener(channel, tracked[i].handler);
              tracked.splice(i, 1);
            }
          }
          return Promise.resolve();
        };
      }

      // --- Default: invoke IPC method on main process ---
      // Frontend usage: await TarvenEnv.provisionAndStart({ port: 8000, ... })
      return (options?: any): Promise<any> => {
        return ipcRenderer.invoke('tarven-env', { method: prop, options: options ?? {} });
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Noop plugin for non-TarvenEnv plugins
//
// @capacitor/core internally calls registerPlugin('WebView'),
// registerPlugin('CapacitorCookies', {...}), registerPlugin('CapacitorHttp', {...}).
// These return a permissive proxy that resolves to undefined — harmless as long
// as the frontend doesn't use them directly (it doesn't).
// ---------------------------------------------------------------------------

function createNoopPlugin(): Record<string, any> {
  return new Proxy({} as Record<string, any>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === 'then') return undefined;
      if (prop === '$$typeof') return undefined;
      if (prop === 'toJSON') return () => ({});
      if (prop === 'addListener' || prop === 'removeListener') {
        return () => Promise.resolve({ remove: () => {} });
      }
      if (prop === 'removeAllListeners') {
        return () => Promise.resolve();
      }
      return () => Promise.resolve(undefined);
    },
  });
}

// ---------------------------------------------------------------------------
// convertFileSrc: maps local file paths to capacitor-file:// URLs
//
// Frontend usage (index.tsx line 1443):
//   const coverUrl = Capacitor.getPlatform() === 'android'
//     ? Capacitor.convertFileSrc(path)
//     : `file://${path}`;
//
// Since getPlatform() returns 'android', convertFileSrc is always called.
// It converts "C:\Users\...\cover.png" → "capacitor-file:///C:/Users/.../cover.png"
// which is served by the capacitor-file:// protocol handler in main.ts.
// ---------------------------------------------------------------------------

const FILE_PROTOCOL = 'capacitor-file';

function convertFileSrc(filePath: string): string {
  if (!filePath) return '';
  let normalized = String(filePath).replace(/\\/g, '/');
  normalized = normalized.replace(/^\/+/, '');
  normalized = normalized.replace(/^file:\/\//i, '');
  return `${FILE_PROTOCOL}:///${normalized}`;
}

// ---------------------------------------------------------------------------
// Capacitor shim object
// ---------------------------------------------------------------------------

const capacitorShim: Record<string, any> = {
  // Platform identification — pretend to be Android so the frontend
  // uses native code paths (isWeb=false, convertFileSrc enabled)
  getPlatform: () => 'android',
  isNativePlatform: () => true,
  getPlatformId: () => 'android',
  isPluginAvailable: () => true,

  // File URL conversion for cover images
  convertFileSrc,

  // Plugin registry — our registerPlugin replaces Capacitor's
  Plugins: {},
  registerPlugin: (name: string): any => {
    if (name === 'TarvenEnv') return createTarvenPlugin();
    return createNoopPlugin();
  },

  // Native bridge stubs (never called because our registerPlugin
  // returns its own proxy, but included for completeness)
  nativeCallback: () => {},
  nativePromise: () => Promise.resolve(undefined),

  // Error handling
  Exception: class CapacitorException extends Error {
    code: string;
    data: unknown;
    constructor(message: string, code?: string, data?: unknown) {
      super(message);
      this.message = message;
      this.code = code || 'UNIMPLEMENTED';
      this.data = data;
    }
  },
  handleError: (err: unknown) => console.error('[Capacitor]', err),

  // Logging flags
  DEBUG: false,
  isLoggingEnabled: false,
  logJs: () => {},
  logToTerminal: () => {},

  // Misc stubs
  linkWithInterceptor: () => false,
  PluginHeaders: [],
};

// ---------------------------------------------------------------------------
// Install shim and protect from @capacitor/core overwrite
// ---------------------------------------------------------------------------

const win = window as any;

Object.defineProperty(win, '__SILLYCLIENT_PLATFORM__', {
  value: 'windows',
  writable: false,
  configurable: false,
  enumerable: false,
});

// Step 1: Set the shim as window.Capacitor
win.Capacitor = capacitorShim;

// Step 2: Protect key properties with getter + no-op setter.
//
// When @capacitor/core's createCapacitor(win) runs at page load, it does:
//   const cap = win.Capacitor || {}        // → gets our shim
//   cap.registerPlugin = registerPlugin     // → swallowed by no-op setter
//   cap.getPlatform = getPlatform           // → swallowed
//   cap.isNativePlatform = isNativePlatform // → swallowed
//   ...                                     // → all swallowed
//   return cap                              // → returns our shim (unchanged)
//
// The exported registerPlugin in @capacitor/core is:
//   const registerPlugin = Capacitor.registerPlugin  // (index.js line 207)
// which reads our shim's registerPlugin — so the frontend's
// `registerPlugin('TarvenEnv')` call goes through OUR implementation.
const protectedKeys = [
  'registerPlugin',
  'getPlatform',
  'isNativePlatform',
  'getPlatformId',
  'isPluginAvailable',
  'convertFileSrc',
  'Plugins',
  'Exception',
  'nativeCallback',
  'nativePromise',
  'handleError',
  'DEBUG',
  'isLoggingEnabled',
  'logJs',
  'logToTerminal',
  'linkWithInterceptor',
  'PluginHeaders',
];

for (const key of protectedKeys) {
  const value = capacitorShim[key];
  Object.defineProperty(capacitorShim, key, {
    get: () => value,
    set: () => {},  // no-op: swallow overwrites from @capacitor/core
    configurable: true,
    enumerable: true,
  });
}

// Step 3: Protect window.Capacitor itself from being replaced.
//
// createCapacitor returns our shim (the same object), so the assignment
// win.Capacitor = createCapacitor(win) is effectively a no-op. But we add
// this as an extra safeguard — if anything tries to replace window.Capacitor
// entirely, the no-op setter prevents it.
let capacitorRef = capacitorShim;
Object.defineProperty(win, 'Capacitor', {
  get: () => capacitorRef,
  set: () => {},  // no-op: swallow win.Capacitor = createCapacitor(win)
  configurable: true,
  enumerable: true,
});

// Step 4: Provide androidBridge so @capacitor/core's getPlatformId() returns
// 'android'. This is redundant (we already protect getPlatformId with our own
// implementation) but included for maximum compatibility.
win.androidBridge = {};
