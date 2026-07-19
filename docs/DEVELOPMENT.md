# 开发与验证

## 干净克隆

```powershell
npm ci
npm run prepare:runtime
npm run sync:frontend
npm run check
npm run build
```

默认同步路径要求 `SillyClient_Android` 与本仓库处在同一工作区。其他布局使用 `Sync-Frontend.ps1 -Source <dist>`。

## 开发运行

```powershell
npm run dev
```

开发模式仍使用 `frontend-dist/` 和 `runtime/node/`，因此行为接近安装包。不要加入系统 Node.js 或工作区前端的隐式回退。

## 安装包验证

```powershell
npm run pack
```

使用生成的 NSIS 安装器安装到测试目录，至少检查：

1. 管理窗口能打开，静态资源没有丢失。
2. 创建实例时能看到下载、解压和依赖安装进度。
3. 启动后独立 SillyTavern 窗口可访问。
4. 关闭阅读窗口后实例仍在运行，停止操作能真正结束进程。
5. 失败安装不会留下可见实例或未完成目录。

源码目录直接执行通过不能代替安装验证。生产路径使用 `process.resourcesPath`，只有安装包能覆盖这条路径。
