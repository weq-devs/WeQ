import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backgroundTasks, runBackgroundTask } from '../src/main/background_tasks';
import { trackModelDownload } from '../src/main/model_download_task';
import { updateFavoriteImportTask } from '../src/main/favorite_import_task';
import { backgroundTasksRouter } from '../src/main/ipc/routers/background_tasks';
import type { FavoriteEmojiImportPreview, ModelDownloadProgress } from '@weq/service';

afterEach(() => {
  for (const task of backgroundTasks.snapshot()) {
    backgroundTasks.finish(task.id, 'cancelled');
    backgroundTasks.remove(task.id);
  }
});

describe('真实后台状态接入', () => {
  it('模型下载按下载器与模型去重、按模型过滤进度并在结束移除监听', async () => {
    let resolve!: (value: { success: boolean; error?: string }) => void;
    const store = Object.assign(new EventEmitter(), {
      downloadModel: vi.fn(
        () =>
          new Promise<{ success: boolean; error?: string }>((done) => {
            resolve = done;
          }),
      ),
    });
    const download = trackModelDownload(store, 'synthetic', 'OCR');
    expect(trackModelDownload(store, 'synthetic', 'OCR')).toBe(download);
    expect(store.downloadModel).toHaveBeenCalledOnce();
    const progress: ModelDownloadProgress = {
      id: 'other',
      percent: 99,
      downloadedBytes: 10,
      totalBytes: 20,
      speed: 0,
    };
    store.emit('progress', progress);
    expect(backgroundTasks.snapshot()[0]?.progress).toBeUndefined();
    store.emit('progress', { ...progress, id: 'synthetic', percent: 50 });
    expect(backgroundTasks.snapshot()[0]?.progress).toBe(50);
    resolve({ success: false, error: '合成下载失败' });
    await expect(download).rejects.toThrow('合成下载失败');
    expect(backgroundTasks.snapshot()[0]).toMatchObject({ status: 'failed', note: '合成下载失败' });
    expect(store.listenerCount('progress')).toBe(0);
    const retry = trackModelDownload(store, 'synthetic', 'OCR');
    resolve({ success: true });
    await retry;
    expect(backgroundTasks.snapshot().map((task) => task.status)).toEqual(['failed', 'completed']);
  });

  it('返回业务失败不能因 Promise 正常返回而显示完成', async () => {
    await runBackgroundTask(
      { kind: 'database', name: '修复' },
      () => ({ ok: false, error: '空间不足' }),
      (result) => ({ status: result.ok ? 'completed' : 'failed', note: result.error }),
    );
    expect(backgroundTasks.snapshot()[0]).toMatchObject({ status: 'failed', note: '空间不足' });
  });

  it('收藏导入保留部分失败和未确认，不把已发送视为成功', () => {
    const id = backgroundTasks.start({ kind: 'favorite-import', name: '导入' });
    const view: FavoriteEmojiImportPreview = {
      token: 'synthetic',
      phase: 'running',
      expiresAt: 0,
      cancelling: false,
      error: null,
      items: [],
      result: {
        stopped: null,
        items: [
          {
            key: 'a',
            emojiId: null,
            state: 'confirmed',
            description: 'confirmed',
            order: 'confirmed',
            issue: null,
          },
          {
            key: 'b',
            emojiId: null,
            state: 'unconfirmed',
            description: 'not-run',
            order: 'not-run',
            issue: '读回失败',
          },
        ],
      },
    };
    updateFavoriteImportTask(id, view);
    expect(backgroundTasks.snapshot()[0]).toMatchObject({ status: 'running' });
    updateFavoriteImportTask(id, { ...view, phase: 'finished' });
    expect(backgroundTasks.snapshot()[0]).toMatchObject({
      status: 'paused',
      statusLabel: '部分结果待核对',
    });
    expect(backgroundTasks.snapshot()[0]?.details?.join('')).toContain('读回失败');
    const stopped = backgroundTasks.start({ kind: 'favorite-import', name: '停止导入' });
    updateFavoriteImportTask(stopped, { ...view, phase: 'finished', cancelling: true });
    expect(backgroundTasks.snapshot().at(-1)?.status).toBe('cancelled');
    const done = backgroundTasks.start({ kind: 'favorite-import', name: '完整导入' });
    updateFavoriteImportTask(done, {
      ...view,
      phase: 'finished',
      result: { stopped: null, items: view.result!.items.slice(0, 1) },
    });
    expect(backgroundTasks.snapshot().at(-1)?.status).toBe('completed');
  });

  it('任务 RPC 按账号配置筛选，清除核对回执版本，远端不能借桌面任务定位文件', async () => {
    const scope = { uin: 'synthetic', configId: 'live' };
    const id = backgroundTasks.start({ kind: 'database', name: '体检', scope });
    backgroundTasks.update(id, { details: ['合成失败明细'] });
    const open = vi.fn();
    backgroundTasks.setActions(id, [{ id: 'open', label: '定位报告', run: open }]);
    const authorize = vi.fn();
    const remote = backgroundTasksRouter.createCaller({ authorize });
    expect(await remote.list({ ...scope, configId: 'static' })).toEqual([]);
    expect((await remote.list(scope))[0]).not.toHaveProperty('details');
    expect(await remote.details({ id, scope, updatedAt: 0 })).toEqual(['合成失败明细']);
    await expect(
      remote.details({ id, scope: { ...scope, configId: 'static' }, updatedAt: 0 }),
    ).rejects.toThrow('失效');
    await expect(remote.act({ id, scope, action: 'open' })).rejects.toThrow('桌面端');
    expect(open).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalled();
    const desktop = backgroundTasksRouter.createCaller({});
    await desktop.act({ id, scope, action: 'open' });
    expect(open).toHaveBeenCalledOnce();
    const old = backgroundTasks.snapshot()[0]!;
    expect(await desktop.remove({ id, scope, updatedAt: old.updatedAt })).toBe(false);
    backgroundTasks.finish(id, 'completed');
    expect(await desktop.remove({ id, scope, updatedAt: old.updatedAt })).toBe(false);
    expect(
      await desktop.remove({ id, scope, updatedAt: backgroundTasks.snapshot()[0]!.updatedAt }),
    ).toBe(true);
  });
});
