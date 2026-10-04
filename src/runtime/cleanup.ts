import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { directorySize } from './directory-stats';
import type { InstanceRecord } from './instances';

type GarbageType = 'orphan_instance' | 'orphan_cover' | 'temp_file' | 'cache';

export interface GarbageItem {
  path: string;
  type: GarbageType;
  sizeBytes: number;
  description: string;
  token: string;
}

interface CleanupContext {
  records: InstanceRecord[];
  activeDirectories: string[];
  activeInstanceIds?: string[];
  activeCoverPaths?: string[];
  protectedPaths?: string[];
}

interface Capability {
  item: GarbageItem;
  fingerprint: string;
  expires: number;
  references: Pick<CleanupContext, 'activeCoverPaths' | 'activeInstanceIds'>;
}

function canonical(value: string): string {
  return path.resolve(value).toLowerCase();
}

function fingerprint(stat: fs.Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.birthtimeMs, stat.isDirectory()].join(':');
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`)
    && relative !== '..' && !path.isAbsolute(relative);
}

/** Refuses links in both the scope's ancestor chain and the candidate tree. */
export async function assertPlainPath(target: string, recursive = false): Promise<fs.Stats> {
  const absolute = path.resolve(target);
  let ancestor = absolute;
  while (true) {
    const stat = await fs.promises.lstat(ancestor);
    if (stat.isSymbolicLink()) throw new Error('Linked paths are not eligible for removal');
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const stat = await fs.promises.lstat(absolute);
  if (recursive && stat.isDirectory()) {
    const queue = [absolute];
    while (queue.length) {
      const directory = queue.pop()!;
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        const childStat = await fs.promises.lstat(child);
        if (childStat.isSymbolicLink()) throw new Error('Linked directory contents are not eligible for removal');
        if (childStat.isDirectory()) queue.push(child);
      }
    }
  }
  return stat;
}

/** Scan issues short-lived capabilities; deletion cannot grant itself eligibility. */
export class CleanupService {
  private capabilities = new Map<string, Capability>();
  private references: Pick<CleanupContext, 'activeCoverPaths' | 'activeInstanceIds'> = {};

  constructor(
    private readonly roots: {
      servers: string; covers: string; temporary: string; logs: string;
    },
    private readonly currentContext: () => CleanupContext,
  ) {}

  invalidate(): void {
    this.capabilities.clear();
  }

  private scope(type: GarbageType): string {
    return {
      orphan_instance: this.roots.servers,
      orphan_cover: this.roots.covers,
      temp_file: this.roots.temporary,
      cache: this.roots.logs,
    }[type];
  }

  private context(references: Capability['references']): CleanupContext {
    const current = this.currentContext();
    return {
      ...current,
      activeCoverPaths: references.activeCoverPaths,
      activeInstanceIds: [...(current.activeInstanceIds || []), ...(references.activeInstanceIds || [])],
    };
  }

  private async eligible(item: Pick<GarbageItem, 'path' | 'type'>, context: CleanupContext): Promise<boolean> {
    const root = path.resolve(this.scope(item.type));
    const target = path.resolve(item.path);
    if (!contained(root, target) || path.dirname(target) !== root) return false;
    const targetKey = canonical(target);
    const directoryProtection = [...context.records.map((record) => record.path), ...context.activeDirectories];
    if (directoryProtection.some((directory) => canonical(directory) === targetKey
      || contained(target, path.resolve(directory)))) return false;
    if (context.protectedPaths?.some((entry) => canonical(entry) === targetKey)) return false;
    const stat = await assertPlainPath(target);
    if (item.type === 'orphan_instance') {
      if (!stat.isDirectory()) return false;
      const id = path.basename(target);
      if (context.activeInstanceIds?.includes(id)) return false;
      // Unknown nonempty directories may contain valuable data without package.json.
      // Only a genuinely empty, unregistered managed directory is disposable.
      return (await fs.promises.readdir(target)).length === 0;
    }
    if (!stat.isFile()) return false;
    if (item.type === 'orphan_cover') {
      if (!context.activeCoverPaths) return false;
      const filename = path.basename(target);
      const protectedIds = [...context.records.map((record) => record.instanceId), ...(context.activeInstanceIds || [])];
      if (protectedIds.some((id) => path.basename(filename, path.extname(filename)) === id
        || filename.startsWith(`${id}--cover-`))) return false;
      return !context.activeCoverPaths.some((cover) => canonical(cover) === targetKey);
    }
    if (item.type === 'temp_file') {
      return Date.now() - stat.mtimeMs > 60 * 60 * 1000;
    }
    const logId = path.basename(target).replace(/\.log(?:\.\d+)?$/i, '');
    return !context.activeInstanceIds?.includes(logId)
      && !context.records.some((record) => record.instanceId === logId && record.sessionStartedAt)
      && !context.activeDirectories.some((directory) => path.basename(directory) === logId);
  }

  async scan(options: { activeInstanceIds?: string[]; activeCoverPaths?: string[] } = {}): Promise<{
    items: GarbageItem[]; totalBytes: number;
  }> {
    this.invalidate();
    this.references = {
      activeInstanceIds: Array.isArray(options.activeInstanceIds)
        ? options.activeInstanceIds.filter((id) => typeof id === 'string') : undefined,
      activeCoverPaths: Array.isArray(options.activeCoverPaths)
        && options.activeCoverPaths.every((cover) => typeof cover === 'string' && path.isAbsolute(cover))
        ? [...options.activeCoverPaths] : undefined,
    };
    const context = this.context(this.references);
    const items: GarbageItem[] = [];
    const scopes: [string, GarbageType][] = [
      [this.roots.servers, 'orphan_instance'], [this.roots.covers, 'orphan_cover'],
      [this.roots.temporary, 'temp_file'], [this.roots.logs, 'cache'],
    ];
    for (const [root, type] of scopes) {
      let entries: fs.Dirent[];
      try {
        await assertPlainPath(root);
        entries = await fs.promises.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const target = path.join(root, entry.name);
        const candidate = { path: target, type };
        try {
          if (!(await this.eligible(candidate, context))) continue;
          const stat = await fs.promises.lstat(target);
          const item: GarbageItem = {
            ...candidate,
            sizeBytes: stat.isDirectory() ? await directorySize(target, { includeHeavy: true, fresh: true }) : stat.size,
            description: `${type}: ${entry.name}`,
            token: randomUUID(),
          };
          this.capabilities.set(item.token, {
            item, fingerprint: fingerprint(stat), expires: Date.now() + 5 * 60 * 1000,
            references: { ...this.references },
          });
          items.push(item);
        } catch { /* uncertain candidates are preserved */ }
      }
    }
    return { items, totalBytes: items.reduce((sum, item) => sum + item.sizeBytes, 0) };
  }

  async remove(options: { path?: string; token?: string }): Promise<{ success: boolean; error?: string }> {
    const capability = typeof options.token === 'string' ? this.capabilities.get(options.token) : undefined;
    if (!capability || !options.path || options.path.split(/[\\/]/).includes('..') || capability.expires < Date.now()
      || canonical(options.path) !== canonical(capability.item.path)) {
      return { success: false, error: 'A current eligible scan token is required' };
    }
    this.capabilities.delete(capability.item.token);
    try {
      const context = this.context(capability.references);
      if (!(await this.eligible(capability.item, context))) throw new Error('Item is no longer eligible for removal');
      const stat = await fs.promises.lstat(capability.item.path);
      if (fingerprint(stat) !== capability.fingerprint) throw new Error('Item changed since the scan');
      if (stat.isDirectory()) await fs.promises.rmdir(capability.item.path);
      else await fs.promises.unlink(capability.item.path);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || String(error) };
    }
  }
}
