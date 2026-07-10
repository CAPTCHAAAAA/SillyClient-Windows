# SillyClient Windows

SillyClient 的 Windows 桌面端，基于 Electron 构建。复用安卓端的 React + Vite 前端代码（capacitor-ui），通过 Capacitor shim 桥接层让前端无需任何修改即可在 Electron 中运行。

**版本：1.3.0**

## 核心特性

- 内置 Node.js v22.16.0 运行时（`runtime/node/`），即开即用，不依赖系统安装 Node.js
- 从本地 zip 安装 SillyTavern，自动解压、提升子目录、安装依赖
- 自定义协议加载前端，Capacitor shim 无缝桥接
- 独立窗口运行酒馆，关闭后自动回到启动器
- 自动检测可用端口（跳过 Hyper-V 保留端口）
- NSIS 安装程序，支持自定义安装路径

## 目录结构

```
SillyClient_Windows/
├── package.json              # 项目配置与构建脚本
├── tsconfig.json             # TypeScript 编译配置
├── .gitignore
├── README.md
├── src/
│   ├── main.ts               # Electron 主进程（窗口、IPC、协议、沉浸式窗口）
│   ├── preload.ts            # 预加载脚本（Capacitor shim，桥接前端到 IPC）
│   ├── plugin.ts             # 插件实现（实例管理、zip 安装、npm install）
│   └── runtime/
│       ├── paths.ts          # 路径管理（内置 Node.js 运行时、npm 路径解析）
│       ├── process.ts        # 进程管理（spawn、npm install、服务启停）
│       └── utils.ts          # 工具函数（zip 解压等）
├── runtime/
│   └── node/                 # 内置 Node.js v22.16.0 运行时
│       ├── node.exe          # Node.js 可执行文件
│       ├── npm.cmd           # npm 批处理入口
│       └── node_modules/     # npm 完整运行时
│           └── npm/bin/
│               └── npm-cli.js  # npm CLI 入口（由 node.exe 执行）
├── frontend-dist/            # 前端构建产物（打包用，从 web/capacitor-ui/dist 复制）
├── web/
│   └── capacitor-ui/         # 前端代码（符号链接或复制自安卓端）
└── build/
    ├── icon.png              # 应用图标 512x512（打包 + 运行时窗口图标）
    └── icon.ico              # 应用图标 256x256（NSIS 安装器）
```

## 环境要求

- Windows 10/11（WebView2 随系统自带）
- 用户无需安装 Node.js — 应用内置运行时

### 开发环境

- Node.js 22+（仅开发编译 TypeScript 用）
- pnpm（前端构建用）
- Electron 33+、electron-builder 25+

## 开发

### 1. 安装依赖

```bash
# 安装 Electron 项目依赖
cd SillyClient_Windows
npm install

# 构建前端（首次开发需要）
cd web/capacitor-ui
pnpm install
pnpm build
```

### 2. 启动开发模式

```bash
npm run dev
# 等价于：tsc && electron .
```

### 3. 构建前端

```bash
npm run build:web
# 等价于：cd web/capacitor-ui && pnpm build
```

构建后需将 `web/capacitor-ui/dist` 内容复制到 `frontend-dist/`（打包时从此目录读取）。

### 4. 打包安装程序

```bash
npm run pack
# 等价于：tsc && electron-builder --win
```

输出 NSIS 安装程序到 `dist/` 目录，文件名格式 `SillyClient Setup X.X.X.exe`。

## 架构说明

### 整体架构

```
┌─────────────────────────────────────────────────┐
│              Electron 主进程 (main.ts)             │
│                                                   │
│  ┌─────────────┐    ┌──────────────────────┐     │
│  │ MainWindow  │    │   TavernWindow        │     │
│  │ 1280x800    │    │   独立 BrowserWindow   │     │
│  │ frame:true  │    │   加载酒馆 URL         │     │
│  │ app:// 协议  │    │   persist:tavern      │     │
│  └──────┬──────┘    └──────────────────────┘     │
│         │                                         │
│         │  IPC: tarven-env                        │
│         ▼                                         │
│  ┌─────────────┐    ┌──────────────────────┐     │
│  │ preload.ts  │───>│   plugin.ts          │     │
│  │ Capacitor   │    │   handle(method,opt) │     │
│  │ shim 桥接    │    │   notify(event,data) │     │
│  └─────────────┘    └──────────────────────┘     │
│                            │                      │
│                    ┌───────┴────────┐             │
│                    │  runtime/      │             │
│                    │  paths.ts      │ 内置 Node   │
│                    │  process.ts    │ npm install │
│                    │  utils.ts      │ zip 解压    │
│                    └────────────────┘             │
│                                                   │
│  协议: app:// (前端)  capacitor-file:// (文件)     │
└─────────────────────────────────────────────────┘
```

### 内置 Node.js 运行时

应用不依赖系统安装的 Node.js，而是在 `runtime/node/` 目录内置完整的 Node.js v22.16.0 运行时：

- `getNodeBin()` 返回 `runtime/node/node.exe`
- `getNpmBin()` 返回 `runtime/node/node_modules/npm/bin/npm-cli.js`
- npm install 通过 `node.exe npm-cli.js install ...` 执行
- `buildEnv()` 将 node 目录注入 PATH，确保 npm 子进程可用

### Capacitor Shim 机制

前端代码使用 `@capacitor/core` 的 `registerPlugin` 和 `addListener`。在 Electron 中，preload.ts 安装一个伪造的 `window.Capacitor` 对象，通过三层保护确保不被 `@capacitor/core` 覆盖：

1. **设置 shim**：`window.Capacitor = capacitorShim`
2. **属性保护**：对关键属性使用 `Object.defineProperty`（getter + 空 setter）
3. **对象保护**：对 `window.Capacitor` 本身使用 `Object.defineProperty`，防止整体替换

### 自定义协议

| 协议 | 用途 | 说明 |
|------|------|------|
| `app://` | 加载前端 | 服务 `frontend-dist` 静态资源，SPA 路由回退到 `index.html` |
| `capacitor-file://` | 本地文件 | 替代安卓的 `Capacitor.convertFileSrc`，服务封面图等本地文件 |

### 酒馆窗口模式

- `enterImmersive(url)`：创建独立 `BrowserWindow` 加载酒馆 URL，推送 `mode: 'tavern'` 事件
- `exitImmersive()`：关闭酒馆窗口，恢复主窗口，推送 `mode: 'launcher'` 事件
- 关闭酒馆窗口自动回到启动器

### 实例安装流程

1. 创建实例目录 `%LOCALAPPDATA%/SillyClient/tarven/bootstrap/servers/<id>`
2. 清空目标目录，从本地 zip 解压
3. `flattenExtractedDir`：查找含 `package.json` 的子目录，提升内容到根
4. `findAvailablePort`：检测可用端口（跳过 Hyper-V 保留端口）
5. `runNpmInstall`：用内置 node.exe + npm-cli.js 执行 `npm install`（3 次重试，npmmirror 镜像）
6. 启动 SillyTavern 服务

### 安全配置

| 窗口 | contextIsolation | sandbox | 说明 |
|------|-----------------|---------|------|
| MainWindow | false | false | 需要与 preload 共享 `window.Capacitor` |
| TavernWindow | true | true | 加载远程酒馆内容，严格隔离 |

## 模块契约

### plugin.ts

```typescript
export function handle(method: string, options: any): Promise<any>;
export function notify(eventName: string, data: any): void;
export function setMainWindow(win: BrowserWindow | null): void;
export function isServerReady(): boolean;
export function cleanup(): void;
```

支持的 method：`provisionAndStart`, `getStatus`, `fetchReleases`, `pickDirectory`, `pickImage`, `pickZipFile`, `scanInstances`, `getInstanceInfo`, `sendCommand`, `pingUrl`, `uninstallInstance`, `cleanGarbage`, `deleteGarbageItem`, `setPullToRefresh`

main.ts 本地处理的 method：`enterImmersive`, `exitImmersive`, `reloadTavern`, `clearWebViewData`, `getSafeInsets`

### runtime/paths.ts

```typescript
export function getNodeBin(): string;      // 内置 node.exe 路径
export function getNpmBin(): string;        // npm-cli.js 路径
export function isElectronNode(): boolean;  // 是否回退到 Electron Node
export function getFrontendDistDir(): string | null;
export const sillyClientHome: string;       // %LOCALAPPDATA%/SillyClient
export const tarvenHome: string;
export const bootstrapDir: string;
export function serverDirFor(id: string): string;
```

### runtime/process.ts

```typescript
export function executeNative(cmd, args, opts): Promise<{code, stdout, stderr}>;
export function runNpmInstall(cwd, onLog): Promise<void>;
export function startServer(cwd, port, onLog): Promise<void>;
export function stopServer(): void;
```

## IPC 频道

| 频道 | 方向 | 用途 |
|------|------|------|
| `tarven-env` | 前端 → 主进程 | 插件方法调用（invoke/handle） |
| `tarven:log` | 主进程 → 前端 | 日志推送 |
| `tarven:progress` | 主进程 → 前端 | 进度推送 `{ percent, stage }` |
| `tarven:ready` | 主进程 → 前端 | 服务就绪 |
| `tarven:mode` | 主进程 → 前端 | 模式切换 `{ mode: 'launcher' | 'tavern' }` |
| `tarven:error` | 主进程 → 前端 | 错误推送 |

## 与安卓端的差异

| 特性 | 安卓端 (Capacitor) | Windows 端 (Electron) |
|------|-------------------|----------------------|
| 容器 | Capacitor + Kotlin | Electron + TypeScript |
| 前端 | React + Vite（相同） | React + Vite（相同，无修改） |
| 插件桥接 | `@CapacitorPlugin` 注解 | preload.ts Capacitor shim + IPC |
| WebView | Android System WebView | WebView2 (via BrowserWindow) |
| 文件协议 | `Capacitor.convertFileSrc` | `capacitor-file://` 自定义协议 |
| Node.js | 交叉编译的 node 二进制 | 内置 `runtime/node/node.exe` |
| 状态栏避让 | `safe-area-inset-top` | 返回 top=32（标题栏高度） |
| 酒馆窗口 | WebContentsView 覆盖 | 独立 BrowserWindow |

## 数据目录

| 路径 | 用途 |
|------|------|
| `%LOCALAPPDATA%/SillyClient/tarven/` | 根数据目录 |
| `tarven/bootstrap/servers/<id>/` | 各实例的 SillyTavern 源码 |
| `tarven/usr/` | npm 缓存等 |
| `tarven/covers/` | 封面图 |
| `tarven/tmp/` | 临时文件 |
| `tarven/logs/` | 日志 |

## License

MIT
