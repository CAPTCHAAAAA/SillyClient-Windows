/**
 * 网络探测与远程实例连通性检测服务
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { loadRemoteBasicAuth, type RemoteBasicAuthCredentials } from './remote-auth';
import type { PingUrlParams, PingUrlResult } from './contracts/ipc-contracts';

export function probeUrl(
  target: URL,
  authOrigin: string,
  credentials: RemoteBasicAuthCredentials | null,
  redirects = 0,
): Promise<PingUrlResult> {
  return new Promise((resolve) => {
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve({ online: false, error: '连接地址必须使用 HTTP 或 HTTPS' });
      return;
    }

    const protocol = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    if (credentials && target.origin === authOrigin) {
      headers.Authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
    }

    const req = protocol.request(target, { method: 'HEAD', timeout: 10000, headers }, (res: any) => {
      const statusCode = Number(res.statusCode || 0);
      const location = res.headers.location as string | undefined;
      res.destroy();

      if (statusCode >= 300 && statusCode < 400 && location && redirects < 5) {
        const redirected = new URL(location, target);
        void probeUrl(redirected, authOrigin, credentials, redirects + 1).then(resolve);
        return;
      }

      if (statusCode === 401) {
        resolve({
          online: false,
          statusCode,
          authRequired: true,
          error: credentials
            ? 'Basic Auth 验证失败，请检查账号和密码'
            : '该地址需要 Basic Auth 账号和密码',
        });
        return;
      }

      resolve({ online: statusCode >= 200 && statusCode <= 499, statusCode });
    });

    req.on('error', (e: any) => resolve({ online: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false, error: 'timeout' }); });
    req.end();
  });
}

export function pingUrl(opts: PingUrlParams): Promise<PingUrlResult> {
  try {
    const target = new URL(String(opts?.url || ''));
    const credentials: RemoteBasicAuthCredentials | null =
      typeof opts.username === 'string' && typeof opts.password === 'string'
        ? { username: opts.username, password: opts.password }
        : opts.instanceId
          ? loadRemoteBasicAuth(String(opts.instanceId))
          : null;
    return probeUrl(target, target.origin, credentials);
  } catch (error: any) {
    return Promise.resolve({ online: false, error: error?.message || String(error) });
  }
}
