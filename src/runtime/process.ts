/**
 * Windows 进程管理
 *
 * 从 Android TarvenProcessRunner.kt 移植。
 * 关键差异：Android 用 LD_LIBRARY_PATH + .so 伪装二进制，
 * Windows 用系统 node.exe（优先）或 Electron 内置 Node（ELECTRON_RUN_AS_NODE=1）。
 */

import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNodeBin, getNpmBin, isElectronNode, logsDir } from './paths';

let serverProcess: ChildProcess | null = null;

/** 构建 spawn 环境变量 */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  // 复制 process.env（过滤 undefined）
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // 如果用 Electron 内置 Node，必须设 ELECTRON_RUN_AS_NODE=1
  if (isElectronNode()) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  if (extra) Object.assign(env, extra);
  return env;
}

/** 执行原生命令，收集输出 */
export function executeNative(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: buildEnv(options.env),
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = options.timeout
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`超时 (${options.timeout}ms)`));
        }, options.timeout)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

/** 冒烟测试 Node.js */
export async function smokeTestNode(): Promise<boolean> {
  try {
    const result = await executeNative(getNodeBin(), ['--version'], { timeout: 10000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** 运行 npm install */
export async function runNpmInstall(
  cwd: string,
  onLog: (msg: string, level?: string) => void,
): Promise<void> {
  const npmBin = getNpmBin();
  const registry = 'https://registry.npmmirror.com';
  const npmArgs = ['install', '--omit=dev', '--registry', registry, '--no-fund', '--no-audit'];

  // npm.cmd 是批处理文件，需要通过 cmd.exe 运行
  const isCmdFile = npmBin.toLowerCase().endsWith('.cmd');
  const cmd = isCmdFile ? 'cmd.exe' : npmBin;
  const args = isCmdFile ? ['/c', npmBin, ...npmArgs] : npmArgs;

  for (let attempt = 1; attempt <= 3; attempt++) {
    onLog(`npm install (尝试 ${attempt}/3)`);
    try {
      const result = await executeNative(cmd, args, { cwd, timeout: 600000 });
      if (result.code === 0) {
        onLog('npm install 完成', 'success');
        return;
      }
      onLog(`npm install 退出码 ${result.code}`, 'error');
      if (result.stderr) onLog(result.stderr.slice(0, 200), 'error');
    } catch (e: any) {
      onLog(`npm install 异常: ${e.message}`, 'error');
    }
    if (attempt < 3) await sleep(2000);
  }
  throw new Error('npm install 失败（3 次重试后放弃）');
}

/** 启动服务端 */
export function startServer(
  serverDir: string,
  instanceId: string,
  port: number,
  onLog: (msg: string, level?: string) => void,
): ChildProcess {
  const nodeBin = getNodeBin();
  const logFile = path.join(logsDir, `${instanceId}.log`);

  const env = buildEnv({
    NODE_ENV: 'production',
    AUTO_LAUNCH: 'false',
    NO_BROWSER: 'true',
  });

  onLog(`启动: ${nodeBin} server.js (端口 ${port})${isElectronNode() ? ' [Electron Node]' : ''}`);

  serverProcess = spawn(nodeBin, ['server.js'], {
    cwd: serverDir,
    env,
    shell: false,
    windowsHide: false,
  });

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  serverProcess.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    logStream.write(text);
    text.split('\n').filter(Boolean).forEach((line) => onLog(line.trim()));
  });

  serverProcess.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    logStream.write(text);
    text.split('\n').filter(Boolean).forEach((line) => onLog(line.trim(), 'error'));
  });

  serverProcess.on('exit', (code) => {
    onLog(`服务端退出 (code=${code})`, code === 0 ? 'success' : 'error');
    logStream.end();
    serverProcess = null;
  });

  return serverProcess;
}

/** 停止服务端 */
export function stopServer(): void {
  if (serverProcess) {
    try {
      // Windows 上需要 taskkill /T 来杀子进程树
      const pid = serverProcess.pid;
      if (pid) {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      }
    } catch { /* ignore */ }
    serverProcess = null;
  }
}

/** 发送命令到 shell */
export function sendCommand(
  text: string,
  cwd: string,
  onLog: (msg: string, level?: string) => void,
): void {
  const child = spawn('cmd.exe', ['/c', text], {
    cwd,
    shell: false,
    windowsHide: false,
  });

  child.stdout?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach((line) => onLog(line.trim()));
  });

  child.stderr?.on('data', (d: Buffer) => {
    d.toString().split('\n').filter(Boolean).forEach((line) => onLog(line.trim(), 'error'));
  });

  child.on('exit', (code) => {
    onLog(`命令完成 (code=${code})`, code === 0 ? 'success' : 'error');
  });
}

/** 服务端是否运行中 */
export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
