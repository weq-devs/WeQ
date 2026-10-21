import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-task-'));
  roots.push(root);
  const cache = join(root, 'cache');
  return { root, cache, manager: new ExportTaskManager({} as MsgService, cache) };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('独立资源沿用导出任务生命周期', () => {
  it('单文件生成与包内部分失败分别记录，不冒称所有条目成功', async () => {
    const f = fixture();
    const failed = [{ fileName: '表情 2', error: '无法读取原图' }];
    const id = await f.manager.startResourceExport({
      name: '收藏表情',
      kind: 'favorite-emoji',
      output: { kind: 'file', name: '收藏表情', extension: 'zip' },
      savePolicy: { mode: 'after' },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'favorite.zip'), 'synthetic-package');
        return {
          total: 1,
          ok: 1,
          failed: [],
          fileName: 'favorite.zip',
          contents: { total: 3, ok: 2, failed },
        };
      },
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.status).toBe('completed'));
    expect(f.manager.getTask(id)).toMatchObject({
      total: 3,
      current: 2,
      resource: { failed: 1 },
      stages: [{ note: '成功 2 个，失败 1 个', failures: [{ stage: 'file', ...failed[0] }] }],
    });
    expect(readFileSync(f.manager.getTask(id)!.filePath!, 'utf8')).toBe('synthetic-package');
  });
  it('包内计数不一致也不发布单文件', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '不完整计数',
      kind: 'favorite-emoji',
      output: { kind: 'file', name: '收藏表情', extension: 'zip' },
      savePolicy: { mode: 'after' },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'favorite.zip'), 'synthetic-package');
        return {
          total: 1,
          ok: 1,
          failed: [],
          fileName: 'favorite.zip',
          contents: { total: 3, ok: 2, failed: [] },
        };
      },
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.status).toBe('failed'));
    expect(f.manager.getTask(id)?.filePath).toBeUndefined();
  });
  it('完成结果另存保留本次自动避让标记，不覆盖文件且不改任务原来的稍后保存策略', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '合成报告',
      kind: 'assistant-artifact',
      output: { kind: 'file', name: '合成报告', extension: 'txt' },
      savePolicy: { mode: 'after' },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'report.txt'), 'synthetic-report');
        return { total: 1, ok: 1, failed: [], fileName: 'report.txt' };
      },
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.status).toBe('completed'));
    const chosen = join(f.root, 'same.txt');
    writeFileSync(chosen, 'personal');
    const first = await f.manager.saveTaskOutput(id, undefined, chosen, true);
    const second = await f.manager.saveTaskOutput(id, undefined, chosen, true);
    expect(first).not.toBe(second);
    expect(readFileSync(chosen, 'utf8')).toBe('personal');
    expect(readFileSync(first, 'utf8')).toBe('synthetic-report');
    expect(readFileSync(second, 'utf8')).toBe('synthetic-report');
    expect(f.manager.getTask(id)?.save?.policy).toEqual({ mode: 'after' });
  });
  it('单资源文件按真实扩展名保存并保留缓存，删除任务清理自己的整份缓存', async () => {
    const f = fixture(),
      target = join(f.root, 'chosen.db');
    const id = await f.manager.startResourceExport({
      name: '合成数据库',
      kind: 'database',
      output: { kind: 'file', name: '合成数据库', extension: 'db' },
      savePolicy: { mode: 'before', filePath: target },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'fixture.db'), 'synthetic-db');
        return { total: 1, ok: 1, failed: [], fileName: 'fixture.db' };
      },
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.save?.status).toBe('saved'));
    const task = f.manager.getTask(id)!;
    expect(task.bundleDir).toBeUndefined();
    expect(task.filePath?.endsWith('.db')).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('synthetic-db');
    const restored = new ExportTaskManager({} as MsgService, f.cache);
    expect(restored.getTask(id)?.resource?.output).toEqual({
      kind: 'file',
      name: '合成数据库',
      extension: 'db',
    });
    const directory = task.resource!.cacheDirectory!;
    expect(restored.deleteTask(id)).toBe(true);
    expect(readdirSync(f.cache)).not.toContain(directory.split('/').at(-1));
    expect(readFileSync(target, 'utf8')).toBe('synthetic-db');
  });
  it('单文件声明不能掩盖额外产物、缺失文件或下载失败', async () => {
    const f = fixture();
    for (const problem of ['extra', 'missing', 'failed']) {
      const id = await f.manager.startResourceExport({
        name: problem,
        kind: 'database',
        output: { kind: 'file', name: problem, extension: 'db' },
        savePolicy: { mode: 'after' },
        run: async ({ directory }) => {
          if (problem !== 'missing') writeFileSync(join(directory, 'one.db'), 'one');
          if (problem === 'extra') writeFileSync(join(directory, 'extra.bin'), 'extra');
          return problem === 'failed'
            ? {
                total: 1,
                ok: 0,
                failed: [{ fileName: 'one.db', error: 'failed' }],
                fileName: 'one.db',
              }
            : { total: 1, ok: 1, failed: [], fileName: 'one.db' };
        },
      });
      await vi.waitFor(() => expect(f.manager.getTask(id)?.status).toBe('failed'));
      expect(f.manager.getTask(id)?.filePath).toBeUndefined();
    }
  });
  it('删除尚未运行的排队任务后不会继续下载或重新生成结果', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = await f.manager.startResourceExport({
      name: '合成前序',
      kind: 'group-files',
      savePolicy: { mode: 'after' },
      run: async () => {
        await gate;
        return { total: 0, ok: 0, failed: [] };
      },
    });
    const run = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    const second = await f.manager.startResourceExport({
      name: '合成已删除',
      kind: 'group-files',
      savePolicy: { mode: 'after' },
      run,
    });
    expect(f.manager.deleteTask(second)).toBe(true);
    release();
    await vi.waitFor(() => expect(f.manager.getTask(first)?.status).toBe('completed'));
    expect(run).not.toHaveBeenCalled();
    expect(f.manager.getTask(second)).toBeNull();
  });
  it('先生成保留缓存与部分失败清单，重启后仍可另存且不覆盖目标原件', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '合成群文件',
      kind: 'group-files',
      savePolicy: { mode: 'after' },
      run: async ({ directory, progress }) => {
        writeFileSync(join(directory, 'first.txt'), 'synthetic');
        progress(1, 2);
        return { total: 2, ok: 1, failed: [{ fileName: 'missing.txt', error: '合成失败' }] };
      },
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.status).toBe('completed'));
    const task = f.manager.getTask(id)!;
    expect(task.resource?.failed).toBe(1);
    expect(task.stages[0]).toMatchObject({ failed: 1, current: 1, total: 2 });
    expect(readFileSync(join(task.bundleDir!, 'resource-results.json'), 'utf8')).toContain(
      'missing.txt',
    );
    const restored = new ExportTaskManager({} as MsgService, f.cache);
    const target = join(f.root, 'chosen');
    mkdirSync(target);
    writeFileSync(join(target, 'personal.txt'), 'preserve');
    const saved = await restored.saveTaskOutput(id, target);
    expect(readFileSync(join(saved, 'files', 'first.txt'), 'utf8')).toBe('synthetic');
    expect(readFileSync(join(target, 'personal.txt'), 'utf8')).toBe('preserve');
    expect(readFileSync(join(task.bundleDir!, 'files', 'first.txt'), 'utf8')).toBe('synthetic');
  });
  it('自动保存复用现有结果发布，明确单文件位置在入队前被拒绝', async () => {
    const f = fixture(),
      target = join(f.root, 'chosen');
    mkdirSync(target);
    const run = vi.fn(async ({ directory }: { directory: string }) => {
      writeFileSync(join(directory, 'image.jpg'), 'synthetic');
      return { total: 1, ok: 1, failed: [] };
    });
    await expect(
      f.manager.startResourceExport({
        name: '合成相册',
        kind: 'group-albums',
        savePolicy: { mode: 'before', filePath: join(target, 'bad.jpg') },
        run,
      }),
    ).rejects.toThrow(/多个文件/);
    expect(run).not.toHaveBeenCalled();
    const id = await f.manager.startResourceExport({
      name: '合成相册',
      kind: 'group-albums',
      savePolicy: { mode: 'preset', directory: target },
      run,
    });
    await vi.waitFor(() => expect(f.manager.getTask(id)?.save?.status).toBe('saved'));
    expect(
      readFileSync(join(f.manager.getTask(id)!.save!.path!, 'files', 'image.jpg'), 'utf8'),
    ).toBe('synthetic');
  });
  it.each(['pause', 'cancel'] as const)(
    '运行中 %s 后停止且不发布未完成目录，不冒称可续传',
    async (action) => {
      const f = fixture();
      let started = false;
      const id = await f.manager.startResourceExport({
        name: '合成中断',
        kind: 'group-files',
        savePolicy: { mode: 'after' },
        run: async ({ directory, signal }) => {
          writeFileSync(join(directory, 'partial.txt'), 'partial');
          started = true;
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          );
          return { total: 1, ok: 1, failed: [] };
        },
      });
      await vi.waitFor(() => expect(started).toBe(true));
      expect(action === 'pause' ? f.manager.pauseTask(id) : f.manager.cancelTask(id)).toBe(true);
      await vi.waitFor(() =>
        expect(readdirSync(f.cache).some((name) => name.endsWith('.partial'))).toBe(false),
      );
      expect(f.manager.getTask(id)).toMatchObject({
        status: action === 'pause' ? 'paused' : 'cancelled',
      });
      expect(f.manager.getTask(id)?.bundleDir).toBeUndefined();
      expect(f.manager.resumeTask(id)).toBe(false);
      expect(new ExportTaskManager({} as MsgService, f.cache).listTasks()[0]?.canResume).toBe(
        false,
      );
    },
  );
});
