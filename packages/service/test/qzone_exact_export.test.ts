import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collectQzone, type QzoneExportDeps } from '../src/account/export/qzone_export';
import { ExportTaskManager } from '../src/account/export/task_manager';
import { QzoneHistoryStore } from '../src/account/export/qzone_history';
import type { MsgService } from '../src/account/msg';
import type { QzoneEmotion } from '../src/account/web/qzone';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const row = (tid: string): QzoneEmotion => ({
  tid,
  content: `fixture-${tid}`,
  time: 100,
  images: [],
  videos: [],
  isPrivate: false,
  commentNum: 0,
});
function deps() {
  const fetchMsgList = vi.fn(async () => {
    throw new Error('精确导出不应扫描整空间');
  });
  const fetchPostDetail = vi.fn(async (_uin: string, tid: string) => ({
    post: row(tid),
    content: `fixture-${tid}`,
    contentHasMore: false,
    contentComplete: true,
    repost: null,
    repostHasMore: false,
    repostComplete: true,
  }));
  const fetchInteractions = vi.fn(async () => new Map());
  return { fetchMsgList, fetchPostDetail, fetchInteractions } satisfies QzoneExportDeps;
}
it('空间离散 tid 精确读取，不被日期或旧缓存扩大范围，互动只处理选中条目', async () => {
  const source = deps();
  const data = await collectQzone(
    {
      targetUin: '10001',
      tids: ['a', 'c', 'a'],
      range: { start: 999, end: 1000 },
      includeInteraction: true,
      onProgress: () => {},
      initialRows: [row('unselected')],
    },
    source,
  );
  expect(source.fetchMsgList).not.toHaveBeenCalled();
  expect(source.fetchPostDetail.mock.calls.map((call) => call[1])).toEqual(['a', 'c']);
  expect(data.rows.map((post) => post.tid)).toEqual(['a', 'c']);
  expect(source.fetchInteractions).toHaveBeenCalledWith(
    '10001',
    expect.arrayContaining([
      expect.objectContaining({ tid: 'a' }),
      expect.objectContaining({ tid: 'c' }),
    ]),
    undefined,
    undefined,
  );
  expect(data.selection?.tids).toEqual(['a', 'c']);
});
it('显式空集合不请求网络；缺失能力、身份不匹配和取消均不转为整空间导出', async () => {
  const source = deps();
  expect(
    (await collectQzone({ targetUin: '10001', tids: [], onProgress: () => {} }, source)).rows,
  ).toEqual([]);
  expect(source.fetchPostDetail).not.toHaveBeenCalled();
  expect(source.fetchInteractions).not.toHaveBeenCalled();
  await expect(
    collectQzone(
      { targetUin: '10001', tids: ['a'], onProgress: () => {} },
      { fetchMsgList: source.fetchMsgList },
    ),
  ).rejects.toThrow('精确');
  source.fetchPostDetail.mockImplementationOnce(async () => ({
    post: row('wrong'),
    content: '不相关内容',
    contentHasMore: false,
    contentComplete: true,
    repost: null,
    repostHasMore: false,
    repostComplete: true,
  }));
  await expect(
    collectQzone({ targetUin: '10001', tids: ['a'], onProgress: () => {} }, source),
  ).rejects.toThrow('不匹配');
  const control = new AbortController();
  control.abort();
  await expect(
    collectQzone(
      { targetUin: '10001', tids: ['a'], signal: control.signal, onProgress: () => {} },
      source,
    ),
  ).rejects.toBeDefined();
  expect(source.fetchMsgList).not.toHaveBeenCalled();
});
it('实际空间多格式任务保存 tid 快照，不导出未选历史，按实际条目而非格式副本计数', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-qzone-exact-'));
  roots.push(root);
  const history = new QzoneHistoryStore(root, '10001');
  await history.savePage({
    targetUin: '10001',
    pos: 0,
    nextPos: 1,
    total: 1,
    rows: [row('unselected')],
    termination: 'stable-tail',
  });
  const source = deps();
  const manager = new ExportTaskManager({} as MsgService, root, { qzone: source });
  const tids = ['a', 'c'];
  const id = await manager.startTask({
    kind: 'c2c',
    conv: '10001',
    name: '合成空间',
    qzone: true,
    qzoneTids: tids,
    format: 'json',
    formats: ['json', 'txt', 'html'],
    total: 2,
    range: { start: 999, end: 1000 },
  });
  tids.push('b');
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(manager.getTask(id)!.status); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const task = manager.getTask(id)!;
  expect(task.error).toBeUndefined();
  expect(task.status).toBe('completed');
  expect(task.qzoneTids).toEqual(['a', 'c']);
  expect(task.range).toBeUndefined();
  expect(task.current).toBe(2);
  expect(task.formatCounts).toEqual({ json: 2, txt: 2, html: 2 });
  expect(
    JSON.parse(readFileSync(task.filePath!, 'utf8')).map((post: { tid: string }) => post.tid),
  ).toEqual(['a', 'c']);
  expect(readdirSync(task.bundleDir!)).not.toContain('qzone-history.json');
  expect(readFileSync(join(task.bundleDir!, '合成空间.html'), 'utf8')).not.toContain('unselected');
  expect(new ExportTaskManager({} as MsgService, root).getTask(id)?.qzoneTids).toEqual(['a', 'c']);
});

it('空间暂停保持原 tid，在新管理器中按原范围重新执行', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-qzone-exact-resume-'));
  roots.push(root);
  const source = deps();
  const manager = new ExportTaskManager({} as MsgService, root, { qzone: source });
  let paused = false;
  manager.on('progress', (event) => {
    if (!paused && event.status === 'running') {
      paused = true;
      manager.pauseTask(event.taskId);
    }
  });
  const id = await manager.startTask({
    kind: 'c2c',
    conv: '10001',
    name: '合成空间',
    qzone: true,
    qzoneTids: ['a', 'c'],
    format: 'json',
    total: 2,
  });
  for (let i = 0; i < 400 && !manager.listTasks()[0]?.canResume; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(manager.getTask(id)?.status).toBe('paused');
  expect(manager.listTasks()[0]?.resumeMode).toBe('restart');
  expect(source.fetchPostDetail).not.toHaveBeenCalled();
  const restored = new ExportTaskManager({} as MsgService, root, { qzone: source });
  expect(restored.resumeTask(id)).toBe(true);
  for (let i = 0; i < 400 && !['completed', 'failed'].includes(restored.getTask(id)!.status); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(restored.getTask(id)?.error).toBeUndefined();
  expect(source.fetchPostDetail.mock.calls.map((call) => call[1])).toEqual(['a', 'c']);
  expect(source.fetchMsgList).not.toHaveBeenCalled();
});
