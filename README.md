# SillyClient Windows

SillyClient 的 Windows 桌面端，基于 Electron 和 TypeScript。它使用与 Android 相同的 React 前端，通过 Capacitor shim 将统一的 `TarvenEnv` 接口桥接到 Electron IPC。

## 功能

- 内置 Node.js 22 运行时，不依赖系统 Node.js
- 下载或导入 SillyTavern zip，自动解压并安装依赖
- 多实例目录、端口与运行状态管理
- 独立 SillyTavern 窗口，关闭阅读窗口不会自动删除实例
- NSIS 安装程序，支持自定义安装路径

## 开发

```powershell
npm install
npm run build
npm run dev
```

共享前端源码位于 Android 仓库的 `web/capacitor-ui/`。构建后将其 `dist/` 内容同步到本项目的 `frontend-dist/`：

```powershell
Set-Location ..\SillyClient_Android\App\web\capacitor-ui
pnpm install
pnpm build
Copy-Item -Recurse -Force .\dist\* ..\..\..\..\SillyClient_Windows\frontend-dist\
```

打包 Windows 安装程序：

```powershell
npm run pack
```

产物输出到 `release/`。

## 运行时

`runtime/node/` 通过 electron-builder 的 `extraResources` 复制到 `resources/runtime/node/`，避免可执行文件进入 `app.asar`。生产路径由 `src/runtime/paths.ts` 使用 `process.resourcesPath` 定位。

用户数据位于：

```text
%LOCALAPPDATA%\SillyClient\tarven\
```

其中：

- `bootstrap/servers/<instanceId>/`：实例目录
- `covers/`：实例封面
- `logs/`：日志
- `tmp/`：临时下载
- `usr/`：运行时缓存

## 桥接接口

前端统一调用 `TarvenEnv`。Electron 主进程处理窗口相关方法，其余方法转发给 `src/plugin.ts`。

- 窗口：`enterImmersive`、`exitImmersive`、`returnToTavern`、`closeTavern`
- 实例：`provisionAndStart`、`scanInstances`、`getInstanceInfo`、`uninstallInstance`
- 工具：`fetchReleases`、`pickDirectory`、`pickImage`、`pickZipFile`、`pingUrl`

## 发布

平台仓库只保存源码。安装程序统一上传到主仓库 [SillyClient Releases](https://github.com/CAPTCHAAAAA/SillyClient/releases)。

## License

MIT
