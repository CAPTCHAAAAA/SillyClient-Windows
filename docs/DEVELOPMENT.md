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

## 数据迁移技术验证

独立 CLI 与文件系统验证步骤见 [`DATA-MIGRATION.md`](./DATA-MIGRATION.md)。
CLI 只生成经校验的数据副本；测试包的原生“文件 > 导入旧酒馆”和调试浮窗提供
“复制迁移”与“原地接管”两种模式，均须确认且不自动启动。复制模式注册新副本；
接管模式登记原目录，后续由实例启动操作调用原程序和独立配置，移除时只解除接管。
不修改 React 前端或 `TarvenEnv` 契约。
测试仅使用临时合成数据；不能把测试通过描述成真实用户数据已迁移或新实例已可运行。
