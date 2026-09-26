import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { MigrationError, validateMigrationDirectory } from './data-migration';

export async function readImportConfiguration(directory: string): Promise<Record<string, any>> {
  await validateMigrationDirectory(directory);
  const file = path.join(directory, 'config.yaml');
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error();
    const doc = parseDocument(await fs.readFile(file, 'utf8'), { strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    const config = doc.toJS({ maxAliasCount: 0 });
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new MigrationError('INVALID_CONFIG', '无法读取迁移配置，原文件未修改。');
  }
}

export function localImportConfiguration(
  original: Record<string, any>, port: number, requireAccounts: boolean,
): Record<string, any> {
  // Retain plugin-specific settings, but not the old installation's network setup.
  const config: Record<string, any> = {
    ...original, dataRoot: './data', port, listen: false,
    listenAddress: { ipv4: '127.0.0.1', ipv6: '::1' },
    protocol: { ipv4: true, ipv6: false },
    ssl: { enabled: false },
    whitelistMode: true, whitelist: ['127.0.0.1', '::1'], securityOverride: false,
    basicAuthMode: false, perUserBasicAuth: false,
    enableUserAccounts: original.enableUserAccounts === true || requireAccounts,
    enableServerPlugins: original.enableServerPlugins === true,
    enableServerPluginsAutoUpdate: false,
    enableExtensionsAutoUpdate: false,
    extensions: { ...original.extensions, autoUpdate: false },
    autorun: false, browserLaunch: { ...original.browserLaunch, enabled: false },
  };
  delete config.basicAuthUser;
  delete config.sso;
  return config;
}

export async function writeImportConfiguration(directory: string, config: Record<string, any>): Promise<void> {
  await fs.writeFile(path.join(directory, 'config.yaml'), stringify(config), 'utf8');
}
