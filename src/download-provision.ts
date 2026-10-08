/**
 * SillyTavern 官方 Releases 查询、源码下载与解压展平服务
 */

import { net } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as utils from './runtime/utils';
import { checkSignal } from './runtime/operations';
import type { FetchReleasesResult, GithubRelease } from './contracts/ipc-contracts';

export async function fetchReleases(): Promise<FetchReleasesResult> {
  const apiUrl = 'https://api.github.com/repos/SillyTavern/SillyTavern/releases?per_page=20';
  const candidates = [
    apiUrl,
    `https://gh-proxy.com/${apiUrl}`,
  ];
  let lastError: Error | null = null;

  for (const [index, url] of candidates.entries()) {
    try {
      const response = await net.fetch(url, {
        headers: {
          'User-Agent': 'SillyClient-Windows',
          'Accept': 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(index === 0 ? 8000 : 15000),
      });
      const payload = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const raw = JSON.parse(payload);
      if (!Array.isArray(raw)) {
        throw new Error('GitHub 返回了无法识别的版本数据');
      }

      const releases: GithubRelease[] = raw
        .filter((release: any) => release.tag_name && release.zipball_url)
        .map((release: any) => ({
          tag: release.tag_name,
          zipballUrl: release.zipball_url,
          prerelease: Boolean(release.prerelease),
        }));
      if (releases.length === 0) {
        throw new Error('GitHub 未返回可用的 SillyTavern 版本');
      }
      return { releases };
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  try {
    const response = await net.fetch(
      'https://data.jsdelivr.com/v1/package/gh/SillyTavern/SillyTavern',
      {
        headers: {
          'User-Agent': 'SillyClient-Windows',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    const raw = (await response.json()) as any;
    if (!response.ok || !Array.isArray(raw?.versions)) {
      throw new Error(`jsDelivr HTTP ${response.status}`);
    }

    const releases: GithubRelease[] = raw.versions.slice(0, 20).map((version: string) => ({
      tag: version,
      zipballUrl: `https://github.com/SillyTavern/SillyTavern/archive/refs/tags/${encodeURIComponent(version)}.zip`,
      prerelease: version.includes('-'),
    }));
    if (releases.length > 0) {
      return { releases };
    }
  } catch (error: any) {
    lastError = error instanceof Error ? error : new Error(String(error));
  }

  throw new Error(`无法获取 SillyTavern 版本：${lastError?.message || '网络请求失败'}`);
}

export async function downloadWithMirrors(
  originalUrl: string,
  destPath: string,
  onProgress: (pct: number) => void,
  log: (msg: string, level?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const mirrors = [
    originalUrl,
    `https://ghfast.top/${originalUrl}`,
    `https://gh-proxy.com/${originalUrl}`,
    `https://ghproxy.net/${originalUrl}`,
  ];

  let lastError: Error | null = null;
  for (let i = 0; i < mirrors.length; i++) {
    for (let retry = 0; retry < 2; retry++) {
      checkSignal(signal);
      try {
        log(`下载 (镜像 ${i + 1}/${mirrors.length}, 重试 ${retry + 1}/2)`);
        await utils.downloadFile(mirrors[i], destPath, onProgress, signal);
        checkSignal(signal);
        return;
      } catch (e: any) {
        checkSignal(signal);
        lastError = e;
        log(`下载失败: ${e.message}`, 'error');
      }
    }
  }
  throw lastError || new Error('下载失败');
}

export function flattenExtractedDir(dir: string): void {
  while (true) {
    if (fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, 'package.json'))) break;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) break;
    const subdir = path.join(dir, entries[0].name);
    const tempHolder = path.join(path.dirname(dir), `.flatten-${randomUUID()}`);
    fs.renameSync(subdir, tempHolder);
    try {
      for (const entry of fs.readdirSync(tempHolder)) {
        fs.renameSync(path.join(tempHolder, entry), path.join(dir, entry));
      }
    } finally {
      if (fs.existsSync(tempHolder)) {
        fs.rmSync(tempHolder, { recursive: true, force: true });
      }
    }
  }
}
