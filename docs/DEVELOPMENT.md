# 开发与验证

## 干净克隆

```powershell
npm ci
npm run prepare:runtime
npm run sync:frontend
npm run check
npm run build
```

默认同步路径使用本仓库 `web/capacitor-ui/dist`。同步会计算本仓库前端源码与构建摘要，
并更新 Windows 仓库中的 `frontend.lock.json`。需要沿用外部 manifest 时传入 `-Manifest <manifest>`。

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

## 2026-10-03 本机试用准备

本轮预览已获用户批准，Windows 隔离工作树已逐文件同步验收源码与新增模块，
包含运行时加固前端契约、预制安装、滚动稳定、位置按压、受控外链、面板溶变和分页修复。
保留既有 Electron preload/Capacitor 桥接及本仓 `sync:frontend`，
未使用 Main 的生成产物直接覆盖 Windows。

Windows 自身前端 `typecheck`、`build` 与宿主 `npm run check` 通过；
前端源码测试 47/47、固定 Node.js 22.16.0 下完整宿主回归 79/79 通过。
`scripts/Sync-Frontend.ps1` 从本仓 `web/capacitor-ui/dist` 生成
`frontend-dist` 与 `frontend.lock.json`，生产构建不包含 DEV 测试 shim。
版本仍为 2.0.1。本检查点不表示已提交、推送或发布。

## 2026-10-04 本机覆盖安装

`npm run pack` 正规 NSIS 构建通过，包内 27 个前端文件与本仓构建及同步产物
逐字节一致，内置 Node.js 22.16.0 与准备阶段 SHA-256 一致。
测试安装包独立归档到 `Local/artifacts/release-hardening-test-20261003/Windows/`，
未覆盖已发布产物。Windows 未配置代码签名凭据。

安装前已备份原应用；NSIS `/S /D=D:\Software\AI\Entertainment\SillyClient`
静默覆盖退出码为 0。安装后 `resources/app.asar` 与打包产物哈希一致，
内置 Node 哈希一致，原实例登记文件未变。安装回执在
`Local/evidence/release-hardening-20261003/output/windows-approved-installation.json`。

用户随后明确不要求 Windows 和 Android 真机验收，本轮不启动 Windows 客户端
或做 UI/实例/扩展流程测试；不将安装和文件校验称为实际运行验收通过。
三正式仓库保持干净，改动仅在隔离工作树，无提交、推送或公开发布。
