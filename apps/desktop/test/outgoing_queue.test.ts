// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { OutgoingQueue } from '../src/renderer/src/lib/outgoingQueue';

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('逐条发送队列', () => {
  it('确认失败后新提交的消息立即发送，不自动重试失败消息', async () => {
    const queue = new OutgoingQueue();
    const first = vi.fn().mockRejectedValue(new Error('失败'));
    const second = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', first);
    await flush();
    queue.add('b', 'chat', second);
    expect(second).toHaveBeenCalledOnce();
    await flush();
    expect(first).toHaveBeenCalledOnce();
  });

  it('越过失败和此前多条排队消息，新分支仍逐条等待回执', async () => {
    const queue = new OutgoingQueue();
    const first = vi.fn().mockRejectedValueOnce(new Error('失败')).mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    const third = vi.fn().mockResolvedValue(undefined);
    let finish!: () => void;
    const fourth = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const fifth = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', first);
    queue.add('b', 'chat', second);
    queue.add('c', 'chat', third);
    await flush();
    queue.add('d', 'chat', fourth);
    queue.add('e', 'chat', fifth);
    expect(fourth).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    expect(fifth).not.toHaveBeenCalled();
    queue.start('d');
    finish();
    await flush();
    expect(fourth).toHaveBeenCalledOnce();
    expect(fifth).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    queue.start('a');
    await flush();
    await flush();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(fourth).toHaveBeenCalledOnce();
    expect(fifth).toHaveBeenCalledOnce();
  });

  it('前驱正在重试时，新消息等待重试结果，不越过正在发送的消息', async () => {
    const queue = new OutgoingQueue();
    let finish!: () => void;
    const first = vi
      .fn()
      .mockRejectedValueOnce(new Error('失败'))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const second = vi.fn().mockResolvedValue(undefined);
    const third = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', first);
    queue.add('b', 'chat', second);
    await flush();
    queue.start('a');
    queue.add('c', 'chat', third);
    expect(second).not.toHaveBeenCalled();
    expect(third).not.toHaveBeenCalled();
    finish();
    await flush();
    await flush();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
  });

  it('前一条失败不放行，重试成功只放行直接后继', async () => {
    const queue = new OutgoingQueue();
    const first = vi.fn().mockRejectedValueOnce(new Error('失败')).mockResolvedValue(undefined);
    let finish!: () => void;
    const second = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const third = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', first);
    queue.add('b', 'chat', second);
    queue.add('c', 'chat', third);
    await flush();
    expect(second).not.toHaveBeenCalled();
    queue.start('a');
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    finish();
    await flush();
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('可手动越过前驱，重复点击不重复发；不同会话互不阻塞', async () => {
    const queue = new OutgoingQueue();
    const pending = () => new Promise<void>(() => {});
    const second = vi.fn(pending);
    const third = vi.fn().mockResolvedValue(undefined);
    const other = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', pending);
    queue.add('b', 'chat', second);
    queue.add('c', 'chat', third);
    queue.add('d', 'other', other);
    queue.start('b');
    queue.start('b');
    await flush();
    expect(second).toHaveBeenCalledTimes(1);
    expect(third).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('手动发送中间条成功后，仅放行它的后继；更早条的回执不重复发送', async () => {
    const queue = new OutgoingQueue();
    let firstFinish!: () => void;
    const second = vi.fn().mockResolvedValue(undefined);
    const third = vi.fn().mockResolvedValue(undefined);
    queue.add(
      'a',
      'chat',
      () =>
        new Promise<void>((resolve) => {
          firstFinish = resolve;
        }),
    );
    queue.add('b', 'chat', second);
    queue.add('c', 'chat', third);
    queue.start('b');
    await flush();
    expect(third).toHaveBeenCalledOnce();
    firstFinish();
    await flush();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
  });

  it('切账号清空后，旧回执和手动触发均不能继续旧队列', async () => {
    const queue = new OutgoingQueue();
    let finish!: () => void;
    const second = vi.fn().mockResolvedValue(undefined);
    queue.add(
      'a',
      'chat',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    queue.add('b', 'chat', second);
    queue.clear();
    finish();
    queue.start('b');
    await flush();
    expect(second).not.toHaveBeenCalled();
  });

  it('移除失败记录释放重试任务，但不视为成功放行后继', async () => {
    const queue = new OutgoingQueue();
    const first = vi.fn().mockRejectedValue(new Error('失败'));
    const second = vi.fn().mockResolvedValue(undefined);
    queue.add('a', 'chat', first);
    queue.add('b', 'chat', second);
    await flush();
    queue.retain(new Set(['b']));
    queue.start('a');
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    queue.start('b');
    await flush();
    expect(second).toHaveBeenCalledOnce();
  });
});
