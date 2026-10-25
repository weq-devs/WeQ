import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MessageJournal } from '../src/account/export/message_journal';
import type { RenderGroupMsg } from '../src/account/msg';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const row = (id: number): RenderGroupMsg => ({
  msgId: BigInt(id),
  msgSeq: BigInt(id),
  sendTime: BigInt(id),
  senderUin: 123n,
  senderUid: 'u_test',
  targetGroupCode: '777',
  elements: [{ type: 'text', data: { textContent: `中文消息 ${id}` } }],
});
async function* source(...ids: number[]) {
  for (const id of ids) yield row(id);
}
async function collect(stream: AsyncGenerator<RenderGroupMsg>) {
  const rows = [];
  for await (const message of stream) rows.push(message);
  return rows;
}
function path() {
  const root = mkdtempSync(join(tmpdir(), 'weq-journal-'));
  roots.push(root);
  return join(root, 'messages.jsonl');
}

it('断电留下的不完整尾行回退至最后提交的换行，保留中文和 bigint', async () => {
  const file = path();
  await collect(new MessageJournal(file).capture(source(1)));
  appendFileSync(file, '{"msgId":');
  const rows = await collect(new MessageJournal(file).capture(source(1, 2)));
  expect(rows.map((message) => message.msgId)).toEqual([1n, 2n]);
  expect(rows[0]?.elements).toEqual(row(1).elements);
  expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
});

it('确认提交但损坏的行明确报错，不静默丢掉后续记录', async () => {
  const file = path();
  await collect(new MessageJournal(file).capture(source(1)));
  appendFileSync(file, 'not json\n');
  await expect(collect(new MessageJournal(file).capture(source(2)))).rejects.toThrow();
  expect(readFileSync(file, 'utf8')).toContain('not json');
});

it('漫游消息落入本地后不重复；精确选择仍区分同数值 ID 的来源', async () => {
  const file = path();
  async function* roaming() {
    yield { ...row(1), source: 'roaming', sourceFormat: 'protocol' as const };
  }
  await collect(new MessageJournal(file).capture(roaming()));
  expect(await collect(new MessageJournal(file).capture(source(1)))).toHaveLength(1);
  const exact = path();
  await collect(new MessageJournal(exact, undefined, true).capture(roaming()));
  expect(await collect(new MessageJournal(exact, undefined, true).capture(source(1)))).toHaveLength(
    2,
  );
});

it('暂停回放不查询来源，不重新准备已持久化的消息', async () => {
  const file = path();
  await collect(new MessageJournal(file).capture(source(1)));
  const journal = new MessageJournal(file);
  journal.sealed = true;
  async function* unavailable(): AsyncGenerator<RenderGroupMsg> {
    yield await Promise.reject<RenderGroupMsg>(new Error('不应读源'));
  }
  expect(await collect(journal.capture(unavailable()))).toHaveLength(1);
});

it('合并时保留原内容，记录内容冲突与候选序号缺口', async () => {
  const file = path();
  await collect(new MessageJournal(file).capture(source(1)));
  async function* changed() {
    yield { ...row(1), elements: [{ type: 'text' as const, data: { textContent: '不同正文' } }] };
    yield row(3);
  }
  const journal = new MessageJournal(file);
  const merged = await collect(journal.capture(changed()));
  expect(merged[0]?.elements).toEqual(row(1).elements);
  expect(journal.mergeWarnings('group', '777')).toMatchObject({
    conflictingMessages: 1,
    conflictMessageIds: ['1'],
    sequenceGapCount: 1,
    sequenceGaps: [{ start: '2', end: '2' }],
  });
});
