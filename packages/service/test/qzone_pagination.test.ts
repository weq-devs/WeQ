import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchQzoneEmotionRange, QzonePaginationError } from '../src/account/export/qzone_export';
import type { QzoneEmotion } from '../src/account/web/qzone';

const row = (tid: string): QzoneEmotion => ({
  tid,
  content: 'fixture',
  time: 1,
  commentNum: 0,
  isPrivate: false,
  images: [],
  videos: [],
});
const rows = (prefix: string, count: number): QzoneEmotion[] =>
  Array.from({ length: count }, (_, index) => row(`${prefix}-${index}`));
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Qzone pagination reports incomplete captures', () => {
  it('does not turn a second-page authentication error into successful completion', async () => {
    const fetchMsgList = vi
      .fn()
      .mockResolvedValueOnce({ total: 40, list: rows('a', 20) })
      .mockRejectedValueOnce(new Error('auth expired'));
    const result = fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}).catch(
      (e) => e,
    );
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(QzonePaginationError);
    expect(error).toMatchObject({
      nextPos: 15,
      reason: 'request-failed',
    });
    expect(error.partialRows.map((item: QzoneEmotion) => item.tid)).toContain('a-0');
  });
  it('does not treat a repeated page as the bottom', async () => {
    const page = rows('a', 20);
    const fetchMsgList = vi.fn(async () => ({ total: 40, list: page }));
    const result = fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}).catch(
      (e) => e,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ nextPos: 15, reason: 'repeated-page' });
  });
  it('can start from a saved cursor and await persistence before continuing', async () => {
    const fetchMsgList = vi.fn(async () => ({ total: 11, list: [row('b')] }));
    const onPage = vi.fn(async () => {});
    const rows = await fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      { startPos: 10, onPage },
    );
    expect(fetchMsgList).toHaveBeenCalledWith('10001', 10, 20, undefined, expect.any(Function));
    expect(onPage).toHaveBeenCalledWith(
      expect.objectContaining({ pos: 10, nextPos: 11, termination: 'stable-tail' }),
    );
    expect(rows).toEqual([row('b')]);
  });
  it('restores saved rows and validates the first resumed overlap anchor', async () => {
    const saved = rows('a', 20);
    const resumed = [...saved.slice(-5), row('b-1')];
    const fetchMsgList = vi.fn(async () => ({ total: 21, list: resumed }));
    const result = await fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      {
        startPos: 15,
        initialRows: saved,
        expectedAnchorTids: saved.slice(-5).map((item) => item.tid),
      },
    );
    expect(result).toHaveLength(21);
    expect(result.at(-1)?.tid).toBe('b-1');
  });
  it('stops when an overlap anchor disappears after the list changes', async () => {
    const fetchMsgList = vi
      .fn()
      .mockResolvedValueOnce({ total: 60, list: rows('a', 20) })
      .mockResolvedValueOnce({ total: 60, list: rows('b', 20) });
    const result = fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}).catch(
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({ nextPos: 15, reason: 'cursor-drift' });
  });
  it('does not advance after persistence fails', async () => {
    const fetchMsgList = vi.fn(async () => ({ total: 2, list: [row('a')] }));
    await expect(
      fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}, undefined, {
        onPage: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toMatchObject({ reason: 'persist-failed', nextPos: 0, partialRows: [] });
    expect(fetchMsgList).toHaveBeenCalledOnce();
  });
  it('does not request pages after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMsgList = vi.fn();
    await expect(
      fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}, controller.signal),
    ).rejects.toMatchObject({ reason: 'cancelled', nextPos: 0 });
    expect(fetchMsgList).not.toHaveBeenCalled();
  });
  it('re-finds saved TID/time anchors after a large insertion without skipping older rows', async () => {
    const original = rows('old', 25).map((entry, index) => ({ ...entry, time: 1000 - index }));
    const inserted = rows('new', 20).map((entry, index) => ({ ...entry, time: 2000 - index }));
    let calls = 0;
    const fetchMsgList = vi.fn(async (_uin, pos, count, _signal, onRaw) => {
      const list = ++calls === 1 ? original : [...inserted, ...original];
      await onRaw?.(JSON.stringify({ position: pos }));
      return { total: list.length, list: list.slice(pos, pos + count) };
    });
    const onPage = vi.fn(async () => {});
    const pending = fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      {
        relocateCursor: true,
        onPage,
      },
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.map((entry) => entry.tid)).toEqual(
      [...inserted, ...original].map((entry) => entry.tid),
    );
    expect(fetchMsgList.mock.calls.map((call) => call[1])).toEqual([0, 15, 30, 0]);
    expect(onPage.mock.calls[1]?.[0]).toMatchObject({
      pos: 30,
      nextPos: 45,
      continuation: true,
      requestPositions: [15, 30, 0],
    });
  });

  it('re-finds an overlap after deletion shifts the cursor backwards', async () => {
    const original = rows('old', 30).map((entry, index) => ({ ...entry, time: 1000 - index }));
    let calls = 0;
    const fetchMsgList = vi.fn(async (_uin, pos, count) => {
      const list = ++calls === 1 ? original : original.slice(10);
      return { total: list.length, list: list.slice(pos, pos + count) };
    });
    const onPage = vi.fn(async () => {});
    const pending = fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      {
        relocateCursor: true,
        onPage,
      },
    );
    await vi.runAllTimersAsync();
    expect((await pending).map((entry) => entry.tid)).toEqual(original.map((entry) => entry.tid));
    expect(onPage.mock.calls[1]?.[0]).toMatchObject({ pos: 0, continuation: true });
  });

  it('does not accept an empty resumed page without the saved overlap', async () => {
    const fetchMsgList = vi.fn(async () => ({ total: 0, list: [] }));
    const onPage = vi.fn(async () => {});
    const pending = fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      {
        startPos: 15,
        initialRows: rows('saved', 20),
        expectedAnchors: [{ tid: 'saved-19', time: 1 }],
        relocateCursor: true,
        onPage,
      },
    ).catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ reason: 'cursor-drift', nextPos: 15 });
    expect(fetchMsgList.mock.calls.length).toBeLessThanOrEqual(9);
    expect(onPage).not.toHaveBeenCalled();
  });

  it('exports the latest observed overlapping version rather than the stale saved row', async () => {
    const saved = row('id');
    const current = { ...saved, content: 'edited after checkpoint' };
    const result = await fetchQzoneEmotionRange(
      { fetchMsgList: async () => ({ total: 1, list: [current] }) },
      '10001',
      undefined,
      () => {},
      undefined,
      { startPos: 10, initialRows: [saved], expectedAnchorTids: ['id'] },
    );
    expect(result).toEqual([current]);
  });
  it('rechecks the head at the tail so small additions within the overlap are included', async () => {
    const original = rows('old', 25).map((entry, index) => ({ ...entry, time: 1000 - index }));
    const inserted = rows('new', 3).map((entry, index) => ({ ...entry, time: 2000 - index }));
    let calls = 0;
    const fetchMsgList = vi.fn(async (_uin, pos, count) => {
      const list = ++calls === 1 ? original : [...inserted, ...original];
      return { total: list.length, list: list.slice(pos, pos + count) };
    });
    const pending = fetchQzoneEmotionRange(
      { fetchMsgList },
      '10001',
      undefined,
      () => {},
      undefined,
      { relocateCursor: true },
    );
    await vi.runAllTimersAsync();
    expect((await pending).map((entry) => entry.tid)).toEqual(
      [...inserted, ...original].map((entry) => entry.tid),
    );
    expect(fetchMsgList.mock.calls.map((call) => call[1])).toEqual([0, 15, 0]);
  });
  it('does not persist a late response after cancellation', async () => {
    const controller = new AbortController();
    const onPage = vi.fn(async () => {});
    const fetchMsgList = vi.fn(async () => {
      controller.abort();
      return { total: 1, list: [row('late')] };
    });
    await expect(
      fetchQzoneEmotionRange({ fetchMsgList }, '10001', undefined, () => {}, controller.signal, {
        onPage,
      }),
    ).rejects.toMatchObject({ reason: 'cancelled', nextPos: 0, partialRows: [] });
    expect(onPage).not.toHaveBeenCalled();
  });
});
