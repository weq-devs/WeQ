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
