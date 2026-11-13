import { afterEach, expect, it, vi } from 'vitest';
import { fetchProviderModels, parseModelList } from '../src/models';
import { normalizeProviderConfig } from '../src/provider';

const floway = {
  id: 'deepseek-v4.1-flash',
  display_name: 'Floway Flash',
  kind: 'chat',
  chat: {
    modalities: { input: ['text', 'image'] },
    reasoning: { effort: { supported: ['low', 'high', 'max'], default: 'high' }, mandatory: true },
  },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

it('Floway 按实际元数据读取能力、原始顺序和默认值，保存不丢扩展字段', () => {
  const [model] = parseModelList({ data: [floway] });
  expect(model).toMatchObject({
    id: floway.id,
    label: floway.display_name,
    capabilities: ['chat', 'vision'],
    reasoningEfforts: ['low', 'high', 'max'],
    metadata: {
      reasoning: {
        mandatory: true,
        controls: [{ kind: 'effort', values: ['low', 'high', 'max'], default: 'high' }],
      },
      raw: floway,
    },
  });
  expect(
    normalizeProviderConfig({
      id: 'p',
      name: 'p',
      vendor: 'custom',
      baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture',
      models: [model!],
    }).models[0]!.metadata,
  ).toEqual(model!.metadata);
});

it('基础目录不再按名称猜测；缺失、null 与 false 各自保留', () => {
  const models = parseModelList({
    data: [
      { id: 'gpt-4o-vision' },
      { id: 'm', capabilities: null },
      { id: 'n', supports_image_in: false, supports_reasoning: false },
    ],
  });
  expect(models[0]!.capabilities).toEqual([]);
  expect(models[1]!.metadata!.capabilities.vision).toBe('unknown');
  expect(models[2]!.metadata).toMatchObject({
    capabilities: { vision: 'unsupported' },
    reasoning: { supported: false, controls: [] },
  });
});

it('图片生成不是图像输入，向量模型不附带聊天和思考档位', () => {
  const models = parseModelList([
    {
      id: 'image',
      kind: 'image',
      input_modalities: ['text', 'image'],
      chat: { modalities: { output: ['image'] } },
    },
    { id: 'embed', kind: 'embedding' },
  ]);
  expect(models[0]!.capabilities).toEqual([]);
  expect(models[1]!.capabilities).toEqual(['embedding']);
  expect(models[1]!.metadata!.capabilities).toEqual({
    chat: 'unsupported',
    embedding: 'supported',
    vision: 'unsupported',
  });
});

it.each([
  {
    id: 'deepseek',
    input_modalities: ['text'],
    effort: { supported_levels: ['high', 'xhigh'], default_level: 'xhigh' },
  },
  {
    id: 'openrouter',
    architecture: { input_modalities: ['text', 'image'] },
    reasoning: { supported_efforts: ['max', 'low'], default_effort: 'low' },
  },
  {
    id: 'vercel',
    type: 'language',
    reasoning_options: [
      { type: 'effort', values: ['custom', 'low'] },
      { type: 'budget_tokens', min: 128, max: 4096 },
      { type: 'toggle' },
    ],
  },
  {
    id: 'claude',
    capabilities: {
      image_input: { supported: true },
      thinking: { supported: true, types: { adaptive: { supported: true } } },
      effort: { low: { supported: true }, max: { supported: false } },
    },
  },
])('解析各家扩展字段，不生成通用三档：$id', (raw) => {
  const [model] = parseModelList([raw]);
  expect(model!.metadata!.reasoning.controls[0]!.kind).toBe('effort');
  expect(model!.metadata!.raw).toEqual(raw);
  expect(model!.reasoningEfforts).not.toEqual(['low', 'medium', 'high']);
});

it('Ollama 布尔开关不字符串化，预算与自适应不是命名档位', () => {
  const [model] = parseModelList([
    {
      id: 'local',
      capabilities: ['completion', 'thinking'],
      thinking: { values: [false, true], default: true },
      chat: { reasoning: { budget_tokens: { min: 128, max: 4096 }, adaptive: true } },
    },
  ]);
  expect(model!.reasoningEfforts).toEqual([]);
  expect(model!.metadata!.reasoning.controls).toEqual([
    { kind: 'toggle', source: 'thinking.values', values: [false, true], default: true },
    { kind: 'budget', source: 'chat.reasoning.budget_tokens', min: 128, max: 4096 },
    { kind: 'adaptive', source: 'chat.reasoning.adaptive' },
  ]);
});

it('LM Studio 使用 key、原生 off/on 及默认值；OpenRouter null 不当作空枚举', () => {
  const models = parseModelList({
    models: [
      {
        key: 'local',
        type: 'llm',
        capabilities: {
          vision: false,
          reasoning: { allowed_options: ['off', 'on'], default: 'on' },
        },
      },
      { id: 'gateway', reasoning: { supported_efforts: null } },
    ],
  });
  expect(models[0]).toMatchObject({
    id: 'local',
    metadata: {
      reasoning: { controls: [{ kind: 'toggle', values: ['off', 'on'], default: 'on' }] },
    },
  });
  expect(models[0]!.reasoningEfforts).toEqual([]);
  expect(models[1]!.metadata!.reasoning.controls[0]!.values).toBeNull();
});

it('原生命名档位保留在元数据，不因同名就当作兼容 API effort', () => {
  const [model] = parseModelList([
    {
      key: 'local',
      type: 'llm',
      capabilities: { reasoning: { allowed_options: ['low', 'high'], default: 'high' } },
    },
  ]);
  expect(model!.metadata!.reasoning.controls[0]).toMatchObject({
    kind: 'effort',
    values: ['low', 'high'],
    default: 'high',
  });
  expect(model!.reasoningEfforts).toEqual([]);
});

it('分页只访问配置端点，保留别名与元数据', async () => {
  const fetch = vi.fn(async (url: string) =>
    url.includes('after_id=')
      ? json({ data: [{ id: 'alias', kind: 'embedding' }], has_more: false })
      : json({ data: [floway], has_more: true, last_id: floway.id }),
  );
  vi.stubGlobal('fetch', fetch);
  const models = await fetchProviderModels({
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture',
  });
  expect(models.map((model) => model.id)).toEqual([floway.id, 'alias']);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://fixture.invalid/v1/models',
    `https://fixture.invalid/v1/models?after_id=${floway.id}`,
  ]);
});

it('已识别 Ollama 才补取原生详情，POST 仅携带模型 ID', async () => {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/api/tags')
      ? json({ models: [{ name: 'local' }] })
      : json({
          capabilities: ['completion', 'vision'],
          thinking: { values: [false, true], default: true },
        }),
  );
  vi.stubGlobal('fetch', fetch);
  const [model] = await fetchProviderModels({
    baseUrl: 'http://fixture.invalid/v1',
    vendor: 'ollama',
    modelIds: ['local'],
  });
  expect(model!.capabilities).toEqual(['chat', 'vision']);
  expect(fetch).toHaveBeenLastCalledWith(
    'http://fixture.invalid/api/show',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'local' }) }),
  );
});

it('原生详情读取失败保留未知与真实原因，不当成不支持', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/api/tags')
        ? json({ models: [{ name: 'local' }] })
        : json({ error: 'denied' }, 403),
    ),
  );
  const [model] = await fetchProviderModels({
    baseUrl: 'http://fixture.invalid/v1',
    vendor: 'ollama',
    modelIds: ['local'],
  });
  expect(model!.metadata!.capabilities.chat).toBe('unknown');
  expect(model!.metadata!.error).toContain('403');
});

it('原生详情补齐嵌套字段，不抹掉目录已有能力', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('/models')
        ? json({ data: [{ id: 'm', capabilities: { completion_chat: true } }] })
        : json({ capabilities: { vision: true } }),
    ),
  );
  const [model] = await fetchProviderModels({
    baseUrl: 'https://fixture.invalid/v1',
    vendor: 'mistral',
    modelIds: ['m'],
  });
  expect(model!.capabilities).toEqual(['chat', 'vision']);
  expect(model!.metadata!.raw).toMatchObject({
    capabilities: { completion_chat: true, vision: true },
  });
});

it('分页游标重复时明确失败，不悄悄把不完整目录当作全部模型', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ data: [{ id: 'm' }], has_more: true, last_id: 'm' })),
  );
  await expect(fetchProviderModels({ baseUrl: 'https://fixture.invalid/v1' })).rejects.toThrow(
    '游标',
  );
});

it('硅基流动按实际原厂类型集合补齐用途，不把生图视为视觉输入', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const type = new URL(url).searchParams.get('sub_type');
      return json({
        data:
          type === 'chat'
            ? [{ id: 'chat' }]
            : type === 'embedding'
              ? [{ id: 'embed' }]
              : [{ id: 'chat' }, { id: 'embed' }, { id: 'image' }],
      });
    }),
  );
  const models = await fetchProviderModels({
    baseUrl: 'https://api.siliconflow.cn/v1',
    vendor: 'siliconflow',
  });
  expect(models.map((model) => model.capabilities)).toEqual([['chat'], ['embedding'], []]);
  expect(models[0]!.metadata!.capabilities.vision).toBe('unknown');
});

it('服务商模板未换但 URL 是自定义网关时不使用原厂类型查询', async () => {
  const fetch = vi.fn(async () => json({ data: [floway] }));
  vi.stubGlobal('fetch', fetch);
  await fetchProviderModels({ baseUrl: 'https://fixture.invalid/v1', vendor: 'siliconflow' });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('oMLX 原生状态目录无权限时仍读取兼容目录，保留缺失原因', async () => {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith('/status') ? json({ error: 'denied' }, 403) : json({ data: [{ id: 'm' }] }),
  );
  vi.stubGlobal('fetch', fetch);
  const [model] = await fetchProviderModels({
    baseUrl: 'https://fixture.invalid/v1',
    vendor: 'omlx',
    modelIds: ['m'],
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    'https://fixture.invalid/v1/models/status',
    'https://fixture.invalid/v1/models',
  ]);
  expect(model!.metadata).toMatchObject({
    error: expect.stringContaining('403'),
    capabilities: { chat: 'unknown' },
    reasoning: { controls: [] },
  });
});
