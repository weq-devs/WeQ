import { afterEach, expect, it, vi } from 'vitest';
import { fetchApi, requestApiJson } from '../src/api_usage';
import type { AgentLabEndpoint, AgentLabUsage } from '../src/types';
import { isUnsupportedTemperature, withoutTemperature } from '../src/temperature_fallback';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const updates: AgentLabUsage[] = [];
  const endpoint: AgentLabEndpoint = {
    baseUrl: 'https://synthetic.invalid/v1',
    apiKey: 'synthetic-key',
    model: 'synthetic-model',
    feature: 'reply-suggestion',
    onUsage: (entry) => updates.push(entry),
  };
  const controller = new AbortController();
  const body = {
    model: endpoint.model,
    temperature: 0,
    messages: [{ role: 'user', content: '合成消息' }],
    max_tokens: 100,
    tools: [{ type: 'function', function: { name: 'synthetic' } }],
  };
  const init: RequestInit = {
    method: 'POST',
    headers: { authorization: 'Bearer synthetic-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  };
  return { updates, endpoint, controller, body, init };
}
const rejected = {
  error: {
    param: 'temperature',
    code: 'unsupported_parameter',
    message: "Unsupported parameter: 'temperature' is not supported with this model.",
  },
  usage: { total_tokens: 1 },
};
const success = {
  choices: [{ message: { content: '合成结果' } }],
  usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
};

it.each([400, 422, 200])(
  'HTTP %s 明确拒绝温度时只移除该参数，沿用原信号与其他字段并分别记账',
  async (status) => {
    const f = fixture();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(rejected), { status }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success)));
    vi.stubGlobal('fetch', fetch);
    await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).resolves.toEqual(success);
    expect(fetch).toHaveBeenCalledTimes(2);
    const first = fetch.mock.calls[0]![1] as RequestInit;
    const retry = fetch.mock.calls[1]![1] as RequestInit;
    const { temperature: _temperature, ...expected } = f.body;
    expect(JSON.parse(String(first.body))).toEqual(f.body);
    expect(JSON.parse(String(retry.body))).toEqual(expected);
    expect(Object.hasOwn(JSON.parse(String(retry.body)), 'temperature')).toBe(false);
    expect(retry.headers).toBe(f.init.headers);
    expect(retry.signal).toBe(f.init.signal);
    expect(f.init.body).toBe(JSON.stringify(f.body));
    const finished = f.updates.filter((entry) => entry.status !== 'pending');
    expect(finished.map((entry) => entry.status)).toEqual(['failed', 'success']);
    expect(finished.map((entry) => entry.totalTokens)).toEqual([1, 5]);
    expect(new Set(finished.map((entry) => entry.requestId)).size).toBe(2);
    expect(
      finished.every(
        (entry) => entry.feature === 'reply-suggestion' && entry.model === f.endpoint.model,
      ),
    ).toBe(true);
  },
);

it('温度回退最多一次，第二次错误保留其真实状态与错误', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rejected), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(rejected), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow(
    'Unsupported parameter',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(f.updates.filter((entry) => entry.status === 'failed')).toHaveLength(2);
});

it.each([401, 403, 408, 429, 500, 503])(
  'HTTP %s 即使错误文字提及温度也不进行参数回退',
  async (status) => {
    const f = fixture();
    const fetch = vi.fn(async () => new Response(JSON.stringify(rejected), { status }));
    vi.stubGlobal('fetch', fetch);
    await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  {
    error: {
      param: 'temperature',
      message: 'temperature must be between 0 and 2',
      code: 'invalid_value',
    },
  },
  { error: { param: 'max_tokens', message: 'Unsupported parameter: max_tokens; temperature=0' } },
  {
    error: { param: 'temperature', message: 'temperature must be a number', code: 'invalid_type' },
  },
  { error: { code: 'invalid_api_key', message: 'temperature is not supported with this model' } },
  { error: { message: 'Unknown model; request contained temperature=0' } },
  { error: { message: 'temperature parameter is required' } },
])('普通参数／鉴权错误不被误认成温度不兼容：%j', async (error) => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify(error), { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['network', 'cancel', 'timeout'] as const)('%s 不触发温度回退', async (kind) => {
  const f = fixture();
  const fetch = vi.fn(async () => {
    throw new DOMException(
      '合成传输错误',
      kind === 'cancel' ? 'AbortError' : kind === 'timeout' ? 'TimeoutError' : 'NetworkError',
    );
  });
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});

it('流式 HTTP 参数拒绝在开始消费正文前回退，保留流标记与使用记录', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rejected), { status: 400 }))
    .mockResolvedValueOnce(
      new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
    );
  vi.stubGlobal('fetch', fetch);
  const result = await fetchApi(
    f.endpoint,
    '/chat/completions',
    { ...f.init, body: JSON.stringify({ ...f.body, stream: true }) },
    true,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await result.response.text()).toBe('data: [DONE]\n\n');
  result.usage.finish('success');
  expect(
    f.updates
      .filter((entry) => entry.status !== 'pending')
      .map((entry) => [entry.status, entry.stream]),
  ).toEqual([
    ['failed', true],
    ['success', true],
  ]);
});

it.each([
  { error: { param: 'temperature', code: 'unsupported_parameter' } },
  {
    error: {
      param: 'temperature',
      code: 'unsupported_value',
      message:
        "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
    },
  },
  { error: { message: 'This model does not support the parameter temperature' } },
  { error: { message: "Unrecognized request argument supplied: 'temperature'" } },
  { error: { message: 'Unknown name "temperature" at request' } },
  { error: { message: 'Temperature is not allowed for this model.' } },
  { error: { message: '该模型不支持 temperature 参数' } },
  { error: { message: 'temperature 参数不支持' } },
  { detail: 'Unsupported parameter: temperature' },
  {
    detail: [
      {
        loc: ['body', 'temperature'],
        type: 'extra_forbidden',
        msg: 'Extra inputs are not permitted',
      },
    ],
  },
])('兼容明确的拒绝形状：%j', (raw) => {
  expect(isUnsupportedTemperature(raw, 400)).toBe(true);
});

it('仅支持聊天 JSON POST 的自有温度字段，不重放其他请求或修改原始输入', () => {
  const body = JSON.stringify({ model: 'synthetic', temperature: 0 });
  for (const init of [
    { method: 'GET', body },
    { method: 'POST', body: 'not json' },
    { method: 'POST', body: '[]' },
    { method: 'POST', body: '{"model":"synthetic"}' },
    { method: 'POST', body: new URLSearchParams({ temperature: '0' }) },
  ]) {
    expect(withoutTemperature('/chat/completions', init)).toBeNull();
  }
  expect(withoutTemperature('/embeddings', { method: 'POST', body })).toBeNull();
});

it.each([400, 200])('HTTP %s 拒绝后已取消则不创建第二次尝试', async (status) => {
  const f = fixture();
  const original = f.endpoint.onUsage;
  f.endpoint.onUsage = (entry) => {
    original?.(entry);
    if (entry.status === 'failed') f.controller.abort();
  };
  const fetch = vi.fn(async () => new Response(JSON.stringify(rejected), { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetch).toHaveBeenCalledOnce();
  expect(new Set(f.updates.map((entry) => entry.requestId)).size).toBe(1);
});

it('拒绝正文过大时不新增无界缓冲或盲目重试，保留正常 HTTP 报错', async () => {
  const f = fixture();
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ ...rejected, padding: 'x'.repeat(70 * 1024) }), {
        status: 400,
      }),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow('HTTP 400');
  expect(fetch).toHaveBeenCalledOnce();
});

it('HTTP 200 已包含生成结果时不重试，避免重复生成', async () => {
  const f = fixture();
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ ...rejected, choices: success.choices })),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow(
    '模型服务错误',
  );
  expect(fetch).toHaveBeenCalledOnce();
});

it('纯文本拒绝也可回退，未声明该参数的后续请求不再重试', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('Unsupported parameter: temperature', { status: 400 }))
    .mockResolvedValueOnce(new Response('Unknown parameter: temperature', { status: 400 }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow('HTTP 400');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it.each([{ loc: ['query', 'temperature'] }, { loc: ['body', 'messages', 0, 'temperature'] }])(
  '不把非顶层温度字段错误当作当前请求参数不兼容：%j',
  ({ loc }) => {
    expect(isUnsupportedTemperature({ detail: [{ loc, type: 'extra_forbidden' }] }, 422)).toBe(
      false,
    );
  },
);

it.each([401, 429, 503])('回退后的 HTTP %s 原样报错，不再继续尝试', async (status) => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rejected), { status: 400 }))
    .mockResolvedValueOnce(new Response('合成第二次错误', { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow(
    `HTTP ${status}`,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(f.updates.filter((entry) => entry.status === 'failed')).toHaveLength(2);
});

it('首次拒绝没有 usage 时仍保留未知账目，不把它填为零或并入第二次成功', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: rejected.error }), { status: 400 }))
    .mockResolvedValueOnce(new Response(JSON.stringify(success)));
  vi.stubGlobal('fetch', fetch);
  await requestApiJson(f.endpoint, '/chat/completions', f.init);
  expect(
    f.updates
      .filter((entry) => entry.status !== 'pending')
      .map((entry) => ({
        status: entry.status,
        prompt: entry.promptTokens,
        total: entry.totalTokens,
      })),
  ).toEqual([
    { status: 'failed', prompt: null, total: null },
    { status: 'success', prompt: 2, total: 5 },
  ]);
});

it('HTTP 200 顶层明确错误码也能回退，不要求特定 error 包装', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rejected.error)))
    .mockResolvedValueOnce(new Response(JSON.stringify(success)));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).resolves.toEqual(success);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('HTTP 200 普通文本／消息里的温度字样不是请求拒绝，不触发回退', async () => {
  const f = fixture();
  for (const data of [
    'temperature is not supported',
    { message: 'temperature is not supported' },
  ]) {
    expect(isUnsupportedTemperature(data, 200)).toBe(false);
    const fetch = vi.fn(async () => new Response(JSON.stringify(data)));
    vi.stubGlobal('fetch', fetch);
    await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).resolves.toEqual(data);
    expect(fetch).toHaveBeenCalledOnce();
  }
});

it('顶层错误码的回退仍失败时保留服务端具体错误，不被泛化提示吞掉', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify(rejected.error)));
  vi.stubGlobal('fetch', fetch);
  await expect(requestApiJson(f.endpoint, '/chat/completions', f.init)).rejects.toThrow(
    rejected.error.message,
  );
  expect(fetch).toHaveBeenCalledTimes(2);
});
