import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { formatChatName, chatLabelScript, resolveLocalChatInstanceId } = require(path.join(process.env.SILLYCLIENT_TEST_HOST_DIST, 'chat-labels.js'));

const running = { instanceId: 'imported-test', url: 'http://127.0.0.1:8123' };
test('scanned card ID resolves to the owned instance registry ID', () => {
  assert.equal(resolveLocalChatInstanceId(`${running.url}/`, 'scan-imported-test', running), running.instanceId);
  assert.equal(resolveLocalChatInstanceId(`${running.url}/`, running.instanceId, running), running.instanceId);
});
test('reopening without an ID resolves only the running instance origin', () => {
  assert.equal(resolveLocalChatInstanceId(`${running.url}/chats?tab=recent`, undefined, running), running.instanceId);
  assert.equal(resolveLocalChatInstanceId('http://127.0.0.1:8124', undefined, running), null);
});
test('missing or stopped runtime cannot enable chat labels', () => {
  assert.equal(resolveLocalChatInstanceId(running.url, running.instanceId, null), null);
});
test('unrelated and remote IDs cannot enable chat labels', () => {
  for (const id of ['remote-test', 'other-import', 'scan-other-import']) {
    assert.equal(resolveLocalChatInstanceId(running.url, id, running), null);
  }
});
test('different origins, protocols and malformed URLs cannot enable chat labels', () => {
  for (const url of ['https://127.0.0.1:8123', 'http://127.0.0.1:8124',
    'http://localhost:8123', 'https://example.com', 'file:///test.html', 'invalid']) {
    assert.equal(resolveLocalChatInstanceId(url, running.instanceId, running), null);
  }
  assert.equal(resolveLocalChatInstanceId('https://example.com', undefined,
    { instanceId: running.instanceId, url: 'https://example.com' }), null);
});

test('legacy branch prefix and timestamp have a readable display label', () => {
  assert.equal(formatChatName('Branch #77 - 2026-03-09@02h28m36s.jsonl'), '2026-03-09 02:28:36 \u00b7 \u5206\u652f 77');
});
test('repeated suffixes compact to the final branch and depth', () => {
  assert.equal(formatChatName('Story - Branch #1 - Branch #9.jsonl'), 'Story \u00b7 \u5206\u652f 9 (2\u5c42)');
  assert.equal(formatChatName('Branch #3 - Story - Branch #9'), 'Story \u00b7 \u5206\u652f 9 (2\u5c42)');
});
test('branch and timestamp interleaved suffixes are peeled correctly', () => {
  assert.equal(formatChatName('Story - Branch #1 - 2026-09-24@03h12m10s.jsonl'), 'Story \u00b7 \u5206\u652f 1');
});
test('timestamp suffixes and extensions are cleanly removed from titled chats', () => {
  assert.equal(formatChatName('Story.jsonl'), 'Story');
  assert.equal(formatChatName('My Branch adventure.jsonl'), 'My Branch adventure');
  assert.equal(formatChatName('Seraphina - 2026-09-24@03h12m10s.jsonl'), 'Seraphina');
  assert.equal(formatChatName('Seraphina - 2026-09-24@03h12m10s123ms.jsonl'), 'Seraphina');
  assert.equal(formatChatName('Seraphina - 2026-09-24 @03h 12m 10s'), 'Seraphina');
  assert.equal(formatChatName('Story - 2026-09-24@03h12m10s (1).jsonl'), 'Story (1)');
});
test('pure branch names and ambiguous branch titles become readable branches', () => {
  assert.equal(formatChatName('Branch #5'), '\u5206\u652f 5');
  assert.equal(formatChatName(' - Branch #9'), '\u5206\u652f 9');
  assert.equal(formatChatName('Branch #4 - '), '\u5206\u652f 4');
});
test('pure timestamp names format to human readable datetime', () => {
  assert.equal(formatChatName('2026-09-24@03h12m10s.jsonl'), '2026-09-24 03:12:10');
  assert.equal(formatChatName('2026-09-24@03h12m10s123ms.jsonl'), '2026-09-24 03:12:10');
});
test('same-timestamp branches keep their distinct numbers', () => {
  assert.notEqual(formatChatName('Branch #7 - 2026-03-09@02h28m36s'),
    formatChatName('Branch #8 - 2026-03-09@02h28m36s'));
});
test('compact timestamps without delimiters are cleanly parsed and stripped', () => {
  assert.equal(formatChatName('chat_default_seraphina_20260816-010949.jsonl'), 'chat_default_seraphina');
  assert.equal(formatChatName('chat_forced_to_share_the_bed_with_your_older_sister__mia_20260816-235229.jsonl'), 'chat_forced_to_share_the_bed_with_your_older_sister__mia');
  assert.equal(formatChatName('Seraphina - 20260816-235229.jsonl'), 'Seraphina');
  assert.equal(formatChatName('Story - 20260816-235229 - Branch #1.jsonl'), 'Story \u00b7 \u5206\u652f 1');
  assert.equal(formatChatName('20260816-235229.jsonl'), '2026-08-16 23:52:29');
});
test('host script is self-contained JavaScript', () => {
  assert.doesNotThrow(() => new Function(chatLabelScript()));
});
