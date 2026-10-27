import { afterEach, expect, it, vi } from 'vitest';
import { detectModelCapabilities } from '../src/capability_probe';
import { normalizeProviderConfig } from '../src/provider';

const endpoint = {
  baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'fixture-secret',
  model: 'fixture',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const answer = (text: string) => json({ choices: [{ message: { content: text } }] });
afterEach(() => vi.unstubAllGlobals());

it('实际验证聊天、数值向量和两张不同颜色的内置图片', async () => {
  const colors = new Set<string>();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(init.headers).toMatchObject({ authorization: `Bearer ${endpoint.apiKey}` });
    if (url.endsWith('/embeddings')) {
      expect(body.input).toEqual(['WeQ capability test']);
      return json({ data: [{ embedding: [0.2, 0.3] }] });
    }
    const content = body.messages[0].content;
    if (typeof content === 'string') return answer('OK');
    const color = content[1].image_url.url.includes('MnjVOTw') ? 'red' : 'blue';
    colors.add(color);
    return answer(color);
  });
  vi.stubGlobal('fetch', fetch);
  const results = await detectModelCapabilities(endpoint);
  expect(results.map((result) => result.status)).toEqual(['supported', 'supported', 'supported']);
  expect(colors.size).toBe(2);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('已复现的 Floway 不支持 embeddings 响应取消向量能力；502 不判不支持', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/embeddings')
        ? json(
            {
              error: {
                message: 'Model fixture does not support the /embeddings endpoint.',
                type: 'api_error',
              },
            },
            400,
          )
        : new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    ),
  );
  expect((await detectModelCapabilities(endpoint)).map((result) => result.status)).toEqual([
    'unknown',
    'unsupported',
    'unknown',
  ]);
});

it.each([401, 403, 429, 500, 502])(
  'HTTP %s 即使包含 unsupported 也不能取消能力',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'unsupported image embedding chat' } }, status)),
    );
    const results = await detectModelCapabilities(endpoint);
    expect(results.every((result) => result.status === 'unknown')).toBe(true);
  },
);

it.each([{ vector: [] }, { vector: ['not-a-number'] }, { vector: [null] }])(
  '空或畸形向量不标记已验证：%j',
  async ({ vector }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/embeddings') ? json({ data: [{ embedding: vector }] }) : answer('OK'),
      ),
    );
    expect((await detectModelCapabilities(endpoint))[1]?.status).toBe('unknown');
  },
);

it('接受图片但始终返回固定颜色，不视为视觉支持', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/embeddings') ? json({ data: [{ embedding: [1] }] }) : answer('red'),
    ),
  );
  expect((await detectModelCapabilities(endpoint))[2]?.status).toBe('unknown');
});

it('不支持图片参数格式不等于模型不支持视觉能力', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json(
        { error: { message: 'unsupported image_url format; model requires a remote URL' } },
        400,
      ),
    ),
  );
  expect((await detectModelCapabilities(endpoint))[2]?.status).toBe('unknown');
});

it('明确的模型视觉能力拒绝标记不支持', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      json({ error: { message: 'This model does not support image inputs' } }, 400),
    ),
  );
  expect((await detectModelCapabilities(endpoint))[2]?.status).toBe('unsupported');
});

it('参数拒绝、模型不存在和返回业务错误只标记未确定，并隐藏回显的密钥', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ error: { message: `Model not found ${endpoint.apiKey}` } }, 404)),
  );
  const results = await detectModelCapabilities(endpoint);
  expect(results.every((result) => result.status === 'unknown')).toBe(true);
  expect(JSON.stringify(results)).not.toContain(endpoint.apiKey);
});

it('请求超时保留未确定', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    ),
  );
  expect(
    (await detectModelCapabilities({ ...endpoint, timeoutMs: 5 })).every(
      (result) => result.status === 'unknown',
    ),
  ).toBe(true);
});

it('保存检测得到的空能力列表时，不自动重新勾选聊天', () => {
  const provider = normalizeProviderConfig({
    id: 'fixture',
    name: 'fixture',
    vendor: 'custom',
    ...endpoint,
    models: [{ id: endpoint.model, capabilities: [] }],
  });
  expect(provider.models[0]?.capabilities).toEqual([]);
});
