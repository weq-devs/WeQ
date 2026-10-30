import { describe, expect, it } from 'vitest';
import { BackgroundTaskRegistry, backgroundTaskVisible } from '../src/shared/background_task';

describe('轻量后台任务回执', () => {
  it('展示订阅抛错不阻断任务开始、结束或其他订阅者', () => {
    const registry = new BackgroundTaskRegistry();
    let seen = 0;
    registry.subscribe(() => {
      throw new Error('合成展示错误');
    });
    registry.subscribe(() => {
      seen++;
    });
    const id = registry.start({ kind: 'model', name: '下载' });
    registry.finish(id, 'completed');
    expect(registry.snapshot()[0]?.status).toBe('completed');
    expect(seen).toBe(2);
  });
  it('订阅不可变快照，结束后忽略迟到进度，重复结束不改变结果', () => {
    const registry = new BackgroundTaskRegistry();
    let events = 0;
    const off = registry.subscribe(() => events++);
    const id = registry.start({ kind: 'model', name: '下载模型' });
    const first = registry.snapshot();
    registry.update(id, { progress: 40 });
    expect(first[0].progress).toBeUndefined();
    registry.finish(id, 'failed', { note: '网络中断' });
    const result = registry.snapshot()[0];
    registry.update(id, { progress: 100 });
    registry.finish(id, 'completed');
    expect(registry.snapshot()[0]).toBe(result);
    expect(result).toMatchObject({ status: 'failed', progress: 40, note: '网络中断' });
    expect(events).toBe(3);
    off();
  });

  it('按账号及配置隔离，跨账号保留全局任务', () => {
    const registry = new BackgroundTaskRegistry();
    registry.start({ kind: 'model', name: '模型' });
    registry.start({ kind: 'forward', name: '转发', scope: { uin: 'a', configId: 'live' } });
    registry.start({ kind: 'database', name: '体检', scope: { uin: 'a' } });
    const visible = (uin: string, configId: string) =>
      registry.snapshot().filter((task) => backgroundTaskVisible(task, { uin, configId }));
    expect(visible('a', 'live')).toHaveLength(3);
    expect(visible('a', 'static')).toHaveLength(2);
    expect(visible('b', 'live')).toHaveLength(1);
    expect(registry.snapshot().filter((task) => backgroundTaskVisible(task, null))).toHaveLength(1);
  });

  it('在途任务不可删除，确认框旧快照不能删掉已变化的结果', () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start({ kind: 'backup', name: '备份' });
    expect(registry.remove(id)).toBe(false);
    registry.finish(id, 'completed');
    const old = registry.snapshot()[0];
    registry.setActions(id, [{ id: 'open', label: '打开', run: () => {} }]);
    expect(registry.remove(id, old)).toBe(false);
    expect(registry.remove(id, registry.snapshot()[0])).toBe(true);
    expect(registry.snapshot()).toHaveLength(0);
  });

  it('只裁剪结束历史，不丢失在途任务及其停止能力', async () => {
    const registry = new BackgroundTaskRegistry(1);
    const running = registry.start({ kind: 'forward', name: '转发' });
    let stopped = false;
    registry.setActions(running, [
      {
        id: 'stop',
        label: '停止',
        run: () => {
          stopped = true;
        },
      },
    ]);
    const old = registry.start({ kind: 'model', name: '旧模型' });
    registry.finish(old, 'completed');
    const next = registry.start({ kind: 'model', name: '新模型' });
    registry.finish(next, 'failed');
    expect(registry.snapshot().map((task) => task.id)).toEqual([running, next]);
    await registry.act(running, 'stop');
    expect(stopped).toBe(true);
  });
});
