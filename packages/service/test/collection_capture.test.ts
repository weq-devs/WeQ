import { describe, expect, it, vi } from 'vitest';
import {
  captureCollectionPages,
  CollectionCaptureError,
  sourceVersionHash,
} from '../src/account/collection_capture';
import type { CollectionItem } from '@weq/db';

const item = (cid: string, text = 'summary') =>
  ({ cid, summary: { textSummary: { text } } }) as CollectionItem;
const page = (cid: string, stamp: string | null) => ({
  items: [item(cid)],
  hasMore: stamp !== null,
  nextCursor: stamp === null ? null : { timeStamp: stamp, sequence: 2 },
  totalCount: 2,
  rawResponse: Uint8Array.of(1, 2, 3),
});

describe('resumable collection capture', () => {
  it('commits each page before continuing and resumes without rescanning', async () => {
    const read = vi.fn(async () => page('a', '10'));
    const sink = vi.fn(async () => {});
    const cp = await captureCollectionPages('10001', read, { onPage: sink, maxPages: 1 });
    expect(cp.complete).toBe(false);
    expect(cp.cursor?.timeStamp).toBe('10');
    const resumed = vi.fn(async () => page('b', null));
    const final = await captureCollectionPages('10001', resumed, { onPage: sink, checkpoint: cp });
    expect(resumed).toHaveBeenCalledOnce();
    expect(resumed).toHaveBeenCalledWith(cp.cursor);
    expect(final).toMatchObject({ complete: true, pages: 2, observedItems: 2 });
    expect(sink.mock.calls[0]?.[0]).toMatchObject({ contentCoverage: 'list-summaries' });
  });
  it('does not advance when source persistence fails', async () => {
    const read = vi.fn(async () => page('a', '10'));
    try {
      await captureCollectionPages('10001', read, {
        onPage: async () => {
          throw new Error('disk full');
        },
      });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionCaptureError);
      expect((error as CollectionCaptureError).checkpoint).toMatchObject({
        cursor: null,
        pages: 0,
        complete: false,
      });
    }
    expect(read).toHaveBeenCalledOnce();
  });
  it('does not label a repeated page complete', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(page('a', '10'))
      .mockResolvedValueOnce(page('a', '5'));
    const sink = vi.fn();
    await expect(captureCollectionPages('10001', read, { onPage: sink })).rejects.toMatchObject({
      checkpoint: { pages: 1, complete: false },
    });
    expect(sink).toHaveBeenCalledOnce();
  });
  it('rejects a checkpoint from another account', async () => {
    const read = vi.fn();
    await expect(
      captureCollectionPages('10001', read, {
        onPage: vi.fn(),
        checkpoint: {
          version: 1,
          uin: '20002',
          cursor: null,
          pages: 0,
          observedItems: 0,
          uniqueItems: 0,
          seenCids: [],
          reportedTotal: null,
          complete: false,
        },
      }),
    ).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it('does not mark a terminal page complete when unique ids differ from totalCount', async () => {
    const read = vi.fn(async () => ({ ...page('a', null), totalCount: 2 }));
    await expect(captureCollectionPages('10001', read, { onPage: vi.fn() })).rejects.toMatchObject({
      checkpoint: {
        complete: false,
        incompleteReason: 'count-mismatch',
        uniqueItems: 1,
        reportedTotal: 2,
      },
    });
  });
  it('hashes revisions and bigint metadata without depending on key order', () => {
    expect(sourceVersionHash({ a: 1n, b: 'x' })).toBe(sourceVersionHash({ b: 'x', a: 1n }));
    expect(sourceVersionHash(item('a', 'before'))).not.toBe(sourceVersionHash(item('a', 'after')));
  });
});
