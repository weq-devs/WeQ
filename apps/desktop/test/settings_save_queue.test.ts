import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsSaveQueue } from '../src/renderer/src/lib/settingsSaveQueue';

afterEach(() => vi.useRealTimers());
describe('设置自动保存队列', () => {
  it('600ms 防抖，只提交最新有效值，同值与无效输入不写入', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    await vi.advanceTimersByTimeAsync(500);
    queue.edit('3', true, save);
    await vi.advanceTimersByTimeAsync(599);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls).toEqual([['3']]);
    queue.edit('3', true, save);
    await queue.flush();
    queue.edit('', false, save);
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
  it('慢请求中允许编辑，后续请求严格串行且合并最新值', async () => {
    let finish!: () => void;
    const save = vi.fn(
      (_value: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    const flushing = queue.flush();
    queue.edit('3', true, save);
    queue.edit('4', true, save);
    expect(save.mock.calls).toEqual([['2']]);
    finish();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls).toEqual([['2'], ['4']]);
    finish();
    await flushing;
    expect(queue.status).toBe('saved');
  });
  it('失败不循环重试，主动重试提交最新输入', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {
      throw new Error('合成失败');
    });
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    expect(await queue.flush()).toBe(false);
    await vi.advanceTimersByTimeAsync(10000);
    expect(save).toHaveBeenCalledTimes(1);
    save.mockResolvedValue(undefined);
    expect(await queue.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('离页在已有请求期间触发 flush 时，等待最新排队值也保存完成', async () => {
    let finish!: () => void;
    const save = vi.fn(
      (_value: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    const background = queue.flush();
    queue.edit('3', true, save);
    let left = false;
    const leaving = queue.flush().then(() => {
      left = true;
    });
    finish();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(left).toBe(false);
    finish();
    await Promise.all([background, leaving]);
    expect(left).toBe(true);
    expect(queue.dirty).toBe(false);
  });
  it('在途请求期间改回原值也排队保存，不丢弃用户的撤回修改', async () => {
    let finish!: () => void;
    const save = vi.fn(
      (_value: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    const flushing = queue.flush();
    queue.edit('1', true, save);
    finish();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls).toEqual([['2'], ['1']]);
    finish();
    await flushing;
    expect(queue.dirty).toBe(false);
  });
  it('恢复等待在途请求，取消旧待保存输入，默认值不会被反写', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const save = vi.fn(
      (_value: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const queue = new SettingsSaveQueue('1');
    queue.edit('2', true, save);
    const flushing = queue.flush();
    queue.edit('3', true, save);
    const suspended = queue.suspend();
    finish();
    await Promise.all([flushing, suspended]);
    queue.edit('3', true, save);
    queue.reset('1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls).toEqual([['2']]);
    expect(queue.dirty).toBe(false);
  });
  it('输入法开始取消半截草稿，卸载后不再提交旧目标', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_value: string) => {});
    const queue = new SettingsSaveQueue('');
    queue.edit('zh', true, save);
    queue.cancelPending();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    queue.edit('中文', true, save);
    await queue.suspend();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
  });
});
