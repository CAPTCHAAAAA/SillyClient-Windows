import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { parseDocument } from 'yaml';

const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_DEPTH = 64;
const COPY_BUFFER_BYTES = 1024 * 1024;
const OWNER_FILE = '.sillyclient-migration-incomplete';
const REPORT_FILE = 'migration-report.json';
const PROFILE_MARKERS = ['settings.json', 'characters', 'chats', 'worlds', 'groups'];

export class MigrationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

export interface InspectMigrationOptions {
  dataRoot?: string;
  allowExternalData?: boolean;
  includeSecrets?: boolean;
  includeExtensions?: boolean;
  signal?: AbortSignal;
}

export interface MigrationFile {
  relativePath: string;
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  dev: number;
}

export interface MigrationPlan {
  sourceRoot: string;
  dataRoot: string;
  sourceVersion: string;
  externalDataRoot: boolean;
  includeSecrets: boolean;
  users: string[];
  directories: string[];
  files: MigrationFile[];
  totalBytes: number;
  metadataFingerprint: string;
  excluded: { relativePath: string; reason: string }[];
  warnings: string[];
  compatibility?: import('./plugin-compatibility').PluginCompatibilityReport;
  isZipSource?: boolean;
  zipCleanup?: () => Promise<void>;
}


export interface MigrationProgress {
  phase: 'copying' | 'verifying' | 'complete';
  completedFiles: number;
  totalFiles: number;
  copiedBytes: number;
  totalBytes: number;
}

export interface CopyMigrationOptions extends InspectMigrationOptions {
  sourceStopped: boolean;
  onProgress?: (progress: MigrationProgress) => void;
}

interface VerifiedFile {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface MigrationResult {
  status: 'verified-data-copy';
  destination: string;
  sourceVersion: string;
  filesCopied: number;
  bytesCopied: number;
  sourceModified: false;
  registeredAsInstance: false;
  reportPath: string;
}

function fail(code: string, message: string): never {
  throw new MigrationError(code, message);
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Migration was cancelled.');
}

function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..'
    && !relative.startsWith(`..${path.sep}`));
}

function overlap(a: string, b: string): boolean {
  return within(a, b) || within(b, a);
}

async function optionalStat(file: string) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// Reject junctions and symlinks before reading or creating anything through them.
async function plainPath(input: string, kind: 'directory' | 'file'): Promise<string> {
  const absolute = path.resolve(input);
  if (absolute.startsWith('\\\\')) fail('NETWORK_PATH', 'Network paths are not supported by this prototype.');
  const root = path.parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) fail('LINK_NOT_SUPPORTED', 'Symlinks and junctions require manual review.');
    const isLast = index === parts.length - 1;
    if (!isLast && !stat.isDirectory()) fail('INVALID_PATH', 'A parent path is not a directory.');
    if (isLast && (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      fail('INVALID_PATH', `Expected a regular ${kind}.`);
    }
  }
  return await fs.realpath(absolute);
}

export async function validateMigrationDirectory(directory: string): Promise<string> {
  return plainPath(directory, 'directory');
}

async function readMetadata(file: string): Promise<string> {
  await plainPath(file, 'file');
  const stat = await fs.stat(file);
  if (stat.size > MAX_METADATA_BYTES) fail('METADATA_TOO_LARGE', 'Metadata exceeds the supported size.');
  return await fs.readFile(file, 'utf8');
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch { /* Do not include metadata contents in errors. */ }
  return fail('INVALID_METADATA', 'Expected valid JSON object metadata.');
}

function readConfiguredDataRoot(text: string): string | undefined {
  try {
    const document = parseDocument(text, { strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mapping');
    const dataRoot = (value as Record<string, unknown>).dataRoot;
    if (dataRoot === undefined) return undefined;
    if (typeof dataRoot !== 'string' || !dataRoot.trim() || dataRoot.includes('\0')) {
      throw new Error('Invalid dataRoot');
    }
    return dataRoot;
  } catch {
    return fail('INVALID_CONFIG', 'config.yaml is invalid or uses unsupported YAML features; its contents were not logged.');
  }
}

function exclusion(relativePath: string, directory: boolean, includeSecrets: boolean, includeExtensions: boolean): string | undefined {
  const parts = relativePath.split('/');
  const name = parts.at(-1)!.toLowerCase();
  if (name === '.git' || (directory && name === 'node_modules')) return 'runtime-or-repository';
  if (directory && name === 'extensions' && parts.length <= 2 && !includeExtensions) return 'extension-code';
  if (!directory && name === 'secrets.json' && !includeSecrets) return 'credentials-not-authorized';
  return undefined;
}

function portableName(name: string): void {
  if (/[<>:"\\|?*\u0000-\u001F]/.test(name) || /[. ]$/.test(name)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    fail('UNSAFE_FILENAME', 'A filename is not safe for a Windows destination.');
  }
}

export async function inspectMigrationSource(
  source: string,
  options: InspectMigrationOptions = {},
): Promise<MigrationPlan> {
  checkCancelled(options.signal);
  const sourceRoot = await plainPath(source, 'directory');
  const packageText = await readMetadata(path.join(sourceRoot, 'package.json'));
  const pkg = jsonObject(packageText);
  if (typeof pkg.name !== 'string' || pkg.name.toLowerCase() !== 'sillytavern') {
    fail('NOT_SILLYTAVERN', 'The selected folder is not a recognized SillyTavern installation.');
  }
  const match = typeof pkg.version === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(pkg.version);
  if (!match || Number(match[1]) !== 1 || Number(match[2]) < 12) {
    fail('UNSUPPORTED_VERSION', 'This prototype requires the SillyTavern 1.12+ data layout; legacy or unknown major versions need review.');
  }
  await plainPath(path.join(sourceRoot, 'server.js'), 'file');
  const configPath = path.join(sourceRoot, 'config.yaml');
  const configText = await optionalStat(configPath) ? await readMetadata(configPath) : '';
  const configuredRoot = configText.trim() ? readConfiguredDataRoot(configText) : undefined;
  const requestedRoot = path.resolve(sourceRoot, options.dataRoot ?? configuredRoot ?? 'data');
  const externalDataRoot = !within(sourceRoot, requestedRoot);
  if (externalDataRoot && !options.allowExternalData) {
    fail('EXTERNAL_DATA_ROOT', 'The data directory is outside the selected installation. Explicit external-data consent is required.');
  }
  const dataRoot = await plainPath(requestedRoot, 'directory');
  if (dataRoot === sourceRoot || within(dataRoot, sourceRoot)) {
    fail('INVALID_DATA_ROOT', 'The data directory cannot contain the installation root.');
  }
  const files: MigrationFile[] = [];
  const directories: string[] = [];
  const excluded: MigrationPlan['excluded'] = [];
  let totalBytes = 0;
  let entryCount = 0;

  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    checkCancelled(options.signal);
    if (depth > MAX_DEPTH) fail('SCAN_LIMIT', 'Directory nesting exceeds the supported limit.');
    await plainPath(directory, 'directory');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const foldedNames = new Set<string>();
    for (const entry of entries) {
      checkCancelled(options.signal);
      if (++entryCount > MAX_FILES) fail('SCAN_LIMIT', 'The data tree exceeds the supported entry count.');
      portableName(entry.name);
      const folded = entry.name.toLowerCase();
      if (foldedNames.has(folded)) fail('NAME_COLLISION', 'Names collide on a case-insensitive Windows filesystem.');
      foldedNames.add(folded);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) fail('LINK_NOT_SUPPORTED', 'The data tree contains a symlink or junction.');
      if (!stat.isFile() && !stat.isDirectory()) fail('SPECIAL_FILE', 'Only regular files and directories can be migrated.');
      const reason = exclusion(relativePath, stat.isDirectory(), Boolean(options.includeSecrets), Boolean(options.includeExtensions));
      if (reason) {
        excluded.push({ relativePath, reason });
        continue;
      }
      if (stat.isDirectory()) {
        directories.push(relativePath);
        await walk(absolute, relativePath, depth + 1);
      } else {
        if (!Number.isSafeInteger(stat.size) || !Number.isSafeInteger(totalBytes + stat.size)) {
          fail('SIZE_LIMIT', 'The data size cannot be represented safely.');
        }
        totalBytes += stat.size;
        files.push({ relativePath, bytes: stat.size, mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
      }
    }
  }
  await walk(dataRoot, '', 0);
  const users = directories.filter(relative => !relative.includes('/') && PROFILE_MARKERS.some(marker =>
    files.some(file => file.relativePath === `${relative}/${marker}`)
      || directories.includes(`${relative}/${marker}`)));
  if (!users.length) fail('NO_USER_DATA', 'No supported user data was found. Select the installation folder, not an arbitrary backup.');
  if (!files.length) fail('NO_USER_DATA', 'The selected data tree contains no files to migrate.');
  const warnings = [
    'This is a data copy, not an installed or registered instance. Matching-version startup has not been validated.',
    'The source must be stopped. Live writes cannot be made atomic by this tool.',
    'Excluding secrets.json is not anonymization: chats, settings and account records can still contain sensitive information.',
    'Command-line dataRoot overrides cannot be inferred. Supply --data-root if the old launcher used one.',
  ];
  if (await optionalStat(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'))) {
    warnings.push('Global third-party extensions are outside this copy and require a separate compatibility review.');
  }
  return {
    sourceRoot, dataRoot, sourceVersion: String(pkg.version), externalDataRoot,
    includeSecrets: Boolean(options.includeSecrets), users, directories, files, totalBytes,
    metadataFingerprint: createHash('sha256').update(packageText).update('\0').update(configText).digest('hex'),
    excluded, warnings,
  };
}

function sameFile(
  stat: Awaited<ReturnType<typeof fs.stat>>, expected: MigrationFile, fromHandle = false,
): boolean {
  // Bundled Node on Windows reports dev=0 for path stats but a volume ID for fstat.
  const comparableDevice = process.platform === 'win32' && fromHandle && expected.dev === 0;
  return stat.isFile() && stat.size === expected.bytes && stat.mtimeMs === expected.mtimeMs
    && stat.ctimeMs === expected.ctimeMs && stat.ino === expected.ino
    && (comparableDevice || stat.dev === expected.dev);
}

async function hashRegularFile(file: string, signal?: AbortSignal): Promise<string> {
  await plainPath(file, 'file');
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytesHashed = 0;
    while (true) {
      checkCancelled(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytesHashed += bytesRead;
      if (bytesHashed > before.size) fail('SOURCE_CHANGED', 'A file grew while it was being verified.');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail('SOURCE_CHANGED', 'A file changed while it was being verified.');
    }
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function copyVerifiedFile(
  source: string, destination: string, expected: MigrationFile, signal?: AbortSignal,
): Promise<string> {
  await plainPath(source, 'file');
  await plainPath(path.dirname(destination), 'directory');
  const input = await fs.open(source, 'r');
  let output: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    if (!sameFile(await input.stat(), expected, true)) fail('SOURCE_CHANGED', 'A source file changed after inspection.');
    output = await fs.open(destination, 'wx', 0o600);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let copied = 0;
    while (true) {
      checkCancelled(signal);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      if (copied + bytesRead > expected.bytes) fail('SOURCE_CHANGED', 'A source file grew during copying.');
      let written = 0;
      while (written < bytesRead) {
        checkCancelled(signal);
        const result = await output.write(buffer, written, bytesRead - written, null);
        if (!result.bytesWritten) fail('COPY_FAILED', 'The destination stopped accepting data.');
        written += result.bytesWritten;
      }
      hash.update(buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    if (copied !== expected.bytes || !sameFile(await input.stat(), expected, true)
        || !sameFile(await fs.lstat(source), expected)) {
      fail('SOURCE_CHANGED', 'A source file changed during copying.');
    }
    await output.sync();
    await output.close();
    output = undefined;
    const digest = hash.digest('hex');
    if (await hashRegularFile(destination, signal) !== digest) {
      fail('VERIFY_FAILED', 'Destination checksum verification failed.');
    }
    return digest;
  } finally {
    await input.close();
    await output?.close();
  }
}

function fingerprint(plan: MigrationPlan): string {
  return JSON.stringify({
    dataRoot: plan.dataRoot, metadata: plan.metadataFingerprint,
    directories: plan.directories, files: plan.files, excluded: plan.excluded,
  });
}

async function verifyDestinationTree(targetData: string, plan: MigrationPlan, signal?: AbortSignal): Promise<void> {
  const directories = new Set(plan.directories);
  const files = new Set(plan.files.map(file => file.relativePath));
  async function walk(directory: string, relative: string): Promise<void> {
    checkCancelled(signal);
    await plainPath(directory, 'directory');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      checkCancelled(signal);
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink() && directories.delete(relativePath)) {
        await walk(absolute, relativePath);
      } else if (!stat.isFile() || stat.isSymbolicLink() || !files.delete(relativePath)) {
        fail('VERIFY_FAILED', 'The destination contains unexpected files, directories or links.');
      }
    }
  }
  await walk(targetData, '');
  if (directories.size || files.size) fail('VERIFY_FAILED', 'The destination is missing expected data.');
}

export async function copyMigrationData(
  source: string, destinationInput: string, options: CopyMigrationOptions,
): Promise<MigrationResult> {
  if (!options.sourceStopped) fail('SOURCE_STOP_REQUIRED', 'Confirm that the source SillyTavern is stopped before copying.');
  checkCancelled(options.signal);
  const plan = await inspectMigrationSource(source, options);
  const destination = path.resolve(destinationInput);
  portableName(path.basename(destination));
  const parent = await plainPath(path.dirname(destination), 'directory');
  if (path.dirname(destination).toLowerCase() !== parent.toLowerCase()) {
    fail('INVALID_DESTINATION', 'The destination parent is not a direct local directory.');
  }
  if (overlap(plan.sourceRoot, destination) || overlap(plan.dataRoot, destination)) {
    fail('OVERLAPPING_PATHS', 'Source and destination directories must not overlap.');
  }
  if (await optionalStat(destination)) fail('DESTINATION_EXISTS', 'The destination must not exist; existing folders are never overwritten.');
  const space = await fs.statfs(parent, { bigint: true });
  const requiredBytes = BigInt(plan.totalBytes) + BigInt(Math.max(16 * 1024 * 1024, Math.ceil(plan.totalBytes * 0.05)));
  if (space.bavail * space.bsize < requiredBytes) fail('INSUFFICIENT_SPACE', 'Not enough free space for the data copy and safety margin.');
  const owner = randomUUID();
  let created = false;
  let ownedInode: number | undefined;
  let copiedBytes = 0;
  const verified: VerifiedFile[] = [];
  const emit = (phase: MigrationProgress['phase']) => options.onProgress?.({
    phase, completedFiles: verified.length, totalFiles: plan.files.length,
    copiedBytes, totalBytes: plan.totalBytes,
  });
  const assertOwnedDestination = async () => {
    await plainPath(destination, 'directory');
    const stat = await fs.lstat(destination);
    const marker = path.join(destination, OWNER_FILE);
    await plainPath(marker, 'file');
    if (stat.ino !== ownedInode || (await fs.lstat(marker)).size !== owner.length
        || await fs.readFile(marker, 'utf8') !== owner) {
      fail('OWNERSHIP_CHANGED', 'The incomplete destination is no longer owned by this operation.');
    }
    if (path.dirname(destination).toLowerCase() !== parent.toLowerCase()
        || overlap(plan.sourceRoot, destination) || overlap(plan.dataRoot, destination)) {
      fail('INVALID_DESTINATION', 'The destination is outside the cleanup boundary.');
    }
  };
  try {
    checkCancelled(options.signal);
    await plainPath(parent, 'directory');
    await fs.mkdir(destination, { recursive: false, mode: 0o700 });
    created = true;
    ownedInode = (await fs.lstat(destination)).ino;
    await fs.writeFile(path.join(destination, OWNER_FILE), owner, { flag: 'wx', mode: 0o600 });
    const targetData = path.join(destination, 'data');
    await fs.mkdir(targetData);
    for (const relative of plan.directories) {
      checkCancelled(options.signal);
      const target = path.join(targetData, ...relative.split('/'));
      await plainPath(path.dirname(target), 'directory');
      await fs.mkdir(target, { recursive: false });
    }
    emit('copying');
    for (const file of plan.files) {
      const parts = file.relativePath.split('/');
      const sha256 = await copyVerifiedFile(path.join(plan.dataRoot, ...parts), path.join(targetData, ...parts), file, options.signal);
      copiedBytes += file.bytes;
      verified.push({ relativePath: file.relativePath, bytes: file.bytes, sha256 });
      emit('copying');
    }
    emit('verifying');
    if (fingerprint(await inspectMigrationSource(source, options)) !== fingerprint(plan)) {
      fail('SOURCE_CHANGED', 'The source inventory or configuration changed during copying.');
    }
    for (const file of verified) {
      checkCancelled(options.signal);
      const parts = file.relativePath.split('/');
      if (await hashRegularFile(path.join(plan.dataRoot, ...parts), options.signal) !== file.sha256
          || await hashRegularFile(path.join(targetData, ...parts), options.signal) !== file.sha256) {
        fail('VERIFY_FAILED', 'The source or destination no longer matches the copied data.');
      }
    }
    if (fingerprint(await inspectMigrationSource(source, options)) !== fingerprint(plan)) {
      fail('SOURCE_CHANGED', 'The source changed during final verification.');
    }
    await verifyDestinationTree(targetData, plan, options.signal);
    await assertOwnedDestination();
    const rootEntries = await fs.readdir(destination);
    if (rootEntries.length !== 2 || !rootEntries.includes('data') || !rootEntries.includes(OWNER_FILE)) {
      fail('VERIFY_FAILED', 'Unexpected entries appeared in the destination root.');
    }
    checkCancelled(options.signal);
    const reportPath = path.join(destination, REPORT_FILE);
    await fs.writeFile(reportPath, `${JSON.stringify({
      schema: 1, status: 'verified-data-copy', createdAt: new Date().toISOString(),
      sourceRoot: plan.sourceRoot, sourceVersion: plan.sourceVersion,
      dataRoot: plan.dataRoot, includeSecrets: plan.includeSecrets,
      users: plan.users, files: verified, excluded: plan.excluded, warnings: plan.warnings,
      registeredAsInstance: false, sourceModified: false,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.unlink(path.join(destination, OWNER_FILE));
    // The completed data copy is not registered or started by this prototype.
    created = false;
    try { emit('complete'); } catch { /* Reporting must not undo a completed copy. */ }
    return { status: 'verified-data-copy', destination, sourceVersion: plan.sourceVersion,
      filesCopied: verified.length, bytesCopied: copiedBytes, sourceModified: false,
      registeredAsInstance: false, reportPath };
  } catch (error) {
    if (created) {
      try {
        await assertOwnedDestination();
        // Only the exact, newly created, ownership-marked destination may be removed.
        await fs.rm(destination, { recursive: true, force: false });
      } catch {
        fail('CLEANUP_REQUIRED', 'Migration failed and its incomplete destination could not be safely removed. The source was not modified.');
      }
    }
    if (error instanceof MigrationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC') fail('INSUFFICIENT_SPACE', 'Free space ran out during copying.');
    fail('COPY_FAILED', 'Migration failed while accessing files. The source was not modified.');
  }
}

export async function copyMigrationRuntime(
  source: string,
  destination: string,
  options: {
    dataRoot: string; includePlugins?: boolean; includeSecrets?: boolean;
    signal?: AbortSignal; onProgress?: (percent: number) => void;
  },
): Promise<number> {
  const root = await plainPath(source, 'directory');
  await plainPath(destination, 'directory');
  if (overlap(root, destination) || overlap(options.dataRoot, destination)) {
    fail('OVERLAPPING_PATHS', 'Runtime source and destination must not overlap.');
  }
  const rootDirectories = new Set(['src', 'public', 'default']);
  if (options.includePlugins) rootDirectories.add('plugins');
  const rootFiles = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'LICENSE']);
  async function inventory() {
    const files: MigrationFile[] = [];
    const directories: string[] = [];
    let totalBytes = 0;
    async function walk(directory: string, relative: string, depth: number): Promise<void> {
      checkCancelled(options.signal);
      if (depth > MAX_DEPTH) fail('DEPTH_LIMIT', 'Runtime directory depth exceeds the limit.');
      const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        checkCancelled(options.signal);
        const name = entry.name.toLowerCase();
        const file = path.join(directory, entry.name);
        const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
        if (name === 'node_modules' || name === '.git' || (name === 'secrets.json' && !options.includeSecrets)
            || (!options.includePlugins && relativePath.toLowerCase() === 'public/scripts/extensions/third-party')
            || within(options.dataRoot, file)) continue;
        if (!relative && !rootFiles.has(entry.name) && !rootDirectories.has(entry.name)
            && !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
        portableName(entry.name);
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink()) fail('LINK_NOT_SUPPORTED', 'Runtime links require manual review.');
        if (files.length + directories.length >= MAX_FILES) fail('FILE_LIMIT', 'Runtime entry limit exceeded.');
        if (stat.isDirectory()) {
          if (!relative && !rootDirectories.has(entry.name)) {
            fail('INVALID_RUNTIME', 'A runtime file was replaced by a directory.');
          }
          directories.push(relativePath);
          await walk(file, relativePath, depth + 1);
        } else if (stat.isFile()) {
          totalBytes += stat.size;
          if (!Number.isSafeInteger(totalBytes)) fail('SIZE_LIMIT', 'Runtime size exceeds the limit.');
          files.push({ relativePath, bytes: stat.size, mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs, ino: stat.ino, dev: stat.dev });
        } else fail('SPECIAL_FILE', 'Runtime contains an unsupported file type.');
      }
    }
    await walk(root, '', 0);
    for (const required of ['server.js', 'package.json']) {
      if (!files.some(file => file.relativePath === required)) fail('INVALID_RUNTIME', 'Runtime files are missing.');
    }
    for (const required of ['src', 'public', 'default']) {
      if (!directories.includes(required)) fail('INVALID_RUNTIME', 'Select a complete SillyTavern installation.');
    }
    return { files, directories, totalBytes };
  }
  const plan = await inventory();
  const space = await fs.statfs(destination);
  if (space.bavail * space.bsize < plan.totalBytes + 16 * 1024 * 1024) {
    fail('INSUFFICIENT_SPACE', 'There is not enough free space for the runtime.');
  }
  for (const directory of plan.directories) {
    checkCancelled(options.signal);
    await fs.mkdir(path.join(destination, ...directory.split('/')), { recursive: false });
  }
  const hashes = new Map<string, string>();
  for (const [index, file] of plan.files.entries()) {
    checkCancelled(options.signal);
    const parts = file.relativePath.split('/');
    hashes.set(file.relativePath, await copyVerifiedFile(
      path.join(root, ...parts), path.join(destination, ...parts), file, options.signal,
    ));
    options.onProgress?.(Math.round((index + 1) * 100 / plan.files.length));
  }
  if (JSON.stringify(await inventory()) !== JSON.stringify(plan)) {
    fail('SOURCE_CHANGED', 'Runtime files changed during import. Stop the old application and retry.');
  }
  for (const file of plan.files) {
    const parts = file.relativePath.split('/');
    const expected = hashes.get(file.relativePath);
    if (await hashRegularFile(path.join(root, ...parts), options.signal) !== expected
        || await hashRegularFile(path.join(destination, ...parts), options.signal) !== expected) {
      fail('VERIFY_FAILED', 'Runtime verification failed.');
    }
  }
  return plan.files.length;
}

export function migrationSummary(plan: MigrationPlan) {
  return {
    sourceRoot: plan.sourceRoot, dataRoot: plan.dataRoot, sourceVersion: plan.sourceVersion,
    externalDataRoot: plan.externalDataRoot, users: plan.users, files: plan.files.length,
    bytes: plan.totalBytes, includeSecrets: plan.includeSecrets,
    excluded: {
      credentialFiles: plan.excluded.filter(item => item.reason === 'credentials-not-authorized').length,
      extensionDirectories: plan.excluded.filter(item => item.reason === 'extension-code').length,
      runtimeDirectories: plan.excluded.filter(item => item.reason === 'runtime-or-repository').length,
    },
    warnings: plan.warnings,
  };
}
