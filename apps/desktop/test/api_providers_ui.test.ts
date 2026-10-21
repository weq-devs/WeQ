import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentLabProviderConfig, TtsProviderConfig } from '@weq/agentlab';
import { AgentLabSection } from '../src/renderer/src/components/settings/AgentLabSection';
import { ApiModelSelect } from '../src/renderer/src/components/settings/ApiModelSelect';
import { TtsProvidersCard } from '../src/renderer/src/components/settings/VoiceTranscribeSection';
import { providerDisplayLabels } from '../src/renderer/src/lib/providerDisplayLabels';

const state = vi.hoisted(() => ({
  providers: [] as AgentLabProviderConfig[],
  tts: [] as TtsProviderConfig[],
  saveTts: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn(async () => true),
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
    trpc: {
      useUtils: () => ({
        bootstrap: {
          listAgentLabProviders: { invalidate: vi.fn(async () => undefined) },
          listTtsProviders: { invalidate: vi.fn(async () => undefined) },
        },
      }),
      bootstrap: {
        getAgentLabCatalog: { useQuery: () => ({ data: catalog }) },
        listAgentLabProviders: { useQuery: () => ({ data: state.providers }) },
        saveAgentLabProvider: {
          useMutation: () => ({ mutateAsync: state.save, isLoading: false }),
        },
        deleteAgentLabProvider: {
          useMutation: () => ({ mutateAsync: state.remove, isLoading: false }),
        },
        testAgentLabProvider: { useMutation: () => ({ isLoading: false }) },
        fetchAgentLabModels: { useMutation: () => ({ isLoading: false }) },
        getTtsCatalog: {
          useQuery: () => ({
            data: [
              {
                vendor: 'cosyvoice',
                label: 'Synthetic Voice',
                fields: ['apiKey'],
                capabilities: { clone: false },
              },
            ],
          }),
        },
        listTtsProviders: { useQuery: () => ({ data: state.tts }) },
        saveTtsProvider: { useMutation: () => ({ mutateAsync: state.saveTts, isLoading: false }) },
        deleteTtsProvider: { useMutation: () => ({ isLoading: false }) },
        testTtsProvider: { useMutation: () => ({ isLoading: false }) },
      },
    },
  };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
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
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
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
  return { host, render, button, set };
}
describe('多 API provider 配置', () => {
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
