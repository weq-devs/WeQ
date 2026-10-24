import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { scanDirectories } from '../src/main/directory_scan';
import { discoverViewerSources } from '@weq/service';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-scan-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function chat(path: string) {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'chat.json'),
    JSON.stringify({
      meta: { type: 'group', groupId: '777' },
      messages: [
        {
          msgId: '1',
          sendTime: 1,
          senderUin: '123',
          elements: [{ type: 'text', data: { textContent: '合成消息' } }],
        },
      ],
    }),
  );
}
const inspect = async (path: string) => (await discoverViewerSources(path, true)).sources;
it('当前目录优先，无导出时自动查下一级，深层目录需明确递归', async () => {
  const root = fixture();
  chat(join(root, 'first'));
  chat(join(root, 'nested', 'second'));
  expect((await scanDirectories(root, inspect)).items).toHaveLength(1);
  expect((await scanDirectories(root, inspect, true)).items).toHaveLength(2);
  chat(root);
  expect((await scanDirectories(root, inspect, true)).items).toHaveLength(1);
});
it('递归不跟随符号链接，遇到不可读子目录不丢掉其他结果', async () => {
  const root = fixture();
  chat(join(root, 'good'));
  mkdirSync(join(root, 'bad'));
  symlinkSync(root, join(root, 'loop'));
  const result = await scanDirectories(
    root,
    async (path) => {
      if (path.endsWith('/bad')) throw new Error('synthetic access denied');
      return inspect(path);
    },
    true,
  );
  expect(result.items).toHaveLength(1);
  expect(result.unreadable).toBe(1);
});
it('限制结果数量并标记截断', async () => {
  const root = fixture();
  const result = await scanDirectories(
    root,
    async () => Array.from({ length: 70 }, (_, i) => i),
    true,
  );
  expect(result.items).toHaveLength(64);
  expect(result.truncated).toBe(true);
});
