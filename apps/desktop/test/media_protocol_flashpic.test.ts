// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';

const FLASH_TOKEN = '/1707889225-1108524972-91CFB712BCDAB31C397F4CB5F226B718';

const state = vi.hoisted(() => ({
  fetched: [] as string[],
  /** 上游返回的字节；`null` 表示取不到。 */
  upstream: null as null | Uint8Array,
}));

vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {},
    bootstrap: {
      userConfig: { cacheDir: () => '' },
      avatarCache: {
        get: async (url: string) => {
          state.fetched.push(url);
          if (!state.upstream) throw new Error('synthetic upstream miss');
          return { data: Buffer.from(state.upstream), contentType: 'image/jpeg', fromCache: false };
        },
      },
    },
  }),
  requirePlatform: () => ({}),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  downloadUrlToFile: async () => ({ ok: false, reason: 'synthetic' }),
}));

function flashpic(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `weq-media://flashpic?${q}`;
}

it('闪照按 offpic 形状拼上游地址，保留连续两个斜杠', async () => {
  state.fetched.length = 0;
  state.upstream = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

  const res = await handleMediaRequest(new Request(flashpic({ token: FLASH_TOKEN, spec: '198' })));

  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/jpeg');
  // fileToken 自带前导 `/`，与固定前缀拼起来就是两个斜杠——CDN 认的就是这个形状。
  expect(state.fetched).toEqual([`https://c2cpicdw.qpic.cn/offpic_new/${FLASH_TOKEN}/198`]);
});

it('三档 spec 都放行，其余一律拒绝', async () => {
  state.upstream = new Uint8Array([1]);
  for (const spec of ['0', '198', '720']) {
    state.fetched.length = 0;
    const res = await handleMediaRequest(new Request(flashpic({ token: FLASH_TOKEN, spec })));
    expect(res.status).toBe(200);
    expect(state.fetched[0]).toContain(`/${spec}`);
  }
  for (const spec of ['1', '2', '999', '', '../0']) {
    state.fetched.length = 0;
    const res = await handleMediaRequest(new Request(flashpic({ token: FLASH_TOKEN, spec })));
    expect(res.status).toBe(404);
    expect(state.fetched).toEqual([]);
  }
});

it('非 offpic 形状的 token 不会被拼进上游，避免变成任意地址出口', async () => {
  state.upstream = new Uint8Array([1]);
  for (const token of [
    'https://evil.invalid/a.jpg',
    '/../etc/passwd',
    'EhSFggR8RGn2BgoNWCKJxibUo0KvhBj2sgIg',
    '/1707889225-1108524972-notamd5',
    '',
  ]) {
    state.fetched.length = 0;
    const res = await handleMediaRequest(new Request(flashpic({ token, spec: '0' })));
    expect(res.status).toBe(404);
    expect(state.fetched).toEqual([]);
  }
});

it('上游取不到时回 404，不伪造成功', async () => {
  state.upstream = null;
  state.fetched.length = 0;
  const res = await handleMediaRequest(new Request(flashpic({ token: FLASH_TOKEN, spec: '0' })));
  expect(res.status).toBe(404);
  expect(state.fetched.length).toBe(1);
});
