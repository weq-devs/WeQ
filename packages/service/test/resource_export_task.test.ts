import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { updateTransferPolicy, updateClientNetwork } from '../src/common/transfer_policy';
import { networkCost, UNKNOWN_NETWORK } from '../src/common/data_saver';
import { networkScope } from '../src/common/network_scope';

const roots: string[] = [];
const managers: ExportTaskManager[] = [];
async function settled(manager: ExportTaskManager) {
  const pending = manager as unknown as {
    queue: Promise<void>;
    outputSaves: Map<string, Promise<string>>;
  };
  await pending.queue;
  await Promise.all(pending.outputSaves.values());
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-task-'));
  roots.push(root);
  const cache = join(root, 'cache');
  const manager = new ExportTaskManager({} as MsgService, cache);
  managers.push(manager);
  return { root, cache, manager, done: () => settled(manager) };
}
afterEach(async () => {
  for (const manager of managers.splice(0)) {
    for (const task of manager.listTasks())
      if (task.status === 'running' || task.status === 'pending') manager.cancelTask(task.id);
    await settled(manager);
  }
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('独立资源沿用导出任务生命周期', () => {
  it('群文件批量下载只有全部大小已知才汇总字节，部分失败不当作已下载', async () => {
    const f = fixture();
    let report!: () => void;
    let continueRun!: () => void;
    const snapshots: ReturnType<ExportTaskManager['activeResourceTransfers']>[] = [];
    const entered = new Promise<void>((resolve) => {
      report = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      continueRun = resolve;
    });
    const id = await f.manager.startResourceExport({
      kind: 'group-files',
      name: '群文件',
      transferTarget: 'group-activity',
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory, progress, transferProgress, transferItemFinished }) => {
        progress(0, 2);
        transferProgress?.(3, 8, 'a');
        snapshots.push(f.manager.activeResourceTransfers());
        transferProgress?.(1, 2, 'b');
        report();
        await gate;
        transferItemFinished?.('a', false);
        progress(1, 2);
        snapshots.push(f.manager.activeResourceTransfers());
        transferProgress?.(2, 2, 'b');
        transferItemFinished?.('b', true);
        writeFileSync(join(directory, 'b'), 'ok');
        return { total: 2, ok: 1, failed: [{ fileName: 'a', error: '不可用' }] };
      },
    });
    try {
      await entered;
      expect(f.manager.activeResourceTransfers()).toEqual([
        expect.objectContaining({
          id,
          received: 4,
          total: 10,
          itemTransfer: false,
          targets: ['group-activity'],
          files: expect.arrayContaining([
            { target: 'a', received: 3, total: 8 },
            { target: 'b', received: 1, total: 2 },
          ]),
        }),
      ]);
    } finally {
      continueRun();
    }
    await f.done();
    expect(snapshots[0]?.[0]).toMatchObject({ received: 3, total: 8, itemTransfer: true });
    expect(snapshots[1]?.[0]).toMatchObject({
      received: 1,
      total: 2,
      itemTransfer: true,
      processed: 1,
      items: 2,
    });
    expect(f.manager.getTask(id)?.resource?.failed).toBe(1);
    expect(f.manager.activeResourceTransfers()).toEqual([]);
  });
  it('单文件下载只保留目标文件，重启后删除任务也不影响下载文件', async () => {
    const f = fixture();
    mkdirSync(join(f.root, 'downloads'));
    const destination = realpathSync(join(f.root, 'downloads'));
    const target = join(destination, 'attachment.bin');
    writeFileSync(target, 'existing');
    const id = await f.manager.startResourceExport({
      name: '附件',
      kind: 'media',
      output: { kind: 'file', name: 'attachment', extension: 'bin' },
      savePolicy: { mode: 'preset', filePath: target, uniqueFileName: true },
      run: async ({ directory }) => {
        expect(dirname(dirname(directory))).toBe(destination);
        writeFileSync(join(directory, 'original.bin'), 'downloaded');
        expect(readdirSync(destination)).not.toContain('attachment-2.bin');
        return { total: 1, ok: 1, failed: [], fileName: 'original.bin' };
      },
    });
    await f.done();
    const saved = join(destination, 'attachment-2.bin');
    expect(f.manager.getTask(id)).toMatchObject({
      status: 'completed',
      filePath: saved,
      save: { status: 'saved', path: saved },
    });
    expect(readdirSync(f.cache)).toEqual(['export_tasks.json']);
    expect(readdirSync(destination).sort()).toEqual(['attachment-2.bin', 'attachment.bin']);
    const restored = new ExportTaskManager({} as MsgService, f.cache);
    expect(restored.deleteTask(id)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('existing');
    expect(readFileSync(saved, 'utf8')).toBe('downloaded');
  });
  it('原位结束的下载失败离页或重启后仍不进入任务列表', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '附件',
      kind: 'media',
      foreground: true,
      browserOutput: true,
      run: async () => {
        throw new Error('合成的下载失败');
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.status).toBe('failed');
    expect(f.manager.backgroundResourceTask(id, true)).toBe(false);
    expect(f.manager.listTasks(true)).toEqual([]);
    const restored = new ExportTaskManager({} as MsgService, f.cache);
    expect(restored.listTasks(true)).toEqual([]);
  });
  it('单文件下载取消时丢弃暂存文件，不发布目标', async () => {
    const f = fixture();
    const target = join(f.root, 'attachment.bin');
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const id = await f.manager.startResourceExport({
      name: '附件',
      kind: 'mail-attachment',
      output: { kind: 'file', name: 'attachment', extension: 'bin' },
      savePolicy: { mode: 'before', filePath: target },
      run: async ({ directory, signal }) => {
        writeFileSync(join(directory, 'attachment.bin'), 'partial');
        started();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
        return { total: 1, ok: 1, failed: [], fileName: 'attachment.bin' };
      },
    });
    await entered;
    expect(f.manager.cancelTask(id)).toBe(true);
    await f.done();
    expect(f.manager.getTask(id)?.status).toBe('cancelled');
    expect(readdirSync(f.root)).toEqual(['cache']);
    expect(readdirSync(f.cache)).toEqual(['export_tasks.json']);
  });
  it('继续一个策略暂停任务只放行其执行上下文，小附件不按批量下载暂停', async () => {
    const f = fixture();
    updateClientNetwork('manual-phone', networkCost(true, true, 'phone'));
    const run = vi.fn(async () => {
      expect(networkScope.getStore()?.override).toBe(true);
      return { total: 0, ok: 0, failed: [] };
    });
    const id = await networkScope.run(
      { clientId: 'manual-phone', restricted: true, intent: 'interactive' },
      () =>
        f.manager.startResourceExport({
          name: '手动继续',
          kind: 'group-files',
          run,
          savePolicy: { mode: 'before', directory: f.root },
        }),
    );
    await vi.waitFor(() => expect(f.manager.getTask(id)?.networkPaused).toBe(true));
    expect(f.manager.resumeTask(id)).toBe(true);
    await (f.manager as unknown as { queue: Promise<void> }).queue;
    expect(run).toHaveBeenCalledOnce();
    const small = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    await networkScope.run(
      { clientId: 'manual-phone', restricted: true, intent: 'interactive' },
      () =>
        f.manager.startResourceExport({
          name: '小附件',
          kind: 'mail-attachment',
          networkTransfer: { bytes: 100 },
          run: small,
          savePolicy: { mode: 'before', directory: f.root },
        }),
    );
    await (f.manager as unknown as { queue: Promise<void> }).queue;
    expect(small).toHaveBeenCalledOnce();
  });
  it('受限手机创建的联网任务先暂停，其他端和本地任务继续，恢复后只启动策略暂停任务', async () => {
    const f = fixture();
    updateClientNetwork('export-phone', networkCost(true, true, 'phone'));
    const run = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    const id = await networkScope.run(
      { clientId: 'export-phone', restricted: true, intent: 'interactive' },
      () =>
        f.manager.startResourceExport({
          name: '受限批量下载',
          kind: 'group-files',
          run,
          savePolicy: { mode: 'before', directory: f.root },
        }),
    );
    await vi.waitFor(() => expect(f.manager.getTask(id)?.networkPaused).toBe(true));
    expect(run).not.toHaveBeenCalled();
    const localRun = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    await f.manager.startResourceExport({
      name: '本地报告',
      kind: 'annual-report',
      run: localRun,
      savePolicy: { mode: 'before', directory: f.root },
    });
    await vi.waitFor(() => expect(localRun).toHaveBeenCalledOnce());
    updateClientNetwork('export-phone', networkCost(false, false, 'phone'));
    await f.done();
    expect(run).toHaveBeenCalledOnce();
    expect(f.manager.getTask(id)?.status).toBe('completed');
  });
  it('资源附加数据选择贯穿任务参数，不被归档默认选项覆盖', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      kind: 'group-files',
      name: '资源属性',
      archive: { formats: ['json'], profile: 'full', extra: { resourceProperties: false } },
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'resource.bin'), 'chosen');
        return {
          total: 1,
          ok: 1,
          failed: [],
          metadata: [
            {
              sourceId: 'file',
              name: '资源',
              path: 'files/resource.bin',
              attributes: { excluded: '未选择的属性' },
            },
          ],
        };
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
    const text = readFileSync(
      join(f.manager.getTask(id)!.bundleDir!, 'resource-results.json'),
      'utf8',
    );
    expect(text).not.toContain('未选择的属性');
    expect(f.manager.getTask(id)?.extra).toEqual({ resourceProperties: false });
  });
  it('仅资源模式不生成结构化清单，保留实际文件与任务计数', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      kind: 'group-files',
      name: '仅资源',
      archive: { formats: [] },
      includeIntegrityReport: false,
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'resource.bin'), 'chosen');
        return { total: 1, ok: 1, failed: [] };
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
    const task = f.manager.getTask(id)!;
    expect(readdirSync(task.bundleDir!)).toEqual(['files']);
    expect(readFileSync(join(task.bundleDir!, 'files', 'resource.bin'), 'utf8')).toBe('chosen');
    expect(task.current).toBe(1);
  });
  it.each([false, true])(
    '批量下载按本次选择附带报告：%s，重启后保持选择',
    async (includeIntegrityReport) => {
      const f = fixture();
      const id = await f.manager.startResourceExport({
        name: '批量下载',
        kind: 'group-files',
        includeIntegrityReport,
        savePolicy: { mode: 'before', directory: f.root },
        run: async ({ directory }) => {
          writeFileSync(join(directory, 'first.txt'), 'first');
          writeFileSync(join(directory, 'second.txt'), 'second');
          return { total: 2, ok: 2, failed: [] };
        },
      });
      await f.done();
      expect(f.manager.getTask(id)?.save?.status).toBe('saved');
      const task = f.manager.getTask(id)!;
      const savedNames = readdirSync(task.save!.path!);
      expect(savedNames.includes('export-report.json')).toBe(includeIntegrityReport);
      expect(savedNames.includes('export-report.html')).toBe(includeIntegrityReport);
      const restored = new ExportTaskManager({} as MsgService, f.cache);
      expect(restored.getTask(id)?.includeIntegrityReport).toBe(includeIntegrityReport);
      expect(Boolean(restored.getReportPath(id))).toBe(includeIntegrityReport);
    },
  );
  it.each(['file', 'bundle'] as const)('正常下载 %s 不生成或另存聊天完整性报告', async (shape) => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '普通下载',
      kind: 'group-files',
      output: shape === 'file' ? { kind: 'file', name: '普通下载', extension: 'txt' } : undefined,
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'download.txt'), 'synthetic-download');
        return { total: 1, ok: 1, failed: [], fileName: 'download.txt' };
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
    const task = f.manager.getTask(id)!;
    expect(task.reportVersion).toBeUndefined();
    expect(task.reportPath).toBeUndefined();
    expect(task.reportHtmlPath).toBeUndefined();
    expect(f.manager.getReportPath(id)).toBeUndefined();
    expect(readdirSync(task.resource!.cacheDirectory!, { recursive: true })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/report.*\.(json|html)$/)]),
    );
    expect(readdirSync(f.root, { recursive: true })).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/report.*\.(json|html)$/)]),
    );
  });
  it.each(['resource', 'marketpack', 'emojipack'] as const)(
    '旧 %s 下载任务不再提供或重新生成聊天完整性报告，保留已有文件',
    (kind) => {
      const f = fixture();
      mkdirSync(f.cache, { recursive: true });
      const reportPath = join(f.cache, 'old.report.json');
      const reportHtmlPath = join(f.cache, 'old.report.html');
      writeFileSync(reportPath, 'old-json');
      writeFileSync(reportHtmlPath, 'old-html');
      writeFileSync(
        join(f.cache, 'export_tasks.json'),
        JSON.stringify([
          {
            id: 'old-download',
            status: 'completed',
            stages: [],
            [kind]: {},
            reportVersion: 1,
            reportPath,
            reportHtmlPath,
          },
        ]),
      );
      const manager = new ExportTaskManager({} as MsgService, f.cache);
      const task = manager.getTask('old-download')!;
      expect(task.reportPath).toBeUndefined();
      expect(task.reportHtmlPath).toBeUndefined();
      expect(task.reportVersion).toBeUndefined();
      expect(manager.getReportPath(task.id)).toBeUndefined();
      expect(readFileSync(reportPath, 'utf8')).toBe('old-json');
      expect(readFileSync(reportHtmlPath, 'utf8')).toBe('old-html');
    },
  );
  it('旧稍后保存任务保留产物但不自动落盘，新任务拒绝旧模式或未选位置', async () => {
    const f = fixture();
    mkdirSync(f.cache, { recursive: true });
    const filePath = join(f.cache, 'existing.txt');
    writeFileSync(filePath, 'historical-result');
    writeFileSync(
      join(f.cache, 'export_tasks.json'),
      JSON.stringify([
        {
          id: 'old-task',
          name: '旧结果',
          status: 'completed',
          format: 'txt',
          stages: [],
          filePath,
          save: { policy: { mode: 'after' }, status: 'pending' },
        },
      ]),
    );
    const manager = new ExportTaskManager({} as MsgService, f.cache);
    expect(manager.getTask('old-task')?.save).toMatchObject({
      policy: { mode: 'before' },
      status: 'interrupted',
    });
    expect(readFileSync(filePath, 'utf8')).toBe('historical-result');
    const run = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    await expect(
      manager.startResourceExport({ kind: 'group-files', name: '未选位置', run }),
    ).rejects.toThrow('保存目录');
    await expect(
      manager.startResourceExport({
        kind: 'group-files',
        name: '旧模式',
        savePolicy: { mode: 'after' } as unknown as Parameters<
          typeof manager.startResourceExport
        >[0]['savePolicy'],
        run,
      }),
    ).rejects.toThrow('不支持');
    expect(run).not.toHaveBeenCalled();
    expect(manager.listTasks()).toHaveLength(1);
  });
  it('单文件生成与包内部分失败分别记录，不冒称所有条目成功', async () => {
    const f = fixture();
    const failed = [{ fileName: '表情 2', error: '无法读取原图' }];
    const id = await f.manager.startResourceExport({
      name: '收藏表情',
      kind: 'favorite-emoji',
      output: { kind: 'file', name: '收藏表情', extension: 'zip' },
      savePolicy: { mode: 'before', directory: f.root },
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
      savePolicy: { mode: 'before', directory: f.root },
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
  it('完成结果另存保留本次自动避让标记，不覆盖文件且不改任务原策略', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '合成报告',
      kind: 'assistant-artifact',
      output: { kind: 'file', name: '合成报告', extension: 'txt' },
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory }) => {
        writeFileSync(join(directory, 'report.txt'), 'synthetic-report');
        return { total: 1, ok: 1, failed: [], fileName: 'report.txt' };
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
    const originalPolicy = f.manager.getTask(id)?.save?.policy;
    const chosen = join(f.root, 'same.txt');
    writeFileSync(chosen, 'personal');
    const first = await f.manager.saveTaskOutput(id, undefined, chosen, true);
    const second = await f.manager.saveTaskOutput(id, undefined, chosen, true);
    expect(first).not.toBe(second);
    expect(readFileSync(chosen, 'utf8')).toBe('personal');
    expect(readFileSync(first, 'utf8')).toBe('synthetic-report');
    expect(readFileSync(second, 'utf8')).toBe('synthetic-report');
    expect(f.manager.getTask(id)?.save?.policy).toEqual(originalPolicy);
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
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
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
        savePolicy: { mode: 'before', directory: f.root },
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
      savePolicy: { mode: 'before', directory: f.root },
      run: async () => {
        await gate;
        return { total: 0, ok: 0, failed: [] };
      },
    });
    const run = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    const second = await f.manager.startResourceExport({
      name: '合成已删除',
      kind: 'group-files',
      savePolicy: { mode: 'before', directory: f.root },
      run,
    });
    expect(f.manager.deleteTask(second)).toBe(true);
    release();
    await vi.waitFor(() => expect(f.manager.getTask(first)?.status).toBe('completed'));
    expect(run).not.toHaveBeenCalled();
    expect(f.manager.getTask(second)).toBeNull();
  });
  it('自动保存仍保留缓存与部分失败清单，重启后可另存且不覆盖目标原件', async () => {
    const f = fixture();
    const id = await f.manager.startResourceExport({
      name: '合成群文件',
      kind: 'group-files',
      savePolicy: { mode: 'before', directory: f.root },
      run: async ({ directory, progress }) => {
        writeFileSync(join(directory, 'first.txt'), 'synthetic');
        progress(1, 2);
        return { total: 2, ok: 1, failed: [{ fileName: 'missing.txt', error: '合成失败' }] };
      },
    });
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
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
    await f.done();
    expect(f.manager.getTask(id)?.save?.status).toBe('saved');
    expect(
      readFileSync(join(f.manager.getTask(id)!.save!.path!, 'files', 'image.jpg'), 'utf8'),
    ).toBe('synthetic');
  });
  it.each(['pause', 'cancel'] as const)(
    '非续作资源 %s 不提供虚假暂停，取消后不发布未完成目录',
    async (action) => {
      const f = fixture();
      let started = false;
      const id = await f.manager.startResourceExport({
        name: '合成中断',
        kind: 'group-files',
        savePolicy: { mode: 'before', directory: f.root },
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
      if (action === 'pause') expect(f.manager.pauseTask(id)).toBe(false);
      expect(f.manager.cancelTask(id)).toBe(true);
      await vi.waitFor(() =>
        expect(readdirSync(f.cache).some((name) => name.endsWith('.partial'))).toBe(false),
      );
      expect(f.manager.getTask(id)).toMatchObject({
        status: 'cancelled',
      });
      expect(f.manager.getTask(id)?.bundleDir).toBeUndefined();
      expect(f.manager.listTasks()[0]).toMatchObject({ canResume: true, resumeMode: 'restart' });
      expect(new ExportTaskManager({} as MsgService, f.cache).listTasks()[0]?.canResume).toBe(
        false,
      );
      if (action === 'cancel') expect(f.manager.getTask(id)?.error).toBeUndefined();
    },
  );
  it('非续作资源不能手动暂停，取消后旧运行器不能发布，退出后允许重新执行', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return { total: 0, ok: 0, failed: [] };
    });
    const id = await f.manager.startResourceExport({
      name: '暂停收尾',
      kind: 'group-files',
      run,
      savePolicy: { mode: 'before', directory: f.root },
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(f.manager.pauseTask(id)).toBe(false);
    expect(f.manager.listTasks()[0]?.canResume).toBe(false);
    expect(f.manager.resumeTask(id)).toBe(false);
    expect(f.manager.cancelTask(id)).toBe(true);
    release();
    await vi.waitFor(() =>
      expect(readdirSync(f.cache).some((name) => name.endsWith('.partial'))).toBe(false),
    );
    expect(f.manager.getTask(id)?.status).toBe('cancelled');
    expect(f.manager.listTasks()[0]).toMatchObject({ canResume: true, resumeMode: 'restart' });
    expect(f.manager.getTask(id)?.bundleDir).toBeUndefined();
  });
  it('非续作资源拒绝暂停，取消清除中断提示并提供重新执行', async () => {
    const f = fixture();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const run = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      started();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
      return { total: 0, ok: 0, failed: [] };
    });
    const id = await f.manager.startResourceExport({
      name: '暂停后取消',
      kind: 'group-files',
      run,
      savePolicy: { mode: 'before', directory: f.root },
    });
    await entered;
    expect(run).toHaveBeenCalledOnce();
    expect(f.manager.pauseTask(id)).toBe(false);
    expect(f.manager.cancelTask(id)).toBe(true);
    await f.done();
    expect(readdirSync(f.cache).some((name) => name.endsWith('.partial'))).toBe(false);
    expect(f.manager.getTask(id)?.error).toBeUndefined();
    expect(f.manager.listTasks()[0]).toMatchObject({ canResume: true, resumeMode: 'restart' });
  });
  it('取消策略暂停的下载后清除暂停状态，网络恢复也不会重新开始', async () => {
    const f = fixture();
    updateClientNetwork('cancel-phone', networkCost(true, false, 'phone'));
    const run = vi.fn(async () => ({ total: 0, ok: 0, failed: [] }));
    const id = await networkScope.run(
      { clientId: 'cancel-phone', restricted: true, intent: 'batch' },
      () =>
        f.manager.startResourceExport({
          name: '取消受限下载',
          kind: 'group-files',
          run,
          savePolicy: { mode: 'before', directory: f.root },
        }),
    );
    await vi.waitFor(() => expect(f.manager.getTask(id)?.networkPaused).toBe(true));
    expect(f.manager.cancelTask(id)).toBe(true);
    expect(f.manager.getTask(id)).toMatchObject({ status: 'cancelled', networkPaused: false });
    updateClientNetwork('cancel-phone', networkCost(false, false, 'phone'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.manager.getTask(id)?.status).toBe('cancelled');
    expect(run).not.toHaveBeenCalled();
  });
});
