import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parseDocument, stringify } from 'yaml';
import { inspectMigrationSource, MigrationError, validateMigrationDirectory } from './data-migration';
import type { MigrationPlan, InspectMigrationOptions } from './data-migration';
import { registerAttachedInstance } from './instances';
import type { InstanceRecord } from './instances';
import { ensureDirs, normalizeInstanceId, tarvenHome } from './paths';

async function readRegular(file: string): Promise<string> {
  await validateMigrationDirectory(path.dirname(file));
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new Error('接管配置或启动文件必须是普通文件，且不超过 1 MB。');
  }
  return fs.readFile(file, 'utf8');
}

async function readRuntime(directory: string): Promise<Record<string, any>> {
  await validateMigrationDirectory(directory);
  await readRegular(path.join(directory, 'package.json'));
  await readRegular(path.join(directory, 'server.js'));
  const cli = await readRegular(path.join(directory, 'src', 'command-line.js'));
  if (!/\.option\(\s*['"]configPath['"]/.test(cli)) {
    throw new Error('该版本没有可识别的独立配置启动参数，不能保证保留原配置；请选择复制迁移。');
  }
  try {
    await validateMigrationDirectory(path.join(directory, 'node_modules'));
  } catch {
    throw new Error('原目录缺少可用依赖。请先用原来的方式完成安装；接管不会替你重装或更新依赖。');
  }
  let text: string;
  try {
    text = await readRegular(path.join(directory, 'config.yaml'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = await readRegular(path.join(directory, 'default', 'config.yaml'));
  }
  try {
    const doc = parseDocument(text, { strict: true, uniqueKeys: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    const value = doc.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error('原配置无法安全解析，已停止接管；原配置未修改。');
  }
}

function validateLocalAuthentication(config: Record<string, any>): void {
  if (config.basicAuthMode || config.sso?.autheliaAuth || config.sso?.authentikAuth) {
    throw new Error('原配置启用了 HTTP Basic Auth 或反向代理登录，当前接管窗口尚不支持这种登录方式。请使用原启动方式，或选择复制迁移；不会关闭或修改原认证配置。');
  }
}

export async function requireIdlePort(port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('原地接管需要有效端口。');
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`端口 ${port} 正在使用或不可用。请先停止原酒馆并排除端口冲突；不会自动切换端口或结束外部进程。`)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => probe.close(() => resolve()));
  });
}

function outsideApp(directory: string): void {
  const within = (a: string, b: string) => {
    const relative = path.relative(a, b);
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  if (within(tarvenHome, directory) || within(directory, tarvenHome)) {
    throw new Error('软件自己的数据目录不能作为外部目录接管，请选择原来独立安装的酒馆。');
  }
}

export async function attachExistingInstance(
  approved: MigrationPlan, options: InspectMigrationOptions & { sourceStopped: boolean },
): Promise<InstanceRecord> {
  if (!options.sourceStopped) throw new MigrationError('SOURCE_NOT_STOPPED', '请先停止原酒馆。');
  const plan = await inspectMigrationSource(approved.sourceRoot, { ...options, dataRoot: approved.dataRoot });
  if (plan.metadataFingerprint !== approved.metadataFingerprint || plan.dataRoot !== approved.dataRoot) {
    throw new MigrationError('SOURCE_CHANGED', '源配置已变化，请重新确认接管。');
  }
  outsideApp(plan.sourceRoot);
  outsideApp(plan.dataRoot);
  const config = await readRuntime(plan.sourceRoot);
  validateLocalAuthentication(config);
  await requireIdlePort(config.port ?? 8000);
  if (options.signal?.aborted) throw new MigrationError('CANCELLED', '接管已取消。');
  const base = normalizeInstanceId(path.basename(plan.sourceRoot)).slice(0, 34);
  return registerAttachedInstance(`${base}-attach-${randomUUID()}`, plan.sourceRoot, plan.dataRoot);
}

export async function prepareAttachedLaunch(record: InstanceRecord, port: number): Promise<string> {
  if (record.managementMode !== 'in-place' || !record.dataRoot) throw new Error('接管记录不完整。');
  outsideApp(record.path);
  outsideApp(record.dataRoot);
  await validateMigrationDirectory(record.dataRoot);
  const config = await readRuntime(record.path);
  validateLocalAuthentication(config);
  await requireIdlePort(config.port ?? 8000);
  if (port !== (config.port ?? 8000)) await requireIdlePort(port);
  // Only the app-owned configuration is changed. Upstream may update this copy.
  config.dataRoot = record.dataRoot;
  config.port = port;
  config.listen = false;
  config.listenAddress = { ipv4: '127.0.0.1', ipv6: '::1' };
  config.protocol = { ipv4: true, ipv6: false };
  config.ssl = { ...config.ssl, enabled: false };
  config.whitelistMode = true;
  config.whitelist = ['127.0.0.1', '::1'];
  config.securityOverride = false;
  config.autorun = false;
  config.browserLaunch = { ...config.browserLaunch, enabled: false };
  config.enableExtensionsAutoUpdate = false;
  config.extensions = { ...config.extensions, autoUpdate: false };
  ensureDirs();
  await validateMigrationDirectory(tarvenHome);
  let parent = tarvenHome;
  for (const name of ['in-place', normalizeInstanceId(record.instanceId)]) {
    parent = path.join(parent, name);
    try { await fs.mkdir(parent); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await validateMigrationDirectory(parent);
  }
  const configPath = path.join(parent, 'config.yaml');
  try { await readRegular(configPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = path.join(parent, `config-${randomUUID()}.yaml`);
  try {
    await fs.writeFile(temporary, stringify(config), { flag: 'wx' });
    await fs.rename(temporary, configPath);
  } finally {
    await fs.unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
  return configPath;
}
