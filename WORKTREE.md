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
| 2026-10-12 | Agent (abf46b6→5802a5d) | **v1.12.1 Windows 专项发布（资产已替换）**：版本双 package.json 升 1.12.1，81/81 测试全绿，GitHub Release `v1.12.1` 仅附 Windows 资产发布至主仓——分端提醒机制验证：更新判定 = 语义化版本更高 **且** Release 含调用端平台安装包资产（windows→exe / android→apk / ios→ipa），故 Android/iOS 1.12.0 用户不会收到本次提醒；线上 v1.12.0 的 Windows 包为 R2 问题版（并行会话 22:51 从本地归档取用），本发布完成替换。**同日追加**：移植主仓 `3fbd81f` 透明封面增量（ManageInstanceCard 组件、cover-clear 三资产、styles.css 圆角收边），Release 资产替换为 SHA-256 `ce785ed3…`（118,653,665 字节）并覆盖重装 | 已发布 |
| 2026-10-12 | Agent | **新旧版本过渡根因修复（用户实测反馈：1.10.0 前隐藏目录实例更新后失联/无法启动）**：①启动解析重构——注册表权威 + 失效记录保留 + 无记录时全位置探测接管（当前生效根/安装目录默认根/AppData 回退根/旧版隐藏 servers，含 local-↔new- 变体），卡片残留旧路径静默自愈不再报"路径冲突"（取代 R3 补丁式 heal）；②确立"携带安装源=创建意图"铁律——启动既有实例缺源时拒绝静默下载全新实例顶替，报清晰中文引导（接管/重建），彻底堵死"数据丢失"假象；③创建意图与注册表冲突时拒绝分身创建；④迁移目标改用当前生效存储根（尊重设置页自定义），迁移弹窗逐项容错 + 结果驱动精确改卡，"稍后处理/检测异常"不再永久静音迁移提醒；⑤创建成功后卡片不再持久化安装源等一次性参数；⑥删除模块级 `appInstancesDir` 双轨常量、统一 `candidateInstanceRoots()` 探测入口，`ensureDirs` 不再自动创建旧版隐藏目录。**另查明 NSIS 链路隐患**：更新（旧卸载器 `--updated` 原子搬空 INSTDIR）与卸载（`RMDir /r $INSTDIR`）均会灭失安装目录内实例，%LOCALAPPDATA% 注册表与 Roaming 卡片不受影响（详见 AGENT_HANDOVER 沉淀）。测试网 85/85 全绿（新增 5 项过渡回归） | 根因修复 |
| 2026-10-12 | Agent (dce7b9d) | **无默认路径存储模型彻底落实（用户拍板：默认根迁出施工区）**：①`getDefaultInstancesRoot` 删除，`getInstancesRoot` 仅返回用户显式登记的存储根（未配置 null），安装目录/AppData 的 instances 降级为只读历史探测落点——任何流程都不可能再把实例放进 NSIS 施工区；②创建链路闭环：向导"安装目录必选"空值硬校验（此前形同虚设）+ 创建成功自动登记存储根 + 下次预填，"之后默认也放在这里"从文案变为真实行为；③迁移向导目标文件夹必选（只读+浏览，对齐冻结契约三入口规则），迁移成功即登记存储根；④复制迁移目标必选（Android 冻结记录第 8 条教训的 Windows 同根因），原地接管不再需要目标计算；⑤GC 孤儿实例扫描升级为多根覆盖全历史落点；⑥删除冗余 `migrateLegacyInstances` 批量 IPC。测试网 88/88 全绿（新增 3 项无默认路径回归 + 更新设置契约测试） | 终态闭环 |
| 2026-10-12 | Agent | **v1.13.0 本机覆盖安装待测**：What's New 公告重写（数据安全存储自主 + 旧实例找回迁移 + 启动防误装保护三卡片）；版本双 package.json 升 1.13.0；后端 tsc 0 错误、前端 vite 通过、88/88 测试全绿；NSIS 打包产出 `SillyClient Setup 1.13.0.exe`，已 `/S` 静默覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（ProductVersion 1.13.0.0，安装目录不再自动创建 instances 空目录），归档 `Local/artifacts/v1.13.0/`（SHA-256 `fb99b662…`，118,657,986 字节）。**等待用户实测**：What's New 公告展示、迁移向导目标必选交互、旧实例启动链路 | 待实测 |
| 2026-10-13 | Agent (73d7ee5) | **同步通用前端 667b83a..f0be259**（动态封面紫酒红中段底板 coverTone.ts、管理卡遮罩对齐首页 manage-card-scrim、溶解统一 780ms、主题切换 shedAmbient 第二参数）：六份内容一致文件直接覆盖 + 三份平台接线文件三方合并零冲突（ManageInstanceModal/NewInstanceWizardModal/routes），合并后补 Windows 存储页签三处 `isPortrait` 传参；平台契约（存储迁移/导入导出/迁移门控/创建闭环）全数保留。前端 tsc+vite 全绿、后端 tsc 0 错误、88/88 测试全绿、锁文件刷新 | 已同步 |

---

## 5. 交付与推送门禁 (Milestone & Delivery Gate)

- **本地门禁**:
  1. `npm test` 80 项测试 100% 通过；
  2. `tsc --noEmit` 0 类型错误；
  3. `npm run pack` 生产构建成功。
- **中央登记协议**:
  - **当且仅当向远端分支执行 `git push` 或打包输出正式 EXE 时**，才向 `Local/docs/CURRENT_STATE.md` 与 `.worktrees/README.md` 登记事实索引。
