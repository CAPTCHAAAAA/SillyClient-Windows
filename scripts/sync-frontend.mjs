import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(scriptDirectory, '..');
const argumentsMap = new Map();

for (let index = 2; index < process.argv.length; index += 2) {
  argumentsMap.set(process.argv[index], process.argv[index + 1]);
}

const source = path.resolve(argumentsMap.get('--source') || '');
const manifestArgument = argumentsMap.get('--manifest');
const manifestPath = manifestArgument ? path.resolve(manifestArgument) : '';
const destination = path.join(repository, 'frontend-dist');
const lockPath = path.join(repository, 'frontend.lock.json');
const manifestName = 'sillyclient-build.json';
const ignoredSourceDirectories = new Set([
  'dist',
  'node_modules',
  '.vite-temp',
  '.microcompact',
  '.todo',
  '.plan',
]);
const textExtensions = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.toml',
  '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

if (!fs.existsSync(path.join(source, 'index.html'))) {
  throw new Error(`Frontend build not found at ${source}`);
}
const sourceRoot = path.dirname(source);
const manifest = manifestPath && fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null;

function collectFiles(directory, { sourceTree = false } = {}) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (sourceTree && ignoredSourceDirectories.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(absolutePath));
    if (entry.isFile() && entry.name !== manifestName) files.push(absolutePath);
  }
  return files.sort((left, right) => {
    const a = left.split(path.sep).join('/');
    const b = right.split(path.sep).join('/');
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function digestTree(directory, options) {
  const hash = crypto.createHash('sha256');
  for (const filePath of collectFiles(directory, options)) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join('/');
    const extension = path.extname(filePath).toLowerCase();
    const raw = fs.readFileSync(filePath);
    const content = textExtensions.has(extension)
      ? Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n'))
      : raw;
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(content.length));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

const assetsSha256 = digestTree(source);
if (manifest && (manifest.schema !== 1 || manifest.assetsSha256 !== assetsSha256)) {
  throw new Error('Frontend build does not match the provided frontend manifest.');
}

fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
if (manifestPath && fs.existsSync(manifestPath)) {
  fs.copyFileSync(manifestPath, path.join(destination, manifestName));
}

const lock = {
  schema: 1,
  sourceRepository: 'CAPTCHAAAAA/SillyClient-Windows',
  sourcePath: 'web/capacitor-ui',
  sourceSha256: manifest?.sourceSha256 || digestTree(sourceRoot, { sourceTree: true }),
  assetsSha256,
};
fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`Verified and synced ${source} -> ${destination}`);
