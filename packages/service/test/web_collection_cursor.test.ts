import { ProtoMsg } from '@weq/codec';
import {
  CollectorReqBody,
  CollectorReqHead,
  CollectorRespBody,
  CollectorRespHead,
} from '@weq/codec/proto/collection/index';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getCollectionDetailsNetwork,
  getCollectionListNetwork,
  getCollectionPageNetwork,
  type CollectionHttpRequest,
} from '../src/account/web/collection';

const cred = { uin: '10001', skey: '', pskey: 'synthetic-weiyun-ticket' };
const responseHead = new ProtoMsg(CollectorRespHead);
const responseBody = new ProtoMsg(CollectorRespBody);
const requestHead = new ProtoMsg(CollectorReqHead);
const requestBody = new ProtoMsg(CollectorReqBody);

function fixture(
  items: Array<{
    cid: string;
    modifyTime: bigint;
    sequence?: bigint;
    type?: number;
    summary?: { textSummary: { text: string; truncated: boolean } };
  }> = [],
  bottom: number | null = 1,
  errorCode = 0,
  unknownBytes = false,
): Uint8Array {
  const head = responseHead.encode({
    retCode: errorCode,
    retMsg: errorCode ? 'synthetic failure' : '',
  });
  const body = responseBody.encode({
    operation: { getCollectionList: { items, totalCount: 3, reachedBottom: bottom ?? undefined } },
  });
  // A valid unknown field on the outer body must survive the raw-response callback.
  const tail = unknownBytes ? Uint8Array.of(0x98, 0x06, 0x7b) : new Uint8Array();
  const out = Buffer.alloc(16 + head.length + body.length + tail.length);
  out.set([0x20, 0x13, 0x03, 0x29, 0x00, 0x01]);
  out.writeUInt32BE(out.length, 6);
  out.writeUInt32BE(body.length + tail.length, 10);
  out.set(head, 16);
  out.set(body, 16 + head.length);
  out.set(tail, 16 + head.length + body.length);
  return out;
}

function readRequest(request: CollectionHttpRequest) {
  const bytes = Buffer.from(request.body);
  const bodyOffset = bytes.length - bytes.readUInt32BE(10);
  return {
    head: requestHead.decode(bytes.subarray(16, bodyOffset)),
    list: requestBody.decode(bytes.subarray(bodyOffset)).operation?.getCollectionList,
    detail: requestBody.decode(bytes.subarray(bodyOffset)).operation?.getCollectionContent,
  };
}

function detailFixture(
  contents: Array<{
    textContent?: { data: string; hasEmoji?: boolean };
    richMediaContent?: {
      richMedia?: Uint8Array;
      rawData?: Uint8Array;
      bizDataList?: Uint8Array[];
      picList?: Array<{ url: string; md5?: Uint8Array }>;
      fileList?: Array<{ name: string; size?: bigint; md5?: Uint8Array }>;
    };
  }>,
  errorCode = 0,
): Uint8Array {
  const head = responseHead.encode({
    retCode: errorCode,
    retMsg: errorCode ? 'synthetic detail failure' : '',
  });
  const body = responseBody.encode({ operation: { getCollectionContent: { contents } } });
  const out = Buffer.alloc(16 + head.length + body.length);
  out.set([0x20, 0x13, 0x03, 0x29, 0x00, 0x01]);
  out.writeUInt32BE(out.length, 6);
  out.writeUInt32BE(body.length, 10);
  out.set(head, 16);
  out.set(body, 16 + head.length);
  return out;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('real network is disabled');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('collector cursor requests', () => {
  it('recognizes the observed 215000 terminal page and preserves its remaining items', async () => {
    const page = await getCollectionPageNetwork(
      cred,
      { timeStamp: '100', sequence: 10 },
      {
        transport: async () => fixture([{ cid: 'last-item', modifyTime: 10n }], 215000),
      },
    );
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(page.items.map((item) => item.cid)).toEqual(['last-item']);
  });
  it('retains uint64 metadata for native detail calls independently of the legacy numeric times', async () => {
    const max = 0xffff_ffff_ffff_ffffn;
    const page = await getCollectionPageNetwork(cred, null, {
      transport: async () =>
        fixture([{ cid: '1-1-synthetic', type: 9, modifyTime: max, sequence: max }]),
    });
    const item = page.items[0]!;
    expect(item.sequence).toBe('18446744073709551615');
    expect(item.nativeModifyTime).toBe('18446744073709551615');
    expect(item.modifyTime).toBe(Number(max));
  });

  it('leaves unavailable native metadata absent rather than inventing detail arguments', async () => {
    const page = await getCollectionPageNetwork(cred, null, {
      transport: async () => fixture([{ cid: 'synthetic', modifyTime: 0n }]),
    });
    expect(page.items[0]?.sequence).toBeUndefined();
    expect(page.items[0]?.nativeModifyTime).toBe('0');
  });
  it('preserves explicit text truncation rather than treating a list summary as full content', async () => {
    const transport = async () =>
      fixture([
        {
          cid: 'truncated',
          modifyTime: 10n,
          type: 1,
          summary: { textSummary: { text: 'summary only', truncated: true } },
        },
      ]);
    const page = await getCollectionPageNetwork(cred, null, { transport });
    expect(page.items[0]?.summary.textSummary).toEqual({ text: 'summary only', truncated: true });
  });
  it('makes one request, preserves raw unknown fields, and provides a durable continuation', async () => {
    const bytes = fixture(
      [
        { cid: 'a', modifyTime: 30n },
        { cid: 'b', modifyTime: 20n },
      ],
      0,
      0,
      true,
    );
    const transport = vi.fn(async (_request: CollectionHttpRequest) => bytes);
    let raw: Uint8Array | undefined;
    const page = await getCollectionPageNetwork(cred, null, {
      transport,
      onRawResponse: async (capture) => {
        raw = capture.response;
      },
    });
    expect(page.items.map((item) => item.cid)).toEqual(['a', 'b']);
    expect(page).toMatchObject({
      hasMore: true,
      nextCursor: { timeStamp: '20', sequence: 2 },
      totalCount: 3,
    });
    expect(raw).toEqual(bytes);
    expect(transport).toHaveBeenCalledTimes(1);
    const req = transport.mock.calls[0]![0];
    expect(req.headers.Cookie).toBe('uin=10001;vt=27;vi=synthetic-weiyun-ticket;appid=5004');
    expect(readRequest(req)).toMatchObject({
      head: { uin: 10001n, sequence: 1, operationId: 20000 },
      list: { timeStamp: 0xffff_ffff_ffff_ffffn, count: 50, searchDown: 1 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resumes a cursor without rescanning and completes only at the server bottom', async () => {
    const transport = vi.fn(async (_request: CollectionHttpRequest) =>
      fixture([{ cid: 'c', modifyTime: 10n }]),
    );
    const page = await getCollectionPageNetwork(
      cred,
      { timeStamp: '20', sequence: 2 },
      { transport },
    );
    expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    expect(readRequest(transport.mock.calls[0]![0])).toMatchObject({
      head: { sequence: 2 },
      list: { timeStamp: 20n },
    });
  });

  it('keeps the old list API and deduplicates overlapping pages', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        fixture(
          [
            { cid: 'a', modifyTime: 30n },
            { cid: 'b', modifyTime: 20n },
          ],
          0,
        ),
      )
      .mockResolvedValueOnce(
        fixture([
          { cid: 'b', modifyTime: 20n },
          { cid: 'c', modifyTime: 10n },
        ]),
      );
    const page = await getCollectionListNetwork(cred, 10, { transport });
    expect(page.items.map((item) => item.cid)).toEqual(['a', 'b', 'c']);
    expect(page.hasMore).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('archives the raw response before reporting a server error', async () => {
    const bytes = fixture([], 1, 190013);
    const capture = vi.fn();
    await expect(
      getCollectionPageNetwork(cred, null, {
        transport: async () => bytes,
        onRawResponse: capture,
      }),
    ).rejects.toThrow('190013');
    expect(capture).toHaveBeenCalledWith({
      sequence: 1,
      requestTimeStamp: '18446744073709551615',
      response: bytes,
    });
  });

  it.each([
    [[], 0],
    [[{ cid: 'a', modifyTime: 20n }], 0],
    [[{ cid: 'a', modifyTime: 0n }], 0],
  ])('rejects non-advancing continuations', async (items, bottom) => {
    await expect(
      getCollectionPageNetwork(
        cred,
        { timeStamp: '20', sequence: 2 },
        {
          transport: async () =>
            fixture(items as Array<{ cid: string; modifyTime: bigint }>, bottom as number),
        },
      ),
    ).rejects.toThrow('no progress');
  });

  it('treats an omitted proto3 bottom flag as more data', async () => {
    const page = await getCollectionPageNetwork(cred, null, {
      transport: async () => fixture([{ cid: 'a', modifyTime: 10n }], null),
    });
    expect(page).toMatchObject({ hasMore: true, nextCursor: { timeStamp: '10', sequence: 2 } });
  });

  it('does not advance when raw-response persistence fails', async () => {
    await expect(
      getCollectionPageNetwork(cred, null, {
        transport: async () => fixture([{ cid: 'a', modifyTime: 10n }], 0),
        onRawResponse: async () => {
          throw new Error('synthetic disk failure');
        },
      }),
    ).rejects.toThrow('synthetic disk failure');
  });

  it('rejects an already-cancelled operation before its transport runs', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancellation'));
    const transport = vi.fn();
    await expect(
      getCollectionPageNetwork(cred, null, { signal: controller.signal, transport }),
    ).rejects.toThrow('synthetic cancellation');
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects malformed credentials and cursors before any request', async () => {
    const transport = vi.fn();
    await expect(
      getCollectionPageNetwork({ ...cred, pskey: '' }, null, { transport }),
    ).rejects.toThrow('p_skey');
    await expect(
      getCollectionPageNetwork(cred, { timeStamp: '0', sequence: 2 }, { transport }),
    ).rejects.toThrow('timestamp');
    await expect(
      getCollectionPageNetwork(cred, { timeStamp: '10', sequence: 0 }, { transport }),
    ).rejects.toThrow('sequence');
    expect(transport).not.toHaveBeenCalled();
  });

  it('enforces a request timeout even for a transport that ignores cancellation', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = getCollectionPageNetwork(cred, null, {
      timeoutMs: 100,
      transport: (request) => {
        signal = request.signal;
        return new Promise(() => {});
      },
    });
    const assertion = expect(pending).rejects.toThrow('timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });

  it('retains malformed raw envelopes before reporting decode failure', async () => {
    const malformed = Uint8Array.from([1, 2, 3]);
    const capture = vi.fn();
    await expect(
      getCollectionPageNetwork(cred, null, {
        transport: async () => malformed,
        onRawResponse: capture,
      }),
    ).rejects.toThrow('too short');
    expect(capture.mock.calls[0]![0].response).toEqual(malformed);
  });
});

describe('collector detail requests', () => {
  it('preserves a structured rich-media body without HTML rather than marking it empty', async () => {
    const bytes = Uint8Array.of(8, 1, 18, 0);
    const [detail] = await getCollectionDetailsNetwork(cred, ['structured'], {
      transport: async () => detailFixture([{ richMediaContent: { richMedia: bytes } }]),
    });
    expect(Array.from(detail?.content.richMedia ?? [])).toEqual(Array.from(bytes));
    expect(detail?.content.richMediaContent?.rawData).toBeUndefined();
  });
  it('encodes operation 20001 and maps text/rich-media details in request order', async () => {
    const transport = vi.fn(async () =>
      detailFixture([
        { textContent: { data: '完整文字', hasEmoji: true } },
        {
          richMediaContent: {
            rawData: new TextEncoder().encode('<div>完整图文</div>'),
            bizDataList: [new TextEncoder().encode('{"kind":"test"}')],
            picList: [{ url: 'https://shp.qpic.cn/collector/test/0' }],
            fileList: [{ name: 'test.txt', size: 10n, md5: new Uint8Array(16) }],
          },
        },
      ]),
    );
    const raw = vi.fn();
    const details = await getCollectionDetailsNetwork(cred, ['cid-text', 'cid-rich'], {
      transport,
      onRawResponse: raw,
    });
    expect(details.map((detail) => detail.cid)).toEqual(['cid-text', 'cid-rich']);
    expect(details[0]?.content.textContent).toEqual({ data: '完整文字', hasEmoji: true });
    expect(details[1]?.content.richMediaContent).toMatchObject({
      rawData: '<div>完整图文</div>',
      bizDataList: ['{"kind":"test"}'],
      picList: [{ uri: 'https://shp.qpic.cn/collector/test/0' }],
      fileList: [{ name: 'test.txt', size: 10n }],
    });
    const request = transport.mock.calls[0]![0];
    expect(readRequest(request)).toMatchObject({
      head: { operationId: 20001, sequence: 1 },
      detail: { cidList: ['cid-text', 'cid-rich'] },
    });
    expect(raw).toHaveBeenCalledWith({
      cids: ['cid-text', 'cid-rich'],
      response: expect.any(Uint8Array),
    });
  });

  it('rejects malformed, duplicate, oversized and count-mismatched detail batches', async () => {
    const transport = vi.fn(async () => detailFixture([]));
    await expect(getCollectionDetailsNetwork(cred, [], { transport })).rejects.toThrow('1-20');
    await expect(
      getCollectionDetailsNetwork(cred, ['same', 'same'], { transport }),
    ).rejects.toThrow('duplicate');
    await expect(getCollectionDetailsNetwork(cred, ['bad\nvalue'], { transport })).rejects.toThrow(
      'invalid',
    );
    await expect(
      getCollectionDetailsNetwork(
        cred,
        Array.from({ length: 21 }, (_, i) => `cid-${i}`),
        {
          transport,
        },
      ),
    ).rejects.toThrow('1-20');
    await expect(
      getCollectionDetailsNetwork(cred, ['one', 'two'], {
        transport: async () => detailFixture([{ textContent: { data: 'one' } }]),
      }),
    ).rejects.toThrow('count mismatch');
  });

  it('archives a failed detail response before surfacing its service error', async () => {
    const bytes = detailFixture([], 190013);
    const raw = vi.fn();
    await expect(
      getCollectionDetailsNetwork(cred, ['cid'], {
        transport: async () => bytes,
        onRawResponse: raw,
      }),
    ).rejects.toThrow('190013');
    expect(raw).toHaveBeenCalledWith({ cids: ['cid'], response: bytes });
  });
});

describe('collector shared read transport', () => {
  it('retries a transient HTTP failure without changing the binary envelope or credentials', async () => {
    const raw = fixture([{ cid: 'synthetic-cid', modifyTime: 10n }]);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response(raw));
    vi.stubGlobal('fetch', fetch);
    const page = await getCollectionPageNetwork(cred, null);
    expect(page.items[0]?.cid).toBe('synthetic-cid');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[1]?.body).toEqual(fetch.mock.calls[1]?.[1]?.body);
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual(fetch.mock.calls[1]?.[1]?.headers);
    expect(fetch.mock.calls[0]?.[1]?.headers['Content-Type']).toBe('application/octet-stream');
  });

  it('does not replay an HTTP authentication failure or a decoded business failure', async () => {
    const fetch = vi.fn(async () => new Response('denied', { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    await expect(getCollectionPageNetwork(cred, null)).rejects.toMatchObject({
      kind: 'authentication',
      status: 403,
    });
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockClear();
    fetch.mockImplementation(async () => new Response(fixture([], 1, 190013)));
    await expect(getCollectionPageNetwork(cred, null)).rejects.toThrow('190013');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('surfaces long Retry-After values without retrying the collector early', async () => {
    const fetch = vi.fn(
      async () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } }),
    );
    vi.stubGlobal('fetch', fetch);
    await expect(getCollectionPageNetwork(cred, null)).rejects.toMatchObject({
      kind: 'rate-limit',
      retryAfterMs: 120000,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
