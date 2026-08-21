# Windows 架构

Windows 客户端把共享 React 控制台放在管理窗口中，把 SillyTavern 放在独立阅读窗口中。两个窗口连接同一个本地 Node.js 服务。

```mermaid
flowchart TD
    UI["React 控制台"] --> Preload["preload / IPC"]
    Preload --> Plugin["plugin.ts"]
    Plugin --> Runtime["runtime/process.ts"]
    Runtime --> Node["内置 node.exe"]
    Node --> Server["SillyTavern 实例"]
    Server --> Reader["独立 Electron 窗口"]
```

## 边界

- `main.ts` 只处理应用生命周期、协议和窗口。
- `preload.ts` 暴露受控 IPC，不给页面直接的 Node.js 权限。
- `plugin.ts` 实现共享 `TarvenEnv` 接口并推送进度、日志和状态。
- `runtime/` 负责实例目录、下载、解压、依赖安装和子进程。

控制台关闭阅读窗口时不终止服务。进程生命周期由实例操作控制，窗口生命周期不能顺带删除实例数据。

## 远程连接认证

远程实例可以配置 HTTP Basic Auth。共享 React 控制台只持久化“已配置”状态和用户名，不保存密码。`remote-auth.ts` 使用 Electron `safeStorage` 加密凭据，并把密文保存在应用 `userData` 目录；`plugin.ts` 负责原生预检，认证头只会发送给初始地址及其同源重定向。

应用内阅读窗口通过 Electron `login` 事件响应目标源的认证挑战，不处理代理认证，也不会把密码拼入 URL。选择系统浏览器打开时不向浏览器传递凭据，由浏览器自行请求认证。删除远程实例会同步清除密文记录；公网地址应优先使用 HTTPS。

## 可再生输入

`frontend-dist/` 来自本仓库 Windows 适配前端源码 `web/capacitor-ui/`。`frontend.lock.json` 记录其源码与
构建摘要，Windows 适配仍通过同一套 `TarvenEnv` 接口完成，不在本仓库维护第二套 React
页面。`runtime/node/` 来自固定版本的 Node.js 官方 Windows 压缩包。构建输入在打包前
必须存在并通过脚本准备。

应用运行时不回退到系统 Node.js，也不从 Android 或其他工作区路径即时加载前端。缺少打包输入时应明确失败，避免开发机上的偶然文件掩盖不完整安装包。

跨仓库关系与发布规则见[主仓库架构文档](https://github.com/CAPTCHAAAAA/SillyClient/blob/main/docs/ARCHITECTURE.md)。
