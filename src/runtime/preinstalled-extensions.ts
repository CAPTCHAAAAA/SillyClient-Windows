import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertPlainPath } from './cleanup';
import { checkSignal } from './operations';
import { downloadFile, unzipToDir } from './utils';
import { resolveInstanceDataRoot } from './instance-config';

const ALLOWED_REPOSITORIES: Record<string, string> = {
  'tavern-helper': 'N0VI028/JS-Slash-Runner',
  littlewhitebox: 'RT15548/LittleWhiteBox',
  'prompt-template': 'zonde306/ST-Prompt-Template',
  dice: 'SillyTavern/Extension-Dice',
};
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export interface PreinstallSelection {
  revision: 1;
  extensionIds: string[];
}

interface ExtensionRecord {
  id: string;
  displayName: string;
  repository: string;
  commit: string;
  archiveSha256: string;
  archiveBytes: number;
  minimumClientVersion?: string;
  version: string;
  license: string;
  licensePath: string;
}

export interface ExtensionInstallTransaction {
  installed: string[];
  skipped: string[];
  commit(): void;
  rollback(): Promise<void>;
}

interface InstallerDependencies {
  catalogPath?: string;
  download?: typeof downloadFile;
  resolveDataRoot?: (serverDir: string, signal?: AbortSignal) => Promise<string>;
}

function defaultCatalogPath(): string {
  return process.resourcesPath
    ? path.join(process.resourcesPath, 'preinstalled-extensions', 'catalog.json')
    : path.join(__dirname, '..', '..', 'resources', 'preinstalled-extensions', 'catalog.json');
}

export function validatePreinstallSelection(value: unknown): PreinstallSelection | undefined {
  if (value === undefined || value === null) return undefined;
  const selection = value as Partial<PreinstallSelection>;
  if (selection.revision !== 1 || !Array.isArray(selection.extensionIds)
    || selection.extensionIds.length > 4
    || Array.from(selection.extensionIds).some((id) => typeof id !== 'string'
      || !Object.prototype.hasOwnProperty.call(ALLOWED_REPOSITORIES, id))
    || new Set(selection.extensionIds).size !== selection.extensionIds.length) {
    throw new Error('Invalid preinstalled extension selection');
  }
  return { revision: 1, extensionIds: [...selection.extensionIds] };
}

function versionParts(value: string): number[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][a-z0-9.-]+)?$/i.exec(value);
  if (!match) throw new Error('Cannot validate the SillyTavern version');
  return match.slice(1, 4).map(Number);
}

function requireMinimum(actual: string, minimum?: string): void {
  if (!minimum) return;
  const actualParts = versionParts(actual);
  const minimumParts = versionParts(minimum);
  for (let index = 0; index < 3; index++) {
    if (actualParts[index] > minimumParts[index]) return;
    if (actualParts[index] < minimumParts[index]) throw new Error(`Extension requires SillyTavern ${minimum} or newer`);
  }
  if (actual.includes('-') && !minimum.includes('-')) {
    throw new Error(`Extension requires stable SillyTavern ${minimum} or newer`);
  }
}

async function digest(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const buffer of fs.createReadStream(file, { signal })) hash.update(buffer);
  checkSignal(signal);
  return hash.digest('hex');
}

async function createPlainDirectories(directory: string, created: string[]): Promise<void> {
  const missing: string[] = [];
  let parent = directory;
  while (!fs.existsSync(parent)) {
    missing.push(parent);
    const next = path.dirname(parent);
    if (next === parent) throw new Error('Cannot create extension directory');
    parent = next;
  }
  await assertPlainPath(parent);
  for (const target of missing.reverse()) {
    await fs.promises.mkdir(target);
    created.push(target);
  }
  await assertPlainPath(directory);
}

async function treeIdentity(root: string, signal?: AbortSignal): Promise<string> {
  const rootStat = await fs.promises.lstat(root);
  const entries: string[] = [`root:${rootStat.dev}:${rootStat.ino}:${rootStat.birthtimeMs}`];
  const queue = [root];
  let bytes = 0;
  while (queue.length) {
    checkSignal(signal);
    const directory = queue.pop()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      checkSignal(signal);
      const target = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Linked extension files are not supported');
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Unsupported extension file');
      if (entries.length > 8192) throw new Error('Extension tree changed beyond its entry bounds');
      bytes += stat.isFile() ? stat.size : 0;
      if (bytes > MAX_EXPANDED_BYTES + 64 * 1024) throw new Error('Extension tree changed beyond its size bounds');
      // Metadata alone cannot detect a same-size edit with a restored timestamp.
      const content = stat.isFile() ? await digest(target, signal) : 'directory';
      const after = await fs.promises.lstat(target);
      if (after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
        throw new Error('Extension file changed during ownership verification');
      }
      entries.push([path.relative(root, target), stat.dev, stat.ino, stat.size, stat.mtimeMs, content].join(':'));
      if (stat.isDirectory()) queue.push(target);
    }
  }
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

function relativeAsset(root: string, entry: unknown): string {
  if (typeof entry !== 'string' || !entry || path.isAbsolute(entry) || entry.includes(':')
    || entry.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) {
    throw new Error('Unsafe extension asset path');
  }
  return path.join(root, entry);
}

async function validateManifest(root: string, actualVersion: string, extension: ExtensionRecord): Promise<void> {
  const manifestPath = path.join(root, 'manifest.json');
  const stat = await assertPlainPath(manifestPath);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid extension manifest');
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  if (manifest.version !== extension.version) throw new Error('Pinned extension manifest version mismatch');
  if (manifest.minimum_client_version !== undefined && typeof manifest.minimum_client_version !== 'string') {
    throw new Error('Invalid extension minimum version');
  }
  requireMinimum(actualVersion, manifest.minimum_client_version);
  const licensePath = relativeAsset(root, extension.licensePath);
  let licenseStat: fs.Stats;
  try {
    licenseStat = await assertPlainPath(licensePath);
  } catch {
    throw new Error('Missing or invalid pinned extension license');
  }
  if (!licenseStat.isFile() || licenseStat.size === 0 || licenseStat.size > 1024 * 1024) {
    throw new Error('Missing or invalid pinned extension license');
  }
  const declared = [...(Array.isArray(manifest.js) ? manifest.js : manifest.js ? [manifest.js] : []),
    ...(Array.isArray(manifest.css) ? manifest.css : manifest.css ? [manifest.css] : [])];
  if (!declared.length) throw new Error('Extension manifest has no JavaScript or CSS entry');
  for (const entry of declared) {
    const entryStat = await assertPlainPath(relativeAsset(root, entry));
    if (!entryStat.isFile() || entryStat.size === 0) throw new Error('Missing extension manifest entry');
  }
}

/** All selected extensions publish together; no existing extension is overwritten. */
export async function installPreselectedExtensions(
  serverDir: string,
  value: unknown,
  options: {
    signal?: AbortSignal;
    operationId?: string;
    log?: (message: string, level?: string) => void;
    progress?: (percent: number, stage: string) => void;
  } = {},
  dependencies: InstallerDependencies = {},
): Promise<ExtensionInstallTransaction> {
  const selection = validatePreinstallSelection(value);
  if (!selection?.extensionIds.length) return {
    installed: [], skipped: [], commit() {}, rollback: async () => undefined,
  };
  checkSignal(options.signal);
  await assertPlainPath(serverDir);
  const packageJson = JSON.parse(await fs.promises.readFile(path.join(serverDir, 'package.json'), 'utf8'));
  const actualVersion = String(packageJson.version || '');
  versionParts(actualVersion);
  const catalog = JSON.parse(await fs.promises.readFile(dependencies.catalogPath || defaultCatalogPath(), 'utf8'));
  if (catalog.revision !== 1 || !Array.isArray(catalog.extensions)) throw new Error('Invalid preinstalled extension catalog');
  const extensions: ExtensionRecord[] = selection.extensionIds.map((id) => {
    const matches = catalog.extensions.filter((entry: ExtensionRecord) => entry.id === id);
    const entry = matches[0] as ExtensionRecord | undefined;
    if (matches.length !== 1 || !entry || entry.repository !== ALLOWED_REPOSITORIES[id]
      || !/^[a-f0-9]{40}$/i.test(entry.commit) || !/^[a-f0-9]{64}$/i.test(entry.archiveSha256)
      || !Number.isInteger(entry.archiveBytes) || entry.archiveBytes <= 0 || entry.archiveBytes > MAX_ARCHIVE_BYTES
      || typeof entry.displayName !== 'string' || !entry.displayName
      || typeof entry.version !== 'string' || !entry.version
      || typeof entry.license !== 'string' || !entry.license
      || typeof entry.licensePath !== 'string' || !entry.licensePath
      || (entry.minimumClientVersion !== undefined && typeof entry.minimumClientVersion !== 'string')) {
      throw new Error(`Invalid pinned extension: ${id}`);
    }
    versionParts(entry.version);
    relativeAsset(serverDir, entry.licensePath);
    requireMinimum(actualVersion, entry.minimumClientVersion);
    return entry;
  });
  const dataRoot = await (dependencies.resolveDataRoot || resolveInstanceDataRoot)(serverDir, options.signal);
  const relative = path.relative(path.resolve(serverDir), path.resolve(dataRoot));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Preinstalled extensions cannot write outside the selected instance');
  }
  checkSignal(options.signal);
  const extensionsRoot = path.join(dataRoot, 'default-user', 'extensions');
  const createdParents: string[] = [];
  const staging: string[] = [];
  const published: { path: string; identity: string }[] = [];
  const prepared: { extension: ExtensionRecord; stage: string; source: string; target: string }[] = [];
  const skipped: string[] = [];
  const installed: string[] = [];
  let committed = false;
  const transactionId = randomUUID();
  const rollback = async () => {
    if (committed) return;
    const failures: string[] = [];
    for (const entry of [...published].reverse()) {
      try {
        if (!fs.existsSync(entry.path)) continue;
        await assertPlainPath(entry.path, true);
        if (await treeIdentity(entry.path) !== entry.identity) throw new Error('Extension files changed after installation');
        const marker = JSON.parse(await fs.promises.readFile(path.join(entry.path, '.sillyclient-install.json'), 'utf8'));
        if (marker.transactionId !== transactionId) throw new Error('Extension ownership changed');
        await fs.promises.rm(entry.path, { recursive: true, force: false });
      } catch (error: any) {
        failures.push(error.message);
      }
    }
    for (const directory of staging) {
      if (!fs.existsSync(directory)) continue;
      try {
        await assertPlainPath(directory, true);
        await fs.promises.rm(directory, { recursive: true, force: false });
      } catch (error: any) { failures.push(error.message); }
    }
    for (const directory of [...createdParents].reverse()) {
      try { await fs.promises.rmdir(directory); } catch { /* preserve any newly populated directory */ }
    }
    if (failures.length) throw new Error(`Extension rollback preserved changed files: ${failures.join('; ')}`);
  };
  try {
    await createPlainDirectories(extensionsRoot, createdParents);
    for (let index = 0; index < extensions.length; index++) {
      checkSignal(options.signal);
      const extension = extensions[index];
      const repositoryName = extension.repository.split('/')[1];
      const target = path.join(extensionsRoot, repositoryName);
      if (fs.existsSync(target)) {
        await assertPlainPath(target);
        const existingManifest = path.join(target, 'manifest.json');
        if (!fs.existsSync(existingManifest)) throw new Error(`Existing incomplete extension preserved: ${extension.id}`);
        await assertPlainPath(existingManifest);
        skipped.push(extension.id);
        options.log?.(`Preserved existing extension: ${extension.displayName}`);
        continue;
      }
      const stage = path.join(extensionsRoot, `.sillyclient-extension-${randomUUID()}`);
      await fs.promises.mkdir(stage);
      staging.push(stage);
      const archive = path.join(stage, 'archive.zip');
      const url = `https://codeload.github.com/${extension.repository}/zip/${extension.commit}`;
      options.progress?.(index * 100 / extensions.length, `Downloading ${extension.displayName}`);
      await (dependencies.download || downloadFile)(url, archive, (percent) => {
        options.progress?.((index + percent / 100) * 100 / extensions.length, `Downloading ${extension.displayName}`);
      }, options.signal, MAX_ARCHIVE_BYTES);
      checkSignal(options.signal);
      const archiveStat = await fs.promises.lstat(archive);
      if (!archiveStat.isFile() || archiveStat.size !== extension.archiveBytes
        || (await digest(archive, options.signal)).toLowerCase() !== extension.archiveSha256.toLowerCase()) {
        throw new Error(`Pinned archive verification failed: ${extension.id}`);
      }
      const extraction = path.join(stage, 'content');
      await fs.promises.mkdir(extraction);
      await unzipToDir(archive, extraction, {
        signal: options.signal, maxEntries: 8192, maxBytes: MAX_EXPANDED_BYTES, maxEntryBytes: MAX_ENTRY_BYTES,
      });
      checkSignal(options.signal);
      const rootEntries = await fs.promises.readdir(extraction);
      const expectedRoot = `${repositoryName}-${extension.commit}`;
      if (rootEntries.length !== 1 || rootEntries[0] !== expectedRoot) throw new Error('Unexpected pinned archive root');
      const source = path.join(extraction, expectedRoot);
      await assertPlainPath(source, true);
      await validateManifest(source, actualVersion, extension);
      await fs.promises.writeFile(path.join(source, '.sillyclient-install.json'), JSON.stringify({
        revision: 1, transactionId, id: extension.id, commit: extension.commit, operationId: options.operationId,
        version: extension.version, license: extension.license, licensePath: extension.licensePath,
      }), { flag: 'wx' });
      prepared.push({ extension, stage, source, target });
    }
    checkSignal(options.signal);
    for (const entry of prepared) {
      checkSignal(options.signal);
      await assertPlainPath(extensionsRoot);
      if (fs.existsSync(entry.target)) throw new Error('Extension target appeared while preparing installation');
      const identity = await treeIdentity(entry.source, options.signal);
      checkSignal(options.signal);
      await fs.promises.rename(entry.source, entry.target);
      published.push({ path: entry.target, identity });
      installed.push(entry.extension.id);
      options.log?.(`Installed pinned extension: ${entry.extension.displayName}`, 'success');
    }
    checkSignal(options.signal);
    for (const directory of staging) await fs.promises.rm(directory, { recursive: true, force: false });
    staging.length = 0;
    options.progress?.(100, 'Preinstalled extensions ready');
    return { installed, skipped, commit() { committed = true; }, rollback };
  } catch (error) {
    await rollback();
    throw error;
  }
}
