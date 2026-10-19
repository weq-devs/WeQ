import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddCustomFace } from '../src/oidb/custom-face';

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
