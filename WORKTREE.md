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
2. **测试网 100% 覆盖**：全量 **88/88 项测试全绿通过**（88 pass，0 fail）；
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

# 3. 运行全量测试网（必须 88/88 全绿）
npm --prefix .worktrees/release-hardening-windows test

# 4. 前端构建与资源同步（若涉及前端修改）
npm --prefix .worktrees/release-hardening-windows/web/capacitor-ui run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .worktrees/release-hardening-windows/scripts/Sync-Frontend.ps1

# 5. 生产打包安装包（仅发布时）
npm --prefix .worktrees/release-hardening-windows run pack
```

---

## 4. 本树推进与改动记录 (Worktree Activity Log)

### 2026-11-24 Windows 1.15.3 Issue 全量修复与 NSIS 安装包打包就绪（待用户敲板发布）

- **问题修复范围（对应 `#9`、`#12`、`#11`、`#14/#17`、`#20/#18/#19`，严守终态解耦架构冻结）**：
  - **启动报错直返与进程早退识别（`#9`）**：`src/contracts/ipc-contracts.ts` 扩展 `ProvisionAndStartResult`（新增可选 `error?: string` / `cancelled?: boolean`）；`src/provision-workflow.ts` 捕获启动期 Node 早退状态、退出码与最后 6 行 `stderr`，在 `pollUntilReady` 中实时检测进程退出，早退时明确上报 `Node.js 进程在启动完成前已退出 (code=...)` 而不再误报 `服务启动超时（180s）`，并在 `catch` 与 `plugin.ts` 中将真实 `error` 或 `cancelled: true` 随返回值同步带回，彻底消除异步 `tarven:error` 事件与 `invoke` 返回值竞态导致的通用兜底文案丢失诊断信息；
  - **重命名串行互斥与 `EPERM` 退避重试（`#12`）**：`src/plugin.ts` 将 `renameInstance` 纳入 `operations.enqueue` 串行队列并传入 `proc.activeProcessDirectories()`，成功后主动刷新 `garbage`/`maintenance` 缓存；`src/runtime/rename.ts` 检查目标目录是否存在终端/后台子进程占用（拒绝并发重命名），对 `EPERM`/`EBUSY`/`EACCES` 引入有界退避重试（`150/300/500/800/1200ms`），耗尽后转为明确中文占用提示并保留原始错误码，大小写两段式重命名失败时自动回滚，并在完成后调用 `invalidateDirectorySize` 清理旧/新路径大小缓存；
  - **通用前端同步（`#11`、`#14/#17`、`#20/#18/#19`）**：同步 `provision-timeout.ts`（`ProvisionTimeoutTracker` 5m 空闲 / 25m 总上限心跳续期与 `resolveProvisionFailure`）、`native-errors.ts`（`RESERVED_DIAGNOSTIC_TOKENS` 防指纹分裂）、`sentry-diagnostic.ts` / `submit-diagnostic-report.ts`（内置生产 DSN 仅在原生生产环境启用）及 `routes/index.tsx` Web 演示端兜底；严格剔除 `src/dev/`。
- **版本与验证**：双 `package.json` 升为 `1.15.3`；`package.json` 的 `npm test` 增补 `tests/rename.test.cjs`；前端 `tsc --noEmit`、Vite 生产构建（1957 modules）与全量前端测试通过；`Sync-Frontend.ps1` 刷新 `frontend-dist` 与 `frontend.lock.json`；宿主 `npm run check`、`npm run build`、`npm test`（**95 pass / 0 fail / 1 optional skip**，新增 `#9` 早退与 `#12` 后台占用/重命名重试回归）全绿通过。
- **打包与审计**：`npm run pack` 产出 NSIS 安装包，归档至 `Local/artifacts/v1.15.3/SillyClient-Windows-v1.15.3.exe`（`118,850,425` 字节，SHA-256 `9d9b8c2f478b6d0e1f4b7799478d61ec4558450d622e29a611f98059a04f83b3`）；`app.asar` 审计确认 28/28 前端资产逐字节一致、含 `1.15.3` / `Windows 控制台` / Sentry DSN 及本次编译后后端修复文案、零 `src/dev` 与合成故障标记。未在本机安装或启动应用（`physicalDeviceTested: false`、`uiInteractionTested: false`）；未合入 `main` 或创建 Release，等待用户敲板发布。

### 2026-11-19 Windows 1.15.1 前端同步与统一发布

- **同步范围**：从 `common-frontend`（`d946b58`）同步统一前端更新（`ManageFolderShell` + `folder-tab-geometry.ts` 一体 SVG 文件夹页签与 780ms `manage-shared-transition.ts` 平切、`HeaderClock`、`CornerResizeCurve` 悬停/激活态、`interactionLocks` 与按需远程状态轮询、取消/未实现错误边界收敛及业务源码 `src/dev/` 物理隔离）；严格剔除 `src/dev/DevDebugOverlay.tsx` 与 `src/dev/dev-fixtures.tsx`（保持 `src/main.tsx` 无调试浮窗引用）；`src/routes/index.tsx` 三方合并保留 `directoryPickerGeneration` 防抖守卫及 `provisionCreatedInstance` 后置 `!isAndroid` 的 `setInstancesRoot` 写入。同步更新 `tests/native-preview.browser.cjs` 管理页签 `role="tab"` 选择器。
- **版本与验证**：双 `package.json` 升为 `1.15.1`；前端 `tsc --noEmit`、Vite 生产构建（1956 modules）与前后两次 `node --test web/capacitor-ui/tests/*.test.cjs`（107/107，含 `dev-isolation.test.cjs`）全通过；`Sync-Frontend.ps1` 刷新 `frontend-dist` 与 `frontend.lock.json`；宿主 `npm run check`、`npm run build`、`npm test`（88 pass / 0 fail / 1 skip 可选归档缓存，Windows 后端终态架构未改动）全通过。
- **打包与审计**：`npm run pack` 产出 NSIS 安装包，归档至 `Local/artifacts/v1.15.1/SillyClient-Windows-v1.15.1.exe`（118,850,650 字节，SHA-256 `7be6b64d0af7eee7437cad27ca452ef8cdd622850f771bf036e8d369c615ee7e`）；`app.asar` 审计确认 28/28 前端资产逐字节一致、含 `Windows 控制台` / `1.15.1` / Sentry DSN、合成与开发测试标记为零（证据：`Local/evidence/v1.15.1-release/windows-package-audit.json`）。未在本机安装或启动应用。

### 2026-11-18 Windows 1.15.0 主题预设紧急修复

- 根据用户紧急发布指令保持版本 `1.15.0`，将打包的 SC Bordeaux 主题与最新生成文件精确对齐，SHA-256 `8253F83DA43971F489A48CDD94F1050A3DD3BABDA0772C1AA5D85300029544F2`；资源 manifest 与宿主安装器校验统一至 Revision 3，修复前端请求 Revision 3、旧宿主只接受 Revision 1 导致的预设安装拒收。
- 宿主正式编译与 `tsc --noEmit` 通过；全量回归 88 PASS / 0 FAIL / 1 可选归档缓存 SKIP。新增校验确认主题安装落盘字节精确匹配内置资源，旧 revision 和篡改资源在修改实例前拒绝。
- 正式 NSIS 安装包归档 `Local/artifacts/v1.15.0/windows-theme-hotfix-20261118/SillyClient-Windows-v1.15.0.exe`，118,852,195 字节，SHA-256 `8C762D3549BCC9191D94ABAC43C258F4130E8551ECB76BD6268950D3A0FB7BFF`。直接从归档 EXE 提取资源，确认主题哈希、manifest Revision 3、asar 内编译后宿主校验一致；前端 28 份资产逐字节一致，Windows 控制台、Sentry 反馈和 1.15.0 版本在包内，合成故障演示标记为零。
- 证据 `Local/evidence/windows-theme-hotfix-1.15.0-20261118/`。本树负责测试、打包、提交推送 LTS 与快进同步 Windows main；主发布流程统一替换现有 v1.15.0 Release 资产与更新说明。未安装或启动应用。

### 2026-11-18 Windows 1.15.0 故障演示链清理与重新构建

- 按用户要求删除前端 `DEV_FAULT_TEST_INSTANCE` 卡片、固定实例 ID、存取过滤、故障 fetch、两处专用错误展示特判，以及 Logo 长按 620ms 合成异常上报、相关定时器与指针事件；保留普通演示实例、showcase、onboarding、真实全局错误处理与 Sentry 反馈。Windows 宿主 `src/` 未修改，版本仍为 `1.15.0`。
- 前端类型检查、Vite 生产构建与 95/95 测试通过；宿主类型检查通过，正式编译后宿主回归 87 PASS / 0 FAIL / 1 可选归档 SKIP。首次宿主测试因旧 `dist` 已清理而缺少编译文件，已保留失败日志；重编译后完整重跑通过。
- 官方 `scripts/Sync-Frontend.ps1` 已刷新 `frontend-dist` 与 `frontend.lock.json`，NSIS 正式打包成功。`app.asar` 内 28 份前端文件与本次源码构建、同步结果逐字节一致；故障演示标记全部为零，Windows 控制台、版本 1.15.0 与 Sentry 交付代码仍在。
- 新包独立归档 `Local/artifacts/v1.15.0/windows-no-fault-demo-20261118/SillyClient-Windows-v1.15.0.exe`：118,842,098 字节，SHA-256 `202376f51f0a4d53ac4376440a397fea230f7aacbe23956d8c138a31b5317f13`。证据 `Local/evidence/windows-no-fault-demo-20261118/`；未覆盖旧根归档、未安装或启动应用。构建通过后提交并推送本 LTS，随后快进同步 Windows main；确切交付 SHA 与远端回执记入上述证据。

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
| 2026-10-13 | Agent | **v1.13.0 含新前端重打包并覆盖安装**：用户指令"构建为1.13.0并安装到本地"；后端 tsc 重建、NSIS 重打包（SHA-256 `45a9789d…`，118,659,540 字节，替换 `Local/artifacts/v1.13.0/` 归档），已 `/S` 覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（1.13.0.0）；asar 实证含新前端（`manage-card-scrim`）与后端新规约（`尚未配置实例存储位置`）。**等待用户实测** | 待实测 |
| 2026-10-16 | Agent | **同步通用前端至 55edc3b（功能 ec678dc，遮罩同步淡出+设置项悬停）并重打包**：本树差量 `f0be259..55edc3b`——直接覆盖 19 份（含 CornerResizeCurve 新增），三方合并 5 份；冲突处置：向导拒绝 common 的"数据迁移模式"面板（Android 语义且 Windows routes 无接线）、搬迁弹窗否决"默认目录"档位（违背无默认路径铁律）但采纳三处 flat-capsule 按钮新规、routes 顶栏时钟按钮取新版悬停样式。前端 tsc+vite、后端 tsc、88/88 测试全绿；重打包 `/S` 覆盖安装本机（1.13.0.0，SHA-256 `bef42c73…`，118,660,488 字节），asar 实证含 `clear-20261014`/`flat-capsule`/`card-rim-depth1` 最新签名。**等待用户实测** | 待实测 |
| 2026-10-16 | Agent (62e72f2→main) | **v1.13.0 发布准备就绪（待口令）**：Windows 仓 `main` 已快进合入 lts（`b82a074..62e72f2`）并推送；发布说明草稿 `Local/artifacts/v1.13.0/RELEASE-NOTES-draft.md`、致歉信草稿 `APOLOGY-LETTER-draft.md`、构建证据 `Local/evidence/v1.13.0/`、Runbook `Local/docs/RELEASE-PREP-v1.13.0.md` 全部就位。tag 与 GitHub Release 创建（仅主仓）等待用户明确口令；用户实测仍是发布前置条件 | 待口令 |
| 2026-10-17 | Agent (d687c84) | **同步通用前端 `674a9a6` 并升版 1.13.1（纯前端）**：终端与管理菜单接入 `CornerResizeCurve` 缩放手柄；管理菜单改全屏居中层 + `animate-manage-panel` 弹窗动画；终端换毛玻璃砰体、下沉日志槽与遮罩；新手引导换图（`ONBOARDING_VERSION` 仍为 3）、动态壁纸拨杆收紧保留绿色自发光；补齐历史漏同步的 `cover-1/2/3.jpg`。合并方式：`ManageInstanceModal` / `routes` / `styles` 用对象对齐后的三方合并，`TerminalModal` 全取新版（Windows 旧实现被新版取代）。**Windows 接线全保留**：存储路径 / 迁移目录 / 导入数据（ZIP）/ 导出实例（ZIP）。**终端文案实证**：asar 内为 `Windows 控制台`、`C:\\>`、`输入 Windows 命令`，未被通用版的 Android shell 串味。后端 `src/` 与已构建 `dist/` 零改动，打包只跑 electron-builder。前端 tsc+vite 通过、后端 88/88 全绿、`/S` 覆盖安装本机 1.13.1.0。产物 `Local/artifacts/v1.13.1/SillyClient-Windows-v1.13.1.exe`（118,942,960 字节，SHA-256 `4e31041b…`） | 待发布 |
| 2026-10-23 | Agent (7331443) | **兜底导出路径修复（用户反馈私自占用下载目录）**：`exportInstance()` 无 `targetZipPath` 时不再写 `~/Downloads/SillyClient-导出`，改落软件自己的数据目录 `%LOCALAPPDATA%\SillyClient\tarven\exports`；用户主动导出仍走原生保存对话框，位置由用户定。**根因二**：单测此前直接在真实 Downloads 建目录，现已把 `LOCALAPPDATA` 隔离到临时目录，并断言结果路径必在 `exportsDir` 下、绝不以真实 Downloads 开头。`npm run build` 0 错误，测试 87 pass / 0 fail / 1 skip（既有的外网 pinned archive 用例）。asar 抽查 `SillyClient-导出` 已 absent。本地验证包 `SillyClient-Windows-v1.13.1-exportfix.exe`（118,942,908 字节，SHA-256 `a5b42e20…`），不覆盖已发布 1.13.1 | 待发布 |
| 2026-10-23 | Agent（安装目录修正） | **按用户澄清把兜底导出改到软件安装目录**：`paths.exportsDir = path.join(appRootDir, 'exports')`，打包后即 `<安装目录>\exports`；`%LOCALAPPDATA%` 中转方案作废（用户明确否决）。单测新增 `SILLYCLIENT_EXPORTS_DIR` 覆写并断言绝不落 Downloads / Desktop / Documents。真实安装路径探针：`exportsDir=D:\Software\AI\Entertainment\SillyClient\exports`、`insideInstallRoot=true`、`touchesDownloads=false`。测试 87 pass / 0 fail / 1 skip。本地验证包 `SillyClient-Windows-v1.13.1-exportfix.exe`（118,942,769 字节，SHA-256 `9c170abf…`），已覆盖安装本机 1.13.1.0 | 待发布 |
| 2026-10-23 | Agent (7b35c77) | **发布 1.13.2 并覆盖安装**：版本双 `package.json` 升 1.13.2；共享前端依赖 store 缺包（`@babel/types`/`picocolors`）已用 `pnpm install --frozen-lockfile` 补齐，前端 1920 modules 重建（产物含 1.13.2、不含 1.13.1），`Sync-Frontend.ps1` 刷新锁；后端 tsc 0 错误、测试 87 pass / 0 fail / 1 skip。asar 抽查：`1.13.2`/`Windows 控制台`/`输入 Windows 命令`/`appRootDir,'exports'` 均在，`SillyClient-导出` absent。`/S` 覆盖安装本机 1.13.2.0。产物 `Local/artifacts/v1.13.2/SillyClient-Windows-v1.13.2.exe`（118,942,767 字节，SHA-256 `b81747ff…`） | 已安装待测 |
| 2026-10-23 | Agent (8a500c2 / Main ea8c9ea) | **v1.13.2 GitHub Release 上传 Windows 资产**：Release 原为 Android-only，现已改为 Windows + Android 双端文案，并上传 `SillyClient-Windows-v1.13.2.exe`（`state=uploaded`，digest `b81747ff…` 与本地一致）。Main 仓文案 `docs/RELEASE-NOTES-v1.13.2.md` 已提交并推送 `ea8c9ea`；Discord 文案同步为双端。iOS 仍待出包 | 已发布 |
| 2026-11-04 | Agent | **同步最新统一前端基线（02e6873..2321eff）并打包 1.14.0**：全量对齐通用前端最新提交，引入 C2 连续长按拖拽重排与动态流光底板采样（`frozenCoverPlate`/`useFrozenCoverPlate`），终端统一毛玻璃外壳、深色代码井（`TerminalWell`/`terminal.css`）与开源 `Maple Mono` 字体，布局收敛（`RunningConsoleCard.css`/`ManageInstanceModal.css`/`useManagePanelLayout`），彻底删除应用内更新公告弹窗（`WhatsNewModal`）及设置/引导入口；完整保留 Windows 终态强类型 IPC 契约、无默认路径铁律与实例管理「导出实例（ZIP）」原生保存对话框接入；前端构建 0 错误、后端 88/88 宿主测试全绿、NSIS 生产打包产出 `SillyClient Setup 1.14.0.exe`（SHA-256 `c8cd9f00…`）并覆盖安装验证成功；未提交 release 文案与 Tag，等待统一发布 | 待统一发布 |
| 2026-11-07 | Agent | **同步最新统一前端基线（98b7047 + 3e1ddea）并构建覆盖安装 1.14.0**：全量对齐通用前端最新提交，引入卡片内重命名（`InstanceRenameField`）、展开控制台抽屉（`InstanceCardDrawer`）、控制台操作按钮规范（`ActionButton`/`console-card.css`）、全屏首屏引导 v4 升级（21 张新图与 `guide-content.ts`，动态平台分流）；原生契约类型补齐（`inspectImportArchive` / `importInstanceData` / `exportInstance` / `instanceParentPath` / `humanizeNativeError` / `selectTavernRelease`）；完整保留 Windows 导出实例（ZIP）原生保存对话框自选位置、设置抽屉无默认路径回退与"敬请期待"原型占位符；双端 package.json 维持 1.14.0；前端 tsc+vite 0 错误、后端 88/88 测试全绿（87 pass / 1 skip）、NSIS 生产打包产出 `SillyClient Setup 1.14.0.exe`（SHA-256 `061df07c…`，118,995,781 字节），已静默覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（SillyClient.exe 1.14.0.0，app.asar 5,774,884 字节）并验证无报错；未提交 release 文案与 Tag，等待统一发布 | 已安装待统发 |
| 2026-11-07 | Agent (58b6987) | **版本升级 1.14.1 并构建覆盖安装**：双端 package.json 升 1.14.1，对齐通用前端最新网络说明契约与搬迁自愈（`handleInstanceRelocated` 兼容结果对象与直接路径）；前端构建 0 错误、后端 88/88 宿主测试全绿（87 pass / 1 skip）、NSIS 生产打包产出 `SillyClient Setup 1.14.1.exe`（SHA-256 `9e5d7a32…`，119,135,234 字节），已静默覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（SillyClient.exe 1.14.1.0，app.asar 5,775,065 字节）并验证无报错；产物归档至 `Local/artifacts/v1.14.1/` 并刷新三端 SHA-256；lts 与 main 均已推送到远端；未提交 release 文案与 Tag，等待统一发布 | 已安装待统发 |
| 2026-11-08 | Agent | **同步最新统一前端基线（7f44d2e + cc692f5）并构建覆盖安装 1.14.1**：全量对齐通用前端最新提交：① 彻底清除已废弃的旧版本实例迁移向导（删除 `LegacyMigrationModal.tsx` 及在 `routes/index.tsx` 中的全部状态、引用与入口，NewInstanceWizardModal 模式收敛为 local/remote 彻底剔除 import 迁移模式）；② 移除设置页旧实例备份（去除 JSON 导入导出及旧版数据页签），引导手册（`guide-content.ts` / `OnboardingGuide`）精简聚焦基础与维护；③ 新增浮层全域背景交互锁与手势阻断（`isBackgroundInteractionBlocked` + `LayerBackdrop` 解决弹窗开启期间背景可穿透交互问题）；④ 完整保留 Windows 强类型 IPC 契约、零默认路径与实例管理原生 ZIP 导出；前端 tsc+vite 0 错误、后端 88/88 测试全绿（87 pass / 1 skip）、NSIS 生产打包产出 `SillyClient Setup 1.14.1.exe`（SHA-256 `6c27a2b9…`，119,247,940 字节），已静默覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（SillyClient.exe 1.14.1.0，app.asar 5,844,735 字节）；产物归档至 `Local/artifacts/v1.14.1/` 并刷新三端 SHA-256 | 已安装待统发 |
| 2026-11-10 | Agent | **同步最新统一前端基线（bfe5b0e）并构建覆盖安装 1.14.1**：全量对齐通用前端最新提交：① 根除新手引导画面撕裂与频闪，废弃 23 张静态 `.webp` 截图，改用视口绑定 SVG Mask 切割（`<mask id="sc-spotlight-mask">`），单帧开销由 15ms 降至 0.05ms，消除高刷撕裂；引导就绪弹窗平滑淡出，`#root` 延迟 250ms 隐藏消除频闪；② 接入沙箱交互与引导握手机制（`OnboardingSession` / `onboardingSandbox` / `onboarding-mode.ts`），并对 Node.js 单测环境严格补齐 `typeof window !== "undefined"` 守卫；③ 同步 SC Bordeaux Revision 3 终态与性能预设收敛；④ 完整保留 Windows 强类型 IPC 契约、零默认路径与实例管理原生 ZIP 导出；前端 tsc+vite 0 错误、后端 88/88 宿主测试全绿（87 pass / 1 skip）、NSIS 生产打包产出 `SillyClient Setup 1.14.1.exe`（SHA-256 `d7f143d7…`，118,845,539 字节），已静默覆盖安装至 `D:\Software\AI\Entertainment\SillyClient`（SillyClient.exe 1.14.1.0，app.asar 5,459,036 字节）；产物归档至 `Local/artifacts/v1.14.1/` 并刷新三端 SHA-256 | 已安装待统发 |
| 2026-11-17 | Agent | **Windows 1.15.0 前端与诊断反馈交付**：承接已验收公共前端增量（设置缩放、浮层溶解、启动/实例位置错误展示、全局反馈入口、Sentry 上报及脱敏/接力降级），双 `package.json` 升 1.15.0；保留 Windows 平台检测、控制台文案、强类型 IPC、无默认路径及原生 ZIP 导出，宿主 `src/` 未改。用户已确认 Windows 测试成功；反馈已由 Sentry 接收为 `SILLYCLIENT-CONSOLE-3`（`7852410176`，`windows` / `sillyclient@1.15.0`，指纹 `sc-023220ef`，累计 1 次），并于北京时间 2026-11-17 20:19:37 同步至 `CAPTCHAAAAA/SillyClient#9`。本次复核：宿主测试 87 pass / 0 fail / 1 可选归档 skip，宿主 `tsc --noEmit` 与前端 tsc+Vite 通过；前端 95/95 通过（两项旧断言在 `cc1e83a` 基线同样失败，现仅更新测试以验证卡片几何/inert 幂等及分页控制器真实导航行为）。官方同步刷新前端锁；NSIS 打包成功，asar 28 份前端资产逐字节一致且含 1.15.0、Windows 控制台与 Sentry 项目。验证包单独归档 `Local/artifacts/v1.15.0/windows-delivery-check-20261117/`（SHA-256 `48b22683…`），未重新安装或操作应用；证据 `Local/evidence/windows-delivery-1.15.0-20261117/`。 | 已验收，交付检查通过 |

---

## 5. 交付与推送门禁 (Milestone & Delivery Gate)

- **本地门禁**:
  1. `npm test` 88 项测试 100% 通过；
  2. `tsc --noEmit` 0 类型错误；
  3. `npm run pack` 生产构建成功。
- **中央登记协议**:
  - **当且仅当向远端分支执行 `git push` 或打包输出正式 EXE 时**，才向 `Local/docs/CURRENT_STATE.md` 与 `.worktrees/README.md` 登记事实索引。
