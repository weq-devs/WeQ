// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { MessageRegistry } from '../src/main/onebot/registry';
import type { BridgeMessage } from '../src/main/onebot/server';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function path() {
  const dir = await mkdtemp(join(tmpdir(), 'weq-onebot-test-'));
  dirs.push(dir);
  return join(dir, 'registry.json');
}
function msg(patch: Partial<BridgeMessage> = {}): BridgeMessage {
  return {
    key: 'received:9007199254740993123',
    peerType: 'c2c',
    targetId: '7',
    senderUin: 7,
    nickname: '合成用户',
    time: 100,
    sequence: 23,
    message: [{ type: 'text', data: { text: '不应持久化的正文' } }],
    location: {
      conv: 'u_peer',
      msgId: '9007199254740993123',
      msgSeq: 800,
      clientSeq: 23,
      random: 91,
    },
    ...patch,
  };
}

it('精确保留 64 位 ID 和两种私聊序号，重开后仍可定位且不复制正文', async () => {
  const file = await path();
  const first = new MessageRegistry(file);
  const id = first.remember(msg());
  first.flush();
  expect(await readFile(file, 'utf8')).not.toContain('不应持久化的正文');
  const second = new MessageRegistry(file);
  expect(second.get(id)).toMatchObject({
    location: { msgId: '9007199254740993123', msgSeq: 800, clientSeq: 23 },
  });
  expect(second.remember(msg())).toBe(id);
  expect(second.remember(msg({ key: 'other', senderUin: 8 }))).not.toBe(id);
  second.flush();
});

it('回执、引用占位和同步原记录共用同一个外部 ID', () => {
  const registry = new MessageRegistry();
  const placeholder = msg({
    key: 'reference',
    location: { conv: 'u_peer', msgSeq: 0, clientSeq: 23, random: 0 },
    message: [],
  });
  const id = registry.remember(placeholder);
  expect(
    registry.remember(
      msg({ key: 'receipt', location: { conv: 'u_peer', msgSeq: 800, clientSeq: 23, random: 91 } }),
    ),
  ).toBe(id);
  expect(registry.remember(msg())).toBe(id);
  registry.remember(placeholder);
  expect(registry.get(id)?.location).toEqual({
    conv: 'u_peer',
    msgId: '9007199254740993123',
    msgSeq: 800,
    clientSeq: 23,
    random: 91,
  });
});

it('同序号同发送者同一秒的不同真实消息不合并，歧义引用独立登记', () => {
  const registry = new MessageRegistry();
  const first = msg({
    peerType: 'group',
    targetId: '42',
    sequence: 12,
    location: { conv: '42', msgId: '9007199254740993001', msgSeq: 12, clientSeq: 0, random: 91 },
  });
  const second = {
    ...first,
    key: 'other',
    location: { ...first.location!, msgId: '9007199254740993002', random: 92 },
  };
  const a = registry.remember(first);
  const b = registry.remember(second);
  expect(a).not.toBe(b);
  expect(registry.get(a)?.location?.msgId).toBe(first.location!.msgId);
  const quote = registry.remember({
    ...first,
    key: 'ambiguous-reference',
    location: { conv: '42', msgSeq: 12, clientSeq: 0, random: 0 },
    message: [],
  });
  expect([a, b]).not.toContain(quote);
});

it('独立账号索引不会读到另一账号消息；预留 ID 避免崩溃重用', async () => {
  const file = await path();
  const first = new MessageRegistry(file);
  const old = first.remember(msg());
  // 模拟只完成 ID 预留、正文登记尚未刷盘时进程终止。
  const restarted = new MessageRegistry(file);
  expect(restarted.remember(msg({ key: 'new', senderUin: 8 }))).not.toBe(old);
  expect(new MessageRegistry().get(old)).toBeUndefined();
  first.flush();
  restarted.flush();
});

it('损坏索引报错且不覆盖原件', async () => {
  const file = await path();
  await writeFile(file, '{broken');
  expect(() => new MessageRegistry(file)).toThrow('原件');
  expect(await readFile(file, 'utf8')).toBe('{broken');
});

it('增量写入不重写整个快照，日志与快照均不包含正文', async () => {
  const file = await path();
  const registry = new MessageRegistry(file);
  const first = registry.remember(msg());
  registry.flush();
  const snapshot = await readFile(file, 'utf8');
  registry.remember(msg({ key: 'other', senderUin: 8 }));
  registry.flush();
  expect(await readFile(file, 'utf8')).toBe(snapshot);
  const journal = await readFile(`${file}.journal`, 'utf8');
  expect(journal).not.toContain('不应持久化的正文');
  expect(journal.split('\n').filter(Boolean)).toHaveLength(2);
  expect(new MessageRegistry(file).get(first)?.location?.msgId).toBe('9007199254740993123');
});

it('日志达到 1024 条后压缩，意外退出的残尾不吞掉完整记录', async () => {
  const file = await path();
  const registry = new MessageRegistry(file);
  for (let i = 1; i <= 1024; i++) {
    registry.remember(
      msg({
        key: `record-${i}`,
        sequence: i,
        location: { conv: 'u_peer', msgId: String(i), msgSeq: i, clientSeq: i, random: i },
      }),
    );
    registry.flush();
  }
  expect((await stat(`${file}.journal`)).size).toBe(0);
  const first = new MessageRegistry(file);
  const id = first.remember(msg({ key: 'tail', senderUin: 9 }));
  first.flush();
  await appendFile(`${file}.journal`, '{partial');
  const recovered = new MessageRegistry(file);
  expect(recovered.get(id)?.senderUin).toBe(9);
  expect((await stat(`${file}.journal`)).size).toBe(0);
});
