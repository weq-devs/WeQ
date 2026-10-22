import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLabProviderConfig, TtsProviderConfig } from '@weq/agentlab';
import { AgentLabSection } from '../src/renderer/src/components/settings/AgentLabSection';
import { ApiModelSelect } from '../src/renderer/src/components/settings/ApiModelSelect';
import { TtsProvidersCard } from '../src/renderer/src/components/settings/VoiceTranscribeSection';
import { providerDisplayLabels } from '../src/renderer/src/lib/providerDisplayLabels';
import { useToast } from '../src/renderer/src/components/Toast';

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
        testTtsProvider: { mutate: state.testTts },
      },
    },
    trpc: {
      useUtils: () => ({
        bootstrap: {
          listAgentLabProviders: { invalidate: vi.fn(async () => undefined) },
          listTtsProviders: { invalidate: vi.fn(async () => undefined) },
        },
      }),
      bootstrap: {
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
        fetchAgentLabModels: { useMutation: () => ({ isLoading: false }) },
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
    act(() => root.render(createElement(tts ? TtsProvidersCard : AgentLabSection)));
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
  it.each([false, true])('%s 加载配置不冒充空列表，失败可重试并保留缓存', (tts) => {
    state.queryMode = 'loading';
    const f = mount(tts);
    expect(f.host.textContent).toContain('正在读取');
    expect(f.host.textContent).not.toContain(tts ? '暂无语音合成' : '还没有 provider');
    state.queryMode = 'error';
    f.render();
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成配置读取失败');
    expect(f.host.textContent).not.toContain(tts ? '暂无语音合成' : '还没有 provider');
    act(() => f.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    state.queryMode = 'stale';
    f.render();
    expect(f.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(f.host.querySelectorAll('.weq-agentlab-provider-item')).toHaveLength(1);
    state.queryMode = 'empty';
    f.render();
    expect(f.host.querySelector('[role="alert"]')).toBeNull();
    expect(f.host.textContent).toContain(tts ? '暂无语音合成' : '还没有 provider');
  });
  it.each([false, true])('%s 模板读取失败可重试，编辑保留原厂商与凭据', (tts) => {
    state.catalogError = true;
    const f = mount(tts);
    act(() => f.host.querySelector<HTMLButtonElement>('.weq-agentlab-provider-item')!.click());
    expect(f.host.querySelector('[role="alert"]')?.textContent).toContain('合成模板读取失败');
    act(() => f.host.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
    expect(state.refetch).toHaveBeenCalledOnce();
    expect(f.host.querySelector<HTMLSelectElement>('select')!.value).toBe(
      tts ? 'cosyvoice' : 'siliconflow',
    );
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
      await act(async () => f.button('保存 provider').click());
      const saved = state.save.mock.calls.at(-1)![0] as AgentLabProviderConfig;
      created.push(saved.id);
      expect(saved.name).toBe(original.name);
      expect(state.providers.find((row) => row.id === original.id)).toEqual(original);
      await act(async () => f.button('保存 provider').click());
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
    await act(async () => f.button('保存 provider').click());
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
