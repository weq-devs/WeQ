import { describe, expect, it, vi } from 'vitest';
import { decode, encode, message } from '../src/protobuf';
import { GetQzoneFeedMediaDetail } from '../src/qzone/feed-media-detail';
import { resolveSign } from '../src/sign-policy';
import type { TrpcNative } from '../src/transport';

const params = { ownerUin: '10001', tid: 'fixture-post', time: 1700000000 };
// 固定已核 SDK tag；不从生产解码 schema 生成响应夹具。
const ids = message([
  { name: 'kind', tag: 1, type: 'uint32' },
  { name: 'numeric', tag: 2, type: 'int64' },
  { name: 'text', tag: 3, type: 'string' },
  { name: 'uin', tag: 4, type: 'uint64' },
]);
const text = message([
  {
    name: 'parts',
    tag: 1,
    repeated: true,
    type: message([
      { name: 'kind', tag: 1, type: 'int32' },
      { name: 'text', tag: 2, type: 'string' },
      { name: 'nickname', tag: 4, type: 'string' },
      { name: 'uin', tag: 7, type: 'string' },
    ]),
  },
]);
const fixture = message([
  {
    name: 'body',
    tag: 4,
    type: message([
      {
        name: 'main',
        tag: 2,
        type: message([
          {
            name: 'feed',
            tag: 1,
            type: message([
              { name: 'title', tag: 3, type: text },
              { name: 'text', tag: 4, type: text },
              {
                name: 'comments',
                tag: 7,
                type: message([{ name: 'count', tag: 1, type: 'uint32', force: true }]),
              },
              {
                name: 'likes',
                tag: 8,
                type: message([{ name: 'count', tag: 1, type: 'uint32', force: true }]),
              },
              {
                name: 'comm',
                tag: 1,
                type: message([
                  {
                    name: 'union',
                    tag: 15,
                    type: message([{ name: 'ids', tag: 4, type: ids, repeated: true }]),
                  },
                ]),
              },
              {
                name: 'media',
                tag: 5,
                type: message([
                  {
                    name: 'items',
                    tag: 1,
                    repeated: true,
                    type: message([
                      { name: 'kind', tag: 1, type: 'uint32', force: true },
                      {
                        name: 'video',
                        tag: 3,
                        type: message([{ name: 'id', tag: 1, type: 'string' }]),
                      },
                      { name: 'live', tag: 18, type: 'bool', force: true },
                    ]),
                  },
                ]),
              },
            ]),
          },
        ]),
      },
    ]),
  },
]);
const response = (
  items: Record<string, unknown>[],
  owner = '10001',
  tid = 'fixture-post',
  appid = 311n,
  extra: Record<string, unknown> = {},
) =>
  encode(fixture, {
    body: {
      main: {
        feed: {
          comm: {
            union: {
              ids: [
                { kind: 8, uin: BigInt(owner) },
                { kind: 5, text: tid },
                { kind: 4, numeric: appid },
              ],
            },
          },
          media: { items },
          ...extra,
        },
      },
    },
  });

describe('空间 V4 媒体详情', () => {
  it('正文来自 tag 4 而非另一文本 cell，保留 @ 和真实零计数', () => {
    expect(
      GetQzoneFeedMediaDetail.parseDetail(
        response([], '10001', 'fixture-post', 311n, {
          title: { parts: [{ text: 'not body' }] },
          text: { parts: [{ text: '正文 ' }, { kind: 1, uin: '10002', nickname: '昵称,{}' }] },
          comments: { count: 0 },
          likes: { count: 12 },
        }),
        params,
      ),
    ).toMatchObject({
      content: '正文 @{uin:10002,nick:昵称%2C%7B%7D}',
      commentCount: 0,
      likeCount: 12,
    });
  });
  it('未知富文本不拼成残缺正文，缺失计数不补零', () => {
    const result = GetQzoneFeedMediaDetail.parseDetail(
      response([], '10001', 'fixture-post', 311n, {
        text: { parts: [{ text: '部分' }, { kind: 99 }] },
      }),
      params,
    );
    expect(result.content).toBeUndefined();
    expect(result.commentCount).toBeUndefined();
    expect(result.likeCount).toBeUndefined();
  });
  it('保留相同 type 下的 true、false 与缺失，不以数组位置分类', () => {
    expect(
      GetQzoneFeedMediaDetail.parse(
        response([
          { kind: 1, video: { id: 'live' }, live: true },
          { kind: 0 },
          { kind: 1, video: { id: 'normal' }, live: false },
          { kind: 1, video: { id: 'unknown' } },
        ]),
        params,
      ),
    ).toEqual([
      { videoId: 'live', isLivePhoto: true },
      { videoId: 'normal', isLivePhoto: false },
      { videoId: 'unknown', isLivePhoto: undefined },
    ]);
  });
  it('拒绝身份不符、空体、非零返回码和截断报文', () => {
    expect(() => GetQzoneFeedMediaDetail.parse(response([], '10002'), params)).toThrow('不匹配');
    expect(() => GetQzoneFeedMediaDetail.parse(response([], '10001', 'other'), params)).toThrow(
      '不匹配',
    );
    expect(() =>
      GetQzoneFeedMediaDetail.parse(response([], '10001', 'fixture-post', 2n), params),
    ).toThrow('不匹配');
    expect(() => GetQzoneFeedMediaDetail.parse(Buffer.alloc(0), params)).toThrow();
    expect(() => GetQzoneFeedMediaDetail.parse(Uint8Array.from([0x10, 0x01]), params)).toThrow();
    expect(() =>
      GetQzoneFeedMediaDetail.parse(Uint8Array.from([0x22, 0x08, 0x90]), params),
    ).toThrow();
  });
  it('同 ID 的冲突标记保持未知，后续重复项不能重新覆盖', () => {
    expect(
      GetQzoneFeedMediaDetail.parse(
        response([
          { video: { id: 'same' }, live: true },
          { video: { id: 'same' }, live: false },
          { video: { id: 'same' }, live: true },
        ]),
        params,
      ),
    ).toEqual([{ videoId: 'same', isLivePhoto: undefined }]);
  });
  it.each([
    { ...params, time: 0 },
    { ...params, ownerUin: 'bad' },
    { ...params, tid: '0' },
  ])('不猜测缺失定位参数 %j', (input) => {
    expect(() => GetQzoneFeedMediaDetail.serialize(input)).toThrow();
  });
  it('发送 QWeb 包而非裸业务体，并沿用中央签名策略', async () => {
    const sendPacket = vi.fn<TrpcNative['sendPacket']>(async () =>
      Buffer.from(response([{ video: { id: 'live' }, live: true }])),
    );
    expect(await GetQzoneFeedMediaDetail.invoke({ sendPacket }, 42, params)).toEqual([
      { videoId: 'live', isLivePhoto: true },
    ]);
    const policy = resolveSign(GetQzoneFeedMediaDetail.cmd);
    expect(sendPacket).toHaveBeenCalledWith(
      42,
      GetQzoneFeedMediaDetail.cmd,
      expect.any(Buffer),
      policy.needSign,
      policy.mode,
    );
    const request = decode(GetQzoneFeedMediaDetail.reqSchema, sendPacket.mock.calls[0]![2]!);
    expect(request.ext).toEqual([{ key: 'fc-appid', value: '101' }]);
    const requestBody = decode(
      message([
        { name: 'id', tag: 2, type: message([{ name: 'ext', tag: 4, type: ids, repeated: true }]) },
      ]),
      request.body as Uint8Array,
    );
    expect(requestBody.id).toMatchObject({
      ext: expect.arrayContaining([
        { kind: 8, uin: 10001n },
        { kind: 5, text: 'fixture-post' },
      ]),
    });
  });
});
