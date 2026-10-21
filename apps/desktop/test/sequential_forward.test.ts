import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FORWARD_OPTIONS,
  forwardDelay,
  forwardSequentially,
  forwardMessageContent,
  estimateForwardDuration,
  validateForwardOptions,
  formatForwardDuration,
} from '../src/renderer/src/lib/sequentialForward';

describe('逐条转发执行', () => {
  it('默认不限单条最大间隔且忽略错误继续，-1 不截断等待', () => {
    expect(DEFAULT_FORWARD_OPTIONS.maxIntervalMs).toBe(-1);
    expect(DEFAULT_FORWARD_OPTIONS.failure).toBe('skip');
    const options = { ...DEFAULT_FORWARD_OPTIONS, mode: 'original' as const };
    const first = { text: '', nonText: false, timestampMs: 0 };
    const last = { ...first, timestampMs: 7_200_000 };
    expect(forwardDelay(first, options, () => 0.5, last)).toBe(7_200_000);
    expect(() => validateForwardOptions(options)).not.toThrow();
    for (const maxIntervalMs of [-2, -0.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => validateForwardOptions({ ...options, maxIntervalMs })).toThrow('参数无效');
    expect(formatForwardDuration(250)).toBe('0.25 秒');
    expect(formatForwardDuration(3_600_000)).toBe('1 小时');
  });
  it('两种非固定间隔连同抖动一并封顶，预估与实际等待一致', async () => {
    for (const mode of ['text', 'original'] as const) {
      const options = { ...DEFAULT_FORWARD_OPTIONS, mode, maxIntervalMs: 2000, jitterMs: 1000 };
      const content = [
        { text: '很长的文本', nonText: false, timestampMs: 1 },
        { text: '末条', nonText: true, timestampMs: 900000 },
      ];
      expect(forwardDelay(content[0]!, options, () => 1, content[1])).toBe(2000);
      const estimate = estimateForwardDuration(content, options, 1);
      expect(estimate.maxMs).toBe(mode === 'text' ? 4000 : 2000);
      const waits: number[] = [];
      await forwardSequentially(content, options, {
        text: (row) => row.text,
        nonText: (row) => row.nonText,
        time: (row) => row.timestampMs,
        send: vi.fn(),
        progress: vi.fn(),
        signal: new AbortController().signal,
        sleep: async (ms) => {
          waits.push(ms);
        },
      });
      expect(waits.every((ms) => ms <= options.maxIntervalMs)).toBe(true);
    }
    expect(
      forwardDelay('文本', { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 5000, maxIntervalMs: 10 }),
    ).toBe(5000);
  });
  it('单条即使保留文本间隔配置也不等待，预估与执行一致', async () => {
    const options = { ...DEFAULT_FORWARD_OPTIONS, mode: 'text' as const, jitterMs: 100 };
    const sleep = vi.fn();
    await forwardSequentially(['正文'], options, {
      text: String,
      signal: new AbortController().signal,
      progress: vi.fn(),
      send: vi.fn(),
      sleep,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(estimateForwardDuration(['正文'], options, 3)).toEqual({ minMs: 0, maxMs: 0 });
  });
  it('参考相邻原消息间隔，不等待首尾，不重排，同秒逆序缺失时间不产生负延时', async () => {
    const options = { ...DEFAULT_FORWARD_OPTIONS, mode: 'original' as const };
    const rows = [1000, 4500, 4500, 2000, Number.NaN];
    const events: number[] = [];
    await forwardSequentially(rows, options, {
      text: String,
      time: Number,
      signal: new AbortController().signal,
      progress: vi.fn(),
      send: async (row) => {
        events.push(row);
      },
      sleep: async (ms) => {
        events.push(-ms);
      },
    });
    expect(events).toEqual([1000, -3500, 4500, 4500, 2000, Number.NaN]);
    expect(
      estimateForwardDuration(
        rows.map((timestampMs) => ({ text: '', nonText: false, timestampMs })),
        options,
        2,
      ),
    ).toEqual({ minMs: 3500, maxMs: 3500 });
  });
  it('文本默认每字 1 秒，混合媒体和卡片整条计非文本时长，不累计文字', () => {
    expect(DEFAULT_FORWARD_OPTIONS.msPerCharacter).toBe(1000);
    expect(DEFAULT_FORWARD_OPTIONS.nonTextMs).toBe(5000);
    const options = { ...DEFAULT_FORWARD_OPTIONS, mode: 'text' as const };
    expect(forwardDelay('甲😀乙', options)).toBe(3000);
    const mixed = forwardMessageContent({
      body: '很长的文字不计时',
      qqElements: [
        { type: 'text', data: { textContent: '很长的文字不计时' } },
        { type: 'pic', data: {} },
      ],
    });
    expect(forwardDelay(mixed, options)).toBe(options.nonTextMs);
    for (const type of ['ark', 'multiMsg', 'face', 'file', 'ptt']) {
      expect(
        forwardDelay(
          forwardMessageContent({ body: '卡片标题', qqElements: [{ type, data: {} }] }),
          options,
        ),
      ).toBe(options.nonTextMs);
    }
    expect(forwardDelay(mixed, { ...options, nonTextMs: 123 })).toBe(123);
  });
  it('按文本长度逐条发送前等待，包含首尾；并行目标预估不乘目标数', async () => {
    const events: string[] = [];
    const options = { ...DEFAULT_FORWARD_OPTIONS, mode: 'text' as const };
    await forwardSequentially(['甲乙', '丙'], options, {
      text: String,
      signal: new AbortController().signal,
      progress: vi.fn(),
      send: async (row) => {
        events.push(row);
      },
      sleep: async (ms) => {
        events.push(String(ms));
      },
    });
    expect(events).toEqual(['2000', '甲乙', '1000', '丙']);
    expect(
      estimateForwardDuration(
        ['甲乙', { text: '忽略', nonText: true }],
        { ...options, jitterMs: 100 },
        2,
      ),
    ).toEqual({ minMs: 6800, maxMs: 7200 });
    expect(
      estimateForwardDuration(['甲乙', '丙'], { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 200 }, 2),
    ).toEqual({ minMs: 200, maxMs: 200 });
    expect(estimateForwardDuration(['甲', '乙'], options, 0)).toEqual({ minMs: 0, maxMs: 0 });
  });
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
      forwardSequentially(
        ['a', 'b'],
        { ...DEFAULT_FORWARD_OPTIONS, failure: 'abort' },
        {
          send: rejected,
          text: String,
          signal: new AbortController().signal,
          progress: vi.fn(),
        },
      ),
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
