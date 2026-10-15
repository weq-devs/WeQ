import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import { sourceStamp, roamingDigest, fileSha256 } from '../src/account/export/resume';
import type { MsgService, RenderGroupMsg } from '../src/account/msg';
import { MessageAudit } from '../src/account/export/message_audit';
import { sequenceCoverage } from '../src/account/export/sequence_coverage';

const dirs: string[] = [];
it('sequence-gap reports keep exact bounded candidates, not a proof of lost messages', () => {
  const window = { seqs: [10n, 4n, 1n], below: null, above: null };
  const cached = [
    { kind: 'group', conv: '777', msgSeq: '2', sendTime: '20' },
    { kind: 'group', conv: 'other', msgSeq: '3', sendTime: '20' },
  ] as never;
  const report = sequenceCoverage(window, cached, 'group', '777', { start: 10, end: 30 });
  expect(report.ranges).toEqual([
    { start: '3', end: '3' },
    { start: '5', end: '9' },
  ]);
  expect(report.beforeOldestObserved).toBe('unknown');
  expect(report.basis).toContain('not proof');
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const wait = async (check: () => boolean) => {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error('fixture task timed out');
};
function fixture(total = 3000) {
  const root = mkdtempSync(join(tmpdir(), 'weq-export-recovery-'));
  dirs.push(root);
  const source = join(root, 'source.db');
  writeFileSync(source, 'immutable fixture source');
  const rows = Array.from(
    { length: total },
    (_, i) =>
      ({
        msgId: BigInt(i + 1),
        msgSeq: BigInt(i + 1),
        sendTime: 1800000000n + BigInt(i),
        senderUid: 'u_alice',
        senderUin: 123n,
        elements: [{ type: 'text', data: { textContent: 'message ' + i } }],
      }) as RenderGroupMsg,
  );
  const msgs = {
    getGroupAfter: async (_conv: string, seq: bigint, limit: number) =>
      rows.filter((r) => r.msgSeq > seq).slice(0, limit),
    getGroupSeqlessAfterRowId: async () => [],
    countConv: async () => total,
    takeSalvageSkips: () => [],
    exportSourceStamp: () => sourceStamp(source),
    withExportFilter(_filter: unknown, signal?: AbortSignal) {
      return Object.assign(Object.create(this), { exportSignal: signal });
    },
    browse: async () => ({ items: rows.slice(0, 100), hasMore: total > 100 }),
  } as unknown as MsgService;
  return { root, source, msgs, manager: new ExportTaskManager(msgs, join(root, 'exports')) };
}

it('pause survives worker unwinding and a new manager resumes the same task ID', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const task = f.manager.listTasks()[0];
    if (!paused && task?.stages.find((s) => s.key === 'message')?.current! >= 1000) {
      paused = true;
      f.manager.pauseTask(task.id);
    }
  });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: 'test',
    format: 'txt',
    total: 3000,
  });
  await wait(() => f.manager.listTasks()[0]?.canResume === true);
  expect(f.manager.getTask(id)?.status).toBe('paused');
  const reloaded = new ExportTaskManager(f.msgs, join(f.root, 'exports'));
  expect(reloaded.resumeTask(id)).toBe(true);
  await wait(
    () => reloaded.getTask(id)?.status === 'completed' || reloaded.getTask(id)?.status === 'failed',
  );
  expect(reloaded.getTask(id)?.status).toBe('completed');
  expect(reloaded.getTask(id)?.current).toBe(3000);
  expect(readFileSync(reloaded.getTask(id)!.filePath!, 'utf8').split('message ').length - 1).toBe(
    3000,
  );
});

it('a completed format checkpoint is hash-verified and reused after restart', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const task = f.manager.listTasks()[0];
    if (
      !paused &&
      task?.formatCheckpoints?.txt &&
      task.stages.find((s) => s.key === 'message')!.current >= 4000
    ) {
      paused = true;
      f.manager.pauseTask(task.id);
    }
  });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: 'test',
    format: 'txt',
    formats: ['txt', 'csv'],
    total: 3000,
  });
  await wait(() => f.manager.listTasks()[0]?.canResume === true);
  const checkpoint = f.manager.getTask(id)!.formatCheckpoints!.txt!;
  const bytes = readFileSync(checkpoint.result.filePath);
  const reloaded = new ExportTaskManager(f.msgs, join(f.root, 'exports'));
  expect(reloaded.resumeTask(id)).toBe(true);
  await wait(() => ['completed', 'failed'].includes(reloaded.getTask(id)!.status));
  expect(reloaded.getTask(id)?.error).toBeUndefined();
  expect(reloaded.getTask(id)?.current).toBe(3000);
  expect(reloaded.getTask(id)?.formatCounts).toEqual({ txt: 3000, csv: 3000 });
  expect(readFileSync(checkpoint.result.filePath)).toEqual(bytes);
  expect(reloaded.listTasks()[0]!.logs.some((line) => line.text.includes('复用已校验'))).toBe(true);
});

it('changed source refuses resume instead of combining two snapshots', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const t = f.manager.listTasks()[0];
    if (!paused && t?.stages[0]?.current! >= 1000) {
      paused = true;
      f.manager.pauseTask(t.id);
    }
  });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: 'test',
    format: 'txt',
    total: 3000,
  });
  await wait(() => f.manager.listTasks()[0]?.canResume === true);
  writeFileSync(f.source, 'changed source');
  expect(f.manager.resumeTask(id)).toBe(true);
  await wait(() => f.manager.getTask(id)?.status === 'failed');
  expect(f.manager.getTask(id)?.error).toContain('来源数据库或导出选项已变化');
});

it('report separates actual message counts from format copies and full-history claims', async () => {
  const f = fixture(4);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: 'test',
    format: 'txt',
    formats: ['txt', 'csv'],
    total: 4,
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const task = f.manager.getTask(id)!;
  const report = JSON.parse(readFileSync(task.reportPath!, 'utf8'));
  expect(report.messages.exported).toBe(4);
  expect(report.messages.byFormat).toEqual({ txt: 4, csv: 4 });
  expect(report.messages.parsing.unknownElements).toBe(0);
  expect(report.allServerHistoryVerified).toBe(false);
  expect(report.media.originalQualityVerified).toBe(false);
});

it('preflight distinguishes bounded sampling from exact filtered counts', async () => {
  const f = fixture();
  const result = await f.manager.preflight({
    kind: 'group',
    conv: '777',
    filter: { keyword: 'message' },
    formats: ['txt'],
  });
  expect(result.sourceMessages).toBe(3000);
  expect(result.matchingMessages).toBeNull();
  expect(result.matchingLowerBound).toBe(100);
  expect(result.estimatedMessageBytes).toBeNull();
  expect(result.availableBytes).toBeGreaterThan(0);
});

it('message audit counts unknown and empty content without claiming missing source rows', () => {
  const audit = new MessageAudit();
  audit.observe([]);
  audit.observe([{ type: 'unknown', data: {} }] as never);
  expect(audit.coverage).toEqual({
    messages: 2,
    unknownMessages: 1,
    unknownElements: 1,
    emptyMessages: 1,
  });
});
it('roaming binding is order independent but detects changed content and counts', () => {
  const a = { msgId: '1', text: 'hello' },
    b = { msgId: '2', text: 'world' };
  expect(roamingDigest([a, b])).toBe(roamingDigest([b, a]));
  expect(roamingDigest([a, b])).not.toBe(roamingDigest([a, { ...b, text: 'changed' }]));
  expect(roamingDigest([a, b])).not.toBe(roamingDigest([a, b, b]));
});
it('checkpoint hashing honours cancellation before opening a file', async () => {
  const f = fixture(1),
    abort = new AbortController();
  abort.abort();
  await expect(fileSha256(f.source, abort.signal)).rejects.toBeDefined();
});
