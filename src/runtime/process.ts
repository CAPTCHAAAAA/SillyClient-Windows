/**
 * Windows 进程管理
 *
 * 核心设计：
 * - npm install: node.exe npm-cli.js install（直接执行，不走 cmd.exe）
 * - 启动服务: 生成 start-server.bat，用 cmd.exe /c 运行
 * - 环境变量: 把内置 node 目录注入 PATH，npm 子进程能找到 node
 */

import { spawn, ChildProcess, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getNodeExe, getNpmCli, logsDir } from './paths';

let serverProcess: ChildProcess | null = null;

/** Windows cmd.exe 完整路径（不依赖 PATH） */
const CMD_EXE = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

// ---------------------------------------------------------------------------
// 环境变量
// ---------------------------------------------------------------------------

/** 构建 spawn 环境：注入内置 node 目录到 PATH */
function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  // 确保内置 node 在 PATH 最前面，npm 子进程能找到 node
  const nodeDir = path.dirname(getNodeExe());
  env.PATH = nodeDir + path.delimiter + (env.PATH || '');
  // npm 缓存目录指向我们的 usr 目录，不污染系统
  if (!env.npm_config_cache) {
    env.npm_config_cache = path.join(path.dirname(path.dirname(nodeDir)), 'usr', 'npm-cache');
  }
  if (extra) Object.assign(env, extra);
  return env;
}

// ---------------------------------------------------------------------------
// npm install — 直接 node.exe npm-cli.js install
// ---------------------------------------------------------------------------

export async function runNpmInstall(
  cwd: string,
  onLog: (msg: string, level?: string) => void,
): Promise<void> {
  const nodeExe = getNodeExe();
  const npmCli = getNpmCli();
  const args = [
    npmCli, 'install', '--omit=dev',
    '--registry', 'https://registry.npmmirror.com',
    '--no-fund', '--no-audit',
  ];

  onLog(`执行: ${nodeExe} npm-cli.js install`);
  onLog(`工作目录: ${cwd}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    onLog(`npm install (尝试 ${attempt}/3)`);
    try {
      const result = await runProcess(nodeExe, args, { cwd, timeout: 600000 });
      if (result.code === 0) {
        onLog('npm install 完成', 'success');
        return;
      }
      onLog(`npm install 退出码 ${result.code}`, 'error');
      if (result.stderr) onLog(result.stderr.slice(0, 500), 'error');
    } catch (e: any) {
      onLog(`npm install 异常: ${e.message}`, 'error');
    }
    if (attempt < 3) await sleep(2000);
  }
  throw new Error('npm install 失败（3 次重试后放弃）');
}

// ---------------------------------------------------------------------------
// 启动服务 — 生成 .bat，用 cmd.exe 运行
// ---------------------------------------------------------------------------

export function startServer(
  serverDir: string,
  instanceId: string,
  port: number,
  onLog: (msg: string, level?: string) => void,
  onExit?: (code: number | null) => void,
): ChildProcess {
  const nodeExe = getNodeExe();
  const logFile = path.join(logsDir, `${instanceId}.log`);

  // 生成 start-server.bat
  const batContent = `@echo off\r\ncd /d "${serverDir}"\r\nset NODE_ENV=production\r\nset AUTO_LAUNCH=false\r\nset NO_BROWSER=true\r\n"${nodeExe}" server.js\r\n`;
  const batPath = path.join(serverDir, 'start-server.bat');
  fs.writeFileSync(batPath, batContent, 'utf-8');

  onLog(`启动: start-server.bat (端口 ${port})`);

  const env = buildEnv({
    NODE_ENV: 'production',
    AUTO_LAUNCH: 'false',
    NO_BROWSER: 'true',
  });

  // 用 cmd.exe 运行 .bat
  const child = spawn(CMD_EXE, ['/c', batPath], {
    cwd: serverDir,
    env,
    windowsHide: false,
  });
  serverProcess = child;

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  child.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    logStream.write(text);
    text.split('\n').filter(Boolean).forEach((line) => onLog(line.trim()));
  });

  child.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    logStream.write(text);
    text.split('\n').filter(Boolean).forEach((line) => onLog(line.trim(), 'error'));
  });

  child.on('exit', (code) => {
    onLog(`服务端退出 (code=${code})`, code === 0 ? 'success' : 'error');
    logStream.end();
    if (serverProcess === child) {
      serverProcess = null;
      onExit?.(code);
    }
  });

  return child;
}

// ---------------------------------------------------------------------------
// 停止服务 — taskkill /T 杀进程树
// ---------------------------------------------------------------------------

export function stopServer(): void {
  if (serverProcess) {
    const processToStop = serverProcess;
    try {
      const pid = processToStop.pid;
      if (pid) {
        // 同步等待整个进程树退出，避免删除实例时仍有文件句柄占用目录。
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 15000,
        });
      }
    } catch { /* ignore */ }
    try {
      if (!processToStop.killed) processToStop.kill();
    } catch { /* ignore */ }
    serverProcess = null;
  }
}

/** 清理由指定实例目录启动、但不再由当前 Electron 进程跟踪的服务进程。 */
export function stopServerForDirectory(serverDir: string): void {
  const targetBatch = path.join(path.resolve(serverDir), 'start-server.bat');
  const script = [
    '$target = $env:SILLYCLIENT_TARGET_BATCH',
    'if (-not $target) { exit 0 }',
    'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |',
    '  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |',
    '  ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null }',
  ].join('\n');

  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 20000,
      env: { ...process.env, SILLYCLIENT_TARGET_BATCH: targetBatch },
    });
  } catch { /* ignore */ }
}

/** 清理占用实例端口的遗留服务，覆盖应用异常退出后的删除场景。 */
export function stopServerOnPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const script = [
    '$targetPort = [int]$env:SILLYCLIENT_TARGET_PORT',
    'Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue |',
    '  Select-Object -ExpandProperty OwningProcess -Unique |',
    '  ForEach-Object { & taskkill.exe /PID $_ /T /F 2>$null | Out-Null }',
  ].join('\n');

  try {
    spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 20000,
      env: { ...process.env, SILLYCLIENT_TARGET_PORT: String(port) },
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 发送命令到终端
// ---------------------------------------------------------------------------

export function sendCommand(
  text: string,
  cwd: string,
  onLog: (msg: string, level?: string) => void,
): void {
  const child = spawn(CMD_EXE, ['/c', text], {
    cwd,
    env: buildEnv(),
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

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed;
}

/** 执行进程并收集输出 */
function runProcess(
  cmd: string,
  args: string[],
  options: { cwd?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: buildEnv(),
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    const timer = options.timeout
      ? setTimeout(() => { child.kill(); reject(new Error(`超时 (${options.timeout}ms)`)); }, options.timeout)
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
