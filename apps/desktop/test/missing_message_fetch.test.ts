import { describe, expect, it, vi } from 'vitest';
import {
  fetchMissingContext,
  missingContextRange,
} from '../src/renderer/src/lib/missingMessageFetch';
import { preferenceDefaults, validatePreferencePatch } from '@weq/service/client-preferences';

describe('缺失消息自动拉取', () => {
  it('默认保留手动拉取，设置只接受布尔值与有界整数', () => {
    expect(preferenceDefaults.autoFetchMissingMessages).toBe(false);
    expect(preferenceDefaults.autoFetchMissingContext).toBe(false);
    expect(() =>
      validatePreferencePatch({
        autoFetchMissingMessages: true,
        autoFetchMissingContext: true,
        missingMessageContextCount: 500,
      }),
    ).not.toThrow();
    for (const value of [0, -1, 501, 1.5, '30', NaN, Infinity, null]) {
      expect(() => validatePreferencePatch({ missingMessageContextCount: value })).toThrow();
    }
    expect(() => validatePreferencePatch({ autoFetchMissingContext: 'true' })).toThrow();
  });

  it('按目标两侧分配上下文，并约束到协议范围', () => {
    expect(missingContextRange('100', 30)).toEqual({ startSeq: 85, endSeq: 115 });
    expect(missingContextRange('100', 3)).toEqual({ startSeq: 98, endSeq: 101 });
    expect(missingContextRange('1', 30)).toEqual({ startSeq: 1, endSeq: 16 });
    expect(missingContextRange('4294967295', 30)).toEqual({
      startSeq: 4294967280,
      endSeq: 4294967295,
    });
    for (const target of ['0', '-1', 'no-seq', '4294967296', '1.2'])
      expect(missingContextRange(target, 30)).toBeNull();
  });

  it('沿服务返回游标串行读取，不因首窗为空或未找到目标而提前结束', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, messages: [], nextStartSeq: 95 })
      .mockResolvedValueOnce({ ok: true, messages: ['target'], nextStartSeq: 105 })
      .mockResolvedValueOnce({ ok: true, messages: ['after'], nextStartSeq: null });
    expect(await fetchMissingContext('100', 30, fetch, () => true)).toEqual(['target', 'after']);
    expect(fetch.mock.calls.map(([range]) => range)).toEqual([
      { startSeq: 85, endSeq: 115 },
      { startSeq: 95, endSeq: 115 },
      { startSeq: 105, endSeq: 115 },
    ]);
  });

  it('切换会话或关闭自动功能后丢弃在途结果且不再请求下一页', async () => {
    let active = true;
    const fetch = vi.fn(async () => {
      active = false;
      return { ok: true as const, messages: ['old'], nextStartSeq: 100 };
    });
    expect(await fetchMissingContext('100', 30, fetch, () => active)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('服务失败和未前进的游标会终止，非法目标不发请求', async () => {
    const failed = vi.fn(async () => ({ ok: false as const, message: 'QQ 未在线' }));
    await expect(fetchMissingContext('100', 30, failed, () => true)).rejects.toThrow('QQ 未在线');
    expect(await fetchMissingContext('0', 30, failed, () => true)).toEqual([]);
    expect(failed).toHaveBeenCalledTimes(1);
    await expect(
      fetchMissingContext(
        '100',
        30,
        async () => ({ ok: true, messages: [], nextStartSeq: 85 }),
        () => true,
      ),
    ).rejects.toThrow('未前进');
  });
});
