# SillyClient Windows

SillyClient 的 Windows 客户端。Electron 负责窗口、文件和进程，共享 React 控制台负责实例管理界面。

应用使用随安装包分发的 Node.js 22，不读取系统 PATH。SillyTavern 在独立窗口中打开；关闭该窗口只会返回控制台，停止实例需要在控制台中明确操作。

## 环境

- Windows 10 或 11 x64
- Node.js 22 与 npm 10（仅用于构建应用）
- PowerShell 5.1 或更新版本

## 首次准备

```powershell
npm ci
npm run prepare:runtime
```

`prepare:runtime` 下载 Node.js 22.16.0 Windows x64 官方压缩包，并使用同目录的 `SHASUMS256.txt` 校验后写入 `runtime/node/`。

共享控制台在 Android 仓库构建。默认工作区结构下可以直接同步：

```powershell
Set-Location ..\SillyClient_Android\web\capacitor-ui
pnpm install --frozen-lockfile
pnpm run build
Set-Location ..\..\..\SillyClient_Windows
npm run sync:frontend
```

独立克隆时，通过脚本参数指定构建目录：

```powershell
.\scripts\Sync-Frontend.ps1 -Source D:\path\to\capacitor-ui\dist
```

## 开发与打包

```powershell
npm run check
npm run build
npm run dev
npm run pack
```

`dev` 和 `pack` 都要求 `frontend-dist/` 已同步，`pack` 还要求 `runtime/node/` 已准备。NSIS 安装包输出到 `release/`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/main.ts` | Electron 生命周期、协议和窗口 |
| `src/plugin.ts` | `TarvenEnv` 的 Windows 实现 |
| `src/runtime/` | 实例路径、下载、解压与 Node.js 进程 |
| `scripts/` | 运行时准备和前端同步 |
| `frontend-dist/` | 可再生的共享控制台副本，不提交 |
| `runtime/node/` | 可再生的固定版本 Node.js，不提交 |

实现边界见 [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)，完整准备步骤见 [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)。安装包统一发布到[主仓库 Releases](https://github.com/CAPTCHAAAAA/SillyClient/releases)。

## License

[MIT](./LICENSE)
