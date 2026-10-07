import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPlainPath } from './cleanup';
import { checkSignal } from './operations';
import { unzipToDir } from './utils';

function forbidden(segments: string[], includeSecrets: boolean): boolean {
  return segments.some((segment) => ['.git', 'node_modules', '.cache'].includes(segment)
    || segment.startsWith('.sillyclient-stage-')
    || segment.startsWith('.sillyclient-migration-')
    || segment.startsWith('.sillyclient-dependencies-')
    || segment === '.sillyclient-dependencies-pending'
    || segment === '.sillyclient-prebuilt-lib'
    || (!includeSecrets && ['secrets.json', 'secrets.json.enc'].includes(segment)));
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(path.resolve(left), path.resolve(right));
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function hash(file: string, signal?: AbortSignal): Promise<string> {
  checkSignal(signal);
  const digest = createHash('sha256');
  const stream = fs.createReadStream(file, { signal });
  for await (const chunk of stream) digest.update(chunk);
  checkSignal(signal);
  return digest.digest('hex');
}

interface OwnershipBounds {
  maxEntries?: number;
  maxBytes?: number;
}

/** A null fingerprint withholds rollback permission without limiting installation size. */
export async function directoryContentIdentity(
  root: string,
  signal?: AbortSignal,
  bounds: OwnershipBounds = {},
): Promise<string | null> {
  checkSignal(signal);
  const maxEntries = bounds.maxEntries ?? 131072;
  const maxBytes = bounds.maxBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('Invalid installation ownership bounds');
  }
  const rootStat = await assertPlainPath(root);
  const records = [`root:${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeMs}`];
  const queue = [root];
  let entries = 0;
  let bytes = 0;
  let known = true;
  const exceedBounds = () => {
    known = false;
    records.length = 0;
  };
  while (queue.length) {
    checkSignal(signal);
    const directory = queue.pop()!;
    for await (const entry of await fs.promises.opendir(directory)) {
      checkSignal(signal);
      if (++entries > maxEntries) exceedBounds();
      const file = path.join(directory, entry.name);
      const before = await fs.promises.lstat(file);
      if (before.isSymbolicLink()) throw new Error('Linked installation contents cannot establish rollback ownership');
      if (before.isDirectory()) {
        if (known) records.push(`directory:${path.relative(root, file)}`);
        queue.push(file);
      } else if (before.isFile()) {
        bytes += before.size;
        if (bytes > maxBytes) exceedBounds();
        // Even unknown ownership must not hide links, cancellation or unstable files.
        const digest = await hash(file, signal);
        const after = await fs.promises.lstat(file);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
          throw new Error('Installation contents changed during ownership verification');
        }
        if (known) records.push(`file:${path.relative(root, file)}:${before.size}:${digest}`);
      } else {
        throw new Error('Unsupported installation contents cannot establish rollback ownership');
      }
    }
  }
  checkSignal(signal);
  if (!known) return null;
  return createHash('sha256').update(records.sort().join('\n')).digest('hex');
}

async function copyTree(
  source: string,
  target: string,
  options: { includeSecrets: boolean; signal?: AbortSignal; scaffold?: boolean },
): Promise<void> {
  checkSignal(options.signal);
  await assertPlainPath(source);
  for (const entry of await fs.promises.readdir(source, { withFileTypes: true })) {
    checkSignal(options.signal);
    if (forbidden([entry.name], options.includeSecrets) || (options.scaffold && entry.name === 'data')) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fs.promises.lstat(from);
    if (stat.isSymbolicLink()) throw new Error('Linked migration sources are not supported');
    if (options.scaffold && fs.existsSync(to) && !stat.isDirectory()) continue;
    if (stat.isDirectory()) {
      await fs.promises.mkdir(to, { recursive: true });
      await copyTree(from, to, options);
    } else if (stat.isFile()) {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
      checkSignal(options.signal);
      if (await hash(from, options.signal) !== await hash(to, options.signal)) {
        throw new Error('Migration copy checksum mismatch');
      }
    } else {
      throw new Error('Unsupported migration source file');
    }
  }
}

function validServer(directory: string): boolean {
  if (!fs.existsSync(path.join(directory, 'server.js'))) return false;
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return typeof packageJson.version === 'string';
  } catch {
    return false;
  }
}

function flatten(root: string): void {
  while (true) {
    if (validServer(root)) break;
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    const nested = path.join(root, entries[0].name);
    const tempHolder = path.join(path.dirname(root), `.flatten-${randomUUID()}`);
    fs.renameSync(nested, tempHolder);
    try {
      for (const entry of fs.readdirSync(tempHolder)) {
        fs.renameSync(path.join(tempHolder, entry), path.join(root, entry));
      }
    } finally {
      if (fs.existsSync(tempHolder)) {
        fs.rmSync(tempHolder, { recursive: true, force: true });
      }
    }
  }
}

/** Takeover only validates and returns a location, never modifies source files. */
export async function resolveTakeoverSource(source: string): Promise<string> {
  const root = path.resolve(source);
  const stat = await assertPlainPath(root);
  if (!stat.isDirectory()) throw new Error('Takeover requires a directory');
  if (validServer(root)) return root;
  const candidates: string[] = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name);
    await assertPlainPath(candidate);
    if (validServer(candidate)) candidates.push(candidate);
  }
  if (candidates.length !== 1) throw new Error('Cannot uniquely identify a complete SillyTavern source');
  return candidates[0];
}

export interface MigrationTransaction {
  target: string;
  commit(): void;
  rollback(): Promise<void>;
}

/** Copies into a private sibling; publication never merges with an existing target. */
export async function copyMigration(
  source: string,
  target: string,
  defaultServer: string,
  options: { includeSecrets: boolean; signal?: AbortSignal; ownershipBounds?: OwnershipBounds },
): Promise<MigrationTransaction> {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  if (overlaps(resolvedSource, resolvedTarget) || overlaps(resolvedTarget, resolvedSource)) {
    throw new Error('Migration source and target must not overlap');
  }
  const sourceStat = await assertPlainPath(resolvedSource);
  if (fs.existsSync(resolvedTarget)) throw new Error('Migration target already exists; existing files were preserved');
  await fs.promises.mkdir(path.dirname(resolvedTarget), { recursive: true });
  await assertPlainPath(path.dirname(resolvedTarget));
  const staging = path.join(path.dirname(resolvedTarget), `.sillyclient-migration-${randomUUID()}`);
  await fs.promises.mkdir(staging);
  let published = false;
  let committed = false;
  let identity = '';
  let contentIdentity: string | null = null;
  const rollback = async () => {
    if (committed) return;
    const disposable = published ? resolvedTarget : staging;
    if (!fs.existsSync(disposable)) return;
    const stat = await assertPlainPath(disposable, true);
    if (published && identity !== `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`) {
      throw new Error('Migration target ownership changed; incomplete files preserved');
    }
    if (published && contentIdentity === null) {
      throw new Error('Migration target content ownership is unknown; files were preserved');
    }
    if (published && await directoryContentIdentity(disposable, undefined, options.ownershipBounds) !== contentIdentity) {
      throw new Error('Migration target contents changed; files were preserved');
    }
    await fs.promises.rm(disposable, { recursive: true, force: false });
  };
  try {
    if (sourceStat.isDirectory()) {
      await copyTree(resolvedSource, staging, options);
    } else if (sourceStat.isFile() && path.extname(resolvedSource).toLowerCase() === '.zip') {
      await unzipToDir(resolvedSource, staging, {
        signal: options.signal,
        filter: (segments) => !forbidden(segments, options.includeSecrets),
      });
      flatten(staging);
    } else {
      throw new Error('Migration requires a directory or ZIP archive');
    }
    checkSignal(options.signal);
    if (!validServer(staging)) {
      if (!validServer(defaultServer)) throw new Error('Data-only backup requires an installed default runtime');
      await copyTree(defaultServer, staging, { ...options, scaffold: true });
    }
    if (!validServer(staging)) throw new Error('Migration source does not contain a complete server');
    checkSignal(options.signal);
    const lockfilePath = path.join(staging, 'package-lock.json');
    if (fs.existsSync(lockfilePath)) {
      try {
        const lockText = await fs.promises.readFile(lockfilePath, 'utf8');
        if (lockText.includes('../..') || lockText.includes('com.sillyclient')) {
          await fs.promises.rm(lockfilePath, { force: true });
        }
      } catch {
        // Ignore read/cleanup errors
      }
    }
    for (const orphan of ['.sillyclient-dependencies-pending', '.sillyclient-prebuilt-lib']) {
      const orphanPath = path.join(staging, orphan);
      if (fs.existsSync(orphanPath)) {
        try { await fs.promises.rm(orphanPath, { force: true }); } catch {}
      }
    }
    if (fs.existsSync(resolvedTarget)) throw new Error('Migration target appeared while preparing the copy');
    contentIdentity = await directoryContentIdentity(staging, options.signal, options.ownershipBounds);
    checkSignal(options.signal);
    await fs.promises.rename(staging, resolvedTarget);
    published = true;
    const stat = fs.lstatSync(resolvedTarget);
    identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    checkSignal(options.signal);
    return {
      target: resolvedTarget,
      commit() { committed = true; },
      rollback,
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}
