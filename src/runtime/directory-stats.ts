import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkSignal } from './operations';

const cache = new Map<string, { at: number; value: number }>();
const pending = new Map<string, Promise<number>>();
const MAX_CACHE_ENTRIES = 128;

/** Bounded, asynchronous traversal. Never follow symlinks or Windows junctions. */
export async function directorySize(
  root: string,
  options: { includeHeavy?: boolean; signal?: AbortSignal; fresh?: boolean } = {},
): Promise<number> {
  const key = `${path.resolve(root)}:${Boolean(options.includeHeavy)}`;
  const hit = cache.get(key);
  if (!options.fresh && hit && Date.now() - hit.at < 30000) return hit.value;
  if (!options.signal && pending.has(key)) return pending.get(key)!;
  const compute = async () => {
    let bytes = 0;
    const queue = [root];
    while (queue.length) {
      checkSignal(options.signal);
      const current = queue.pop()!;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(current);
      } catch (error: any) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isSymbolicLink()) continue;
      if (!stat.isDirectory()) {
        bytes += stat.size;
        continue;
      }
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (!options.includeHeavy && ['node_modules', '.git', '.cache'].includes(entry.name)) continue;
        queue.push(path.join(current, entry.name));
      }
    }
    checkSignal(options.signal);
    cache.set(key, { at: Date.now(), value: bytes });
    if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    return bytes;
  };
  const promise = compute();
  if (!options.signal) pending.set(key, promise);
  try {
    return await promise;
  } finally {
    if (pending.get(key) === promise) pending.delete(key);
  }
}

export function invalidateDirectorySize(root: string): void {
  const prefix = `${path.resolve(root)}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
