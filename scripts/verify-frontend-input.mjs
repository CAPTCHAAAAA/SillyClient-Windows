import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.argv[2] || path.join(repository, 'frontend-dist'));
const extensions = new Set([
  '.css', '.html', '.js', '.json', '.md', '.mjs', '.toml',
  '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return files(absolute);
    return entry.isFile() && entry.name !== 'sillyclient-build.json' ? [absolute] : [];
  });
}

if (!fs.existsSync(path.join(directory, 'index.html'))) throw new Error('Missing frontend index.html.');
const entries = files(directory).sort((a, b) => {
  a = a.split(path.sep).join('/');
  b = b.split(path.sep).join('/');
  return a < b ? -1 : a > b ? 1 : 0;
});
// Match the existing frontend.lock.json digest contract without syncing or editing assets.
const hash = createHash('sha256');
for (const file of entries) {
  const raw = fs.readFileSync(file);
  const content = extensions.has(path.extname(file).toLowerCase())
    ? Buffer.from(raw.toString('utf8').replace(/\r\n?/g, '\n')) : raw;
  hash.update(path.relative(directory, file).split(path.sep).join('/'));
  hash.update('\0');
  hash.update(String(content.length));
  hash.update('\0');
  hash.update(content);
  hash.update('\0');
}
const actual = hash.digest('hex');
const expected = JSON.parse(fs.readFileSync(path.join(repository, 'frontend.lock.json'), 'utf8')).assetsSha256;
console.log(JSON.stringify({ directory, files: entries.length, actual, expected, match: actual === expected }, null, 2));
if (actual !== expected) process.exitCode = 1;
