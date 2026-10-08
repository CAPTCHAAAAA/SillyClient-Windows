/**
 * 数据迁移（目录复制或原地接管）事务编排服务
 */

import * as path from 'node:path';
import * as paths from './runtime/paths';
import * as instanceStore from './runtime/instances';
import { copyMigration, resolveTakeoverSource } from './runtime/migration';
import { ensureInstanceDependencies } from './runtime/dependencies';
import {
  installPreselectedExtensions,
  type ExtensionInstallTransaction,
} from './runtime/preinstalled-extensions';
import { invalidateDirectorySize } from './runtime/directory-stats';
import type { OperationContext } from './runtime/operations';
import type { MigrateInstanceParams, MigrateInstanceResult } from './contracts/ipc-contracts';

export async function migrateInstanceInternal(
  options: MigrateInstanceParams,
  context: OperationContext,
  notifyEvent: (eventName: string, data: any) => void,
): Promise<MigrateInstanceResult> {
  const { sourcePath, targetPath, instanceId = `migrated-${Date.now()}`, mode = 'copy', includeSecrets = false } = options || {};
  const cleanSourcePath = (typeof sourcePath === 'string') ? sourcePath.trim().replace(/^["']|["']$/g, '').trim() : '';
  if (!cleanSourcePath) throw new Error('缺少来源路径');

  const safeInstanceId = context.instanceId;
  const targetDir = paths.serverDirFor(safeInstanceId, targetPath, 'exact');

  context.check();
  if (instanceStore.getInstanceRecord(safeInstanceId)) throw new Error('Instance is already registered');
  const eventContext = { instanceId: safeInstanceId, operationId: context.operationId };
  const migrationEvent = (eventName: string, data: any) => {
    if (!context.signal.aborted) notifyEvent(eventName, { ...data, ...eventContext });
  };
  migrationEvent('log', { message: `【数据迁移】开始${mode === 'takeover' ? '原地接管' : '复制迁移'}: ${cleanSourcePath}`, level: 'info' });
  migrationEvent('progress', { percent: 10, stage: 'Validating migration source' });

  if (mode === 'takeover') {
    const realTakeoverPath = await resolveTakeoverSource(cleanSourcePath);
    context.check();
    instanceStore.registerInstance(safeInstanceId, realTakeoverPath, undefined, true);
    migrationEvent('progress', { percent: 100, stage: 'Takeover complete' });
    migrationEvent('log', { message: `【成功】已原地接管目录: ${realTakeoverPath}`, level: 'success' });
    return { success: true, instanceId: safeInstanceId, targetPath: realTakeoverPath };
  }
  if (mode !== 'copy') throw new Error('Unknown migration mode');
  migrationEvent('progress', { percent: 30, stage: 'Copying and verifying data' });
  const transaction = await copyMigration(cleanSourcePath, targetDir,
    path.join(paths.bootstrapDir, 'servers', 'default'), { includeSecrets, signal: context.signal });
  let extensions: ExtensionInstallTransaction | null = null;
  try {
    context.check();
    if (options.preinstall?.extensionIds.length) {
      const log = (message: string, level?: string) => migrationEvent('log', { message, level });
      migrationEvent('progress', { percent: 75, stage: 'Preparing base runtime dependencies' });
      await ensureInstanceDependencies(transaction.target, log, { signal: context.signal });
      context.check();
      extensions = await installPreselectedExtensions(transaction.target, options.preinstall, {
        signal: context.signal,
        operationId: context.operationId,
        log,
        progress: (percent, stage) => migrationEvent('progress', { percent: 80 + Math.floor(percent * 0.19), stage }),
      });
    }
    context.check();
    instanceStore.registerInstance(safeInstanceId, transaction.target, undefined, false);
    transaction.commit();
    extensions?.commit();
    invalidateDirectorySize(transaction.target);
    migrationEvent('progress', { percent: 100, stage: 'Migration verified' });
    migrationEvent('log', { message: `【成功】数据迁移完成，实例 [${safeInstanceId}] 已就绪！`, level: 'success' });
    return { success: true, instanceId: safeInstanceId, targetPath: transaction.target };
  } catch (error) {
    await extensions?.rollback();
    await transaction.rollback();
    throw error;
  }
}
