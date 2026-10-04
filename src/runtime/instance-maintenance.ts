import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPlainPath } from './cleanup';

type Kind = 'download_cache' | 'broken_extension' | 'stale_extension_reference';
type Action = 'delete_cache' | 'quarantine' | 'remove_disabled_reference';

export interface MaintenanceItem {
  id: string; token: string; kind: Kind; relativePath: string; sizeBytes: number;
  description: string; confidence: 'owned' | 'suspected'; defaultSelected: boolean; action: Action;
}
export interface MaintenanceScan {
  instanceId: string; scanId: string; expiresAt: number; items: MaintenanceItem[]; warnings: string[];
}
interface Result {
  id: string; success: boolean; action?: Action; error?: string;
  freedBytes: number; quarantinedBytes: number; recoveryId?: string;
}
export interface MaintenanceRecovery {
  recoveryId: string; token: string; createdAt: number; description: string; relativePath: string;
  kind: Kind; action: Action; sizeBytes: number; canRestore: boolean; conflict?: string;
}
interface Context {
  resolveInstance(instanceId: string): { directory: string; isTakeover?: boolean; shared?: boolean };
  resolveDataRoot(directory: string): Promise<string>;
  isBusy(): boolean;
  commit<T>(work: () => Promise<T>): Promise<T>;
  now?: () => number;
}
interface Snapshot {
  digest: string; sizeBytes: number; identity: string; contentDigest?: string;
  witnesses: { relative: string; fingerprint: string; children?: string[] }[];
}
interface Candidate { item: MaintenanceItem; relative: string; snapshot: Snapshot; reference?: string }
interface Configuration { fingerprint: string; digest: string }
interface ScanPlan {
  scan: MaintenanceScan; directory: string; identity: string;
  configuration: Configuration | null; candidates: Map<string, Candidate>;
}
interface RecoveryRecord {
  revision: 1; instanceId: string; recoveryId: string; state: 'prepared' | 'active' | 'restored';
  createdAt: number; originalRelativePath: string; kind: Kind; action: Action; description: string;
  snapshot: Pick<Snapshot, 'digest' | 'sizeBytes' | 'identity'>;
  originalSnapshot?: Pick<Snapshot, 'digest' | 'sizeBytes' | 'identity'>;
  appliedDigest?: string; originalContentDigest?: string; references?: string[];
}
interface RestorePlan {
  instanceId: string; directory: string; identity: string; recoveryId: string;
  recordDigest: string; payloadDigest: string; expiresAt: number;
  configuration: Configuration | null;
}

const TTL = 5 * 60_000;
const MAX_FILE = 32 * 1024 * 1024;
const MAX_TREE = 256 * 1024 * 1024;
const MAX_ENTRIES = 8192;
const MAX_RECOVERIES = 256;
interface Budget { entries: number; bytes: number; deadline: number }
const budget = (): Budget => ({ entries: 0, bytes: 0, deadline: Date.now() + 30_000 });
function charge(limit: Budget, bytes = 0, entries = 1) {
  if ((limit.entries += entries) > MAX_ENTRIES || (limit.bytes += bytes) > MAX_TREE || Date.now() > limit.deadline) {
    throw new Error('维护扫描超过安全限额，文件已保留');
  }
}
function exhausted(limit: Budget) {
  return limit.entries >= MAX_ENTRIES || limit.bytes >= MAX_TREE || Date.now() > limit.deadline;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAINTENANCE = '.sillyclient-maintenance';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// Windows lstat reports dev=0 while descriptor.stat reports the volume ID.
const identity = (stat: fs.Stats) => [process.platform === 'win32' ? 'win32' : stat.dev,
  stat.ino, stat.birthtimeMs, stat.isDirectory()].join(':');
const fingerprint = (stat: fs.Stats) => [identity(stat), stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const relativeName = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');

function segment(value: string): boolean {
  return !!value && value !== '.' && value !== '..' && !/[\\/:?#\0-\x1f]/.test(value);
}
function resolveRelative(root: string, relative: string): string {
  const parts = relative.split('/');
  if (!parts.every(segment)) throw new Error('Invalid maintenance path');
  const target = path.resolve(root, ...parts);
  const within = path.relative(root, target);
  if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('Maintenance path escapes the instance');
  }
  return target;
}
function authorizedRelative(relative: string, kind: Kind): boolean {
  const parts = relative.split('/');
  if (!parts.every(segment)) return false;
  if (kind === 'download_cache') return parts.length === 3
    && parts[0] === MAINTENANCE && parts[1] === 'download-cache' && UUID.test(parts[2]);
  if (kind === 'stale_extension_reference') return parts.length === 3
    && parts[0] === 'data' && parts[2] === 'settings.json';
  return (parts.length === 5 && parts.slice(0, 4).join('/') === 'public/scripts/extensions/third-party')
    || (parts.length === 4 && parts[0] === 'data' && parts[2] === 'extensions');
}
async function exists(file: string): Promise<boolean> {
  try { await fs.promises.lstat(file); return true; }
  catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}
async function plainEntries(directory: string, limit?: Budget): Promise<fs.Dirent[]> {
  if (!(await exists(directory))) return [];
  const stat = await assertPlainPath(directory);
  if (!stat.isDirectory()) throw new Error('Expected an ordinary directory');
  const entries: fs.Dirent[] = [];
  for await (const entry of await fs.promises.opendir(directory)) {
    if (entries.length >= MAX_ENTRIES) throw new Error('Directory entry limit reached; files were preserved');
    if (limit) charge(limit);
    entries.push(entry);
  }
  return entries;
}
async function readStable(file: string, maximum = MAX_FILE, limit?: Budget) {
  const before = await assertPlainPath(file);
  if (!before.isFile() || before.size > maximum) throw new Error('File cannot be safely inspected');
  if (limit) charge(limit, before.size);
  const descriptor = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fingerprint(await descriptor.stat()) !== fingerprint(before)) throw new Error('File changed during inspection');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await descriptor.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== before.size) throw new Error('File changed during inspection');
    const bytes = buffer.subarray(0, length);
    const after = await descriptor.stat();
    if (fingerprint(before) !== fingerprint(after)
      || fingerprint(await fs.promises.lstat(file)) !== fingerprint(after)) {
      throw new Error('File changed during inspection');
    }
    return { bytes, digest: hash(bytes), stat: after };
  } finally { await descriptor.close(); }
}
async function snapshot(target: string, limit = budget()): Promise<Snapshot> {
  const root = await assertPlainPath(target);
  const digest = createHash('sha256');
  const witnesses: Snapshot['witnesses'] = [];
  let contentDigest: string | undefined;
  let sizeBytes = 0;
  let count = 0;
  const walk = async (file: string, relative: string): Promise<void> => {
    if (++count > MAX_ENTRIES || relative.split('/').length > 33) throw new Error('Inspection entry limit reached; files were preserved');
    charge(limit);
    const stat = await assertPlainPath(file);
    if (relative === '.' && identity(stat) !== identity(root)) throw new Error('Inspection target changed; files were preserved');
    digest.update(JSON.stringify([relative, stat.isDirectory() ? 'directory' : 'file', identity(stat)]));
    if (stat.isDirectory()) {
      const entries = (await plainEntries(file, limit)).sort((a, b) => a.name.localeCompare(b.name));
      witnesses.push({ relative, fingerprint: fingerprint(stat), children: entries.map(entry => entry.name) });
      for (const entry of entries) {
        await walk(path.join(file, entry.name), `${relative}/${entry.name}`);
      }
      if (fingerprint(await fs.promises.lstat(file)) !== fingerprint(stat)) throw new Error('Directory changed during inspection');
    } else {
      const read = await readStable(file, MAX_FILE, limit);
      if (fingerprint(read.stat) !== fingerprint(stat)) throw new Error('File changed during inspection');
      witnesses.push({ relative, fingerprint: fingerprint(read.stat) });
      if (relative === '.') contentDigest = read.digest;
      sizeBytes += read.bytes.length;
      if (sizeBytes > MAX_TREE) throw new Error('Inspection byte limit reached; files were preserved');
      digest.update(read.digest);
    }
  };
  await walk(target, '.');
  return { digest: digest.digest('hex'), sizeBytes, identity: identity(root), contentDigest, witnesses };
}
async function assertSnapshot(target: string, inspected: Snapshot) {
  // Content hashing remains outside the lifecycle queue; publication rechecks every inspected entry.
  await assertPlainPath(target);
  for (let offset = 0; offset < inspected.witnesses.length; offset += 64) {
    await Promise.all(inspected.witnesses.slice(offset, offset + 64).map(async witness => {
      const file = witness.relative === '.' ? target : resolveRelative(target, witness.relative.slice(2));
      const stat = await fs.promises.lstat(file);
      if (stat.isSymbolicLink() || fingerprint(stat) !== witness.fingerprint) throw new Error('项目自扫描后已变化，请重新扫描');
      if (witness.children) {
        const names = (await fs.promises.readdir(file)).sort((a, b) => a.localeCompare(b));
        if (JSON.stringify(names) !== JSON.stringify(witness.children)) throw new Error('目录内容自扫描后已变化');
      }
    }));
  }
  if (fingerprint(await assertPlainPath(target)) !== inspected.witnesses[0].fingerprint) throw new Error('维护目录已变化');
}
function parseJson(bytes: Buffer): any {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('维护文件不是有效 JSON，内容已保留'); }
}
async function configuration(directory: string): Promise<Configuration | null> {
  const file = path.join(directory, 'config.yaml');
  if (!(await exists(file))) return null;
  const read = await readStable(file, 1024 * 1024);
  return { fingerprint: fingerprint(read.stat), digest: read.digest };
}
async function assertConfiguration(directory: string, expected: Configuration | null) {
  if (JSON.stringify(await configuration(directory)) !== JSON.stringify(expected)) {
    throw new Error('实例配置已变化，请重新扫描');
  }
}
async function mkdirPlain(directory: string, root: string) {
  await assertPlainPath(root);
  const parts = path.relative(root, directory).split(path.sep);
  if (!parts.every(segment)) throw new Error('Invalid recovery directory');
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.promises.mkdir(current, { mode: 0o700 }); }
    catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    if (!(await assertPlainPath(current)).isDirectory()) throw new Error('Recovery path is not a directory');
  }
}
async function writeNew(file: string, bytes: Buffer | string) {
  await assertPlainPath(path.dirname(file));
  const descriptor = await fs.promises.open(file, 'wx', 0o600);
  try { await descriptor.writeFile(bytes); await descriptor.sync(); }
  finally { await descriptor.close(); }
}
async function writeRecord(file: string, value: RecoveryRecord) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeNew(temporary, `${JSON.stringify(value)}\n`);
  try {
    if (await exists(file)) await assertPlainPath(file);
    await fs.promises.rename(temporary, file);
  } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
}

/** Content inspection is outside the lifecycle queue; only final publication is serialized. */
export class InstanceMaintenanceService {
  private scans = new Map<string, ScanPlan>();
  private restores = new Map<string, RestorePlan>();
  private requests = new Map<string, string>();
  private generation = 0;
  private now: () => number;

  constructor(private readonly context: Context) {
    this.now = context.now || Date.now;
  }
  invalidate(): void {
    this.generation += 1;
    this.scans.clear();
    this.restores.clear();
    this.requests.clear();
  }
  private assertPlan(instanceId: string, plan: ScanPlan) {
    if (this.scans.get(instanceId) !== plan || plan.scan.expiresAt <= this.now()) {
      throw new Error('维护扫描已失效，请重新扫描');
    }
  }

  private async available(instanceId: string, expected?: { directory: string; identity: string }) {
    if (typeof instanceId !== 'string' || !segment(instanceId) || instanceId.length > 80) throw new Error('Invalid instance identity');
    if (this.context.isBusy()) throw new Error('请先停止实例及正在执行的任务');
    const resolved = this.context.resolveInstance(instanceId);
    if (resolved.isTakeover || resolved.shared) throw new Error('原地接管或共享目录不支持实例维护');
    if (!path.isAbsolute(resolved.directory)) throw new Error('Invalid managed instance directory');
    const directory = path.resolve(resolved.directory);
    const stat = await assertPlainPath(directory);
    if (!stat.isDirectory()) throw new Error('Instance directory is unavailable');
    const id = identity(stat);
    if (expected && (directory !== expected.directory || id !== expected.identity)) throw new Error('Instance changed; scan again');
    return { directory, identity: id };
  }

  private async standardData(directory: string, expected?: Configuration | null) {
    const config = await configuration(directory);
    if (expected !== undefined && JSON.stringify(config) !== JSON.stringify(expected)) throw new Error('实例配置已变化，请重新扫描');
    const data = path.resolve(await this.context.resolveDataRoot(directory));
    if (data !== path.join(directory, 'data')) throw new Error('自定义或未知 dataRoot 不支持实例维护');
    if (await exists(data)) await assertPlainPath(data);
    await assertConfiguration(directory, config);
    return { data, configuration: config };
  }

  async scan(instanceId: string): Promise<MaintenanceScan> {
    this.scans.delete(instanceId);
    const generation = this.generation;
    const request = randomUUID();
    this.requests.set(`scan:${instanceId}`, request);
    const scope = await this.available(instanceId);
    const { data, configuration: config } = await this.standardData(scope.directory);
    const limit = budget();
    const scan: MaintenanceScan = {
      instanceId, scanId: randomUUID(), expiresAt: this.now() + TTL, items: [], warnings: [],
    };
    const candidates = new Map<string, Candidate>();
    const add = async (file: string, kind: Kind, description: string, reference?: string, expectedDigest?: string) => {
      if (scan.items.length >= 256) throw new Error('Maintenance item limit reached');
      const relative = relativeName(scope.directory, file);
      if (!authorizedRelative(relative, kind)) throw new Error('Unsupported maintenance scope');
      const content = await snapshot(file, limit);
      if (expectedDigest && content.contentDigest !== expectedDigest) throw new Error('Settings changed during inspection');
      const item: MaintenanceItem = {
        id: randomUUID(), token: randomUUID(), kind,
        relativePath: reference ? `${relative}#${reference}` : relative,
        description, sizeBytes: content.sizeBytes, confidence: kind === 'download_cache' ? 'owned' : 'suspected',
        defaultSelected: kind === 'download_cache',
        action: kind === 'broken_extension' ? 'quarantine' : kind === 'download_cache' ? 'delete_cache' : 'remove_disabled_reference',
      };
      scan.items.push(item);
      candidates.set(item.id, { item, relative, snapshot: content, reference });
    };
    const inspectExtensions = async (root: string) => {
      for (const entry of await plainEntries(root, limit)) {
        if (!entry.isDirectory() || !segment(entry.name)) continue;
        const extension = path.join(root, entry.name);
        try {
          const manifestFile = path.join(extension, 'manifest.json');
          let reason: string | null = null;
          if (!(await exists(manifestFile))) reason = '缺少 manifest.json';
          else {
            try {
              const manifest = parseJson((await readStable(manifestFile, 1024 * 1024, limit)).bytes);
              if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) reason = 'manifest.json 无效';
              else {
                for (const key of ['js', 'css']) {
                  if (manifest[key] === undefined || manifest[key] === null || manifest[key] === '') continue;
                  if (typeof manifest[key] !== 'string') { reason = '入口声明无效'; break; }
                  const asset = resolveRelative(extension, manifest[key].replace(/\\/g, '/').replace(/^\.\//, ''));
                  const stat = await assertPlainPath(asset);
                  if (!stat.isFile() || stat.size === 0) { reason = '入口文件缺失或为空'; break; }
                }
              }
            } catch { reason = 'manifest.json 或入口文件无法校验'; }
          }
          if (reason) await add(extension, 'broken_extension', `${entry.name} · ${reason}`);
        } catch { scan.warnings.push(`${relativeName(scope.directory, extension)} 无法安全扫描，已保留`); }
      }
    };
    const globalRoot = path.join(scope.directory, 'public', 'scripts', 'extensions', 'third-party');
    await inspectExtensions(globalRoot);
    for (const user of await plainEntries(data, limit)) {
      if (!user.isDirectory() || !segment(user.name) || user.name.startsWith('.') || user.name === '_storage') continue;
      const userRoot = path.join(data, user.name);
      const extensions = path.join(userRoot, 'extensions');
      await inspectExtensions(extensions);
      const settings = path.join(userRoot, 'settings.json');
      if (!(await exists(settings))) continue;
      try {
        const original = await readStable(settings, 2 * 1024 * 1024, limit);
        const parsed = parseJson(original.bytes);
        const disabled = parsed?.extension_settings?.disabledExtensions;
        if (!Array.isArray(disabled)) continue;
        for (const reference of [...new Set(disabled)]) {
          if (typeof reference !== 'string' || !reference.startsWith('third-party/')) continue;
          const name = reference.slice('third-party/'.length);
          if (!segment(name) || await exists(path.join(extensions, name)) || await exists(path.join(globalRoot, name))) continue;
          await add(settings, 'stale_extension_reference', `${name} · 无对应目录的禁用记录`, reference, original.digest);
        }
      } catch { scan.warnings.push(`${relativeName(scope.directory, settings)} 无法安全读取，已保留`); }
    }
    const cacheRoot = path.join(scope.directory, MAINTENANCE, 'download-cache');
    for (const entry of await plainEntries(cacheRoot, limit)) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const cache = path.join(cacheRoot, entry.name);
      try {
        const names = (await plainEntries(cache, limit)).map((file) => file.name).sort();
        if (names.join('\n') !== 'download.zip\nowner.json') continue;
        const marker = await readStable(path.join(cache, 'owner.json'), 8192, limit);
        const owner = parseJson(marker.bytes);
        const payload = await readStable(path.join(cache, 'download.zip'), MAX_FILE, limit);
        const cacheStat = await assertPlainPath(cache);
        if (owner.revision !== 1 || owner.owner !== 'sillyclient' || owner.instanceId !== instanceId
          || owner.payload !== 'download.zip' || owner.sha256 !== payload.digest || owner.sizeBytes !== payload.bytes.length) continue;
        await add(cache, 'download_cache', '已核验的下载缓存');
      } catch { scan.warnings.push(`${relativeName(scope.directory, cache)} 归属无法校验，已保留`); }
    }
    await this.available(instanceId, scope);
    await assertConfiguration(scope.directory, config);
    if (generation !== this.generation || this.requests.get(`scan:${instanceId}`) !== request) {
      throw new Error('维护扫描已失效，请重新扫描');
    }
    scan.expiresAt = this.now() + TTL;
    this.scans.set(instanceId, { scan, ...scope, configuration: config, candidates });
    return scan;
  }

  private async recoveryFolder(instanceId: string, scope: { directory: string; identity: string }, candidate: Candidate) {
    const recoveryId = randomUUID();
    const folder = path.join(scope.directory, MAINTENANCE, 'recovery', recoveryId);
    await mkdirPlain(folder, scope.directory);
    const record: RecoveryRecord = {
      revision: 1, instanceId, recoveryId, state: 'prepared', createdAt: this.now(),
      originalRelativePath: candidate.relative, kind: candidate.item.kind, action: candidate.item.action,
      description: candidate.item.description, snapshot: {
        digest: candidate.snapshot.digest, sizeBytes: candidate.snapshot.sizeBytes, identity: candidate.snapshot.identity,
      },
    };
    return { folder, record };
  }

  async apply(instanceId: string, scanId: string, selections: { id: string; token: string }[]) {
    const plan = this.scans.get(instanceId);
    if (!plan || plan.scan.scanId !== scanId || plan.scan.expiresAt <= this.now()) throw new Error('维护扫描已过期，请重新扫描');
    if (!Array.isArray(selections) || selections.length > 256) throw new Error('Invalid maintenance selection');
    const chosen: Candidate[] = [];
    const results: Result[] = [];
    const seen = new Set<string>();
    for (const selection of selections) {
      const candidate = plan.candidates.get(selection?.id);
      if (!candidate || candidate.item.token !== selection.token || seen.has(selection.id)) {
        throw new Error('Invalid or already consumed maintenance token');
      }
      seen.add(selection.id);
      chosen.push(candidate);
    }
    // Consume before the first await so concurrent requests cannot replay the same capability.
    chosen.forEach((candidate) => plan.candidates.delete(candidate.item.id));
    await this.available(instanceId, plan);
    await this.standardData(plan.directory, plan.configuration);
    this.assertPlan(instanceId, plan);
    const groups = new Map<string, Candidate[]>();
    chosen.forEach((candidate) => {
      const key = candidate.reference ? candidate.relative : candidate.item.id;
      groups.set(key, [...(groups.get(key) || []), candidate]);
    });
    const limit = budget();
    const inspected = new Map<string, Snapshot>();
    // Preflight the whole selection before publishing any item.
    for (const [key, group] of groups) {
      const current = await snapshot(resolveRelative(plan.directory, group[0].relative), limit);
      if (group.some(item => item.snapshot.digest !== current.digest)) {
        throw new Error('项目自扫描后已变化，请重新扫描');
      }
      inspected.set(key, current);
    }
    const publicationLimit = budget();
    for (const [key, group] of groups) {
      const candidate = group[0];
      let recoveryId: string | undefined;
      let quarantinedBytes = 0;
      try {
        this.assertPlan(instanceId, plan);
        await this.available(instanceId, plan);
        await assertConfiguration(plan.directory, plan.configuration);
        const target = resolveRelative(plan.directory, candidate.relative);
        const current = inspected.get(key)!;
        const { folder, record } = await this.recoveryFolder(instanceId, plan, candidate);
        const recordFile = path.join(folder, 'record.json');
        const payload = path.join(folder, 'payload');
        if (candidate.reference) {
          const original = await readStable(target, 2 * 1024 * 1024);
          if (original.digest !== current.contentDigest) throw new Error('设置文件自扫描后已变化');
          const settings = parseJson(original.bytes);
          const disabled = settings?.extension_settings?.disabledExtensions;
          if (!Array.isArray(disabled)) throw new Error('禁用记录已变化');
          const references = group.map((item) => item.reference!);
          if (!references.every((value) => disabled.includes(value))) throw new Error('禁用记录已变化');
          for (const reference of references) {
            const name = reference.slice('third-party/'.length);
            if (await exists(path.join(path.dirname(target), 'extensions', name))
              || await exists(path.join(plan.directory, 'public', 'scripts', 'extensions', 'third-party', name))) {
              throw new Error('对应扩展已安装，请重新扫描');
            }
          }
          settings.extension_settings.disabledExtensions = disabled.filter((value: unknown) => !references.includes(value as string));
          const output = `${JSON.stringify(settings, null, 2)}\n`;
          record.references = references;
          record.appliedDigest = hash(output);
          record.originalContentDigest = original.digest;
          await writeNew(payload, original.bytes);
          await writeRecord(recordFile, record);
          const temporary = `${target}.maintenance-${randomUUID()}.tmp`;
          await writeNew(temporary, output);
          try {
            await this.context.commit(async () => {
              this.assertPlan(instanceId, plan);
              await this.available(instanceId, plan);
              await assertConfiguration(plan.directory, plan.configuration);
              await assertSnapshot(target, current);
              for (const reference of references) {
                const name = reference.slice('third-party/'.length);
                if (await exists(path.join(path.dirname(target), 'extensions', name))
                  || await exists(path.join(plan.directory, 'public', 'scripts', 'extensions', 'third-party', name))) {
                  throw new Error('对应扩展已安装，请重新扫描');
                }
              }
              await fs.promises.rename(temporary, target);
            });
          } finally { await fs.promises.unlink(temporary).catch(() => undefined); }
        } else {
          await writeRecord(recordFile, record);
          await this.context.commit(async () => {
            this.assertPlan(instanceId, plan);
            await this.available(instanceId, plan);
            await assertConfiguration(plan.directory, plan.configuration);
            await assertSnapshot(target, current);
            await assertPlainPath(folder);
            if (await exists(payload)) throw new Error('Recovery destination already exists');
            await fs.promises.rename(target, payload);
          });
          recoveryId = record.recoveryId;
          // A file can change after its metadata check but before the directory rename.
          const published = await snapshot(payload, publicationLimit);
          if (published.identity !== current.identity) throw new Error('隔离目录身份已变化，文件已保留且暂不可恢复');
          quarantinedBytes = published.sizeBytes;
          if (published.digest !== current.digest) record.originalSnapshot = record.snapshot;
          record.snapshot = { digest: published.digest, sizeBytes: published.sizeBytes, identity: published.identity };
          if (published.digest !== current.digest) {
            record.state = 'active';
            await writeRecord(recordFile, record);
            throw new Error('隔离期间项目已变化，文件已保留在恢复记录');
          }
        }
        record.state = 'active';
        // A prepared record with a published payload is recoverable after interrupted finalization.
        await writeRecord(recordFile, record).catch(() => undefined);
        group.forEach((item, index) => results.push({
          id: item.item.id, action: item.item.action, success: true, freedBytes: 0,
          quarantinedBytes: index === 0 && !candidate.reference ? quarantinedBytes : 0, recoveryId: record.recoveryId,
        }));
      } catch (error: any) {
        group.forEach((item, index) => results.push({
          id: item.item.id, action: item.item.action, success: false, error: error.message || String(error),
          freedBytes: 0, quarantinedBytes: index === 0 ? quarantinedBytes : 0,
          ...(recoveryId ? { recoveryId } : {}),
        }));
      }
    }
    return {
      success: results.every((result) => result.success), results, freedBytes: 0,
      quarantinedBytes: results.reduce((sum, result) => sum + result.quarantinedBytes, 0),
      recoveryIds: [...new Set(results.flatMap((result) => result.recoveryId ? [result.recoveryId] : []))],
    };
  }

  private async recoveryRecord(instanceId: string, directory: string, recoveryId: string, limit?: Budget) {
    if (!UUID.test(recoveryId)) throw new Error('Invalid recovery identity');
    const folder = path.join(directory, MAINTENANCE, 'recovery', recoveryId);
    const read = await readStable(path.join(folder, 'record.json'), 64 * 1024);
    if (limit) charge(limit, read.bytes.length, 0);
    const record = parseJson(read.bytes) as RecoveryRecord;
    if (record.revision !== 1 || record.instanceId !== instanceId || record.recoveryId !== recoveryId
      || !['prepared', 'active', 'restored'].includes(record.state)
      || !['download_cache', 'broken_extension', 'stale_extension_reference'].includes(record.kind)
      || !authorizedRelative(record.originalRelativePath, record.kind) || !/^[a-f0-9]{64}$/.test(record.snapshot?.digest)
      || !Number.isFinite(record.createdAt) || !Number.isSafeInteger(record.snapshot?.sizeBytes)
      || record.snapshot.sizeBytes < 0 || typeof record.description !== 'string'
      || record.action !== (record.kind === 'broken_extension' ? 'quarantine'
        : record.kind === 'download_cache' ? 'delete_cache' : 'remove_disabled_reference')) {
      throw new Error('Invalid recovery record');
    }
    return { folder, record, recordDigest: read.digest };
  }

  private async archiveRestored(instanceId: string, scope: { directory: string; identity: string },
    record: RecoveryRecord, recordDigest: string, config: Configuration | null, generation: number) {
    const source = path.join(scope.directory, MAINTENANCE, 'recovery', record.recoveryId);
    const history = path.join(scope.directory, MAINTENANCE, 'recovery-history');
    await mkdirPlain(history, scope.directory);
    const target = path.join(history, record.recoveryId);
    await this.context.commit(async () => {
      if (generation !== this.generation) throw new Error('恢复记录已失效，请刷新');
      await this.available(instanceId, scope);
      await assertConfiguration(scope.directory, config);
      await assertPlainPath(source);
      await assertPlainPath(history);
      const current = await this.recoveryRecord(instanceId, scope.directory, record.recoveryId);
      if (current.record.state !== 'restored' || current.recordDigest !== recordDigest) throw new Error('恢复记录已变化');
      if (await exists(target)) throw new Error('恢复历史归档已存在，文件已保留');
      await fs.promises.rename(source, target);
    });
  }

  private async restoreConflict(directory: string, folder: string, record: RecoveryRecord,
    limit?: Budget): Promise<string | undefined> {
    if (record.state === 'restored') return '已恢复';
    const target = resolveRelative(directory, record.originalRelativePath);
    const payload = path.join(folder, 'payload');
    if (!(await exists(payload))) return '隔离文件不可用';
    if (record.kind === 'stale_extension_reference') {
      if (!record.appliedDigest || !(await exists(target))) return '设置文件不可用';
      if ((await readStable(target, 2 * 1024 * 1024, limit)).digest !== record.appliedDigest) return '设置已修改，不能覆盖';
    } else if (await exists(target)) return '同名目录已存在，不能覆盖';
    return undefined;
  }

  async listRecovery(instanceId: string): Promise<{ items: MaintenanceRecovery[]; warnings: string[] }> {
    const generation = this.generation;
    const request = randomUUID();
    this.requests.set(`recovery:${instanceId}`, request);
    const scope = await this.available(instanceId);
    const { configuration: config } = await this.standardData(scope.directory);
    const limit = budget();
    for (const [token, plan] of this.restores) if (plan.instanceId === instanceId || plan.expiresAt <= this.now()) this.restores.delete(token);
    const items: MaintenanceRecovery[] = [];
    const tokens = new Map<string, RestorePlan>();
    const warnings: string[] = [];
    const recovery = path.join(scope.directory, MAINTENANCE, 'recovery');
    async function* entries() {
      if (!(await exists(recovery))) return;
      if (!(await assertPlainPath(recovery)).isDirectory()) throw new Error('恢复目录不可用');
      for await (const entry of await fs.promises.opendir(recovery)) yield entry;
    }
    for await (const entry of entries()) {
      if (items.length >= MAX_RECOVERIES || exhausted(limit)) {
        warnings.push('恢复记录达到本次安全限额，未列出的文件已保留，请刷新后继续');
        break;
      }
      if (!entry.isDirectory() || !UUID.test(entry.name)) { charge(limit); continue; }
      try {
        const { folder, record, recordDigest } = await this.recoveryRecord(instanceId, scope.directory, entry.name, limit);
        if (record.state === 'restored') {
          await this.archiveRestored(instanceId, scope, record, recordDigest, config, generation);
          continue;
        }
        if (record.state === 'prepared' && !(await exists(path.join(folder, 'payload')))) {
          warnings.push(`${entry.name} 准备记录没有隔离文件，元数据已保留`);
          continue;
        }
        charge(limit);
        let conflict = await this.restoreConflict(scope.directory, folder, record, limit);
        const payload = path.join(folder, 'payload');
        let content: Snapshot | undefined;
        if (await exists(payload)) {
          try { content = await snapshot(payload, limit); } catch { conflict = '隔离内容无法安全校验'; }
        }
        if (content && record.kind !== 'stale_extension_reference' && content.digest !== record.snapshot.digest) conflict = '隔离内容已变化';
        if (record.kind === 'stale_extension_reference'
          && (!record.references || !Array.isArray(record.references))) conflict = '恢复记录不完整';
        if (content && record.kind === 'stale_extension_reference'
          && content.contentDigest !== record.originalContentDigest) {
          conflict = '设置备份已变化';
        }
        const token = randomUUID();
        if (!conflict && content) tokens.set(token, {
          instanceId, ...scope, recoveryId: record.recoveryId, recordDigest,
          configuration: config,
          payloadDigest: content.digest, expiresAt: this.now() + TTL,
        });
        items.push({
          recoveryId: record.recoveryId, token: conflict ? '' : token, createdAt: record.createdAt,
          description: record.description, relativePath: record.originalRelativePath,
          kind: record.kind, action: record.action, sizeBytes: record.snapshot.sizeBytes,
          canRestore: !conflict, ...(conflict ? { conflict } : {}),
        });
      } catch {
        limit.entries += 1;
        warnings.push(`${entry.name} 恢复记录无法安全校验，已保留`);
      }
    }
    await this.available(instanceId, scope);
    await assertConfiguration(scope.directory, config);
    if (generation !== this.generation || this.requests.get(`recovery:${instanceId}`) !== request) {
      throw new Error('恢复记录已失效，请刷新');
    }
    for (const [token, plan] of this.restores) if (plan.instanceId === instanceId) this.restores.delete(token);
    for (const [token, plan] of tokens) this.restores.set(token, plan);
    return { items: items.sort((a, b) => b.createdAt - a.createdAt), warnings };
  }

  async restore(instanceId: string, recoveryId: string, token: string) {
    const plan = typeof token === 'string' ? this.restores.get(token) : undefined;
    if (!plan || plan.instanceId !== instanceId || plan.recoveryId !== recoveryId || plan.expiresAt <= this.now()) {
      return { success: false, error: '恢复令牌已过期，请刷新恢复记录' };
    }
    this.restores.delete(token);
    const generation = this.generation;
    try {
      await this.available(instanceId, plan);
      await this.standardData(plan.directory, plan.configuration);
      const { folder, record, recordDigest } = await this.recoveryRecord(instanceId, plan.directory, recoveryId);
      if (recordDigest !== plan.recordDigest) throw new Error('恢复记录已变化');
      const conflict = await this.restoreConflict(plan.directory, folder, record);
      if (conflict) throw new Error(conflict);
      const payload = path.join(folder, 'payload');
      const inspected = await snapshot(payload);
      if (inspected.digest !== plan.payloadDigest) throw new Error('隔离内容已变化');
      const target = resolveRelative(plan.directory, record.originalRelativePath);
      let temporary: string | undefined;
      let original: Awaited<ReturnType<typeof readStable>> | undefined;
      if (record.kind === 'stale_extension_reference') {
        original = await readStable(target, 2 * 1024 * 1024);
        if (original.digest !== record.appliedDigest) throw new Error('设置已修改，不能覆盖');
        temporary = `${target}.maintenance-${randomUUID()}.tmp`;
        await writeNew(temporary, (await readStable(payload, 2 * 1024 * 1024)).bytes);
      }
      try {
        await this.context.commit(async () => {
          if (generation !== this.generation || plan.expiresAt <= this.now()) throw new Error('恢复令牌已失效，请刷新');
          await this.available(instanceId, plan);
          await assertConfiguration(plan.directory, plan.configuration);
          await assertPlainPath(path.dirname(target));
          if ((await readStable(path.join(folder, 'record.json'), 64 * 1024)).digest !== plan.recordDigest) {
            throw new Error('恢复记录已变化');
          }
          await assertSnapshot(payload, inspected);
          if (original) {
            const latest = await readStable(target, 2 * 1024 * 1024);
            if (fingerprint(latest.stat) !== fingerprint(original.stat) || latest.digest !== record.appliedDigest) {
              throw new Error('设置已修改，不能覆盖');
            }
          } else if (await exists(target)) throw new Error('同名目录已存在，不能覆盖');
          await fs.promises.rename(temporary || payload, target);
        });
      } finally { if (temporary) await fs.promises.unlink(temporary).catch(() => undefined); }
      record.state = 'restored';
      try {
        await writeRecord(path.join(folder, 'record.json'), record);
        const current = await this.recoveryRecord(instanceId, plan.directory, recoveryId);
        await this.archiveRestored(instanceId, plan, record, current.recordDigest, plan.configuration, generation);
      } catch { /* Restored content remains in place if history archival is unavailable. */ }
      return { success: true, recoveryId, relativePath: record.originalRelativePath };
    } catch (error: any) { return { success: false, error: error.message || String(error) }; }
  }
}
