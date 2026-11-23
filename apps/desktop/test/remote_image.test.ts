import { afterEach, expect, it, vi } from 'vitest';
import { requestRemoteImage } from '../src/renderer/src/lib/remoteImage';

const url = 'https://p.qlogo.cn/gh/123/123/100';
const path = (id: string) => `/_weq-remote-local/image/${id}`;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('iOS 新壳只下载短期本机二进制，省去 Base64 解码', async () => {
  const postMessage = vi.fn(async ({ id }: { id: string }) => ({ path: path(id) }));
  vi.stubGlobal('webkit', { messageHandlers: { weqQqImage: { postMessage } } });
  vi.stubGlobal('weqRemoteBinaryImages', true);
  const bytes = new Uint8Array([0, 100, 255]);
  const receive = vi.fn(
    async () =>
      new Response(bytes, {
        headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
      }),
  );
  vi.stubGlobal('fetch', receive);
  const decode = vi.spyOn(window, 'atob');
  const result = await requestRemoteImage(url, new AbortController().signal);
  expect(result?.type).toBe('image/png');
  expect(new Uint8Array(await result!.arrayBuffer())).toEqual(bytes);
  expect(decode).not.toHaveBeenCalled();
  expect(postMessage).toHaveBeenCalledWith({ id: expect.stringMatching(/^[a-f0-9]{32}$/), url });
  const id = postMessage.mock.calls[0]![0].id;
  expect(receive).toHaveBeenCalledWith(path(id), expect.objectContaining({ redirect: 'error' }));
});

it('Android 新壳使用二进制入口，取消会结束本机请求', async () => {
  let signal: AbortSignal | undefined;
  const receive = vi.fn(async (_: string, init: RequestInit) => {
    signal = init.signal ?? undefined;
    return new Promise<Response>((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    });
  });
  vi.stubGlobal('fetch', receive);
  const loadQqImage = vi.fn();
  const loadQqImageBinary = vi.fn((id: string) => {
    window.dispatchEvent(
      new CustomEvent('weq-remote-qq-image', {
        detail: { id, image: { path: path(id) } },
      }),
    );
  });
  vi.stubGlobal('weqRemoteLinks', {
    loadQqImage,
    loadQqImageBinary,
    supportsBinaryImages: () => true,
  });
  const abort = new AbortController();
  const pending = requestRemoteImage(url, abort.signal);
  expect(receive).toHaveBeenCalledOnce();
  abort.abort();
  expect(await pending).toBeNull();
  expect(signal?.aborted).toBe(true);
  expect(loadQqImage).not.toHaveBeenCalled();
});

it('旧壳回复仍可读取，无法读取时回到电脑路径', async () => {
  const postMessage = vi.fn(async () => ({ type: 'image/png', base64: 'Zg==' }));
  vi.stubGlobal('webkit', { messageHandlers: { weqQqImage: { postMessage } } });
  const result = await requestRemoteImage(url, new AbortController().signal);
  expect(await result?.text()).toBe('f');
  expect(postMessage).toHaveBeenCalledWith(url);
  postMessage.mockRejectedValueOnce(new Error('bridge unavailable'));
  expect(await requestRemoteImage(url, new AbortController().signal)).toBeNull();
});

it('不读取与当前请求 ID 不匹配的本机地址', async () => {
  vi.stubGlobal('weqRemoteBinaryImages', true);
  vi.stubGlobal('webkit', {
    messageHandlers: { weqQqImage: { postMessage: async () => ({ path: path('0'.repeat(32)) }) } },
  });
  const receive = vi.fn();
  vi.stubGlobal('fetch', receive);
  expect(await requestRemoteImage(url, new AbortController().signal)).toBeNull();
  expect(receive).not.toHaveBeenCalled();
});
