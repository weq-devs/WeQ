import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLabProviderConfig, TtsProviderConfig } from '@weq/agentlab';
import { parseModelList } from '@weq/agentlab';
import { AgentLabSection } from '../src/renderer/src/components/settings/AgentLabSection';
import { ApiModelSelect } from '../src/renderer/src/components/settings/ApiModelSelect';
import { TtsProvidersCard } from '../src/renderer/src/components/settings/VoiceTranscribeSection';
import { providerDisplayLabels } from '../src/renderer/src/lib/providerDisplayLabels';
import { useToast } from '../src/renderer/src/components/Toast';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots } from '../src/renderer/src/lib/pageSnapshots';

const state = vi.hoisted(() => ({
  queryMode: 'ready',
  catalogError: false,
  refetch: vi.fn(async () => ({})),
  providers: [] as AgentLabProviderConfig[],
  tts: [] as TtsProviderConfig[],
  saveTts: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(async () => true),
  testLlm: vi.fn(),
  detectCapabilities: vi.fn(),
  fetchModels: vi.fn(),
  testTts: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
  useDialog: Object.assign(
    (select: (s: { confirm: typeof state.confirm }) => unknown) =>
      select({ confirm: state.confirm }),
    { getState: () => ({ confirm: state.confirm }) },
  ),
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ success: vi.fn(), error: state.error, confirm: state.confirm }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const catalog = [
    {
      vendor: 'siliconflow',
      label: 'Synthetic Provider',
      baseUrl: 'https://one.example.invalid/v1',
      models: [{ id: 'shared-model', capabilities: ['chat'] }],
    },
  ];
  return {
    client: {
      bootstrap: {
        testAgentLabProvider: { mutate: state.testLlm },
        detectAgentLabModelCapabilities: { mutate: state.detectCapabilities },
        testTtsProvider: { mutate: state.testTts },
      },
    },
    trpc: {
      useUtils: () => ({
        account: { intentSense: { getStatus: { invalidate: vi.fn(async () => undefined) } } },
        bootstrap: {
          listAgentLabProviders: { invalidate: vi.fn(async () => undefined) },
          listTtsProviders: { invalidate: vi.fn(async () => undefined) },
          getAgentLabDefaultModel: { invalidate: vi.fn(async () => undefined), setData: vi.fn() },
          getSettings: { invalidate: vi.fn(async () => undefined) },
        },
      }),
      bootstrap: {
        getDefaultVisionModel: {
          useQuery: () => ({ data: { ref: null, available: false, error: null } }),
        },
        setDefaultVisionModel: { useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }) },
        getAgentLabDefaultModel: {
          useQuery: () => ({
            data: { ref: null, available: false, error: null },
            refetch: state.refetch,
          }),
        },
        setAgentLabDefaultModel: {
          useMutation: () => ({ mutateAsync: vi.fn(), isLoading: false }),
        },
        getAgentLabCatalog: {
          useQuery: () => ({
            data: state.catalogError ? undefined : catalog,
            error: state.catalogError ? Error('合成模板读取失败') : null,
            refetch: state.refetch,
          }),
        },
        listAgentLabProviders: {
          useQuery: () => ({
            data: ['ready', 'stale'].includes(state.queryMode)
              ? state.providers
              : state.queryMode === 'empty'
                ? []
                : undefined,
            isLoading: state.queryMode === 'loading',
            error: ['error', 'stale'].includes(state.queryMode) ? Error('合成配置读取失败') : null,
            refetch: state.refetch,
          }),
        },
        saveAgentLabProvider: {
          useMutation: () => ({ mutateAsync: state.save, isLoading: false }),
        },
        deleteAgentLabProvider: {
          useMutation: () => ({ mutateAsync: state.remove, isLoading: false }),
        },
        testAgentLabProvider: {
          useMutation: () => ({ mutateAsync: state.testLlm, isLoading: false }),
        },
        fetchAgentLabModels: {
          useMutation: () => ({ isLoading: false, mutateAsync: state.fetchModels }),
        },
        getTtsCatalog: {
          useQuery: () => ({
            data: state.catalogError
              ? undefined
              : [
                  {
                    vendor: 'cosyvoice',
                    label: 'Synthetic Voice',
                    fields: ['apiKey'],
                    capabilities: { clone: false },
                  },
                ],
            error: state.catalogError ? Error('合成模板读取失败') : null,
            refetch: state.refetch,
          }),
        },
        listTtsProviders: {
          useQuery: () => ({
            data: ['ready', 'stale'].includes(state.queryMode)
              ? state.tts
              : state.queryMode === 'empty'
                ? []
                : undefined,
            isLoading: state.queryMode === 'loading',
            error: ['error', 'stale'].includes(state.queryMode) ? Error('合成配置读取失败') : null,
            refetch: state.refetch,
          }),
        },
        saveTtsProvider: { useMutation: () => ({ mutateAsync: state.saveTts, isLoading: false }) },
        deleteTtsProvider: { useMutation: () => ({ isLoading: false }) },
        testTtsProvider: { useMutation: () => ({ mutateAsync: state.testTts, isLoading: false }) },
      },
    },
  };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  state.queryMode = 'ready';
  state.catalogError = false;
  state.refetch.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.providers = [
    {
      id: 'synthetic-provider',
      name: 'Synthetic Provider',
      vendor: 'siliconflow',
      baseUrl: 'https://one.example.invalid/v1',
      apiKey: 'synthetic-first-key',
      models: [{ id: 'shared-model', capabilities: ['chat'] }],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  state.error.mockReset();
  state.testLlm.mockReset();
  state.detectCapabilities.mockReset();
  state.fetchModels.mockReset().mockResolvedValue([]);
  state.testTts.mockReset();
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  state.confirm.mockClear();
  state.tts = [
    {
      id: 'synthetic-voice',
      name: 'Synthetic Voice',
      vendor: 'cosyvoice',
      baseUrl: 'https://voice.example.invalid/v1',
      apiKey: 'synthetic-voice-first',
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  state.saveTts
    .mockReset()
    .mockImplementation(async (input: Omit<TtsProviderConfig, 'createdAt' | 'updatedAt'>) => {
      const next = { ...input, createdAt: 2, updatedAt: 2 };
      state.tts = [...state.tts.filter((row) => row.id !== input.id), next];
      return next;
    });
  state.save
    .mockReset()
    .mockImplementation(async (input: Omit<AgentLabProviderConfig, 'createdAt' | 'updatedAt'>) => {
      const next = { ...input, createdAt: 2, updatedAt: 2 };
      state.providers = [...state.providers.filter((row) => row.id !== input.id), next];
      return next;
    });
  state.remove.mockReset().mockImplementation(async ({ id }: { id: string }) => {
    state.providers = state.providers.filter((row) => row.id !== id);
    return true;
  });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function mount(tts = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(
          PageSnapshots,
          { scope: 'provider-settings-test' },
          createElement(tts ? TtsProvidersCard : AgentLabSection),
        ),
      ),
    );
  render();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    act(() => root.unmount());
    host.remove();
  };
  cleanups.push(close);
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (row) => row.textContent?.trim() === text,
    )!;
  const set = (selector: string, value: string) =>
    act(() => {
      const input = host.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { host, render, button, set, close };
}
describe('多 API provider 配置', () => {
  const detect = (f: ReturnType<typeof mount>) =>
    f.host.querySelector<HTMLButtonElement>('.weq-provider-model-detect')!;
  const confirmId = (f: ReturnType<typeof mount>) =>
    f.host
      .querySelector<HTMLInputElement>('[aria-label="模型 1 ID"]')!
      .dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

  it('Floway 元数据完整时直接回填原始档位、默认值与能力，只在保存服务商时提交', async () => {
    state.fetchModels.mockResolvedValue(
      parseModelList([
        {
          id: 'shared-model',
          kind: 'chat',
          chat: {
            modalities: { input: ['text', 'image'] },
            reasoning: { effort: { supported: ['low', 'high', 'max'], default: 'high' } },
          },
        },
      ]),
    );
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => confirmId(f));
    const input = f.host.querySelector<HTMLInputElement>('[aria-label="模型 1 思考档位"]')!;
    expect(input.value).toBe('low, high, max');
    expect(input.title).toContain('默认 high');
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.detectCapabilities).not.toHaveBeenCalled();
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0].models[0]).toMatchObject({
      capabilities: ['chat', 'vision'],
      reasoningEfforts: ['low', 'high', 'max'],
      metadata: { reasoning: { controls: [{ default: 'high' }] } },
    });
  });

  it('批量导入一次询问缺失项，暂不探测后确认相同 ID 不重复弹窗，图标可主动重试', async () => {
    state.fetchModels.mockResolvedValue(
      parseModelList([
        { id: 'a', kind: 'chat', chat: { modalities: { input: ['text'] } } },
        { id: 'b' },
      ]),
    );
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => f.button('拉取可用模型').click());
    await act(async () => f.button('导入选中 (2)').click());
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(state.confirm).toHaveBeenCalledWith(
      '探测缺失的模型信息？',
      expect.stringContaining('2 个模型缺少能力、思考控制与合法档位'),
      { okLabel: '开始探测', cancelLabel: '暂不探测' },
    );
    expect(state.fetchModels).toHaveBeenCalledTimes(1);
    expect(state.detectCapabilities).not.toHaveBeenCalled();
    await act(async () =>
      f.host
        .querySelector<HTMLInputElement>('[aria-label="模型 2 ID"]')!
        .dispatchEvent(new FocusEvent('focusout', { bubbles: true })),
    );
    expect(state.confirm).toHaveBeenCalledTimes(1);
    await act(async () =>
      f.host.querySelectorAll<HTMLButtonElement>('.weq-provider-model-detect')[1]!.click(),
    );
    expect(state.confirm).toHaveBeenCalledTimes(2);
  });

  it('仅思考缺失时不重测能力，探测的原始档位回填草稿', async () => {
    state.fetchModels.mockResolvedValue(
      parseModelList([
        { id: 'shared-model', kind: 'chat', chat: { modalities: { input: ['text'] } } },
      ]),
    );
    state.detectCapabilities.mockResolvedValue({
      capabilities: [],
      reasoning: {
        status: 'supported',
        detail: '合法枚举',
        reasoning: {
          supported: true,
          controls: [
            { kind: 'effort', source: 'probe.reasoning_effort', values: ['custom', 'max'] },
          ],
        },
      },
    });
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => detect(f).click());
    expect(state.detectCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: [], reasoning: true }),
    );
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="模型 1 思考档位"]')!.value).toBe(
      'custom, max',
    );
  });

  it('能力缺失但明确不支持思考时只探测缺失能力', async () => {
    state.fetchModels.mockResolvedValue(
      parseModelList([{ id: 'shared-model', supports_image_in: false, supports_reasoning: false }]),
    );
    state.detectCapabilities.mockResolvedValue({ capabilities: [] });
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => detect(f).click());
    expect(state.detectCapabilities).toHaveBeenCalledWith(
      expect.objectContaining({ capabilities: ['chat', 'embedding'], reasoning: false }),
    );
  });

  it('改模型 ID 后清除旧模型自动回填项，不把旧档位留给未知模型', async () => {
    state.providers[0]!.models = parseModelList([
      {
        id: 'shared-model',
        kind: 'chat',
        chat: {
          modalities: { input: ['text', 'image'] },
          reasoning: { effort: { supported: ['low', 'high'], default: 'high' } },
        },
      },
    ]);
    state.fetchModels.mockResolvedValue(parseModelList([{ id: 'unknown-model' }]));
    state.confirm.mockResolvedValueOnce(false);
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('[aria-label="模型 1 ID"]', 'unknown-model');
    await act(async () => confirmId(f));
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="模型 1 思考档位"]')!.value).toBe(
      '',
    );
    expect(
      [...f.host.querySelectorAll('[aria-label="模型 1 能力"] button')].map((button) =>
        button.getAttribute('aria-pressed'),
      ),
    ).toEqual(['false', 'false', 'false']);
    expect(state.detectCapabilities).not.toHaveBeenCalled();
  });

  it('元数据迟到不覆盖期间手改的能力与思考档位，仍补齐未改字段', async () => {
    let finish!: (value: unknown) => void;
    state.fetchModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => detect(f).click());
    f.set('[aria-label="模型 1 思考档位"]', 'manual');
    act(() =>
      [...f.host.querySelectorAll<HTMLButtonElement>('[aria-label="模型 1 能力"] button')]
        .find((item) => item.textContent === '聊天')!
        .click(),
    );
    await act(async () =>
      finish(
        parseModelList([
          {
            id: 'shared-model',
            kind: 'chat',
            chat: {
              modalities: { input: ['text', 'image'] },
              reasoning: { effort: { supported: ['low', 'high'], default: 'high' } },
            },
          },
        ]),
      ),
    );
    expect(f.host.querySelector<HTMLInputElement>('[aria-label="模型 1 思考档位"]')!.value).toBe(
      'manual',
    );
    const buttons = [
      ...f.host.querySelectorAll<HTMLButtonElement>('[aria-label="模型 1 能力"] button'),
    ];
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'false',
      'true',
    ]);
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0].models[0]).toMatchObject({
      capabilities: ['vision'],
      reasoningEfforts: ['manual'],
      overrides: { capabilities: ['chat'], reasoning: true },
    });
  });

  it('能力使用独立多选按钮，切换与保存保留其他能力和思考档位', async () => {
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    const group = f.host.querySelector('[aria-label="模型 1 能力"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.querySelector('[role="checkbox"]')).toBeNull();
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['聊天', '向量', '视觉']);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    f.set('[aria-label="模型 1 思考档位"]', 'low, high');
    act(() => buttons[2]!.click());
    act(() => buttons[1]!.click());
    act(() => buttons[0]!.click());
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual([
      'false',
      'true',
      'true',
    ]);
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0].models[0]).toMatchObject({
      capabilities: ['vision', 'embedding'],
      reasoningEfforts: ['low', 'high'],
    });
  });
  it.each([false, true])('%s 未修改或改回原值时关闭不确认，也不留下页面草稿', async (tts) => {
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    expect(pageSnapshots.hasDrafts('provider-settings-test')).toBe(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(pageSnapshots.hasDrafts('provider-settings-test')).toBe(false);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    const original = f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value;
    f.set('input[type="password"]', 'synthetic-edit');
    f.set('input[type="password"]', original);
    await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(f.host.querySelector('.weq-provider-modal')).toBeNull();
  });
  it.each([false, true])('%s 修改仅在关闭编辑器时确认，取消保留，放弃后不遗留草稿', async (tts) => {
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('input[type="password"]', 'synthetic-edit');
    expect(state.confirm).not.toHaveBeenCalled();
    state.confirm.mockResolvedValueOnce(false);
    await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(state.confirm).toHaveBeenCalledWith(
      '放弃未保存的修改？',
      expect.any(String),
      expect.anything(),
    );
    expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      'synthetic-edit',
    );
    await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(f.host.querySelector('.weq-provider-modal')).toBeNull();
    expect(pageSnapshots.hasDrafts('provider-settings-test')).toBe(false);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).not.toBe(
      'synthetic-edit',
    );
  });
  it.each([false, true])('%s 保存后关闭不确认且不遗留页面草稿', async (tts) => {
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('input[type="password"]', 'synthetic-edit');
    await act(async () => f.button(tts ? '保存' : '保存服务商').click());
    await act(async () => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(state.confirm).not.toHaveBeenCalled();
    expect(pageSnapshots.hasDrafts('provider-settings-test')).toBe(false);
  });
  it.each([false, true])('%s 清除旧编辑器遗留标记，不恢复已关闭的编辑框', (tts) => {
    const prefix = tts ? 'tts' : 'provider';
    pageSnapshots.write(JSON.stringify(['provider-settings-test', `${prefix}:open`]), false, true);
    pageSnapshots.write(JSON.stringify(['provider-settings-test', `${prefix}:form`]), {}, true);
    const f = mount(tts);
    expect(f.host.querySelector('.weq-provider-modal')).toBeNull();
    expect(pageSnapshots.hasDrafts('provider-settings-test')).toBe(false);
  });
  it('能力检测回填已验证与不支持项，未知项保留原选择且不自动保存', async () => {
    state.providers[0]!.models[0]!.capabilities = ['embedding', 'vision'];
    state.detectCapabilities.mockResolvedValue({
      capabilities: [
        { capability: 'chat', status: 'supported', detail: '测试通过' },
        { capability: 'embedding', status: 'unsupported', detail: '不支持 /embeddings' },
        { capability: 'vision', status: 'unknown', detail: 'HTTP 502' },
      ],
    });
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-provider-model-detect')!.click(),
    );
    expect(state.confirm).toHaveBeenCalledWith(
      '探测缺失的模型信息？',
      expect.stringContaining('不包含聊天记录'),
      expect.anything(),
    );
    expect(state.detectCapabilities).toHaveBeenCalledWith({
      providerId: state.providers[0]!.id,
      providerName: state.providers[0]!.name,
      baseUrl: state.providers[0]!.baseUrl,
      apiKey: state.providers[0]!.apiKey,
      model: 'shared-model',
      capabilities: ['chat', 'embedding', 'vision'],
      reasoning: true,
    });
    const title = f.host.querySelector('.weq-provider-model-detect')!.getAttribute('title');
    expect(title).toContain('聊天：已验证');
    expect(title).toContain('向量：不支持');
    expect(title).toContain('视觉：未确定');
    expect(title).toContain('HTTP 502');
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0].models[0].capabilities).toEqual(['chat', 'vision']);
    expect(state.save.mock.calls[0]![0].models[0]).not.toHaveProperty('probe');
  });
  it('暂不探测不发推理请求，检测中允许手改但锁定保存，失败不改原能力', async () => {
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    state.confirm.mockResolvedValueOnce(false);
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-provider-model-detect')!.click(),
    );
    expect(state.detectCapabilities).not.toHaveBeenCalled();
    let reject!: (error: Error) => void;
    state.detectCapabilities.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-provider-model-detect')!.click(),
    );
    expect(f.host.querySelector('fieldset')?.disabled).toBe(false);
    expect(f.button('保存服务商').disabled).toBe(true);
    await act(async () => reject(new Error('合成网络错误')));
    expect(f.host.querySelector('fieldset')?.disabled).toBe(false);
    expect(state.error).toHaveBeenCalledWith('模型检测失败', '合成网络错误');
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0].models[0].capabilities).toEqual(['chat']);
  });
  it('配置已变化时丢弃迟到的能力结果', async () => {
    let finish!: (value: unknown) => void;
    state.detectCapabilities.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () =>
      f.host.querySelector<HTMLButtonElement>('.weq-provider-model-detect')!.click(),
    );
    f.set('[aria-label="API Key"]', 'synthetic-new-key');
    await act(async () =>
      finish({
        capabilities: [{ capability: 'chat', status: 'unsupported', detail: '旧端点结果' }],
      }),
    );
    expect(f.host.textContent).not.toContain('旧端点结果');
    await act(async () => f.button('保存服务商').click());
    expect(state.save.mock.calls[0]![0]).toMatchObject({
      apiKey: 'synthetic-new-key',
      models: [{ id: 'shared-model', capabilities: ['chat'] }],
    });
  });
  it.each([false, true])('%s 加载配置不冒充空列表，失败可重试并保留缓存', (tts) => {
    state.queryMode = 'loading';
    const f = mount(tts);
    expect(f.host.textContent).toContain('正在读取');
    expect(f.host.textContent).not.toContain(tts ? '暂无语音合成' : '还没有服务商');
    state.queryMode = 'error';
    f.render();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成配置读取失败');
    expect(f.host.textContent).not.toContain(tts ? '暂无语音合成' : '还没有服务商');
    act(() => f.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    state.queryMode = 'stale';
    f.render();
    expect(f.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.host.querySelectorAll('.weq-agentlab-provider-item')).toHaveLength(1);
    state.queryMode = 'empty';
    f.render();
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    expect(f.host.textContent).toContain(tts ? '暂无语音合成' : '还没有服务商');
  });
  it.each([false, true])('%s 模板读取失败可重试，编辑保留原厂商与凭据', (tts) => {
    state.catalogError = true;
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成模板读取失败');
    act(() => f.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(
      f.host.querySelector<HTMLSelectElement>(
        `[aria-label="${tts ? 'TTS 服务商模板' : 'API 服务商模板'}"]`,
      )!.value,
    ).toBe(tts ? 'cosyvoice' : 'siliconflow');
    expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      tts ? 'synthetic-voice-first' : 'synthetic-first-key',
    );
  });
  it('模型选择读取失败保留已保存引用，不误标不可用，并可重试', () => {
    state.queryMode = 'error';
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    act(() =>
      root.render(
        createElement(ApiModelSelect, {
          label: '合成模型',
          value: { providerId: 'synthetic-provider', model: 'shared-model' },
          onChange,
        }),
      ),
    );
    cleanups.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    expect(host.querySelector('select')!.value).toBe(
      JSON.stringify(['synthetic-provider', 'shared-model']),
    );
    expect(host.textContent).not.toContain('不可用');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成配置读取失败');
    act(() => host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('模板迟到或重试成功不覆盖正在编辑的 API 草稿', () => {
    state.catalogError = true;
    const f = mount();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('input[type="password"]', 'synthetic-unsaved-edit');
    state.catalogError = false;
    f.render();
    expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      'synthetic-unsaved-edit',
    );
    expect(state.save).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    '%s 提供方测试挂起时仍可关闭与编辑其他配置，迟到结果只更新原横幅',
    async (tts) => {
      const test = tts ? state.testTts : state.testLlm;
      let finish!: (result: { ok: boolean; error?: string }) => void;
      test.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const f = mount(tts);
      try {
        act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
        await act(async () => f.button(tts ? '测试' : '测试连通性').click());
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click(),
        );
        expect(f.host.querySelector('.weq-provider-modal')).toBeNull();
        expect(useToast.getState().toasts).toHaveLength(1);
        expect(useToast.getState().toasts[0]!.loading).toBe(true);
        expect(test.mock.calls[0]![0]).toMatchObject({
          apiKey: tts ? 'synthetic-voice-first' : 'synthetic-first-key',
        });
        act(() => f.button('新建').click());
        expect(f.button(tts ? '测试' : '测试连通性').disabled).toBe(false);
        const draftKey = f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value;
        await act(async () => finish({ ok: false, error: '合成连通性失败' }));
        expect(useToast.getState().toasts).toHaveLength(1);
        expect(useToast.getState().toasts[0]).toMatchObject({
          tone: 'error',
          loading: false,
          detail: '合成连通性失败',
        });
        expect(f.host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
          draftKey,
        );
        expect(state.error).not.toHaveBeenCalled();
      } finally {
        if (finish) await act(async () => finish({ ok: true }));
      }
    },
  );
  it.each([false, true])('%s 测试不依赖设置组件挂载，卸载后仍能完成原任务', async (tts) => {
    const test = tts ? state.testTts : state.testLlm;
    let finish!: (result: { ok: boolean }) => void;
    test.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => f.button(tts ? '测试' : '测试连通性').click());
    f.close();
    await act(async () => finish({ ok: true }));
    expect(useToast.getState().toasts[0]).toMatchObject({ tone: 'success', loading: false });
    expect(state.error).not.toHaveBeenCalled();
  });
  it.each([false, true])('%s 测试输入缺失只提示横幅，不发请求或打开错误弹窗', async (tts) => {
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('input[placeholder^="https://"]', '');
    await act(async () => f.button(tts ? '测试' : '测试连通性').click());
    expect(tts ? state.testTts : state.testLlm).not.toHaveBeenCalled();
    expect(useToast.getState().toasts[0]).toMatchObject({ tone: 'warning', title: '无法测试' });
    expect(state.error).not.toHaveBeenCalled();
  });
  it('TTS 测试保留样例播放与横幅重播入口，不依赖仍打开编辑器', async () => {
    const sources: string[] = [];
    const play = vi.fn(async () => undefined);
    vi.stubGlobal(
      'Audio',
      class {
        constructor(source: string) {
          sources.push(source);
        }
        play = play;
      },
    );
    state.testTts.mockResolvedValueOnce({ ok: true, audioBase64: 'U1lOVEhFVElD', format: 'wav' });
    const f = mount(true);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    await act(async () => f.button('测试').click());
    expect(sources).toEqual(['data:audio/wav;base64,U1lOVEhFVElD']);
    expect(play).toHaveBeenCalledOnce();
    f.close();
    useToast.getState().toasts[0]!.action!.run();
    expect(play).toHaveBeenCalledTimes(2);
    expect(useToast.getState().toasts[0]).toMatchObject({ tone: 'success', loading: false });
  });
  it('同一 API 页面中的 TTS 同名配置也能并存，重复保存不制造新配置', async () => {
    const f = mount(true);
    const original = structuredClone(state.tts[0]!);
    act(() => f.button('新建').click());
    f.set('input[placeholder="CosyVoice"]', original.name);
    f.set('input[placeholder="https://..."]', original.baseUrl);
    f.set('input[type="password"]', 'synthetic-voice-second');
    await act(async () => f.button('保存').click());
    expect(state.tts).toHaveLength(2);
    expect(state.tts.find((row) => row.id === original.id)).toEqual(original);
    const id = (state.saveTts.mock.calls[0]![0] as TtsProviderConfig).id;
    await act(async () => f.button('保存').click());
    expect((state.saveTts.mock.calls[1]![0] as TtsProviderConfig).id).toBe(id);
    expect(state.tts).toHaveLength(2);
  });
  it('连续新建同名同模板 provider 不覆盖；编辑与重复保存保留各自 ID', async () => {
    const f = mount();
    const original = structuredClone(state.providers[0]!);
    const created: string[] = [];
    for (const key of ['synthetic-second-key', 'synthetic-third-key']) {
      act(() => f.button('新建').click());
      f.set('input[type="password"]', key);
      await act(async () => f.button('保存服务商').click());
      const saved = state.save.mock.calls.at(-1)![0] as AgentLabProviderConfig;
      created.push(saved.id);
      expect(saved.name).toBe(original.name);
      expect(state.providers.find((row) => row.id === original.id)).toEqual(original);
      await act(async () => f.button('保存服务商').click());
      expect((state.save.mock.calls.at(-1)![0] as AgentLabProviderConfig).id).toBe(saved.id);
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      f.render();
    }
    expect(new Set(created).size).toBe(2);
    expect(state.providers).toHaveLength(3);
    f.render();
    expect(
      new Set(
        [...f.host.querySelectorAll('.weq-agentlab-provider-name')].map((row) =>
          row.textContent?.trim(),
        ),
      ).size,
    ).toBe(3);
    expect(state.error).not.toHaveBeenCalled();
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    f.set('input[type="password"]', 'synthetic-updated-first-key');
    await act(async () => f.button('保存服务商').click());
    expect((state.save.mock.calls.at(-1)![0] as AgentLabProviderConfig).id).toBe(original.id);
    expect(
      state.providers.filter((row) => created.includes(row.id)).map((row) => row.apiKey),
    ).toEqual(['synthetic-second-key', 'synthetic-third-key']);
  });

  it('模型选择保留 provider ID，不把两个同名同模型配置混为一项', () => {
    const first = state.providers[0]!;
    state.providers.push({ ...first, id: 'second-provider', apiKey: 'synthetic-other-key' });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    act(() =>
      root.render(createElement(ApiModelSelect, { label: 'API 模型', value: null, onChange })),
    );
    cleanups.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    const groups = [...host.querySelectorAll('optgroup')];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.label).not.toBe(groups[1]!.label);
    expect(groups.map((group) => group.label)).toEqual(
      state.providers.map((provider) => providerDisplayLabels(state.providers).get(provider.id)),
    );
    const select = host.querySelector('select')!;
    for (const provider of state.providers) {
      act(() => {
        select.value = JSON.stringify([provider.id, 'shared-model']);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(onChange).toHaveBeenLastCalledWith({ providerId: provider.id, model: 'shared-model' });
    }
  });
});
