import { describe, expect, it } from 'vitest';
import { BackgroundTaskRegistry, backgroundTaskVisible } from '../src/shared/background_task';

describe('轻量后台任务回执', () => {
  it('关闭页面只释放本页本账号的临时任务，在途任务结束后再删除', () => {
    const registry = new BackgroundTaskRegistry();
    const scope = { uin: 'synthetic' };
    const input = { kind: 'database' as const, name: '体检', scope, ownerId: 'page-a' };
    const completed = registry.start(input);
    const failed = registry.start(input);
    const running = registry.start(input);
    registry.finish(completed, 'completed');
    registry.finish(failed, 'failed');
    const otherPage = registry.start({ ...input, ownerId: 'page-b' });
    const otherAccount = registry.start({ ...input, scope: { uin: 'other' } });
    const persistent = registry.start({ kind: 'backup', name: '备份', scope });

    registry.releaseOwner('page-a', scope);
    expect(registry.snapshot().map((task) => task.id)).toEqual([
      running,
      otherPage,
      otherAccount,
      persistent,
    ]);
    expect(registry.remove(running)).toBe(false);
    registry.finish(running, 'cancelled');
    registry.setActions(running, [{ id: 'retry', label: '重试', run: () => {} }]);
    registry.update(running, { progress: 100 });
    expect(registry.snapshot().map((task) => task.id)).toEqual([
      otherPage,
      otherAccount,
      persistent,
    ]);
    registry.releaseOwner('page-a', scope);
    expect(registry.snapshot()).toHaveLength(3);
  });

  it('各类任务自动保留开始、进度、暂停、继续与失败日志，操作刷新不刷屏', () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start({ kind: 'backup', name: '备份数据库' });
    registry.update(id, { progress: 25, note: '正在复制数据库' });
    const before = registry.snapshot()[0].logs!;
    registry.update(id, { progress: 25, note: '正在复制数据库' });
    registry.setActions(id, []);
    expect(registry.snapshot()[0].logs).toBe(before);
    registry.finish(id, 'paused', { statusLabel: '等待磁盘' });
    registry.resume(id);
    registry.finish(id, 'failed', { note: '目标磁盘已断开' });
    const task = registry.snapshot()[0];
    expect(task.logs?.map((line) => line.text).join('\n')).toMatch(/开始.*备份数据库/);
    expect(task.logs?.some((line) => line.text.includes('25%'))).toBe(true);
    expect(task.logs?.some((line) => line.text.includes('等待磁盘'))).toBe(true);
    expect(task.logs?.some((line) => line.text.includes('继续'))).toBe(true);
    expect(task.logs?.at(-1)).toMatchObject({ level: 'error' });
    expect(task.logs?.at(-1)?.text).toContain('目标磁盘已断开');
    expect(task.finishedAt).toBeGreaterThanOrEqual(task.startedAt);
  });

  it('高频字节进度只按检查点记录，日志容量有界且序号连续递增', () => {
    const registry = new BackgroundTaskRegistry();
    const id = registry.start({ kind: 'model', name: '模型' });
    for (let i = 0; i < 1000; i++)
      registry.update(id, { progress: i / 10, note: `${i} / 1000 KiB` });
    expect(registry.snapshot()[0].logs!.length).toBeLessThan(20);
    for (let i = 0; i < 500; i++) registry.update(id, { statusLabel: `阶段 ${i}` });
    const logs = registry.snapshot()[0].logs!;
    expect(logs.length).toBeLessThanOrEqual(300);
    expect(logs[0].seq).toBeGreaterThan(1);
    expect(new Set(logs.map((line) => line.seq)).size).toBe(logs.length);
  });

  it('业务显式提供日志时保持原内容和分阶段序号，不混入自动日志', () => {
    const registry = new BackgroundTaskRegistry();
    const logs = [{ ts: 1, seq: 10, stage: 'groups', level: 'info' as const, text: '群名单' }];
    const id = registry.start({ kind: 'contacts', name: '联系人' });
    registry.update(id, { logs });
    registry.update(id, { progress: 80, note: '群资料' });
    registry.finish(id, 'completed');
    expect(registry.snapshot()[0].logs).toBe(logs);
  });

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
