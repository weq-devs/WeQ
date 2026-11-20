// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  createWebAvatarCache,
  webAvatarKey,
  WEB_AVATAR_LIMITS,
  type StoredAvatar,
} from '../src/renderer/src/lib/webAvatarCache';

const source = '/_media/avatar?scope=user&uin=10001&v=small&cid=client';
const key = webAvatarKey('account-a', source)!;
const blob = (text: string) => new Blob([text], { type: 'image/png' });
const response = (text: string) => new Response(blob(text), { headers: { etag: `"${text}"` } });
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function fixture(initial?: StoredAvatar) {
  const values = new Map(initial ? [[initial.key, initial]] : []);
  const store = {
    get: vi.fn(async (key: string) => values.get(key)),
    put: vi.fn(async (value: StoredAvatar) => {
      values.set(value.key, value);
    }),
  };
  const prepare = vi.fn(async (value: Blob) => ({
    src: `blob:${await value.text()}`,
    bytes: 4096,
    dispose: vi.fn(),
  }));
  const fetchImage = vi.fn(async (_source: string, _init: RequestInit) => response('new'));
  let time = WEB_AVATAR_LIMITS.freshMs + 100;
  const cache = createWebAvatarCache({ store, prepare, fetchImage, now: () => time });
  const release = cache.subscribe(key, () => {});
  return {
    cache,
    store,
    prepare,
    fetchImage,
    release,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
afterEach(() => vi.useRealTimers());

it('同图地址规范化但账号、配置、分辨率和省流量策略不混用', () => {
  expect(webAvatarKey('account-a', source + '&_weq_avatar_refresh=3&_weq_avatar_remote=1')).toBe(
    key,
  );
  expect(webAvatarKey('account-a', source.replace('client', 'other'))).toBe(key);
  expect(webAvatarKey('account-b', source)).not.toBe(key);
  expect(webAvatarKey('account-a', source.replace('small', 'big'))).not.toBe(key);
  expect(webAvatarKey('account-a', source + '&ds=1&auto=0')).not.toBe(key);
  expect(webAvatarKey('account-a', '/_media/pic?name=image')).toBeNull();
});

it('新鲜的持久头像解码后直接复用，卸载重进不再读取磁盘或网络', async () => {
  const f = fixture({ key, blob: blob('old'), etag: '"old"', updatedAt: 200 });
  await f.cache.load(key, source);
  expect(f.cache.peek(key)).toEqual({ src: 'blob:old', ready: true, failed: false });
  f.release();
  await f.cache.load(key, source);
  expect(f.store.get).toHaveBeenCalledTimes(1);
  expect(f.fetchImage).not.toHaveBeenCalled();
  expect(f.prepare).toHaveBeenCalledTimes(1);
});

it('缩略图失败时显示已加载的原图，缩略图恢复后仍优先使用缩略图', async () => {
  const f = fixture();
  const original = source.replace('v=small', 'v=big');
  const originalKey = webAvatarKey('account-a', original)!;
  f.fetchImage.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await f.cache.load(key, source);
  expect(f.cache.peek(key, originalKey)?.failed).toBe(true);

  f.fetchImage.mockResolvedValueOnce(response('original'));
  await f.cache.load(originalKey, original);
  expect(f.cache.peek(key, originalKey)?.src).toBe('blob:original');
  expect(f.fetchImage).toHaveBeenCalledTimes(2);

  f.advance(2_000);
  await f.cache.load(key, source);
  expect(f.cache.peek(key, originalKey)?.src).toBe('blob:new');
});

it('过期头像在慢请求完成前先显示旧图，刷新失败保持旧图并退避', async () => {
  const f = fixture({ key, blob: blob('old'), etag: '"old"', updatedAt: 0 });
  let reject!: (error: Error) => void;
  f.fetchImage.mockImplementation(
    () =>
      new Promise((_yes, no) => {
        reject = no;
      }),
  );
  const loading = f.cache.load(key, source);
  await flush();
  expect(f.cache.peek(key)?.src).toBe('blob:old');
  reject(new Error('offline'));
  await loading;
  expect(f.cache.peek(key)).toEqual({ src: 'blob:old', ready: true, failed: false });
  await f.cache.load(key, source);
  expect(f.fetchImage).toHaveBeenCalledTimes(1);
  f.advance(WEB_AVATAR_LIMITS.retryMs);
  f.fetchImage.mockResolvedValue(response('new'));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:new');
});

it('同一可见头像首次失败后自动补试并恢复，多处显示只发一个补试请求', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const firstView = f.cache.activate(key);
  const secondView = f.cache.activate(key);
  f.fetchImage.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.failed).toBe(true);
  firstView();
  const recovered = new Promise<void>((resolve) => {
    const unsubscribe = f.cache.subscribe(key, () => {
      if (!f.cache.peek(key)?.ready) return;
      unsubscribe();
      resolve();
    });
  });

  f.advance(2_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await recovered;
  expect(f.fetchImage).toHaveBeenCalledTimes(2);
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  secondView();
});

it('离屏取消补试，重新可见可加载', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const leave = f.cache.activate(key);
  f.fetchImage.mockImplementation(async () => new Response(null, { status: 404 }));
  await f.cache.load(key, source);
  leave();
  f.advance(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.fetchImage).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  const leaveAgain = f.cache.activate(key);
  await f.cache.load(key, source);
  f.advance(1_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(f.fetchImage).toHaveBeenCalledTimes(2);
  expect(f.cache.peek(key)?.failed).toBe(true);
  leaveAgain();
  expect(vi.getTimerCount()).toBe(0);
});

it('持续缺图时拉长补试间隔，耗尽预算后停止', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const leave = f.cache.activate(key);
  f.fetchImage.mockImplementation(async () => new Response(null, { status: 503 }));
  await f.cache.load(key, source);
  expect(f.fetchImage).toHaveBeenCalledTimes(1);

  for (const [index, delay] of [2_000, 5_000, 15_000, 30_000].entries()) {
    f.advance(delay - 1);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.fetchImage).toHaveBeenCalledTimes(index + 1);
    f.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.fetchImage).toHaveBeenCalledTimes(index + 2);
  }
  expect(f.cache.peek(key)?.failed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);

  const offscreen = `${source}&scopeFixture=other`;
  const offscreenKey = webAvatarKey('account-a', offscreen)!;
  await f.cache.load(offscreenKey, offscreen);
  f.fetchImage.mockResolvedValueOnce(response('reconnected'));
  f.cache.retryFailedVisible();
  f.cache.retryFailedVisible();
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:reconnected');
  expect(f.cache.peek(offscreenKey)?.failed).toBe(true);
  expect(f.fetchImage).toHaveBeenCalledTimes(7);
  leave();
});

it('304 只更新校验时间，不重解码、不换图片地址；换图时成功解码后才替换', async () => {
  const f = fixture({ key, blob: blob('old'), etag: '"old"', updatedAt: 0 });
  f.fetchImage.mockResolvedValue(new Response(null, { status: 304 }));
  await f.cache.load(key, source);
  expect(f.fetchImage.mock.calls[0]![1].headers).toEqual({ 'If-None-Match': '"old"' });
  expect(f.cache.peek(key)?.src).toBe('blob:old');
  expect(f.prepare).toHaveBeenCalledTimes(1);
  f.advance(WEB_AVATAR_LIMITS.freshMs);
  f.fetchImage.mockResolvedValue(response('changed'));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:changed');
  expect(f.store.put).toHaveBeenLastCalledWith(expect.objectContaining({ key, etag: '"changed"' }));
});

it('显式换头像绕过新鲜缓存，同一刷新在多处只请求一次', async () => {
  const f = fixture({ key, blob: blob('old'), etag: '"old"', updatedAt: 200 });
  await f.cache.load(key, source);
  const refresh = source + '&_weq_avatar_refresh=5&_weq_avatar_remote=1';
  const first = f.cache.load(key, refresh);
  expect(f.cache.load(key, refresh)).toBe(first);
  await first;
  expect(f.fetchImage.mock.calls[0]![1].headers).toEqual({});
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  await f.cache.load(key, refresh);
  expect(f.fetchImage).toHaveBeenCalledTimes(1);
});

it('存储不可用仍在线显示，格式错误和解码失败不覆盖旧缓存', async () => {
  const f = fixture();
  f.store.get.mockRejectedValue(new Error('blocked'));
  f.store.put.mockRejectedValue(new Error('quota'));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  f.advance(WEB_AVATAR_LIMITS.freshMs);
  f.fetchImage.mockResolvedValue(new Response('<html>error</html>'));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  f.advance(WEB_AVATAR_LIMITS.retryMs);
  f.fetchImage.mockResolvedValue(response('broken'));
  f.prepare.mockRejectedValue(new Error('bad image'));
  await f.cache.load(key, source);
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  expect(f.store.put).toHaveBeenCalledTimes(1);
});

it('切走账号取消请求，迟到结果不写入；超时结束加载态并允许稍后重试', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let resolve!: (value: Response) => void;
  f.fetchImage.mockImplementation(
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
  );
  const loading = f.cache.load(key, source);
  await flush();
  f.release();
  resolve(response('late'));
  await loading;
  expect(f.cache.peek(key)).toBeUndefined();
  expect(f.store.put).not.toHaveBeenCalled();
  f.cache.subscribe(key, () => {});
  const retry = f.cache.load(key, source);
  await vi.advanceTimersByTimeAsync(15_000);
  await retry;
  expect(f.cache.peek(key)?.failed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('滚过长列表后淘汰屏外头像，但当前可见头像不被挤掉', async () => {
  const f = fixture();
  const deactivate = f.cache.activate(key);
  await f.cache.load(key, source);
  for (let i = 0; i < WEB_AVATAR_LIMITS.maxImages + 2; i++) {
    const other = `${source}&uinFixture=${i}`;
    const otherKey = webAvatarKey('account-a', other)!;
    await f.cache.load(otherKey, other);
  }
  expect(f.cache.peek(key)?.src).toBe('blob:new');
  expect(f.cache.peek(webAvatarKey('account-a', `${source}&uinFixture=0`)!)).toBeUndefined();
  const oldest = await f.prepare.mock.results[1]!.value;
  expect(oldest.dispose).toHaveBeenCalledTimes(1);
  deactivate();
});
