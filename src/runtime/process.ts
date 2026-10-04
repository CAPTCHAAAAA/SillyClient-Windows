import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { getNodeExe, getNpmCli, logsDir } from './paths';
import { ProcessSupervisor } from './process-supervisor';
import { checkSignal, delay, OperationCancelledError } from './operations';
import { createLineSink, RotatingLog } from './logs';

let serverProcess: ChildProcess | null = null;
const supervisor = new ProcessSupervisor();
const commandControllers = new Set<AbortController>();
const pendingLogs = new Set<Promise<void>>();
const MAX_CAPTURE_LENGTH = 64 * 1024;
const CMD_EXE = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const nodeDir = path.dirname(getNodeExe());
  env.PATH = nodeDir + path.delimiter + (env.PATH || '');
  if (!env.npm_config_cache) {
    env.npm_config_cache = path.join(path.dirname(path.dirname(nodeDir)), 'usr', 'npm-cache');
  }
  if (extra) Object.assign(env, extra);
  return env;
}

export async function runNpmInstall(
  cwd: string,
  onLog: (msg: string, level?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const args = [
    getNpmCli(), 'install', '--omit=dev',
    '--registry', 'https://registry.npmmirror.com', '--no-fund', '--no-audit',
  ];
  for (let attempt = 1; attempt <= 3; attempt++) {
    checkSignal(signal);
    onLog(`npm install (${attempt}/3)`);
    try {
      const result = await runProcess(getNodeExe(), args, {
        cwd, timeout: 600000, signal, onLog,
      });
      checkSignal(signal);
      if (result.code === 0) {
        onLog('npm install completed', 'success');
        return;
      }
      onLog(`npm install exited (${result.code})`, 'error');
      if (result.stderr) onLog(result.stderr.slice(-500), 'error');
    } catch (error: any) {
      checkSignal(signal);
      if (error?.name === 'ProcessTerminationError') throw error;
      onLog(`npm install failed: ${error.message}`, 'error');
    }
    if (attempt < 3) await delay(2000, signal);
  }
  throw new Error('npm install failed after 3 attempts');
}

export function startServer(
  serverDir: string,
  instanceId: string,
  port: number,
  onLog: (msg: string, level?: string) => void,
  onExit?: (code: number | null) => void,
  options: { args?: string[]; operationId?: string } = {},
): ChildProcess {
  if (serverProcess && supervisor.owns(serverProcess)) throw new Error('Previous server is still running');
  onLog(`Starting server (port ${port})`);
  // Direct invocation leaves takeover scripts untouched and owns the real Node PID.
  const child = spawn(getNodeExe(), ['server.js', ...(options.args || ['--port', String(port)])], {
    cwd: serverDir,
    env: buildEnv({ NODE_ENV: 'production', AUTO_LAUNCH: 'false', NO_BROWSER: 'true' }),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess = child;
  supervisor.track(child, serverDir, { instanceId, operationId: options.operationId });
  const diskLog = new RotatingLog(path.join(logsDir, `${instanceId}.log`),
    (error) => onLog(`Cannot write server log: ${error.message}`, 'error'));
  const stdout = createLineSink((line) => onLog(line));
  const stderr = createLineSink((line) => onLog(line, 'error'));
  child.stdout?.on('data', (data: Buffer) => { diskLog.write(data); stdout.write(data); });
  child.stderr?.on('data', (data: Buffer) => { diskLog.write(data); stderr.write(data); });
  child.stdout?.on('error', (error) => onLog(`Server output failed: ${error.message}`, 'error'));
  child.stderr?.on('error', (error) => onLog(`Server error output failed: ${error.message}`, 'error'));
  child.once('error', (error) => onLog(`Server spawn failed: ${error.message}`, 'error'));
  child.once('close', (code) => {
    stdout.end();
    stderr.end();
    const closing = diskLog.end();
    pendingLogs.add(closing);
    closing.finally(() => pendingLogs.delete(closing)).catch(() => undefined);
    onLog(`Server exited (code=${code})`, code === 0 ? 'success' : 'error');
    if (serverProcess === child) {
      serverProcess = null;
      onExit?.(code);
    }
  });
  return child;
}

export async function stopServer(): Promise<void> {
  const child = serverProcess;
  if (!child) return;
  await supervisor.stop(child);
  if (serverProcess === child) serverProcess = null;
  await Promise.all(pendingLogs);
}

export async function stopServerForDirectory(directory: string): Promise<void> {
  await supervisor.stopDirectory(directory);
  await Promise.all(pendingLogs);
}

export async function stopAllProcesses(): Promise<void> {
  for (const controller of commandControllers) controller.abort();
  await supervisor.stopAll();
  await Promise.all(pendingLogs);
}

export function activeProcessDirectories(): string[] {
  return supervisor.activeDirectories();
}

export async function sendCommand(
  text: string,
  cwd: string,
  onLog: (msg: string, level?: string) => void,
): Promise<void> {
  const controller = new AbortController();
  commandControllers.add(controller);
  try {
    const result = await runProcess(CMD_EXE, ['/d', '/s', '/c', text], {
      cwd, timeout: 30000, signal: controller.signal, onLog,
    });
    onLog(`Command completed (code=${result.code})`, result.code === 0 ? 'success' : 'error');
  } catch (error: any) {
    onLog(`Command failed: ${error.message}`, 'error');
  } finally {
    commandControllers.delete(controller);
  }
}

export function isServerRunning(): boolean {
  return serverProcess !== null && supervisor.owns(serverProcess);
}

/** Output capture and live line buffers have fixed upper bounds. */
export function runProcess(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    onLog?: (msg: string, level?: string) => void;
  },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  checkSignal(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: buildEnv(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    supervisor.track(child, options.cwd || process.cwd());
    let stdout = '';
    let stderr = '';
    let failure: Error | null = null;
    let settled = false;
    let stopping: Promise<void> | null = null;
    const outLines = createLineSink((line) => options.onLog?.(line));
    const errLines = createLineSink((line) => options.onLog?.(line, 'error'));
    const stop = (error: Error) => {
      if (stopping) return;
      failure = error;
      stopping = supervisor.stop(child);
      stopping.catch((stopError) => {
        failure = stopError;
        finish(null);
      });
    };
    const abort = () => stop(new OperationCancelledError());
    const timer = options.timeout
      ? setTimeout(() => stop(new Error(`Process timeout (${options.timeout}ms)`)), options.timeout)
      : null;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      outLines.end();
      errLines.end();
      if (failure) reject(failure);
      else resolve({ stdout, stderr, code });
    };
    child.stdout?.on('data', (data: Buffer) => {
      stdout = (stdout + data.toString()).slice(-MAX_CAPTURE_LENGTH);
      outLines.write(data);
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-MAX_CAPTURE_LENGTH);
      errLines.write(data);
    });
    child.stdout?.on('error', (error) => stop(error));
    child.stderr?.on('error', (error) => stop(error));
    child.once('close', finish);
    child.once('error', (error) => {
      failure = error;
      if (!child.pid) finish(null);
      else stop(error);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
