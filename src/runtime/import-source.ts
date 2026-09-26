import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { inspectMigrationSource, MigrationError, validateMigrationDirectory } from './data-migration';
import type { InspectMigrationOptions, MigrationPlan } from './data-migration';
import { extractAndValidateZip } from './zip-import';
import { analyzeCompatibility, formatCompatibilitySummary } from './plugin-compatibility';
import { discoverLocalTaverns } from './auto-discover';

export { discoverLocalTaverns, analyzeCompatibility, formatCompatibilitySummary };

export interface ImportSourceOptions extends InspectMigrationOptions {
  runtimeRoot?: string;
  mode?: 'copy' | 'in-place';
  stagingParent?: string;
  onZipProgress?: (percent: number, message: string) => void;
  skipCompatibilityScan?: boolean;
}

async function hasRuntime(directory: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directory, 'package.json'));
    await fs.lstat(path.join(directory, 'server.js'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

// Only inspect the selected directory and its immediate parent, never scan a drive.
export async function inspectImportSelection(
  selected: string, options: ImportSourceOptions = {},
): Promise<MigrationPlan> {
  if (options.signal?.aborted) throw new MigrationError('CANCELLED', 'Import cancelled.');

  // 支持 ZIP 压缩包来源
  if (typeof selected === 'string' && selected.toLowerCase().endsWith('.zip')) {
    if (options.mode === 'in-place') {
      throw new MigrationError('ZIP_IN_PLACE_UNSUPPORTED', 'ZIP 压缩包仅支持“复制迁移”，不支持“原地接管”。');
    }
    const stagingParent = options.stagingParent || os.tmpdir();
    const zipResult = await extractAndValidateZip(selected, stagingParent, {
      signal: options.signal,
      onProgress: options.onZipProgress,
    });

    try {
      const plan = await inspectImportSelection(zipResult.tavernRoot, {
        ...options,
        skipCompatibilityScan: true, // 先由外层统一扫
      });
      plan.isZipSource = true;
      plan.zipCleanup = zipResult.cleanup;

      if (!options.skipCompatibilityScan) {
        try {
          const compat = await analyzeCompatibility(plan.sourceRoot);
          plan.compatibility = compat;
          if (compat.summary.highRisk > 0 || compat.summary.mediumRisk > 0) {
            plan.warnings.push(formatCompatibilitySummary(compat));
          }
        } catch {
          // ignore compatibility probe failure
        }
      }

      return plan;
    } catch (err) {
      await zipResult.cleanup();
      throw err;
    }
  }

  const directory = await validateMigrationDirectory(selected);
  let plan: MigrationPlan;
  if (options.runtimeRoot) {
    plan = await inspectMigrationSource(options.runtimeRoot, { ...options, dataRoot: directory });
  } else if (await hasRuntime(directory)) {
    plan = await inspectMigrationSource(directory, options);
  } else {
    const parent = path.dirname(directory);
    if (parent !== directory && await hasRuntime(parent)) {
      plan = await inspectMigrationSource(parent, { ...options, dataRoot: directory });
    } else {
      throw new MigrationError('RUNTIME_REQUIRED',
        '这是独立数据目录。请另外选择原酒馆本体目录（包含 package.json 和 server.js），以保留原版本。');
    }
  }

  if (!options.skipCompatibilityScan) {
    try {
      const compat = await analyzeCompatibility(plan.sourceRoot);
      plan.compatibility = compat;
      if (compat.summary.highRisk > 0 || compat.summary.mediumRisk > 0) {
        plan.warnings.push(formatCompatibilitySummary(compat));
      }
    } catch {
      // ignore
    }
  }

  return plan;
}
