import * as path from 'node:path';
import { getNodeExe } from './paths';
import { runProcess } from './process';

/** Reads only the installed YAML parser, never instance or extension entry points. */
export async function resolveInstanceDataRoot(serverDir: string, signal?: AbortSignal): Promise<string> {
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const {createRequire} = require('node:module');",
    'const root = process.argv[1];',
    "const requireInstance = createRequire(path.join(root, 'package.json'));",
    "const yaml = requireInstance('yaml');",
    "const file = path.join(root, 'config.yaml');",
    "const document = fs.existsSync(file) ? yaml.parse(fs.readFileSync(file, 'utf8')) : {};",
    'const config = document ?? {};',
    "if (Object.prototype.toString.call(config) !== '[object Object]') throw new Error('Installation config must be a YAML mapping');",
    "const dataRoot = config.dataRoot ?? './data';",
    "if (typeof dataRoot !== 'string' || !dataRoot.trim()) throw new Error('Invalid dataRoot');",
    'process.stdout.write(JSON.stringify({dataRoot}));',
  ].join('\n');
  const result = await runProcess(getNodeExe(), ['-e', script, serverDir], {
    cwd: serverDir, signal, timeout: 5000,
  });
  if (result.code !== 0) throw new Error('Cannot safely resolve the installation dataRoot');
  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cannot safely resolve the installation dataRoot');
  }
  if (typeof parsed?.dataRoot !== 'string' || !parsed.dataRoot.trim()) {
    throw new Error('Invalid installation dataRoot');
  }
  const resolved = path.resolve(serverDir, parsed.dataRoot);
  const relative = path.relative(path.resolve(serverDir), resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Installation dataRoot must stay inside the selected instance');
  }
  return resolved;
}
