# SillyClient 工作树规约：Windows 终态解耦后端与发布加固 (Release Hardening Windows)

> **[LTS 核心工作树]** 本文档为该工作树的自包含边界与记录中枢。本树所有进行中改动、调试日志与设计草稿就地记录在此，严禁向中央本地目录散落碎片文档。

---

## 1. 职责与范围边界 (Scope & Boundaries)

- **所属仓库**: `SillyClient_Windows`
- **标识分支**: `lts/windows-release-hardening`
- **授权修改范围**:
  - `src/contracts/ipc-contracts.ts`：前后端强类型 IPC 契约定义；
  - `src/*.ts`：自治领域服务（下载解压、生命周期、端口探测、文件系统、网络诊断）；
  - `src/plugin.ts`：纯净门面（严格控制在 <=300 行）；
  - `src/main.ts`：Electron 宿主入口，彻底移除弱类型强转；
  - `src/system-dialogs.ts`：原生保存/选择系统对话框服务；
  - Windows 安装程序（NSIS 打包与依赖分发）。
- **严禁事项 (Forbidden Boundaries)**:
  - **严禁擅改终态冻结路线**：用户明确指令“这个路线是最完美的 不用再改了 最好别动这个路线”，严禁退化回巨石或打补丁堆砌代码；
  - 严禁随意引入未固化的外部全局依赖；
  - 严禁真机 UI 操控（不许脚本点按真实窗口）。

---

## 2. 核心架构契约 (Invariants & Constraints)

1. **架构终态冻结**：详见 `SillyClient_Windows/docs/WINDOWS-BACKEND-ARCHITECTURE-FREEZE.md`；
2. **测试网 100% 覆盖**：全量 **80/80 项测试全绿通过**（80 pass，0 fail）；
3. **导出实例（ZIP）自选路径**：必须通过 Electron `dialog.showSaveDialog` 弹出原生系统对话框由用户自主选择保存位置与文件名；取消操作优雅返回 `{ canceled: true }`，绝不静默写死下载路径；
4. **前端残留清洗**：拔除无用空白旧迁移弹窗，仅在存在旧实例时弹窗；Windows 桌面端隐藏无用手势“下拉刷新”；设置抽屉底部保留“敬请期待”原型占位符。

---

## 3. 接手开发与依赖挂载指南 (Handover & Setup Guide)

新 Agent 在本工作树（`.worktrees/release-hardening-windows`）接手开发时，必须按以下步骤执行：

```powershell
# 1. 确保依赖目录 Junction 已正确建立（依赖存放在 Local/cache，不随 git 提交）
New-Item -ItemType Junction -Path ".worktrees\release-hardening-windows\node_modules" -Target "D:\BACKUP\Project\SillyClient\Local\cache\windows\node_modules" -Force
New-Item -ItemType Junction -Path ".worktrees\release-hardening-windows\web\capacitor-ui\node_modules" -Target "D:\BACKUP\Project\SillyClient\SillyClient_Android\web\capacitor-ui\node_modules" -Force

# 2. 编译后端 TypeScript
npm --prefix .worktrees/release-hardening-windows run build

# 3. 运行全量测试网（必须 80/80 全绿）
npm --prefix .worktrees/release-hardening-windows test

# 4. 前端构建与资源同步（若涉及前端修改）
npm --prefix .worktrees/release-hardening-windows/web/capacitor-ui run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .worktrees/release-hardening-windows/scripts/Sync-Frontend.ps1

# 5. 生产打包安装包（仅发布时）
npm --prefix .worktrees/release-hardening-windows run pack
```

---

## 4. 本树推进与改动记录 (Worktree Activity Log)

| 日期 | 操作人 / 提交 | 改动摘要与内部验证结果 | 状态 |
| :--- | :--- | :--- | :---: |
| 2026-10-08 | Agent (f5ce082) | 修复从移动端导入 ZIP 依赖锁失效与启动阻塞，打包 Windows 1.11.0 安装包并推送到 main | 已发布 |
| 2026-10-09 | Agent (d08b179) | 纯净后端清洗、解耦与终态冻结：79 项测试全通，构建安装验证，确立架构终态冻结规范 | 终态冻结 |
| 2026-10-09 | Agent (d68dd7c) | 修复导出实例自选保存路径（saveDialog）、清洗无用空白迁移弹窗与无效手势，扩充至 80 项测试全绿 | 核心加固 |
| 2026-10-09 | Agent (0bb65de) | 依用户指令在设置抽屉还原并保留“敬请期待”原型占位符，完成全量打包与验证 | 规范合规 |
| 2026-10-11 | Agent | 工作树 Fast-Forward 完全对齐 main（0bb65de），80 项测试在隔离树全绿通过，完善新 Agent 同步开发接手文档 | 基线对齐 |
| 2026-10-11 | Agent (ccad821) | **Windows 1.12.0 发布**：承接 WIP + 同步主仓 580ab07 已验收通用前端基线（3D 卡片/FlipCard/竖版管理菜单/Terminal 拖拽/9 modal 悬停精修），保留平台终态（导入数据 ZIP、空白弹窗门控、双 Tab 设置、平台契约），补齐 routes bg/theme 持久化与拖拽重排接线；前端 tsc+vite 全绿、80 项测试全绿、NSIS 打包并静默覆盖安装本机（SillyClient.exe 1.12.0.0）；lts 分支与 main 均已推送 | 已发布 |
| 2026-10-11 | Agent (3b2f9ad) | **R2 修复（用户实测反馈）**：主页搜索栏同步为已验收 `.home-search` 轻内凹结构；routes 补传 `bgMode`/`themeStyle` 给管理菜单（跟随用户主题）；AppSettingsDrawer 与向导 6 处按钮/徽标对齐悬停纯字体高亮约定；重审确认向导「安装目录（必选）」等为更新的平台功能予以保留。80 项测试全绿、重打包覆盖重装验证，产物 SHA-256 更换为 `3c282648…` | R2 修复 |
| 2026-10-12 | Agent (839b52f) | **R3 修复（用户实测反馈：迁移目录/导出丢失 + 用户启动报"注册的安装目录缺失"）**：①恢复被中断 WIP 合并丢弃的存储 Tab 三个入口（存储迁移 onOpenRelocate、实例重命名、导出实例 ZIP saveDialog）——R2 期间误判为"有意替换"的结论**作废纠正**；②启动自愈：注册表指向已消失目录（隐藏目录→自定义目录转型遗留）而卡片显式路径存在时，解析到现存路径并经 usage 登记回写修复注册表，运行中实例保护与同 ID 默认目录拒收卫兵原样保留；③readRegistry 单条损坏记录跳过告警、不再毒化整个注册表（冻结契约§4）。测试网 81/81 全绿（新增转型自愈回归测试），产物 SHA-256 更换为 `a537d4f3…` 并覆盖重装 | R3 修复 |

---

## 5. 交付与推送门禁 (Milestone & Delivery Gate)

- **本地门禁**:
  1. `npm test` 80 项测试 100% 通过；
  2. `tsc --noEmit` 0 类型错误；
  3. `npm run pack` 生产构建成功。
- **中央登记协议**:
  - **当且仅当向远端分支执行 `git push` 或打包输出正式 EXE 时**，才向 `Local/docs/CURRENT_STATE.md` 与 `.worktrees/README.md` 登记事实索引。
