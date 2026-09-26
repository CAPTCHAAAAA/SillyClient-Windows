import { URL } from 'node:url';

export function resolveLocalChatInstanceId(
  url: string,
  requestedId: string | undefined,
  running: { instanceId: string; url: string } | null,
): string | null {
  if (!running || (requestedId && requestedId !== running.instanceId
    && requestedId !== `scan-${running.instanceId}`)) return null;
  try {
    const target = new URL(url);
    if (target.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || target.origin !== new URL(running.url).origin) return null;
    return running.instanceId;
  } catch {
    return null;
  }
}

export function formatChatName(original: string): string {
  if (typeof original !== 'string' || !original.trim()) return original;
  let title = original.trim();

  // 1. 去除 .jsonl / .json 扩展名
  title = title.replace(/\.jsonl?$/i, '').trim();

  const prefixes: string[] = [];
  const suffixes: string[] = [];
  let foundTimestamp: string | null = null;
  let copySuffix = '';

  // 标准时间戳正则（结尾）：支持各类时间分隔符、毫秒与空格（如 2026-09-24@03h12m10s、2026-09-24 03:12:10）
  const endTsRegex = /(?:[\s_-]+)(\d{4}[-/.]\d{2}[-/.]\d{2})[@\s_-]+(\d{2})[h:.-]\s*(\d{2})[m:.-]\s*(\d{2})(?:s)?(?:\s*\d+ms)?$/i;
  // 紧凑时间戳正则（结尾）：如 20260816-235229、20260816_235229、2026-08-16-235229
  const endCompactTsRegex = /(?:[\s_-]+)(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})[@\s_-]+(\d{2})[-/.]?(\d{2})[-/.]?(\d{2})(?:\s*\d+ms)?$/i;
  // 分支后缀正则（结尾）：- Branch #1 或 Branch #1
  const endBranchRegex = /(?:[\s_-]+|^)Branch\s*#(\d+)$/i;
  // 分支前缀正则（开头）：Branch #1 -
  const startBranchRegex = /^Branch\s*#(\d+)[\s_-]+/i;
  // 副本标记正则（结尾）：(1), (copy)
  const endCopyRegex = /[\s_-]*\((?:\d+|copy)\)$/i;

  let changed = true;
  while (changed) {
    changed = false;

    const copyMatch = endCopyRegex.exec(title);
    if (copyMatch) {
      copySuffix = copyMatch[0].trim();
      title = title.slice(0, copyMatch.index).trim();
      changed = true;
    }

    const bMatch = endBranchRegex.exec(title);
    if (bMatch) {
      suffixes.unshift(bMatch[1]);
      title = title.slice(0, bMatch.index).trim();
      changed = true;
      continue;
    }

    const tsMatch = endTsRegex.exec(title);
    if (tsMatch) {
      if (!foundTimestamp) {
        foundTimestamp = `${tsMatch[1].replace(/[/.]/g, '-')} ${tsMatch[2]}:${tsMatch[3]}:${tsMatch[4]}`;
      }
      title = title.slice(0, tsMatch.index).trim();
      changed = true;
      continue;
    }

    const compactMatch = endCompactTsRegex.exec(title);
    if (compactMatch) {
      if (!foundTimestamp) {
        foundTimestamp = `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]} ${compactMatch[4]}:${compactMatch[5]}:${compactMatch[6]}`;
      }
      title = title.slice(0, compactMatch.index).trim();
      changed = true;
      continue;
    }

    const startBMatch = startBranchRegex.exec(title);
    if (startBMatch) {
      prefixes.push(startBMatch[1]);
      title = title.slice(startBMatch[0].length).trim();
      changed = true;
      continue;
    }
  }

  if (!title) {
    if (foundTimestamp) {
      title = foundTimestamp;
    }
  } else {
    // 检查是否开头就是纯时间戳（无前缀）
    const pureTsRegex = /^(\d{4}[-/.]\d{2}[-/.]\d{2})[@\s_-]+(\d{2})[h:.-]\s*(\d{2})[m:.-]\s*(\d{2})(?:s)?(?:\s*\d+ms)?$/i;
    const pureCompactRegex = /^(\d{4})[-/.]?(\d{2})[-/.]?(\d{2})[@\s_-]+(\d{2})[-/.]?(\d{2})[-/.]?(\d{2})(?:\s*\d+ms)?$/i;
    const pureMatch = pureTsRegex.exec(title);
    if (pureMatch) {
      title = `${pureMatch[1].replace(/[/.]/g, '-')} ${pureMatch[2]}:${pureMatch[3]}:${pureMatch[4]}`;
    } else {
      const pureCMatch = pureCompactRegex.exec(title);
      if (pureCMatch) {
        title = `${pureCMatch[1]}-${pureCMatch[2]}-${pureCMatch[3]} ${pureCMatch[4]}:${pureCMatch[5]}:${pureCMatch[6]}`;
      }
    }
  }

  const branches = [...prefixes, ...suffixes];
  if (branches.length > 0) {
    const depth = branches.length > 1 ? ` (${branches.length}层)` : '';
    title = title ? `${title} · 分支 ${branches.at(-1)}${depth}` : `分支 ${branches.at(-1)}${depth}`;
  }

  if (copySuffix) {
    title = title ? `${title} ${copySuffix}` : copySuffix;
  }

  return title.trim() || original;
}

// SillyTavern reads filename text for rename/export. Only generated CSS content
// may change here; the text node, attributes used as IDs and files stay intact.
function installChatLabels(format: (original: string) => string): void {
  const id = 'sillyclient-chat-labels';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    .select_chat_block_filename.sc-chat-label,
    .chatName > span:last-child.sc-chat-label,
    .chat_name.sc-chat-label,
    .chatAttachmentsName.sc-chat-label {
      font-size: 0 !important;
      line-height: 0 !important;
      color: transparent !important;
    }
    .select_chat_block_filename.sc-chat-label::after,
    .chatName > span:last-child.sc-chat-label::after,
    .chat_name.sc-chat-label::after,
    .chatAttachmentsName.sc-chat-label::after {
      content: attr(data-sc-chat-label);
      font-size: var(--sc-chat-font, 13px) !important;
      line-height: normal !important;
      color: var(--SmartThemeBodyColor, inherit);
      display: inline-block;
      vertical-align: middle;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }`;
  document.head.append(style);

  const selectors = [
    '.select_chat_block_filename',
    '.chatName > span:last-child',
    '.chat_name',
    '.chatAttachmentsName',
  ];
  const selector = selectors.join(', ');
  const ignoredSelector = '#chat, #sheld, #expression-holder, .mes, .mes_text, #send_form, #textgenerationwebui_mes';

  const pending = new Set<HTMLElement>();
  let frame = 0;

  const decorate = (element: HTMLElement) => {
    const original = element.textContent || '';
    const trimmed = original.trim();
    if (!trimmed || trimmed === '–' || trimmed === '-') return;

    const label = format(original);
    if (label === original) {
      if (element.classList.contains('sc-chat-label')) {
        element.classList.remove('sc-chat-label');
        delete element.dataset.scChatLabel;
        element.removeAttribute('aria-label');
        element.removeAttribute('title');
      }
      return;
    }
    if (!element.classList.contains('sc-chat-label')) {
      const currentFontSize = getComputedStyle(element).fontSize
        || (element.parentElement ? getComputedStyle(element.parentElement).fontSize : '');
      if (currentFontSize && currentFontSize !== '0px') {
        element.style.setProperty('--sc-chat-font', currentFontSize);
      }
    }
    element.dataset.scChatLabel = label;
    element.title = original;
    element.setAttribute('aria-label', label);
    element.classList.add('sc-chat-label');
  };

  const collect = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return;
    if (element.closest(ignoredSelector)) return;
    if (element.matches(selector)) pending.add(element as HTMLElement);
    const owner = element.closest<HTMLElement>(selector);
    if (owner) pending.add(owner);
    if (element.childElementCount > 0) {
      element.querySelectorAll<HTMLElement>(selector).forEach(child => pending.add(child));
    }
  };

  collect(document.body);
  pending.forEach(decorate);
  pending.clear();

  new MutationObserver(records => {
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.target instanceof Element && record.target.closest(ignoredSelector)) continue;
      if (record.target instanceof Element && record.target.matches(selector)) {
        pending.add(record.target as HTMLElement);
      }
      for (let j = 0; j < record.addedNodes.length; j++) {
        collect(record.addedNodes[j]);
      }
    }
    if (pending.size && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        pending.forEach(element => { if (element.isConnected) decorate(element); });
        pending.clear();
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}

export function chatLabelScript(): string {
  return `(${installChatLabels.toString()})(${formatChatName.toString()});`;
}
