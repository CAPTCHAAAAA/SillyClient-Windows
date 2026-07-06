# SillyClient Windows

SillyClient 的 Windows 桌面端，基于 Electron 构建。复用安卓端的 React + Vite 前端代码（capacitor-ui），通过 Capacitor shim 桥接层让前端无需任何修改即可在 Electron 中运行。

## 目录结构

```
SillyClient_Windows/
├── package.json              # 项目配置与构建脚本
├── tsconfig.json             # TypeScript 编译配置
├── .gitignore
├── README.md
├── src/
│   ├── main.ts               # Electron 主进程（窗口、IPC、沉浸式 WebView、协议）
│   ├── preload.ts            # 预加载脚本（Capacitor shim，桥接前端到 IPC）
│   ├── plugin.ts             # 插件实现（由其他子代理创建）
│   └── runtime/
│       └── paths.ts          # 路径管理（由其他子代理创建）
├── bootstrap/
│   └── scripts/
│       └── start-server.bat  # SillyTavern Node 服务启动脚本
├── web/
│   └── capacitor-ui/         # 前端代码（符号链接或复制自安卓端）
└── build/
    └── icon.ico              # 应用图标（打包时需要）
```

## 环境要求

- Node.js 22+
- pnpm（前端构建用）
- Windows 10/11（WebView2 随系统自带）

## 开发

### 1. 安装依赖

```bash
# 安装 Electron 项目依赖
cd SillyClient_Windows
npm install

# 构建前端（首次开发需要）
# 方式一：在本目录下构建
cd web/capacitor-ui
pnpm install
pnpm build

# 方式二：直接复用安卓端已构建的前端（开发时推荐）
# main.ts 会自动检测 ../SillyClient_Android/App/web/capacitor-ui/dist
```

### 2. 启动开发模式

```bash
npm run dev
# 等价于：tsc && electron .
```

此命令会先编译 TypeScript 到 `dist/`，然后启动 Electron 加载前端。

### 3. 构建前端

```bash
npm run build:web
# 等价于：cd web/capacitor-ui && pnpm build
```

### 4. 打包安装程序

```bash
npm run pack
# 等价于：tsc && electron-builder --win
```

输出 NSIS 安装程序到 `release/` 目录。打包前需要准备 `build/icon.ico`。

## 架构说明

### 整体架构

```
┌─────────────────────────────────────────────┐
│              Electron 主进程 (main.ts)         │
│                                               │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ MainWindow  │    │   TavernView (沉浸式)  │ │
│  │ 1280x800    │    │   WebContentsView     │ │
│  │ frame:true  │    │   加载酒馆 URL         │ │
│  │ app:// 协议  │    │   persist:tavern      │ │
│  └──────┬──────┘    └──────────────────────┘ │
│         │                                     │
│         │  IPC: tarven-env                    │
│         ▼                                     │
│  ┌─────────────┐    ┌──────────────────────┐ │
│  │ preload.ts  │───▶│   plugin.ts          │ │
│  │ Capacitor   │    │   handle(method,opt) │ │
│  │ shim 桥接    │    │   notify(event,data) │ │
│  └─────────────┘    └──────────────────────┘ │
│                                               │
│  协议: app:// (前端)  capacitor-file:// (文件)  │
└─────────────────────────────────────────────┘
```

### Capacitor Shim 机制

前端代码使用 `@capacitor/core` 的 `registerPlugin` 和 `addListener`。在 Electron 中，preload.ts 安装一个伪造的 `window.Capacitor` 对象，通过三层保护确保不被 `@capacitor/core` 覆盖：

1. **设置 shim**：`window.Capacitor = capacitorShim`
2. **属性保护**：对 17 个关键属性使用 `Object.defineProperty`（getter + 空 setter），吞掉 `@capacitor/core` 的赋值覆盖
3. **对象保护**：对 `window.Capacitor` 本身使用 `Object.defineProperty`，防止整体替换

`@capacitor/core` 导出的 `registerPlugin` 直接读取 `window.Capacitor.registerPlugin`（index.js 第 207 行），因此前端的 `registerPlugin('TarvenEnv')` 调用走我们的 IPC 代理：

- **方法调用**：`TarvenEnv.provisionAndStart({...})` → `ipcRenderer.invoke('tarven-env', { method, options })` → 主进程 `plugin.handle(method, options)`
- **事件监听**：`TarvenEnv.addListener('log', cb)` → `ipcRenderer.on('tarven:log', handler)` → 主进程 `mainWindow.webContents.send('tarven:log', data)`

### 自定义协议

| 协议 | 用途 | 说明 |
|------|------|------|
| `app://` | 加载前端 | 服务 `web/capacitor-ui/dist` 静态资源，SPA 路由回退到 `index.html` |
| `capacitor-file://` | 本地文件 | 替代安卓的 `Capacitor.convertFileSrc`，服务封面图等本地文件 |

### 沉浸式模式

- `enterImmersive(url)`：创建 `WebContentsView` 加载酒馆 URL，覆盖在主窗口上方，启动顶栏取色轮询，推送 `mode: 'tavern'` 事件
- `exitImmersive()`：销毁 `tavernView`，恢复主窗口背景色，推送 `mode: 'launcher'` 事件
- 顶栏取色：每 1.5 秒注入 JS 读取页面背景色，同步到窗口标题栏

### 安全配置

| 窗口 | contextIsolation | sandbox | 说明 |
|------|-----------------|---------|------|
| MainWindow | false | false | 需要与 preload 共享 `window.Capacitor`；preload 需要 `require('electron')` |
| TavernView | true | true | 加载远程酒馆内容，严格隔离 |

## 模块契约

### plugin.ts（由其他子代理实现）

```typescript
export function handle(method: string, options: any): Promise<any>;
export function notify(eventName: string, data: any): void;
export function setMainWindow(win: BrowserWindow | null): void;
// 可选
export function isServerReady(): boolean;
export function cleanup(): void;
```

`notify` 通过 `mainWindow.webContents.send('tarven:' + eventName, data)` 推送事件到前端。

支持的 method 列表（对应前端 `TarvenEnvPlugin` 接口）：
`provisionAndStart`, `getStatus`, `fetchReleases`, `pickDirectory`, `pickImage`, `pickZipFile`, `scanInstances`, `getInstanceInfo`, `sendCommand`, `pingUrl`, `uninstallInstance`, `cleanGarbage`, `deleteGarbageItem`, `setPullToRefresh`

以下 method 由 main.ts 本地处理（需要 BrowserWindow 访问），不转发到 plugin：
`enterImmersive`, `exitImmersive`, `reloadTavern`, `clearWebViewData`, `getStatus`, `getSafeInsets`

### runtime/paths.ts（由其他子代理实现）

```typescript
export function getFrontendDistDir(): string | null;
// 可选
export const bootstrapDir: string;
```

`getFrontendDistDir` 返回前端构建产物路径。如果返回 null 或路径不存在，main.ts 会依次回退到：
1. `web/capacitor-ui/dist`（本目录）
2. `../SillyClient_Android/App/web/capacitor-ui/dist`（安卓端同级目录）

## IPC 频道

| 频道 | 方向 | 用途 |
|------|------|------|
| `tarven-env` | 前端 → 主进程 | 插件方法调用（invoke/handle） |
| `tarven:log` | 主进程 → 前端 | 日志推送 |
| `tarven:progress` | 主进程 → 前端 | 进度推送 `{ percent, stage }` |
| `tarven:ready` | 主进程 → 前端 | 服务就绪 |
| `tarven:mode` | 主进程 → 前端 | 模式切换 `{ mode: 'launcher' \| 'tavern' }` |
| `tarven:error` | 主进程 → 前端 | 错误推送 |

## 与安卓端的差异

| 特性 | 安卓端 (Capacitor) | Windows 端 (Electron) |
|------|-------------------|----------------------|
| 容器 | Capacitor + Kotlin | Electron + TypeScript |
| 前端 | React + Vite（相同） | React + Vite（相同，无修改） |
| 插件桥接 | `@CapacitorPlugin` 注解 | preload.ts Capacitor shim + IPC |
| WebView | Android System WebView | WebView2 (via WebContentsView) |
| 文件协议 | `Capacitor.convertFileSrc` | `capacitor-file://` 自定义协议 |
| 状态栏避让 | `safe-area-inset-top` | 无需处理（frame:true，返回 0 insets） |
| 顶栏取色 | 原生 InsetsController | JS 注入轮询 + setBackgroundColor |

## License

MIT
