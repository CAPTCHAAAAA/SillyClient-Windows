import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  copyMigrationData, copyMigrationRuntime, inspectMigrationSource,
  MigrationError, validateMigrationDirectory,
} from './data-migration';
import type { CopyMigrationOptions, MigrationPlan } from './data-migration';
import { readImportConfiguration, localImportConfiguration, writeImportConfiguration } from './import-config';

export const IMPORT_INCOMPLETE = '.sillyclient-import-incomplete';
export const IMPORT_SETTINGS = '.sillyclient-import.json';

interface ImportContext {
  managedRoot: string;
  register: (instanceId: string, directory: string) => void;
}

export interface ManagedImportOptions extends CopyMigrationOptions {
  onStage?: (percent: number, stage: 'data' | 'runtime' | 'registering') => void;
}

export async function importManagedInstance(
  approved: MigrationPlan, options: ManagedImportOptions, context: ImportContext,
): Promise<{ instanceId: string; directory: string; filesCopied: number; sourceVersion: string }> {
  const checkCancelled = () => {
    if (options.signal?.aborted) throw new MigrationError('CANCELLED', 'Import cancelled.');
  };
  checkCancelled();
  if (!options.sourceStopped) throw new MigrationError('SOURCE_NOT_STOPPED', 'Stop the old installation first.');
  const copyOptions = { ...options, dataRoot: approved.dataRoot, includeExtensions: true };
  const plan = await inspectMigrationSource(approved.sourceRoot, copyOptions);
  if (plan.metadataFingerprint !== approved.metadataFingerprint || plan.dataRoot !== approved.dataRoot) {
    throw new MigrationError('SOURCE_CHANGED', 'Source configuration changed. Inspect it again before importing.');
  }
  const sourceConfig = await readImportConfiguration(plan.sourceRoot);
  const managedRoot = await validateMigrationDirectory(context.managedRoot);
  // Keep staging on the destination volume so C: -> D: imports can be promoted.
  const stagingRoot = managedRoot;
  const sourceContains = (candidate: string) => [plan.sourceRoot, plan.dataRoot].some(sourceRoot => {
    const relative = path.relative(sourceRoot, candidate);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  });
  if (sourceContains(managedRoot)) {
    throw new MigrationError('OVERLAPPING_PATHS', 'Managed directories must be outside the source installation.');
  }
  const suffix = randomUUID();
  const base = path.basename(approved.sourceRoot).replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '').slice(0, 36) || 'SillyTavern';
  const instanceId = `${base}-import-${suffix}`;
  const destination = path.join(managedRoot, instanceId);
  const staging = await fs.mkdtemp(path.join(stagingRoot, 'instance-import-'));
  const owner = path.join(staging, '.owner');
  let promoted = false;
  try {
    await fs.writeFile(owner, suffix, { flag: 'wx' });
    const instance = path.join(staging, 'instance');
    options.onStage?.(0, 'data');
    const result = await copyMigrationData(plan.sourceRoot, instance, {
      ...copyOptions,
      onProgress: progress => {
        options.onProgress?.(progress);
        options.onStage?.(Math.round(progress.completedFiles * 55 / Math.max(1, progress.totalFiles)), 'data');
      },
    });
    options.onStage?.(55, 'runtime');
    await copyMigrationRuntime(plan.sourceRoot, instance, {
      dataRoot: plan.dataRoot, signal: options.signal, includePlugins: true, includeSecrets: options.includeSecrets,
      onProgress: percent => options.onStage?.(55 + Math.round(percent * 0.4), 'runtime'),
    });
    const current = await inspectMigrationSource(plan.sourceRoot, copyOptions);
    if (JSON.stringify(current.files) !== JSON.stringify(plan.files)
        || current.metadataFingerprint !== plan.metadataFingerprint) {
      throw new MigrationError('SOURCE_CHANGED', 'Source data changed during import.');
    }
    // Preserve account login for imported profiles; network access remains local-only.
    const enableUserAccounts = sourceConfig.enableUserAccounts === true || plan.users.some(user => user !== 'default-user')
      || plan.directories.includes('_storage');
    await fs.writeFile(path.join(instance, IMPORT_SETTINGS), JSON.stringify({
      version: 2, sourceVersion: plan.sourceVersion, enableUserAccounts, importedAt: new Date().toISOString(),
      pluginsCopied: true, pluginDependenciesReady: false,
    }), { flag: 'wx' });
    await writeImportConfiguration(instance, localImportConfiguration(sourceConfig, 8000, enableUserAccounts));
    await fs.writeFile(path.join(instance, IMPORT_INCOMPLETE), suffix, { flag: 'wx' });
    checkCancelled();
    await validateMigrationDirectory(managedRoot);
    try {
      await fs.lstat(destination);
      throw new MigrationError('DESTINATION_EXISTS', 'The destination already exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    options.onStage?.(98, 'registering');
    await fs.rename(instance, destination);
    promoted = true;
    try {
      context.register(instanceId, destination);
      await fs.unlink(path.join(destination, IMPORT_INCOMPLETE));
    } catch {
      throw new MigrationError('REGISTRATION_FAILED', `Import could not be registered. A protected copy remains at: ${destination}`);
    }
    return { instanceId, directory: destination, filesCopied: result.filesCopied, sourceVersion: plan.sourceVersion };
  } finally {
    // Only this exact, newly allocated operation directory is eligible for cleanup.
    try {
      await validateMigrationDirectory(staging);
      if (path.dirname(staging) !== stagingRoot || await fs.readFile(owner, 'utf8') !== suffix) {
        throw new Error('Ownership changed.');
      }
      await fs.rm(staging, { recursive: true, force: false });
    } catch {
      if (!promoted) throw new MigrationError('CLEANUP_REQUIRED', `Import stopped; inspect the temporary directory: ${staging}`);
    }
  }
}

export async function prepareImportedPluginDependencies(
  directory: string, install: (pluginDirectory: string) => Promise<void>,
): Promise<void> {
  const marker = path.join(directory, IMPORT_SETTINGS);
  let settings: Record<string, any>;
  try {
    settings = JSON.parse(await fs.readFile(marker, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('迁移记录无法读取，已停止准备插件。');
  }
  if (!settings.pluginsCopied || settings.pluginDependenciesReady) return;
  const config = await readImportConfiguration(directory);
  if (config.enableServerPlugins !== true) return;
  const root = path.join(directory, 'plugins');
  let entries: import('node:fs').Dirent[];
  try {
    await validateMigrationDirectory(root);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') entries = [];
    else throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('插件目录包含链接，不能自动安装依赖。');
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pluginDirectory = path.join(root, entry.name);
    await validateMigrationDirectory(pluginDirectory);
    try {
      const stat = await fs.lstat(path.join(pluginDirectory, 'package.json'));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('插件 package.json 必须是普通文件。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    await install(pluginDirectory);
  }
  settings.pluginDependenciesReady = true;
  const temporary = `${marker}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(settings), { flag: 'wx' });
    await fs.rename(temporary, marker);
  } finally {
    await fs.unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
