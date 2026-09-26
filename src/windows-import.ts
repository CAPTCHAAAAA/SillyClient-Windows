import { BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'node:path';
import { ensureDirs, bootstrapDir } from './runtime/paths';
import { registerImportedInstance } from './runtime/instances';
import { MigrationError, validateMigrationDirectory } from './runtime/data-migration';
import type { MigrationPlan } from './runtime/data-migration';
import { inspectImportSelection, formatCompatibilitySummary } from './runtime/import-source';
import type { ImportSourceOptions } from './runtime/import-source';

import { importManagedInstance } from './runtime/import-instance';
import { attachExistingInstance } from './runtime/takeover-instance';

let controller: AbortController | null = null;

export const IMPORT_NOTICES = {
  copy: '仅复制导入：旧文件夹保留在本地，副本与原版之后的聊天、设置等数据不会自动同步。',
  takeover: '原地接管（不推荐）：直接使用原目录，和原启动方式共用同一份数据。可能发生配置、依赖或并发写入冲突，无法保证兼容性；请完整备份，且不要同时启动原酒馆。',
  scope: '复制聊天、预设、用户/全局第三方扩展、服务器插件及相关配置。不是完整备份：旧依赖和 Git 更新记录不复制；首次启动会安装依赖，插件自动更新关闭。secrets.json 默认不复制，需单独勾选；其他插件配置仍可能含密钥。',
  cleanup: '确认所需数据已完整迁入，或已另存可恢复的完整备份后，建议自行清理不再需要的旧文件夹，避免重复占用空间和误用旧数据。未核对前请保留。',
  responsibility: '请自行负责数据备份、完整性核对和手动清理。本软件不会自动删除旧文件夹，也不提供删除旧文件夹的操作。',
} as const;

export interface ImportRequest {
  mode?: 'copy' | 'in-place';
  source?: string;
  runtimeRoot?: string;
  destination?: string;
}

export interface ImportStatus {
  state: 'working' | 'complete' | 'cancelled' | 'error';
  message: string;
  percent?: number;
}

export function isImportRunning(): boolean { return controller !== null; }
export function cancelImport(): void { controller?.abort(); }
export function defaultImportDirectory(): string { return path.join(bootstrapDir, 'servers'); }

function setBusy(busy: boolean): void {
  const menu = Menu.getApplicationMenu();
  const start = menu?.getMenuItemById('import-old-tavern');
  const cancel = menu?.getMenuItemById('cancel-data-import');
  if (start) start.enabled = !busy;
  if (cancel) cancel.enabled = busy;
}

async function chooseDirectory(win: BrowserWindow, title: string): Promise<string | undefined> {
  const result = await dialog.showOpenDialog(win, { title, properties: ['openDirectory'] });
  return result.canceled ? undefined : result.filePaths[0];
}

async function chooseSource(win: BrowserWindow, mode: 'copy' | 'in-place'): Promise<string | undefined> {
  if (mode === 'in-place') {
    return chooseDirectory(win, '选择旧酒馆文件夹，或其中的 data 文件夹');
  }
  const choice = await dialog.showMessageBox(win, {
    type: 'question', title: '选择导入来源形式',
    message: '你的旧酒馆是本地文件夹，还是备份的 ZIP 压缩包？',
    buttons: ['取消', '旧酒馆文件夹', 'ZIP 压缩包'], defaultId: 1, cancelId: 0, noLink: true,
  });
  if (choice.response === 1) {
    return chooseDirectory(win, '选择旧酒馆文件夹，或其中的 data 文件夹');
  }
  if (choice.response === 2) {
    const result = await dialog.showOpenDialog(win, {
      title: '选择旧酒馆备份 ZIP 压缩包',
      properties: ['openFile'],
      filters: [{ name: 'ZIP 压缩包 (*.zip)', extensions: ['zip'] }],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }
  return undefined;
}

export async function beginImport(
  win: BrowserWindow, runtimeBusy: () => boolean, request: ImportRequest = {},
  notify: (status: ImportStatus) => void = () => {}, launcher = win,
): Promise<void> {
  if (controller) {
    notify({ state: 'error', message: '已有导入任务正在进行。' });
    return;
  }
  if (runtimeBusy()) {
    notify({ state: 'error', message: '请先停止正在运行或创建中的实例。' });
    await dialog.showMessageBox(win, { type: 'info', message: '请先停止正在运行或创建中的实例，再导入旧酒馆。' });
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  setBusy(true);
  const title = win.getTitle();
  let completed = false;
  let currentPlan: MigrationPlan | undefined;
  try {
    let mode = request.mode;
    if (!mode) {
      const choice = await dialog.showMessageBox(win, {
        type: 'question', title: '接入旧酒馆', message: '请选择接入方式。',
        detail: `复制迁移：复制一份，原版与副本不自动同步。\n${IMPORT_NOTICES.takeover}`,
        buttons: ['取消', '复制迁移', '原地接管（不推荐）'], defaultId: 1, cancelId: 0, noLink: true,
      });
      if (choice.response === 0 || signal.aborted) return;
      mode = choice.response === 2 ? 'in-place' : 'copy';
    }
    if (mode !== 'copy' && mode !== 'in-place') throw new Error('未知接入方式。');
    const source = request.source || await chooseSource(win, mode);
    if (!source || signal.aborted) return;
    const isZip = source.toLowerCase().endsWith('.zip');
    if (!isZip) {
      await validateMigrationDirectory(source);
    }
    const options: ImportSourceOptions = {
      signal,
      runtimeRoot: request.runtimeRoot,
      includeExtensions: mode === 'copy',
      mode,
      onZipProgress: (percent, msg) => {
        notify({ state: 'working', message: msg, percent });
        if (!win.isDestroyed()) {
          win.setTitle(`SillyClient · ${msg}`);
          win.setProgressBar(percent / 100);
        }
      },
    };
    notify({ state: 'working', message: isZip ? '正在解压并校验 ZIP 归档…' : '正在识别并检查旧酒馆文件夹…' });
    win.setProgressBar(2);
    win.setTitle(isZip ? 'SillyClient · 正在解析 ZIP 归档' : 'SillyClient · 正在识别旧酒馆');
    let plan: MigrationPlan | undefined;
    while (!plan) {
      try {
        plan = await inspectImportSelection(source, options);
        currentPlan = plan;
      } catch (error) {

        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'RUNTIME_REQUIRED' && !options.runtimeRoot) {
          const consent = await dialog.showMessageBox(win, {
            type: 'question', title: '还需要原酒馆的程序文件',
            message: '选中的文件夹只有数据，无法从旁边找到酒馆程序。',
            detail: '请选择原来运行这份数据的 SillyTavern 文件夹，里面应有 server.js 和 package.json。确认接入前只读取文件，不修改原文件。',
            buttons: ['取消', '选择原酒馆文件夹'], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (consent.response !== 1 || signal.aborted) return;
          options.runtimeRoot = await chooseDirectory(win, '选择原来运行这份数据的 SillyTavern 文件夹（里面有 server.js）');
          if (!options.runtimeRoot || signal.aborted) return;
        } else if (code === 'EXTERNAL_DATA_ROOT' && !options.allowExternalData) {
          const consent = await dialog.showMessageBox(win, {
            type: 'question', title: '外部数据目录',
            message: '所选数据位于酒馆本体目录之外。是否允许读取该数据目录？',
            buttons: ['取消', '允许识别'], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (consent.response !== 1 || signal.aborted) return;
          options.allowExternalData = true;
        } else if ((code === 'ENOENT' || code === 'NO_USER_DATA') && !options.dataRoot && !options.runtimeRoot) {
          const consent = await dialog.showMessageBox(win, {
            type: 'question', message: '未找到可导入的数据，是否手动指定旧数据目录？',
            buttons: ['取消', '选择数据目录'], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (consent.response !== 1 || signal.aborted) return;
          options.dataRoot = await chooseDirectory(win, '选择包含 default-user 或其他用户文件夹的数据目录');
          if (!options.dataRoot || signal.aborted) return;
          options.allowExternalData = true;
        } else throw error;
      }
    }
    if (mode === 'in-place') {
      win.setProgressBar(-1);
      const consent = await dialog.showMessageBox(win, {
        type: 'warning', title: '原地接管确认（不推荐）',
        message: '不复制、不搬动文件，之后直接读写原目录中的数据。',
        detail: [
          `原酒馆：${plan.sourceRoot}`, `共用的数据：${plan.dataRoot}`, '',
          IMPORT_NOTICES.takeover,
          '原插件、预设和密钥留在原位置，是否能运行仍取决于兼容性。只接管你信任的程序。',
          '本软件使用内置 Node 和另存的启动配置；不会覆盖原 config.yaml、启动脚本，也不会重装依赖。',
          '本次启动仅使用本机 HTTP，关闭独立配置中的 HTTPS 和扩展自动更新，保留酒馆账户登录。HTTP Basic Auth/反向代理登录暂不支持，会明确报错。',
          '接管只登记位置，不自动启动。启动酒馆和插件仍可能修改原数据；移除实例只解除接管，不删除原目录。',
        ].join('\n'),
        buttons: ['取消', '原酒馆已停止，确认接管'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (consent.response !== 1 || signal.aborted) return;
      if (runtimeBusy()) throw new Error('实例正在运行，请先停止后重试。');
      const record = await attachExistingInstance(plan, { ...options, sourceStopped: true });
      completed = true;
      const detail = `运行目录：${record.path}\n数据目录：${record.dataRoot}\n没有创建副本，也未移动或删除文件。原目录就是运行目录，请勿当作迁移残留删除。\n请勿同时用原启动方式运行同一份数据。`;
      notify({ state: 'complete', message: `原地接管已登记，尚未启动。\n${detail}`, percent: 100 });
      if (!launcher.isDestroyed()) launcher.webContents.reload();
      if (!win.isDestroyed()) await dialog.showMessageBox(win, {
        type: 'info', title: '原地接管已登记', message: '已加入实例列表，运行时直接使用原目录。',
        detail, buttons: ['知道了'], noLink: true,
      });
      return;
    }
    ensureDirs();
    const managedRoot = await validateMigrationDirectory(request.destination || defaultImportDirectory());
    win.setProgressBar(-1);
    if (signal.aborted) return;
    const compatDetail = plan.compatibility ? ['', '【扩展与插件兼容性分析】', formatCompatibilitySummary(plan.compatibility)] : [];
    const confirmation = await dialog.showMessageBox(win, {
      type: 'warning', title: '复制导入确认',
      message: `复制 SillyTavern ${plan.sourceVersion} 的 ${plan.users.length} 个用户数据？旧文件夹不会被搬走或删除。`,
      detail: [
        IMPORT_NOTICES.copy, IMPORT_NOTICES.scope, '',
        `旧酒馆文件夹：${plan.sourceRoot}`, `旧数据文件夹：${plan.dataRoot}`,
        `数据量：${plan.files.length} 个文件，${(plan.totalBytes / 1024 / 1024).toFixed(1)} MB`,
        `保存到：${managedRoot} 下的新实例目录`,
        ...compatDetail, '',
        '请先停止旧酒馆及其他写入程序，并备份重要数据。',
        '仅导入你信任的安装目录。插件文件与配置一并复制，保留原服务器插件开关；启动副本会运行已启用的插件，安装依赖可能执行安装脚本。导入过程不执行插件，也不会自动启动。',
        '副本仅使用本机 HTTP，保留酒馆账户登录，不沿用原网络监听、HTTPS、HTTP Basic Auth 或反向代理登录设置。',
        '插件中的绝对路径、外部服务和平台依赖无法保证迁移后可用，请自行核对。Git 更新记录不复制，插件在线更新可能需要重新安装插件。',
        IMPORT_NOTICES.takeover, IMPORT_NOTICES.responsibility,
      ].join('\n'),
      checkboxLabel: '同时复制 API 密钥（secrets.json）', checkboxChecked: false,
      buttons: ['取消', '旧酒馆已停止，复制一份'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (confirmation.response !== 1 || signal.aborted) return;
    if (runtimeBusy()) throw new Error('实例正在运行，请先停止后重试。');
    notify({ state: 'working', message: '开始复制并校验…', percent: 0 });
    const result = await importManagedInstance(plan, {
      ...options, sourceStopped: true, includeSecrets: confirmation.checkboxChecked,
      onStage: (percent, stage) => {
        const label = stage === 'data' ? '复制并校验数据' : stage === 'runtime' ? '复制并校验酒馆本体' : '加入实例列表';
        notify({ state: 'working', message: label, percent });
        if (!win.isDestroyed()) {
          win.setTitle(`SillyClient · ${label} ${percent}%`);
          win.setProgressBar(percent / 100);
        }
      },
    }, {
      managedRoot,
      register: (id, directory) => { registerImportedInstance(id, directory); },
    });
    completed = true;
    const resultDetail = [
      `新副本：${result.directory}`,
      `仍保留在本地的旧酒馆：${plan.sourceRoot}`,
      `仍保留在本地的旧数据：${plan.dataRoot}`, '',
      IMPORT_NOTICES.copy,
      `已复制的文件通过校验，不代表所有内容已完整迁移或启动成功。${IMPORT_NOTICES.scope}`,
      '请运行新实例，核对聊天、角色卡、预设、插件及密钥是否齐全。首次运行会联网安装主程序和已启用服务器插件的依赖；原插件启用状态保留。自定义绝对路径和外部服务需自行核对。',
      IMPORT_NOTICES.cleanup, IMPORT_NOTICES.responsibility,
    ].join('\n');
    notify({ state: 'complete', message: `复制完成，旧文件夹仍然保留。\n${resultDetail}`, percent: 100 });
    if (!launcher.isDestroyed()) launcher.webContents.reload();
    if (win.isDestroyed()) return;
    await dialog.showMessageBox(win, {
      type: 'warning', title: '复制完成：旧文件夹仍然保留',
      message: '副本已加入实例列表。请先核对数据和备份，不要立即删除旧文件夹。',
      detail: resultDetail,
      buttons: ['知道了，先核对副本'], defaultId: 0, cancelId: 0, noLink: true,
    });
  } catch (error) {
    completed = true;
    if ((error instanceof MigrationError && error.code === 'CANCELLED')
        || (error instanceof Error && error.name === 'AbortError')) {
      notify({ state: 'cancelled', message: '导入已取消，原酒馆未修改。' });
      if (!win.isDestroyed()) await dialog.showMessageBox(win, { type: 'info', message: '导入已取消，原酒馆未修改。' });
    } else {
      notify({ state: 'error', message: error instanceof Error ? error.message : '导入失败。' });
      if (!win.isDestroyed()) await dialog.showMessageBox(win, {
        type: 'error', title: '导入未完成', message: '导入未完成，原酒馆未修改。',
        detail: error instanceof Error ? error.message : '未知错误',
      });
    }
  } finally {
    if (currentPlan?.isZipSource && currentPlan.zipCleanup) {
      try { await currentPlan.zipCleanup(); } catch { /* ignore */ }
    }
    if (!completed) notify({ state: 'cancelled', message: '未执行导入，原酒馆未修改。' });
    controller = null;
    setBusy(false);
    if (!win.isDestroyed()) {
      win.setTitle(title);
      win.setProgressBar(-1);
    }
  }
}
