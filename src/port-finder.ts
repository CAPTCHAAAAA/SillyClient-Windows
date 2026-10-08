/**
 * 端口探测与可用端口搜寻服务
 */

import * as nodeNet from 'node:net';
import { checkSignal } from './runtime/operations';

export function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = nodeNet.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => {
      tester.close(() => resolve(true));
    });
    tester.listen(port, host);
  });
}

export async function findAvailablePort(
  startPort: number,
  log: (msg: string, level?: string) => void,
  signal?: AbortSignal,
  host = '127.0.0.1',
): Promise<number> {
  for (let p = startPort; p < Math.min(65536, startPort + 100); p++) {
    checkSignal(signal);
    if (await isPortAvailable(p, host)) return p;
  }
  log(`端口 ${startPort}-${Math.min(65535, startPort + 99)} 全部不可用`, 'error');
  throw new Error('No available server port');
}
