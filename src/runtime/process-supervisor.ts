import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';

interface OwnedProcess {
  child: ChildProcess;
  directory: string;
  instanceId?: string;
  operationId?: string;
  closed: Promise<void>;
  stopping?: Promise<void>;
}

const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const TASKKILL = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

function waitWithTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    }, () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** Only children actually spawned by this application can be terminated. */
export class ProcessSupervisor {
  private owned = new Map<ChildProcess, OwnedProcess>();

  track(child: ChildProcess, directory: string, metadata?: {
    instanceId?: string; operationId?: string;
  }): void {
    let close!: () => void;
    const owned: OwnedProcess = {
      child,
      directory: path.resolve(directory),
      ...metadata,
      closed: new Promise<void>((resolve) => { close = resolve; }),
    };
    this.owned.set(child, owned);
    child.once('close', () => {
      this.owned.delete(child);
      close();
    });
    child.once('error', () => {
      if (!child.pid) {
        this.owned.delete(child);
        close();
      }
    });
  }

  owns(child: ChildProcess): boolean {
    return this.owned.has(child);
  }

  async stop(child: ChildProcess): Promise<void> {
    const record = this.owned.get(child);
    if (!record) return;
    if (record.stopping) return record.stopping;
    record.stopping = this.stopOwned(record).catch((error) => {
      record.stopping = undefined;
      throw error;
    });
    return record.stopping;
  }

  private async stopOwned(record: OwnedProcess): Promise<void> {
    const { child } = record;
    if (!this.owned.has(child)) return;
    const alive = () => child.exitCode === null && child.signalCode === null;
    if (process.platform === 'win32' && child.pid && alive()) {
      await new Promise<void>((resolve) => {
        let helper: ChildProcess;
        try {
          helper = spawn(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        } catch {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try { helper.kill(); } catch { /* helper already exited */ }
          finish();
        }, 15000);
        helper.once('close', finish);
        helper.once('error', finish);
      });
    }
    if (this.owned.has(child) && alive()) {
      try { child.kill(); } catch { /* wait below confirms actual exit */ }
    }
    if (!(await waitWithTimeout(record.closed, 5000))) {
      const error = new Error(`Owned process did not exit (pid=${child.pid ?? 'unknown'})`);
      error.name = 'ProcessTerminationError';
      throw error;
    }
  }

  async stopDirectory(directory: string): Promise<void> {
    const resolved = path.resolve(directory).toLowerCase();
    const children = [...this.owned.values()]
      .filter((record) => record.directory.toLowerCase() === resolved);
    await Promise.all(children.map((record) => this.stop(record.child)));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.owned.keys()].map((child) => this.stop(child)));
  }

  activeDirectories(): string[] {
    return [...new Set([...this.owned.values()].map((record) => record.directory))];
  }
}
