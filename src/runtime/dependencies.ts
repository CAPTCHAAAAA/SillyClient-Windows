import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { bootstrapDir } from './paths';
import { runNpmInstall } from './process';
import { assertPlainPath } from './cleanup';
import { checkSignal } from './operations';

function canonical(directory: string): string {
  return path.resolve(directory).toLowerCase();
}

function identity(stat: fs.Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

/** A partial node_modules directory is not evidence of a completed npm install. */
export async function ensureInstanceDependencies(
  directory: string,
  log: (message: string, level?: string) => void,
  options: { signal?: AbortSignal; isTakeover?: boolean } = {},
): Promise<void> {
  checkSignal(options.signal);
  const rootStat = await assertPlainPath(directory);
  if (!rootStat.isDirectory()) throw new Error('Instance path is not a directory');
  const modules = path.join(directory, 'node_modules');
  const markerDirectory = path.join(bootstrapDir, 'dependency-installs');
  const key = createHash('sha256').update(canonical(directory)).digest('hex');
  const marker = path.join(markerDirectory, `${key}.pending.json`);
  const hasModules = fs.existsSync(modules);
  if (hasModules && !(await assertPlainPath(modules)).isDirectory()) {
    throw new Error('Instance dependencies path is not a directory');
  }
  if (hasModules && !fs.existsSync(marker)) return;
  if (options.isTakeover) {
    throw new Error('Takeover dependencies are missing or incomplete; source files were preserved');
  }
  await assertPlainPath(bootstrapDir);
  await fs.promises.mkdir(markerDirectory, { recursive: true });
  await assertPlainPath(markerDirectory);
  checkSignal(options.signal);
  const expected = JSON.stringify({ revision: 1, directory: path.resolve(directory) });
  try {
    await fs.promises.writeFile(marker, expected, { encoding: 'utf8', flag: 'wx' });
  } catch (error: any) {
    if (error.code !== 'EEXIST') throw error;
  }
  const markerStat = await assertPlainPath(marker);
  if (!markerStat.isFile() || markerStat.size > 4096) throw new Error('Invalid dependency installation marker');
  const markerContents = await fs.promises.readFile(marker, 'utf8');
  let stored: any;
  try { stored = JSON.parse(markerContents); } catch { throw new Error('Invalid dependency installation marker'); }
  if (stored?.revision !== 1 || typeof stored.directory !== 'string'
    || canonical(stored.directory) !== canonical(directory)) {
    throw new Error('Dependency installation marker does not belong to this instance');
  }
  checkSignal(options.signal);
  await runNpmInstall(directory, log, options.signal);
  checkSignal(options.signal);
  if (identity(await assertPlainPath(directory)) !== identity(rootStat)) {
    throw new Error('Instance changed during dependency installation');
  }
  if (!fs.existsSync(modules) || !(await assertPlainPath(modules)).isDirectory()) {
    throw new Error('Runtime dependency installation did not complete');
  }
  if (identity(await assertPlainPath(marker)) !== identity(markerStat)
    || await fs.promises.readFile(marker, 'utf8') !== markerContents) {
    throw new Error('Dependency installation marker changed; retry state was preserved');
  }
  checkSignal(options.signal);
  await fs.promises.unlink(marker);
}
