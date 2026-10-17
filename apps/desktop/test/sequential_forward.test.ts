import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FORWARD_OPTIONS,
  forwardDelay,
  forwardSequentially,
} from '../src/renderer/src/lib/sequentialForward';

describe('逐条转发执行', () => {
  it('默认等待真实成功才发下一条，不插入间隔', async () => {
    let finish: (() => void) | undefined;
    const send = vi.fn(async (row: string) => {
      if (row === 'a')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
    });
    const sleep = vi.fn();
    const task = forwardSequentially(['a', 'b'], DEFAULT_FORWARD_OPTIONS, {
      send,
      sleep,
      text: String,
      signal: new AbortController().signal,
      progress: vi.fn(),
    });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    finish!();
    expect(await task).toEqual({ sent: 2, failed: 0 });
    expect(send.mock.calls.map(([row]) => row)).toEqual(['a', 'b']);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('失败重试按单条总次数计，忽略失败后继续', async () => {
    const send = vi.fn(async (row: string) => {
      if (row === 'a') throw new Error('拒绝');
    });
    expect(
      await forwardSequentially(
        ['a', 'b'],
        { ...DEFAULT_FORWARD_OPTIONS, maxAttempts: 3, failure: 'skip' },
        { send, text: String, signal: new AbortController().signal, progress: vi.fn() },
      ),
    ).toEqual({ sent: 1, failed: 1 });
    expect(send.mock.calls.map(([row]) => row)).toEqual(['a', 'a', 'a', 'b']);
  });
  it('中止不会继续下一条，取消在途成功后也不发送后续', async () => {
    const rejected = vi.fn(async () => {
      throw new Error('服务端拒绝');
    });
    await expect(
      forwardSequentially(['a', 'b'], DEFAULT_FORWARD_OPTIONS, {
        send: rejected,
        text: String,
        signal: new AbortController().signal,
        progress: vi.fn(),
      }),
    ).rejects.toThrow('服务端拒绝');
    expect(rejected).toHaveBeenCalledOnce();
    const controller = new AbortController();
    const send = vi.fn(async () => {
      controller.abort();
    });
    await expect(
      forwardSequentially(['a', 'b'], DEFAULT_FORWARD_OPTIONS, {
        send,
        text: String,
        signal: controller.signal,
        progress: vi.fn(),
      }),
    ).rejects.toBeDefined();
    expect(send).toHaveBeenCalledOnce();
  });
  it('固定/按文本长度间隔和随机抖动均有界，文本按字符而非 UTF-16 单元计', () => {
    const options = { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 100, jitterMs: 200 };
    expect(forwardDelay('正文', options, () => 0)).toBe(0);
    expect(forwardDelay('正文', options, () => 1)).toBe(300);
    expect(forwardDelay('甲乙', { ...options, mode: 'text', msPerCharacter: 80 }, () => 0.5)).toBe(
      160,
    );
  });
  it('拒绝无效重试与间隔，不先发出一条再报错', async () => {
    const send = vi.fn();
    await expect(
      forwardSequentially(
        ['a'],
        { ...DEFAULT_FORWARD_OPTIONS, maxAttempts: Number.NaN },
        { send, text: String, signal: new AbortController().signal, progress: vi.fn() },
      ),
    ).rejects.toThrow('参数无效');
    expect(send).not.toHaveBeenCalled();
  });
});
