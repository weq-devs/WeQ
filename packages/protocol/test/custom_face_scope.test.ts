import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  AddCustomFace,
  FetchCustomFaceDetail,
  ModifyCustomFace,
  OrderCustomFace,
} from '../src/oidb/custom-face';
import { decode, encode } from '../src/protobuf';

const state = vi.hoisted(() => ({
  session: vi.fn(async () => ({ host: '127.0.0.1', port: 80 })),
  pack: vi.fn(),
  unpack: vi.fn(),
}));
vi.mock('../src/highway/highway-client', () => ({
  fetchHighwaySession: state.session,
  packHighwayFrame: state.pack,
  unpackHighwayFrame: state.unpack,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('不允许联网');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

it('移动仅发送已验证的置前参数，不把任意序号当作协议能力', async () => {
  const sendOidbPacket = vi.fn(async () => Buffer.alloc(0));
  await expect(
    OrderCustomFace.invoke({ sendOidbPacket }, 101, {
      emojiId: '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0',
      position: 2,
    }),
  ).rejects.toThrow('移到最前');
  expect(sendOidbPacket).not.toHaveBeenCalled();
});

it('收藏详情使用 UIN 信封，保持原顺序并且不发送前置移动指令', async () => {
  const emojis = [
    {
      emojiId: '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0',
      md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  ];
  const sendOidbPacket = vi.fn(async (..._args: unknown[]) =>
    Buffer.from(
      encode(FetchCustomFaceDetail.respSchema, {
        retCode: 0,
        entries: [{ emoji: emojis[0], desc: '合成备注' }],
      }),
    ),
  );
  await expect(FetchCustomFaceDetail.invoke({ sendOidbPacket }, 101, { emojis })).resolves.toEqual([
    { emojiId: emojis[0]!.emojiId, desc: '合成备注' },
  ]);
  expect(sendOidbPacket).toHaveBeenCalledOnce();
  const call = sendOidbPacket.mock.calls[0]!;
  expect(call.slice(0, 3)).toEqual([
    101,
    FetchCustomFaceDetail.command,
    FetchCustomFaceDetail.subCommand,
  ]);
  expect(call[4]).toBe(true);
  expect(call[5]).toBe(true);
  expect(decode(FetchCustomFaceDetail.reqSchema, call[3] as Uint8Array)).toMatchObject({
    opType: 2,
    emojis,
  });
});

it('清空收藏备注也显式发送 desc，不把空串变成未修改', () => {
  const bytes = encode(
    ModifyCustomFace.reqSchema,
    ModifyCustomFace.serialize({
      emojiId: '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0',
      md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      desc: '',
    }),
  );
  const decoded = decode(ModifyCustomFace.reqSchema, bytes);
  expect((decoded.entry as Record<string, unknown>).desc).toBe('');
});

it('收藏表情取 Highway 会话后切号，不申请上传 token', async () => {
  const sendPacket = vi.fn(async () => Buffer.alloc(0));
  await expect(
    AddCustomFace.invoke({ sendPacket }, 101, {
      selfUin: '10001',
      imageBytes: new Uint8Array([1]),
      beforeSend: () => {
        throw new Error('账号改变');
      },
    }),
  ).rejects.toThrow('账号改变');
  expect(sendPacket).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
it('取得上传 token 后身份失效，不开始 Highway 上传', async () => {
  const sendPacket = vi.fn(async () => Buffer.from([0x1a, 3, 0x42, 1, 1]));
  let stages = 0;
  await expect(
    AddCustomFace.invoke({ sendPacket }, 101, {
      selfUin: '10001',
      imageBytes: new Uint8Array([1]),
      beforeSend: () => {
        if (++stages === 2) throw new Error('运行时改变');
      },
    }),
  ).rejects.toThrow('运行时改变');
  expect(sendPacket).toHaveBeenCalledOnce();
  expect(state.pack).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
