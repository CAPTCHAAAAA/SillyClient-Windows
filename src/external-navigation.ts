export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'block' }
  | { action: 'external'; url: string };

export function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!/^https?:\/\/[^/\\\s?#]/i.test(raw) || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || !url.hostname
      || url.username
      || url.password
      || /^https?:\/\/[^/?#]*@/i.test(raw)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

export function isLauncherUrl(value: unknown): boolean {
  if (
    typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)
    || /^app:\/\/[^/?#]*@/i.test(value)
  ) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'app:' && url.hostname === 'localhost'
      && !url.port && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function decideTavernNavigation(
  value: unknown,
  instanceUrl: string,
  isMainFrame: boolean,
): NavigationDecision {
  if (!isMainFrame) return { action: 'allow' };
  const instance = parseHttpUrl(instanceUrl);
  const raw = typeof value === 'string' ? value.trim() : '';
  // Keep instance-owned blob navigation in the existing download pipeline, never the shell.
  if (/^blob:/i.test(raw)) {
    const origin = /[\u0000-\u0020\u007f\\]/.test(raw) ? null : parseHttpUrl(raw.slice(5));
    return origin && instance && origin.origin === instance.origin
      ? { action: 'allow' } : { action: 'block' };
  }
  const target = parseHttpUrl(value);
  if (!target) return { action: 'block' };
  return instance && target.origin === instance.origin
    ? { action: 'allow' }
    : { action: 'external', url: target.href };
}

export function decideLauncherNavigation(value: unknown, isMainFrame: boolean): NavigationDecision {
  if (!isMainFrame || isLauncherUrl(value)) return { action: 'allow' };
  const target = parseHttpUrl(value);
  return target ? { action: 'external', url: target.href } : { action: 'block' };
}
