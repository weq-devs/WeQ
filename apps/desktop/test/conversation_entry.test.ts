import { describe, expect, it, vi } from 'vitest';
import { loadConversationEntry, type EntryWindow } from '../src/renderer/src/lib/conversationEntry';

const row = (msgSeq: string) => ({ msgSeq });
type Row = ReturnType<typeof row>;
const cached = (rows: Row[]): EntryWindow<Row> => ({
  rows,
  anchored: true,
  hasOlder: true,
  hasNewer: false,
});
function fixture() {
  return {
    readFromFirstUnread: true,
    dirty: false,
    limit: 2,
    before: vi
      .fn<(seq: string, limit: number) => Promise<Row[]>>()
      .mockResolvedValue([row('10'), row('9')]),
    after: vi.fn<(seq: string, limit: number) => Promise<Row[]>>().mockResolvedValue([row('11')]),
    latest: vi.fn<(limit: number) => Promise<Row[]>>().mockResolvedValue([row('12'), row('11')]),
    current: vi.fn().mockReturnValue(true),
    show: vi.fn<(window: EntryWindow<Row>, first: boolean) => void>(),
  };
}

describe('会话分阶段打开', () => {
  it('冷首屏先显示真实本地页，合并完成前保留未完成标记；空本地页不误报空会话', async () => {
    const f = fixture();
    let finish!: (rows: Row[]) => void;
    const task = loadConversationEntry({
      ...f,
      readFromFirstUnread: false,
      progressiveLatest: async (_size, show) => {
        show([]);
        show([row('10'), row('9')]);
        return new Promise<Row[]>((done) => {
          finish = done;
        });
      },
    });
    expect(f.show).toHaveBeenCalledOnce();
    expect(f.show.mock.calls[0]![0].rows).toEqual([row('9'), row('10')]);
    expect(f.show.mock.calls[0]).toHaveLength(3);
    finish([row('11'), row('10')]);
    await task;
    expect(f.show).toHaveBeenLastCalledWith(
      expect.objectContaining({ rows: [row('10'), row('11')] }),
      false,
    );
  });
  it('已有完整缓存时不被本地中间页替换，仍接收最终校准', async () => {
    const f = fixture();
    await loadConversationEntry({
      ...f,
      readFromFirstUnread: false,
      cached: cached([row('9'), row('10')]),
      progressiveLatest: async (_size, show) => {
        show([row('8')]);
        return [row('11')];
      },
    });
    expect(f.show).toHaveBeenCalledTimes(2);
    expect(f.show.mock.calls[0]![0].rows).toEqual([row('9'), row('10')]);
    expect(f.show.mock.calls[1]![0].rows).toEqual([row('11')]);
  });
  it('普通模式立即显示最新窗口缓存，校准只读最新页，不等待未读水位', async () => {
    const f = fixture();
    let release!: (rows: Row[]) => void;
    f.latest.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const resolveReadSeq = vi.fn(async () => '10');
    const window = cached([row('9'), row('10')]);
    const task = loadConversationEntry({
      ...f,
      cached: window,
      dirty: true,
      readFromFirstUnread: false,
      resolveReadSeq,
    });
    expect(f.show).toHaveBeenCalledWith(window, true);
    expect(resolveReadSeq).not.toHaveBeenCalled();
    release([row('12'), row('11')]);
    await task;
    expect(f.show).toHaveBeenLastCalledWith(
      expect.objectContaining({
        rows: [row('11'), row('12')],
        anchored: true,
      }),
      false,
    );
    expect(f.after).not.toHaveBeenCalled();
  });
  it.each([false, undefined])('关闭或缺省阅读偏好时忽略旧位置和历史缓存：%s', async (enabled) => {
    const f = fixture();
    await loadConversationEntry({
      ...f,
      readFromFirstUnread: enabled,
      readSeq: '10',
      cached: { ...cached([row('9'), row('10')]), anchored: false, hasNewer: true },
    });
    expect(f.latest).toHaveBeenCalledOnce();
    expect(f.before).not.toHaveBeenCalled();
    expect(f.after).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [row('11'), row('12')], anchored: true }),
      true,
    );
  });
  it('不等待后续查询，先显示最后已读位置之前的一页', async () => {
    const f = fixture();
    let resolve!: (rows: Row[]) => void;
    f.after.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const task = loadConversationEntry({ ...f, readSeq: '10' });
    await vi.waitFor(() => expect(f.after).toHaveBeenCalledWith('10', f.limit));
    expect(f.before).toHaveBeenCalledWith('11', f.limit);
    expect(f.latest).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledOnce();
    expect(f.show).toHaveBeenCalledWith(
      { rows: [row('9'), row('10')], anchored: false, hasOlder: true, hasNewer: true },
      true,
    );
    resolve([row('11')]);
    await task;
    expect(f.show).toHaveBeenLastCalledWith(
      { rows: [row('9'), row('10'), row('11')], anchored: true, hasOlder: true, hasNewer: false },
      false,
    );
  });

  it('readSeq=0 表示从第一条未读开始，不退到最新页', async () => {
    const f = fixture();
    f.before.mockResolvedValue([]);
    await loadConversationEntry({ ...f, readSeq: '0' });
    expect(f.before).toHaveBeenCalledWith('1', f.limit);
    expect(f.after).toHaveBeenCalledWith('0', f.limit);
    expect(f.latest).not.toHaveBeenCalled();
  });

  it('没有阅读记录时只读最新单页', async () => {
    const f = fixture();
    await loadConversationEntry(f);
    expect(f.before).not.toHaveBeenCalled();
    expect(f.after).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledWith(
      { rows: [row('11'), row('12')], anchored: true, hasOlder: true, hasNewer: false },
      true,
    );
  });

  it('首次加载未完成就切走留下的空缓存，不阻止下次读取', async () => {
    const f = fixture();
    await loadConversationEntry({ ...f, cached: cached([]), dirty: true });
    expect(f.latest).toHaveBeenCalledOnce();
    expect(f.show).toHaveBeenCalledOnce();
  });

  it('缓存有变更时只校准已有范围，再向下增量读取，不重读到最新', async () => {
    const f = fixture();
    await loadConversationEntry({ ...f, dirty: true, cached: cached([row('9'), row('10')]) });
    expect(f.before).toHaveBeenCalledWith('11', f.limit);
    expect(f.after).toHaveBeenCalledWith('10', f.limit);
    expect(f.latest).not.toHaveBeenCalled();
  });

  it('历史窗口不主动延伸，保留原窗口的后续分页状态', async () => {
    const f = fixture();
    await loadConversationEntry({
      ...f,
      dirty: true,
      cached: { ...cached([row('9'), row('10')]), anchored: false, hasNewer: true },
    });
    expect(f.after).not.toHaveBeenCalled();
    expect(f.show).toHaveBeenCalledWith(
      expect.objectContaining({ anchored: false, hasNewer: true }),
      false,
    );
  });

  it('后续页满了就保持分离，不继续循环加载所有新消息', async () => {
    const f = fixture();
    f.after.mockResolvedValue([row('11'), row('12')]);
    await loadConversationEntry({ ...f, cached: cached([row('9'), row('10')]) });
    expect(f.after).toHaveBeenCalledOnce();
    expect(f.show).toHaveBeenCalledWith(
      expect.objectContaining({ anchored: false, hasNewer: true }),
      false,
    );
  });

  it('游标使用调用方确认过的本地 seq，不把漫游的独立序号当本地游标', async () => {
    const f = fixture();
    await loadConversationEntry({
      ...f,
      cached: cached([row('10'), row('9000')]),
      cursor: () => '10',
    });
    expect(f.after).toHaveBeenCalledWith('10', f.limit);
  });

  it.each(['before', 'after'] as const)('%s 在途切换会话后不落地旧结果', async (phase) => {
    const f = fixture();
    f[phase].mockImplementation(async () => {
      f.current.mockReturnValue(false);
      return [row('10')];
    });
    await loadConversationEntry({ ...f, readSeq: '10' });
    expect(f.show).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
  });

  it('后续页失败时保留先显示的上下文，仍可向下重试', async () => {
    const f = fixture();
    f.after.mockRejectedValue(new Error('synthetic failure'));
    await expect(loadConversationEntry({ ...f, readSeq: '10' })).rejects.toThrow(
      'synthetic failure',
    );
    expect(f.show).toHaveBeenCalledOnce();
    expect(f.show.mock.calls[0]![0].hasNewer).toBe(true);
  });

  it('首屏结果因窗口变化被丢弃时，同一会话仍结束加载', async () => {
    const f = fixture();
    let loading = true;
    const settled = vi.fn(() => {
      loading = false;
    });
    f.latest.mockImplementation(async () => {
      f.current.mockReturnValue(false);
      return [row('12')];
    });
    await loadConversationEntry({ ...f, active: () => true, settled });
    expect(f.show).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
    expect(loading).toBe(false);
  });

  it('切换账号或会话后，旧请求不能结束新会话的加载', async () => {
    const f = fixture();
    let active = true;
    const settled = vi.fn();
    f.latest.mockImplementation(async () => {
      active = false;
      f.current.mockReturnValue(false);
      return [row('12')];
    });
    await loadConversationEntry({ ...f, active: () => active, settled });
    expect(f.show).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('首屏读取失败也结束加载，但不将失败伪装成空消息页', async () => {
    const f = fixture();
    const settled = vi.fn();
    f.latest.mockRejectedValue(new Error('synthetic failure'));
    await expect(loadConversationEntry({ ...f, active: () => true, settled })).rejects.toThrow(
      'synthetic failure',
    );
    expect(settled).toHaveBeenCalledOnce();
    expect(f.show).not.toHaveBeenCalled();
  });

  it('未读快照返回时窗口已变化，不再查询消息，但仍结束本会话加载', async () => {
    const f = fixture();
    const settled = vi.fn();
    const resolveReadSeq = vi.fn(async () => {
      f.current.mockReturnValue(false);
      return '10';
    });
    await loadConversationEntry({ ...f, active: () => true, settled, resolveReadSeq });
    expect(resolveReadSeq).toHaveBeenCalledOnce();
    expect(f.before).not.toHaveBeenCalled();
    expect(f.latest).not.toHaveBeenCalled();
    expect(f.show).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledOnce();
  });

  it('正常返回消息时只收尾一次，不影响首次和后续两阶段显示', async () => {
    const f = fixture();
    const settled = vi.fn();
    const resolveReadSeq = vi.fn(async () => '10');
    await loadConversationEntry({ ...f, active: () => true, settled, resolveReadSeq });
    expect(f.before).toHaveBeenCalledWith('11', f.limit);
    expect(f.after).toHaveBeenCalledWith('10', f.limit);
    expect(f.show).toHaveBeenCalledTimes(2);
    expect(settled).toHaveBeenCalledOnce();
  });

  it.each(['before', 'after'] as const)(
    '%s 阶段失败都能收尾，并向调用方保留错误',
    async (phase) => {
      const f = fixture();
      const settled = vi.fn();
      f[phase].mockRejectedValue(new Error('synthetic failure'));
      await expect(
        loadConversationEntry({ ...f, readSeq: '10', active: () => true, settled }),
      ).rejects.toThrow('synthetic failure');
      expect(settled).toHaveBeenCalledOnce();
      expect(f.show).toHaveBeenCalledTimes(phase === 'before' ? 0 : 1);
    },
  );

  it('旧请求切走后才失败，不结束新会话的加载', async () => {
    const f = fixture();
    const settled = vi.fn();
    let active = true;
    f.latest.mockImplementation(async () => {
      active = false;
      f.current.mockReturnValue(false);
      throw new Error('synthetic failure');
    });
    await expect(loadConversationEntry({ ...f, active: () => active, settled })).rejects.toThrow(
      'synthetic failure',
    );
    expect(f.show).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('关闭阅读偏好时不读取未读快照', async () => {
    const f = fixture();
    const resolveReadSeq = vi.fn(async () => '10');
    await loadConversationEntry({ ...f, readFromFirstUnread: false, resolveReadSeq });
    expect(resolveReadSeq).not.toHaveBeenCalled();
    expect(f.latest).toHaveBeenCalledOnce();
  });

  it('已有缓存或已存阅读位置时不重复读取未读快照', async () => {
    for (const entry of [{ cached: cached([row('10')]) }, { readSeq: '10' }]) {
      const f = fixture();
      const resolveReadSeq = vi.fn(async () => '20');
      await loadConversationEntry({ ...f, ...entry, resolveReadSeq });
      expect(resolveReadSeq).not.toHaveBeenCalled();
      expect(f.after).toHaveBeenCalledWith('10', f.limit);
    }
  });
});
