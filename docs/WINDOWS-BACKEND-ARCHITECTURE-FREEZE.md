---
hads-version: 1.0
document-version: 1.0.0
status: frozen
last-updated: 2026-10-09
ai-instructions: 这是 Windows 后端架构与前后端契约的终态冻结记录。本路线为最完美形态，已全面冻结；任何新 Agent 或后续任务严禁随意改动此路线。
---

# Windows 后端架构与前后端契约 · 终态冻结记录（1.11.0）

> **状态：FROZEN（2026-10-09 起全面冻结）**
> 用户指令原文：**"可以可以 很完美 直接推送提交后端 顺便记录一下这个路线是最完美的 不用再改了 再能强调的地方都强调一下最好别动这个路线"**。
> 本文件是 Windows 端（`SillyClient_Windows`）后端架构与解耦链路的**唯一权威准则**：架构形态已达最优解，以下列出的正确路线已定型，严禁退化回巨石或打补丁模式！

---

## 一、终态分层架构（最完美路线）

```
SillyClient_Windows/
├── src/
│   ├── contracts/
│   │   └── ipc-contracts.ts        # 【层级 1：强类型契约】40+ 请求/响应强类型接口，严格 1:1 对齐前端
│   ├── port-finder.ts              # 【层级 2：独立领域服务】端口占用检测与自增寻址服务
│   ├── system-dialogs.ts           # 【层级 2：独立领域服务】目录、图片封面、ZIP 选择原生对话框
│   ├── file-system-ops.ts          # 【层级 2：独立领域服务】原子临时文件写入与安全文本读写
│   ├── garbage-collector.ts        # 【层级 2：独立领域服务】孤立资源/临时文件扫描与清理
│   ├── download-provision.ts       # 【层级 2：独立领域服务】GitHub releases 拉取、多镜像并发下载与解压展平
│   ├── network-probe.ts            # 【层级 2：独立领域服务】连通性探测与 Basic Auth 状态验证
│   ├── instance-query.ts           # 【层级 2：独立领域服务】实例自检扫描、元数据提取与路径解析
│   ├── instance-uninstall.ts       # 【层级 2：独立领域服务】实例彻底卸载与日志/封面/归档级联清理
│   ├── instance-migrate.ts         # 【层级 2：独立领域服务】复制迁移与原地接管事务编排
│   ├── provision-workflow.ts       # 【层级 2：独立领域服务】实例创建、依赖准备、预设扩展/主题注入与启动编排
│   ├── plugin.ts                   # 【层级 3：调度与门面】瘦身为 280 行纯净 Facade & Dispatcher
│   ├── main.ts                     # 【层级 4：Electron 宿主】窗口生命周期、协议拦截与强类型 IPC 处理
│   └── runtime/                    # 【层级 5：底层基础设施】路径管理、进程监控、加密存储、数据库等基础能力
```

---

## 二、冻结契约（绝对铁律）

### 1. 强类型 IPC 通信铁律
- 前后端通信必须且只能通过 `src/contracts/ipc-contracts.ts` 中定义的强类型模型交互；
- **严禁** 在 IPC 层重新引入隐式 `any` 字典、未受检参数或不可预测的元组；
- 前端 `web/capacitor-ui/src/capacitor-plugin.ts` 与后端 `ipc-contracts.ts` 保持同源对齐，字段增删必须同步受检。

### 2. 门面调度与高内聚领域服务
- `src/plugin.ts` **永远定位为纯净调度中心（Facade & Dispatcher）**，代码量严格约束在 300 行以内；
- **禁止** 重新向 `plugin.ts` 中塞入内联业务逻辑、长篇文件操作、网络下载或复杂事务编排；
- 所有具体业务必须收拢在专门的领域服务（如 `download-provision.ts`、`provision-workflow.ts` 等）中自治运行。

### 3. 主进程边界清晰化
- `src/main.ts` 严禁使用历史多 Agent 留下的 `PluginContract` 或 `PathsContract` 防御性 `as unknown as` 强转；
- `main.ts` 仅负责 Electron 进程生命周期、硬件加速配置、特权协议（`app://`、`capacitor-file://`）与窗口视图管理；
- 宿主与插件交互必须编译期强类型绑定，禁止恢复弱类型可选链掩盖隐患。

### 4. 依赖注入与测试隔离兼容性
- 位于 `src/` 下的领域服务引用 `src/runtime/` 下的基础设施时，统一采用 root-relative（即 `./runtime/xxx`）导入；
- 此规范已被 79 项宿主单元测试网通过定制 loader 完整验证并形成闭环，**不得随意重构或挪动文件层级**。

### 5. 存储规范与数据安全零损失
- 用户数据注册表（`%LOCALAPPDATA%\SillyClient\tarven\instances.json`）与内置 Node.js 运行时必须严格保全；
- 任何卸载、清理、重命名、搬迁操作必须严格执行级联安全检查（`assertPlainPath` 与进程所有权检测），拒绝跨越根路径或误伤未登记目录。

---

## 三、已排除的错误做法（严禁再犯）

1. **已排除：巨石上帝模块 `plugin.ts` 膨胀**
   - 过去 1,405 行的巨石模块混杂了窗口事件、文件选择、下载解压、端口探测、垃圾清理和实例启动，任何单点修改都会带来不可预测的连锁破坏。
2. **已排除：弱类型 IPC 防御性断言**
   - 过去使用 `pluginModule as unknown as PluginContract` 掩耳盗铃，不仅丢失了 TypeScript 编译期守护，更导致类型错误只能在运行期爆发。
3. **已排除：跨目录层级相对路径导致的测试 Mock 失效**
   - 如果把高阶领域服务（如包含 `utils`、`preinstalled-extensions`、`companion-presets` 调用的工作流）深嵌在 `src/runtime/` 下同级引用，会导致测试 loader 绕过注入 mock 直接加载真实文件而引发网络挂起。保持在 `src/` 根层级调用 `./runtime/xxx` 是唯一经过 79 项全绿验证的正确模式。
4. **已排除：在向导中混入复杂数据迁移**
   - 新建向导必须只做纯粹的轻量创建；数据导入导出完整收拢入实例管理面板（ZIP 导入/导出）。

---

## 四、验证基线

每次代码提交前，必须确保以下三道闸门全部全绿：
1. `npm --prefix SillyClient_Windows test`：全量 **79/79 测试** 必须 100% 通过（78 pass，0 fail，1 optional skipped）；
2. `npm --prefix SillyClient_Windows run check`：后端 `tsc --noEmit` 保持 **0 错误、0 警告**；
3. `npm --prefix SillyClient_Windows\web\capacitor-ui run typecheck`：前端 `tsc --noEmit` 保持 **0 错误、0 警告**。
