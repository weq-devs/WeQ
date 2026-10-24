import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportTaskManager, type MediaDeps } from '../src/account/export/task_manager';
import { sourceStamp, roamingDigest, fileSha256 } from '../src/account/export/resume';
import type { MsgService, RenderGroupMsg } from '../src/account/msg';
import { MessageAudit } from '../src/account/export/message_audit';
import { sequenceCoverage } from '../src/account/export/sequence_coverage';
import type { MessageFilter } from '../src/account/message_filter';
import { iterateGroupMessages } from '../src/account/export/message_source';
import { ExportScheduler } from '../src/account/export/scheduler';

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
function fixture(total = 3000, deps: MediaDeps = {}) {
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
    withExportFilter(filter: MessageFilter | undefined, signal?: AbortSignal) {
      return Object.assign(Object.create(this), { exportSignal: signal, exportFilter: filter });
    },
    browse: async () => ({ items: rows.slice(0, 100), hasMore: total > 100 }),
  } as unknown as MsgService;
  return {
    root,
    source,
    msgs,
    rows,
    manager: new ExportTaskManager(msgs, join(root, 'exports'), deps),
  };
}

it('精确导出自己的已发送缓存直接读本地来源，不要求开启联网补全', async () => {
  const fetch = vi.fn(async () => {
    throw Error('本次不应联网补全');
  });
  const cached = vi.fn(async () => [
    {
      kind: 'group' as const,
      conv: '777',
      msgId: '77',
      msgSeq: '2',
      senderUid: 'u_self',
      senderUin: '10001',
      sendTime: '1800000001',
      elements: [{ type: 'text' as const, data: { textContent: '自己的已持久化消息' } }],
      sourceFormat: 'protocol' as const,
      localSent: true,
    },
  ]);
  const f = fixture(1, { messageBackfill: { cached, fetch, cachedForExport: cached } });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '所选自发消息',
    format: 'txt',
    total: 1,
    filter: { messageIds: ['roaming:protocol:2:77'] },
  });
  await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)?.status ?? ''));
  const task = f.manager.getTask(id)!;
  expect(task.status).toBe('completed');
  expect(readFileSync(task.filePath!, 'utf8')).toContain('自己的已持久化消息');
  expect(readFileSync(task.filePath!, 'utf8')).not.toContain('message 0');
  expect(cached).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});

it('后台按预设自动保存且不依赖渲染界面，保留原结果与持久保存回执', async () => {
  const f = fixture(3);
  const target = join(f.root, 'saved');
  mkdirSync(target);
  const manager = new ExportTaskManager(f.msgs, join(f.root, 'exports'), {
    exportSavePolicy: () => ({ mode: 'preset', directory: target }),
  });
  const id = await manager.startTask({
    kind: 'group',
    conv: '777',
    name: '后台保存',
    format: 'txt',
    total: 3,
  });
  await wait(
    () =>
      manager.getTask(id)?.save?.status === 'saved' ||
      manager.getTask(id)?.save?.status === 'failed',
  );
  const task = manager.getTask(id)!;
  expect(task.save?.error).toBeUndefined();
  expect(task.save?.status).toBe('saved');
  expect(task.status).toBe('completed');
  expect(task.save!.path).toBe(join(realpathSync(target), '后台保存.txt'));
  expect(readFileSync(task.save!.path!, 'utf8')).toContain('message 2');
  expect(readFileSync(task.filePath!, 'utf8')).toContain('message 2');
  expect(new ExportTaskManager(f.msgs, join(f.root, 'exports')).getTask(id)?.save).toEqual(
    task.save,
  );
});

it('新的询问偏好不阻断无选择器的后台任务，也不改写全局策略', async () => {
  const preference = { mode: 'before' as const };
  const f = fixture(2, { exportSavePolicy: () => preference });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '后台生成',
    format: 'txt',
    total: 2,
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  expect(f.manager.getTask(id)?.save).toEqual({ policy: { mode: 'after' }, status: 'pending' });
  expect(preference).toEqual({ mode: 'before' });
});

it('开始前没有位置不建任务，单次覆盖保存策略不修改默认配置', async () => {
  const f = fixture(2, { exportSavePolicy: () => ({ mode: 'after' }) });
  await expect(
    f.manager.startTask({
      kind: 'group',
      conv: '777',
      name: '取消',
      format: 'txt',
      total: 2,
      savePolicy: { mode: 'before' },
    }),
  ).rejects.toThrow('保存目录');
  expect(f.manager.listTasks()).toEqual([]);
  const policy = { mode: 'before', directory: join(f.root, 'picked') } as const;
  mkdirSync(policy.directory);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '本次',
    format: 'txt',
    total: 2,
    savePolicy: policy,
  });
  await wait(() => f.manager.getTask(id)?.save?.status === 'saved');
  const later = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '默认',
    format: 'txt',
    total: 2,
  });
  await wait(() => f.manager.getTask(later)?.status === 'completed');
  expect(f.manager.getTask(later)?.save).toEqual({ policy: { mode: 'after' }, status: 'pending' });
});

it('保存失败不改写导出成功，可重新选位置；重复在途保存只复制一次', async () => {
  const f = fixture(2);
  const bad = join(f.root, 'not-a-directory');
  writeFileSync(bad, 'preserve');
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: 'fixture',
    format: 'txt',
    total: 2,
    savePolicy: { mode: 'preset', directory: bad },
  });
  await wait(() => f.manager.getTask(id)?.save?.status === 'failed');
  expect(f.manager.getTask(id)?.status).toBe('completed');
  expect(f.manager.getTask(id)?.error).toBeUndefined();
  expect(readFileSync(bad, 'utf8')).toBe('preserve');
  const target = join(f.root, 'retry');
  mkdirSync(target);
  const saves = await Promise.all([
    f.manager.saveTaskOutput(id, target),
    f.manager.saveTaskOutput(id, target),
  ]);
  expect(saves[0]).toBe(saves[1]);
  expect(f.manager.getTask(id)?.save?.status).toBe('saved');
});

it('已选择的目录失效后不创建替代目录，保留生成结果供重新选择', async () => {
  const f = fixture(2),
    target = join(f.root, 'missing-location');
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '目录失效',
    format: 'txt',
    total: 2,
    savePolicy: { mode: 'preset', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.save?.status === 'failed');
  expect(existsSync(target)).toBe(false);
  const task = f.manager.getTask(id)!;
  expect(task.status).toBe('completed');
  expect(task.error).toBeUndefined();
  expect(existsSync(task.filePath!)).toBe(true);
});

it('定时任务携带自己的保存策略，自动保存失败不能提前结算为成功', async () => {
  const f = fixture(2);
  const bad = join(f.root, 'blocked-target');
  writeFileSync(bad, 'preserve');
  const scheduler = new ExportScheduler(join(f.root, 'schedules'), {
    taskManager: f.manager,
    isOnline: () => true,
  });
  try {
    const schedule = scheduler.create({
      name: 'fixture',
      format: 'txt',
      enabled: true,
      conversations: [{ id: '777', name: 'fixture', kind: 'group', total: 2 }],
      schedule: { mode: 'interval', intervalHours: 24, time: '00:00' },
      options: {
        range: { preset: 'all', start: null, end: null },
        exportMedia: false,
        completeMessages: false,
        exportAvatar: false,
        completeMedia: false,
        downloadVideo: false,
        downloadFile: false,
        downloadPtt: false,
        transcribeVoice: false,
        savePolicy: { mode: 'preset', directory: bad },
      },
    });
    const ids = await scheduler.runNow(schedule.id);
    expect(ids).toHaveLength(1);
    await wait(() => f.manager.getTask(ids[0]!)?.save?.status === 'failed');
    expect(f.manager.getTask(ids[0]!)?.status).toBe('completed');
    expect(scheduler.list()[0]?.history[0]?.outcome).toBe('partial');
    expect(f.manager.getTask(ids[0]!)?.save?.policy).toEqual({
      mode: 'preset',
      filePath: join(bad, 'fixture.txt'),
      uniqueFileName: true,
    });
    expect(scheduler.list()[0]?.options.savePolicy).toEqual({ mode: 'preset', directory: bad });
  } finally {
    scheduler.stop();
  }
});

it('精确间断消息集合贯穿多格式导出、持久任务与不可变参数', async () => {
  const f = fixture(7);
  const ids = ['2', '6'];
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '精确选择',
    format: 'txt',
    formats: ['txt', 'json', 'csv'],
    total: 2,
    filter: { messageIds: ids },
  });
  ids.push('3');
  await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)!.status));
  const task = f.manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.filter?.messageIds).toEqual(['2', '6']);
  expect(task.formatCounts).toEqual({ txt: 2, json: 2, csv: 2 });
  const text = readFileSync(task.filePath!, 'utf8');
  expect(text).toContain('message 1');
  expect(text).toContain('message 5');
  expect(text).not.toContain('message 2');
  const reloaded = new ExportTaskManager(f.msgs, join(f.root, 'exports'));
  expect(reloaded.getTask(id)?.filter?.messageIds).toEqual(['2', '6']);
});

it('精确漫游行不被同数值 ID 的本地消息抢占', async () => {
  const f = fixture(7);
  const source = f.msgs.withExportFilter({ messageIds: ['roaming:protocol:5:2'] });
  const items: RenderGroupMsg[] = [];
  for await (const row of iterateGroupMessages(source, '777', {
    roam: () => [
      {
        kind: 'group',
        conv: '777',
        msgId: '2',
        msgSeq: '5',
        sourceFormat: 'protocol',
        sendTime: '1800000005',
        senderUid: 'u_fixture',
        senderUin: '123',
        elements: [{ type: 'text', data: { textContent: 'remote fixture' } }],
      },
    ],
  }))
    items.push(row);
  expect(items).toHaveLength(1);
  expect(items[0]?.elements).toEqual([{ type: 'text', data: { textContent: 'remote fixture' } }]);
});

it('pause survives worker unwinding and a new manager resumes the same task ID', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const task = f.manager.listTasks()[0];
    if (!paused && task && (task.stages.find((s) => s.key === 'message')?.current ?? 0) >= 1000) {
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

it('旧任务只有格式断点时先建立消息基线，之后可继续增量', async () => {
  const f = fixture(3);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '旧格式断点',
    format: 'txt',
    total: 3,
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const task = f.manager.getTask(id)!;
  expect(f.manager.listBaselines(dirname(task.journalPath!)).items).toHaveLength(1);
  rmSync(task.journalPath!);
  delete task.journalPath;
  task.status = 'paused';
  expect(f.manager.resumeTask(id)).toBe(true);
  await wait(() => ['completed', 'failed'].includes(task.status));
  expect(task.error).toBeUndefined();
  expect(existsSync(task.journalPath!)).toBe(true);
  expect(f.manager.resumeTask(id, true)).toBe(true);
  await wait(() => ['completed', 'failed'].includes(task.status));
  expect(task.error).toBeUndefined();
  expect(task.current).toBe(3);
});

it('来源变化后按已保存消息继续，不因 QQ 正常写入阻断续作', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const t = f.manager.listTasks()[0];
    if (!paused && t && (t.stages[0]?.current ?? 0) >= 1000) {
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
  await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)!.status));
  expect(f.manager.getTask(id)?.error).toBeUndefined();
  expect(f.manager.getTask(id)?.current).toBe(3000);
});

it('暂停收尾生成可保存的有效 JSON，续作与增量不重复消息', async () => {
  const f = fixture();
  let paused = false;
  f.manager.on('progress', () => {
    const t = f.manager.listTasks()[0];
    if (!paused && t && (t.stages.find((s) => s.key === 'message')?.current ?? 0) >= 1000) {
      paused = true;
      f.manager.pauseTask(t.id);
    }
  });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '暂停快照',
    format: 'json',
    total: 3000,
  });
  await wait(() => f.manager.listTasks()[0]?.canResume === true);
  const task = f.manager.getTask(id)!;
  expect(task.current).toBeGreaterThanOrEqual(1000);
  expect(task.partialReady).toBe(false);
  await expect(f.manager.saveTaskOutput(id, join(f.root, 'before-finalize'))).rejects.toThrow();
  let observedFinalizing = false;
  f.manager.on('progress', (event) => {
    if (event.message === '收尾中')
      observedFinalizing =
        f.manager.listTasks().find((task) => task.id === id)?.isFinalizing === true;
  });
  const finishing = f.manager.finalizeTask(id);
  expect(await f.manager.finalizeTask(id)).toBe(false);
  expect(await finishing).toBe(true);
  expect(observedFinalizing).toBe(true);
  const finalized = readFileSync(task.filePath!);
  expect(await f.manager.finalizeTask(id)).toBe(true);
  expect(readFileSync(task.filePath!)).toEqual(finalized);
  expect(() => JSON.parse(readFileSync(task.filePath!, 'utf8'))).not.toThrow();
  const target = join(f.root, 'partial');
  mkdirSync(target);
  expect(await f.manager.saveTaskOutput(id, target)).toContain(target);
  expect(f.manager.resumeTask(id)).toBe(true);
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  expect(f.manager.resumeTask(id, true)).toBe(true);
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  expect(f.manager.getTask(id)?.current).toBe(3000);
});

it('增量导出补入新消息，保留源库已删除的旧记录，重复执行不增加副本', async () => {
  const f = fixture(3);
  const target = join(f.root, 'direct');
  mkdirSync(target);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '增量',
    format: 'jsonl',
    total: 3,
    savePolicy: { mode: 'before', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const path = f.manager.getTask(id)!.filePath!;
  expect(path).toBe(join(realpathSync(target), '增量.jsonl'));
  expect(existsSync(join(f.root, 'exports', `task-${id}`))).toBe(false);
  const old = f.rows.shift()!;
  f.rows.push({
    ...old,
    msgId: 4n,
    msgSeq: 4n,
    elements: [{ type: 'text', data: { textContent: '新增消息' } }],
  });
  writeFileSync(f.source, 'updated database');
  for (let i = 0; i < 2; i++) {
    expect(f.manager.resumeTask(id, true)).toBe(true);
    await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)!.status));
    expect(f.manager.getTask(id)?.error).toBeUndefined();
    expect(f.manager.getTask(id)?.current).toBe(4);
  }
  const rows = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(rows.map((row) => row.msgId)).toEqual(['1', '2', '3', '4']);
  expect(f.manager.deleteTask(id)).toBe(true);
  expect(existsSync(path)).toBe(true);
});

it('选择基线文件夹在新任务中合并归档，不依赖原任务索引且不改写基线', async () => {
  const f = fixture(3, { exportAccountUin: '10001' });
  const target = join(f.root, 'baseline');
  mkdirSync(target);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '基线',
    format: 'jsonl',
    total: 3,
    range: { start: 1800000000, end: 1800000001 },
    savePolicy: { mode: 'before', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const original = readFileSync(f.manager.getTask(id)!.filePath!);
  const removed = f.rows.shift()!;
  f.rows[0]!.elements = [{ type: 'text', data: { textContent: '来源内容已改变' } }];
  f.rows.push({ ...removed, msgId: 4n, msgSeq: 4n });
  const manager = new ExportTaskManager(f.msgs, join(f.root, 'new-exports'), {
    exportAccountUin: '10002',
  });
  const next = await manager.startTask({
    kind: 'group',
    conv: '777',
    name: '增量结果',
    format: 'jsonl',
    total: 3,
    baselineDirectory: target,
  });
  await wait(() => ['completed', 'failed'].includes(manager.getTask(next)!.status));
  expect(manager.getTask(next)?.error).toBeUndefined();
  const rows = readFileSync(manager.getTask(next)!.filePath!, 'utf8')
    .trim()
    .split('\n')
    .map((row) => JSON.parse(row));
  expect(rows.map((row) => row.msgId)).toEqual(['1', '2', '3', '4']);
  expect(JSON.stringify(rows[1])).toContain('message 1');
  expect(manager.getTask(next)?.mergeWarnings?.conflictingMessages).toBe(1);
  expect(readFileSync(f.manager.getTask(id)!.filePath!)).toEqual(original);
  const other = new ExportTaskManager(f.msgs, join(f.root, 'other-account'), {
    exportAccountUin: '10002',
  });
  const bad = await other.startTask({
    kind: 'group',
    conv: '888',
    name: '不同会话',
    format: 'jsonl',
    total: 3,
    baselineDirectory: target,
  });
  await wait(() => other.getTask(bad)?.status === 'failed');
  expect(other.getTask(bad)?.error).toContain('匹配的增量基线');
});

it('直接写入采用独占命名，已有文件和报告均不被覆盖', async () => {
  const f = fixture(2);
  const target = join(f.root, 'direct');
  mkdirSync(target);
  writeFileSync(join(target, '原件.txt'), '用户原件');
  writeFileSync(join(target, '原件 (1).txt.report.json'), '旧报告');
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '原件',
    format: 'txt',
    total: 2,
    savePolicy: { mode: 'preset', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  expect(f.manager.getTask(id)?.save?.path).toBe(join(realpathSync(target), '原件 (2).txt'));
  expect(readFileSync(join(target, '原件.txt'), 'utf8')).toBe('用户原件');
  expect(readFileSync(join(target, '原件 (1).txt.report.json'), 'utf8')).toBe('旧报告');
});

it('多格式直接写入独立目标包，增量和暂停不把几个格式写到同一文件', async () => {
  const f = fixture(3);
  const target = join(f.root, 'bundle');
  mkdirSync(target);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '多个格式',
    format: 'txt',
    formats: ['txt', 'csv', 'json'],
    total: 3,
    savePolicy: { mode: 'before', directory: target },
  });
  await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)!.status));
  const task = f.manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.bundleDir?.startsWith(realpathSync(target))).toBe(true);
  expect(readFileSync(join(task.bundleDir!, '多个格式.txt'), 'utf8')).toContain('message 2');
  expect(readFileSync(join(task.bundleDir!, '多个格式.csv'), 'utf8')).toContain('message 2');
  expect(() =>
    JSON.parse(readFileSync(join(task.bundleDir!, '多个格式.json'), 'utf8')),
  ).not.toThrow();
  expect(task.save?.path).toBe(task.bundleDir);
});

it('续作选项从单文件变为多格式时转入独立目录，不覆盖原文件或混写格式', async () => {
  const f = fixture(3);
  const target = join(f.root, 'options-change');
  mkdirSync(target);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '格式变化',
    format: 'txt',
    total: 3,
    savePolicy: { mode: 'before', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const task = f.manager.getTask(id)!;
  const original = task.filePath!,
    bytes = readFileSync(original);
  task.formats = ['txt', 'json'];
  expect(f.manager.resumeTask(id, true)).toBe(true);
  await wait(() => ['completed', 'failed'].includes(task.status));
  expect(task.error).toBeUndefined();
  expect(task.bundleDir).toBeDefined();
  expect(readFileSync(original)).toEqual(bytes);
  expect(() =>
    JSON.parse(readFileSync(join(task.bundleDir!, '格式变化.json'), 'utf8')),
  ).not.toThrow();
  expect(task.current).toBe(3);
});

it('目标目录失效不重建替代目录，用户修改过的目标文件不被增量覆盖', async () => {
  const f = fixture(2);
  const target = join(f.root, 'direct-protect');
  mkdirSync(target);
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '保护结果',
    format: 'txt',
    total: 2,
    savePolicy: { mode: 'before', directory: target },
  });
  await wait(() => f.manager.getTask(id)?.status === 'completed');
  const task = f.manager.getTask(id)!;
  writeFileSync(task.filePath!, '用户修改');
  expect(f.manager.resumeTask(id, true)).toBe(true);
  await wait(() => f.manager.getTask(id)?.status === 'failed');
  expect(readFileSync(task.filePath!, 'utf8')).toBe('用户修改');
  expect(task.error).toContain('已有修改');
  rmSync(target, { recursive: true });
  expect(f.manager.resumeTask(id)).toBe(true);
  await wait(() => f.manager.getTask(id)?.status === 'failed');
  expect(existsSync(target)).toBe(false);
  expect(task.error).toContain('目录不可用');
});

it('暂停后可单独跳过头像，继续正文且在报告保留用户跳过证据', async () => {
  const get = vi.fn(async () => null);
  const f = fixture(3000, {
    avatarCache: { get } as unknown as NonNullable<MediaDeps['avatarCache']>,
  });
  let paused = false;
  f.manager.on('progress', () => {
    const t = f.manager.listTasks()[0];
    if (!paused && t && (t.stages.find((s) => s.key === 'message')?.current ?? 0) >= 1000) {
      paused = true;
      f.manager.pauseTask(t.id);
    }
  });
  const id = await f.manager.startTask({
    kind: 'group',
    conv: '777',
    name: '跳过头像',
    format: 'txt',
    total: 3000,
    exportAvatar: true,
  });
  await wait(() => f.manager.listTasks()[0]?.canResume === true);
  expect(await f.manager.skipTaskStage(id, 'message')).toBe(false);
  expect(await f.manager.skipTaskStage(id, 'avatar')).toBe(true);
  expect(f.manager.resumeTask(id)).toBe(true);
  await wait(() => ['completed', 'failed'].includes(f.manager.getTask(id)!.status));
  const task = f.manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.current).toBe(3000);
  expect(task.stages.find((s) => s.key === 'avatar')?.status).toBe('skipped');
  expect(get).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(task.reportPath!, 'utf8')).skippedStages).toEqual(['avatar']);
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
  const originalHtml = task.reportHtmlPath!;
  writeFileSync(originalHtml, '已有 HTML 原件');
  delete task.reportHtmlPath;
  expect(f.manager.getReportPath(id)).toMatch(/\.html$/);
  expect(task.reportHtmlPath).not.toBe(originalHtml);
  expect(readFileSync(originalHtml, 'utf8')).toBe('已有 HTML 原件');
  expect(readFileSync(task.reportHtmlPath!, 'utf8')).toContain('导出完整性报告');
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
