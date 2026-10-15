import { afterEach, describe, expect, it, vi } from 'vitest';
// Comment parser/page-budget fixtures do not wait on the app-wide network quota.
// Real dispatch throttling and cancellation are covered by qzone_pagination_limit.test.ts.
vi.mock('../src/common/qzone_pagination', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/common/qzone_pagination')>()),
  waitForQzonePage: async () => {},
}));
import {
  parseQzoneCommentPage,
  readQzoneComments,
  supplementQzoneComments,
} from '../src/account/web/qzone_comments';
import type { QzoneInteraction } from '../src/account/web/qzone_interaction';
const credential = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
function page(start: number, length: number, total = length, replyNum: number | undefined = 0) {
  return {
    code: 0,
    data: {
      hostUin: 10001,
      tid: 'synthetic_tid',
      total,
      comments: Array.from({ length }, (_, index) => ({
        id: start + index + 1,
        content: `synthetic comment ${index}`,
        postTime: 1700000000,
        poster: { id: 10002, name: 'fixture' },
        extendData: { replyNum },
      })),
    },
  };
}
function unknownReplies() {
  const value = page(0, 1);
  Reflect.deleteProperty(value.data.comments[0]!.extendData, 'replyNum');
  return value;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fetchPages(values: unknown[]) {
  const fetch = vi.fn();
  for (const value of values) fetch.mockResolvedValueOnce(new Response(JSON.stringify(value)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('structured QZone root comments', () => {
  it('maps observed stable identities, content and seconds, retaining unknown reply counts', () => {
    const result = parseQzoneCommentPage(unknownReplies(), '10001', 'synthetic_tid');
    expect(result.comments[0]).toMatchObject({
      id: '1',
      uin: '10002',
      nickname: 'fixture',
      content: 'synthetic comment 0',
      time: 1700000000,
      isReply: false,
    });
    expect(result.replyCounts['1']).toBeNull();
  });
  it('rejects wrong-owner/wrong-post, malformed identities and duplicated IDs', () => {
    expect(() => parseQzoneCommentPage(page(0, 1), '10003', 'synthetic_tid')).toThrow();
    expect(() => parseQzoneCommentPage(page(0, 1), '10001', 'other_tid')).toThrow();
    const bad = page(0, 2);
    bad.data.comments[1]!.id = 1;
    expect(() => parseQzoneCommentPage(bad, '10001', 'synthetic_tid')).toThrow();
    bad.data.comments[1]!.id = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseQzoneCommentPage(bad, '10001', 'synthetic_tid')).toThrow();
  });
  it('follows pages, captures exact replies, and counts distinct roots against a stable declaration', async () => {
    const values = [page(0, 50, 55), page(50, 5, 55)];
    const fetch = fetchPages(values),
      capture = vi.fn(async () => {});
    const result = await readQzoneComments(credential, '10001', 'synthetic_tid', {
      captureRaw: capture,
    });
    expect(result).toMatchObject({ countMatched: true, requests: 2, reportedTotal: 55 });
    expect(result.comments).toHaveLength(55);
    expect(new URL(fetch.mock.calls[1]![0]).searchParams.get('start')).toBe('50');
    expect(capture.mock.calls[0]?.[0]).toBe(JSON.stringify(values[0]));
  });
  it('does not stop at a short page while an explicit total still promises more roots', async () => {
    const fetch = fetchPages([page(0, 1, 3), page(1, 2, 3)]);
    const result = await readQzoneComments(credential, '10001', 'synthetic_tid');
    expect(result.countMatched).toBe(true);
    expect(new URL(fetch.mock.calls[1]![0]).searchParams.get('start')).toBe('1');
  });
  it('keeps changed totals and overlapping pages unverified and does not continue chasing them', async () => {
    let fetch = fetchPages([page(0, 50, 55), page(50, 5, 56)]);
    expect((await readQzoneComments(credential, '10001', 'synthetic_tid')).countMatched).toBe(
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch = fetchPages([page(0, 50, 100), page(0, 50, 100)]);
    expect((await readQzoneComments(credential, '10001', 'synthetic_tid')).countMatched).toBe(
      false,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('preserves a partial root set when the page budget is consumed', async () => {
    fetchPages([page(0, 50, 100)]);
    const result = await readQzoneComments(credential, '10001', 'synthetic_tid', { maxPages: 1 });
    expect(result).toMatchObject({ countMatched: false, reportedTotal: 100, requests: 1 });
    expect(result.comments).toHaveLength(50);
  });
  it('never publishes a response whose raw capture cancelled the operation', async () => {
    fetchPages([page(0, 1)]);
    const controller = new AbortController();
    await expect(
      readQzoneComments(credential, '10001', 'synthetic_tid', {
        signal: controller.signal,
        captureRaw: async () => {
          controller.abort(new Error('stop after capture'));
        },
      }),
    ).rejects.toThrow('stop after capture');
  });
  it('only certifies zero replies when all roots and all explicit reply counts are covered', async () => {
    fetchPages([page(0, 1)]);
    const result = await supplementQzoneComments(
      credential,
      '10001',
      [{ tid: 'synthetic_tid' }],
      new Map(),
    );
    expect(result.get('synthetic_tid')?.fieldCoverage).toMatchObject({
      comments: 'complete',
      replies: 'complete',
      likes: 'unobserved',
    });
    fetchPages([unknownReplies()]);
    const unknown = await supplementQzoneComments(
      credential,
      '10001',
      [{ tid: 'synthetic_tid' }],
      new Map(),
    );
    expect(unknown.get('synthetic_tid')?.fieldCoverage?.replies).toBe('unobserved');
  });
  it('retains matching HTML replies while leaving positive reply counts unverified', async () => {
    fetchPages([page(0, 1, 1, 2)]);
    const root = parseQzoneCommentPage(page(0, 1), '10001', 'synthetic_tid').comments[0]!;
    const legacy: QzoneInteraction = {
      comments: [root, { ...root, id: '1_r_1_10002', isReply: true, parentCommentId: '1' }],
      likes: [],
    };
    const result = await supplementQzoneComments(
      credential,
      '10001',
      [{ tid: 'synthetic_tid' }],
      new Map([['synthetic_tid', legacy]]),
    );
    expect(result.get('synthetic_tid')?.comments).toHaveLength(2);
    expect(result.get('synthetic_tid')?.fieldCoverage?.replies).toBe('observed');
  });
  it('retains observed media only when the structured root identity and body still match', async () => {
    fetchPages([page(0, 1)]);
    const root = parseQzoneCommentPage(page(0, 1), '10001', 'synthetic_tid').comments[0]!;
    root.images = ['https://qpic.cn/synthetic.jpg'];
    const results = await supplementQzoneComments(
      credential,
      '10001',
      [{ tid: 'synthetic_tid' }],
      new Map([['synthetic_tid', { comments: [root], likes: [] }]]),
    );
    expect(results.get('synthetic_tid')?.comments[0]?.images).toEqual(root.images);
    fetchPages([page(0, 1)]);
    const changed = await supplementQzoneComments(
      credential,
      '10001',
      [{ tid: 'synthetic_tid' }],
      new Map([
        ['synthetic_tid', { comments: [{ ...root, content: 'older variant' }], likes: [] }],
      ]),
    );
    expect(changed.get('synthetic_tid')?.comments[0]?.images).toEqual([]);
  });
  it('stops new requests on rate limits and after three independent failures', async () => {
    const targets = Array.from({ length: 4 }, (_, i) => ({ tid: `target_${i}` }));
    let fetch = fetchPages([{ code: -10000 }]);
    await supplementQzoneComments(credential, '10001', targets, new Map());
    expect(fetch).toHaveBeenCalledOnce();
    fetch = fetchPages([{ code: 1 }, { code: 1 }, { code: 1 }]);
    await supplementQzoneComments(credential, '10001', targets, new Map());
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
