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
    expect(fetchMsgList).toHaveBeenCalledWith('10001', 10, 20, undefined);
    expect(onPage).toHaveBeenCalledWith(
      expect.objectContaining({ pos: 10, nextPos: 11, termination: 'stable-tail' }),
    );
    expect(rows).toEqual([row('b')]);
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
});
