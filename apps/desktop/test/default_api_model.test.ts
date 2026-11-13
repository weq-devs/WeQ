import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultApiModelRow } from '../src/renderer/src/components/settings/DefaultApiModelRow';
import { ApiModelSelect } from '../src/renderer/src/components/settings/ApiModelSelect';
import { useModelSelectionLabel } from '../src/renderer/src/components/settings/useModelSelectionLabel';
import { DEFAULT_MODEL_SELECTION_KEY } from '@weq/agentlab/model-selection';

const f = vi.hoisted(() => ({
  status: {
    ref: null as { providerId: string; model: string } | null,
    available: false,
    error: null as string | null,
  },
  queryError: null as Error | null,
  visionStatus: { ref: { providerId: 'synthetic', model: 'vision' }, available: true, error: null },
  embeddingStatus: {
    ref: { providerId: 'synthetic', model: 'embedding' },
    available: true,
    error: null,
  },
  saveVision: vi.fn(),
  saveEmbedding: vi.fn(),
  save: vi.fn(),
  refetch: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: { intentSense: { getStatus: { invalidate: f.invalidate } } },
      bootstrap: {
        getDefaultVisionModel: {
          setData: (_: undefined, value: typeof f.visionStatus) => {
            f.visionStatus = value;
          },
        },
        getDefaultEmbeddingModel: {
          setData: (_: undefined, value: typeof f.embeddingStatus) => {
            f.embeddingStatus = value;
          },
        },
        getAgentLabDefaultModel: {
          setData: (_: undefined, value: typeof f.status) => {
            f.status = value;
          },
        },
        getSettings: { invalidate: f.invalidate },
      },
    }),
    bootstrap: {
      getDefaultVisionModel: {
        useQuery: () => ({ data: f.visionStatus, error: f.queryError, refetch: f.refetch }),
      },
      getDefaultEmbeddingModel: {
        useQuery: () => ({ data: f.embeddingStatus, error: f.queryError, refetch: f.refetch }),
      },
      setDefaultVisionModel: {
        useMutation: () => ({ mutateAsync: f.saveVision, isLoading: false }),
      },
      setDefaultEmbeddingModel: {
        useMutation: () => ({ mutateAsync: f.saveEmbedding, isLoading: false }),
      },
      getAgentLabDefaultModel: {
        useQuery: () => ({ data: f.status, error: f.queryError, refetch: f.refetch }),
      },
      setAgentLabDefaultModel: { useMutation: () => ({ mutateAsync: f.save, isLoading: false }) },
      listAgentLabProviders: {
        useQuery: () => ({
          data: [
            {
              id: 'synthetic',
              name: '合成服务',
              baseUrl: 'https://synthetic.invalid',
              models: [
                { id: 'chat', capabilities: ['chat'] },
                { id: 'vision', capabilities: ['vision'] },
                { id: 'embedding', capabilities: ['embedding'] },
              ],
            },
          ],
          isLoading: false,
        }),
      },
    },
  },
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  f.status = { ref: null, available: false, error: null };
  f.queryError = null;
  f.visionStatus = {
    ref: { providerId: 'synthetic', model: 'vision' },
    available: true,
    error: null,
  };
  f.embeddingStatus = {
    ref: { providerId: 'synthetic', model: 'embedding' },
    available: true,
    error: null,
  };
  for (const save of [f.saveVision, f.saveEmbedding]) {
    save.mockReset();
    save.mockImplementation(async ({ ref }) => ({ ref, available: !!ref, error: null }));
  }
  f.save.mockReset();
  f.save.mockImplementation(async ({ ref }) => ({ ref, available: !!ref, error: null }));
});
afterEach(() => vi.unstubAllGlobals());

function mount(content: () => ReactElement = () => createElement(DefaultApiModelRow)) {
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = () => act(() => root.render(content()));
  render();
  return {
    host,
    render,
    select: () => host.querySelector<HTMLSelectElement>('select')!,
    close: () => act(() => root.unmount()),
  };
}

describe('LLM 默认聊天模型设置', () => {
  it.each(['vision', 'embedding'] as const)(
    '默认 %s 只列对应能力，支持保存、清空、读取重试且不改聊天默认',
    async (capability) => {
      const name = capability === 'vision' ? '视觉' : '向量';
      const save = capability === 'vision' ? f.saveVision : f.saveEmbedding;
      const page = mount(() => createElement(DefaultApiModelRow, { capability }));
      try {
        expect(page.select().getAttribute('aria-label')).toBe(`默认${name}模型`);
        expect([...page.select().options].map((option) => option.textContent)).toEqual([
          `未设置默认${name}模型`,
          capability,
        ]);
        await act(async () => {
          page.select().value = JSON.stringify(['synthetic', capability]);
          page.select().dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(save).toHaveBeenLastCalledWith({
          ref: { providerId: 'synthetic', model: capability },
        });
        await act(async () => {
          page.select().value = '';
          page.select().dispatchEvent(new Event('change', { bubbles: true }));
        });
        page.render();
        expect(save).toHaveBeenLastCalledWith({ ref: null });
        expect(page.select().value).toBe('');
        expect(f.save).not.toHaveBeenCalled();
        f.queryError = new Error('合成读取失败');
        page.render();
        expect(page.select().disabled).toBe(true);
        expect(page.host.textContent).toContain(`默认${name}模型读取失败`);
        act(() => page.host.querySelector<HTMLButtonElement>('button')!.click());
        expect(f.refetch).toHaveBeenCalled();
      } finally {
        page.close();
      }
    },
  );

  it.each(['chat', 'vision', 'embedding'] as const)(
    '%s 消费入口和显示标签继承对应默认模型',
    (capability) => {
      f.status = { ref: { providerId: 'synthetic', model: 'chat' }, available: true, error: null };
      function Content() {
        const label = useModelSelectionLabel(capability);
        return createElement(
          'div',
          null,
          createElement('span', null, label({ useDefault: true })),
          createElement(ApiModelSelect, {
            capability,
            label: '模型',
            value: { useDefault: true },
            onChange: vi.fn(),
          }),
        );
      }
      const page = mount(() => createElement(Content));
      try {
        expect(page.select().selectedOptions[0]?.textContent).toBe(`默认（当前：${capability}）`);
        expect(page.host.querySelector('span')?.textContent).toBe(`默认（当前：${capability}）`);
      } finally {
        page.close();
      }
    },
  );
  it('助手等入口统一默认聊天模型文案，旧资料中未使用的可选模型仍保留原提示', () => {
    function Labels() {
      const label = useModelSelectionLabel();
      return createElement(
        'div',
        null,
        [label(null), label({ useDefault: true }), label(null, '未使用')].join('|'),
      );
    }
    f.status = { ref: { providerId: 'synthetic', model: 'chat' }, available: true, error: null };
    const page = mount(() => createElement(Labels));
    try {
      expect(page.host.textContent).toBe('默认（当前：chat）|默认（当前：chat）|未使用');
      f.status.available = false;
      page.render();
      expect(page.host.textContent).toBe(
        '默认（当前：chat（不可用））|默认（当前：chat（不可用））|未使用',
      );
    } finally {
      page.close();
    }
  });

  it('消费入口移除未选择，空值显示默认，选择时提交独立标记', () => {
    f.status = { ref: { providerId: 'synthetic', model: 'chat' }, available: true, error: null };
    const change = vi.fn();
    const page = mount(() =>
      createElement(ApiModelSelect, {
        allowDefault: true,
        label: '使用模型',
        value: null,
        onChange: change,
      }),
    );
    try {
      expect(page.select().value).toBe(DEFAULT_MODEL_SELECTION_KEY);
      expect(page.select().querySelector('option[value=""]')).toBeNull();
      expect(page.select().selectedOptions[0]?.textContent).toBe('默认（当前：chat）');
      expect(page.select().title).toBe('默认（当前：chat）');
      expect(change).not.toHaveBeenCalled();
      act(() => {
        page.select().value = DEFAULT_MODEL_SELECTION_KEY;
        page.select().dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(change).toHaveBeenLastCalledWith({ useDefault: true });
    } finally {
      page.close();
    }
  });

  it('继承引用在默认清空或读取失败时仍保留，失败可重试', () => {
    const change = vi.fn();
    const page = mount(() =>
      createElement(ApiModelSelect, {
        allowDefault: true,
        label: '使用模型',
        value: { useDefault: true },
        onChange: change,
      }),
    );
    try {
      expect(page.select().value).toBe(DEFAULT_MODEL_SELECTION_KEY);
      expect(page.host.textContent).toContain('默认（当前：未配置）');
      f.queryError = new Error('合成读取失败');
      page.render();
      expect(page.select().value).toBe(DEFAULT_MODEL_SELECTION_KEY);
      expect(page.host.textContent).toContain('默认（当前：读取失败）');
      act(() => page.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(f.refetch).toHaveBeenCalled();
      expect(change).not.toHaveBeenCalled();
    } finally {
      page.close();
    }
  });
  it('不自动选择首项，只列聊天模型；显式选择及清空提交真实引用', async () => {
    const page = mount();
    try {
      expect(page.host.textContent).toContain('默认聊天模型');
      expect(page.select().getAttribute('aria-label')).toBe('默认聊天模型');
      expect(page.select().selectedOptions[0]?.textContent).toBe('未设置默认聊天模型');
      expect(page.select().value).toBe('');
      expect([...page.select().options].map((option) => option.textContent)).not.toContain(
        'embedding',
      );
      await act(async () => {
        page.select().value = JSON.stringify(['synthetic', 'chat']);
        page.select().dispatchEvent(new Event('change', { bubbles: true }));
      });
      page.render();
      expect(f.save).toHaveBeenLastCalledWith({ ref: { providerId: 'synthetic', model: 'chat' } });
      expect(page.select().value).toBe(JSON.stringify(['synthetic', 'chat']));
      await act(async () => {
        page.select().value = '';
        page.select().dispatchEvent(new Event('change', { bubbles: true }));
      });
      page.render();
      expect(f.save).toHaveBeenLastCalledWith({ ref: null });
      expect(page.select().value).toBe('');
    } finally {
      page.close();
    }
  });

  it('失效引用保留并显示原因，保存失败不改变已存选择', async () => {
    const saved = { providerId: 'removed', model: 'missing-chat' };
    f.status = { ref: saved, available: false, error: '默认聊天模型的 provider 不可用：removed' };
    f.save.mockRejectedValueOnce(new Error('合成写入失败'));
    const page = mount();
    try {
      expect(page.select().selectedOptions[0]?.textContent).toContain('已保存但不可用');
      expect(page.host.textContent).toContain('provider 不可用');
      await act(async () => {
        page.select().value = JSON.stringify(['synthetic', 'chat']);
        page.select().dispatchEvent(new Event('change', { bubbles: true }));
      });
      page.render();
      expect(page.select().value).toBe(JSON.stringify([saved.providerId, saved.model]));
      expect(page.host.textContent).toContain('合成写入失败');
    } finally {
      page.close();
    }
  });

  it('读取失败禁用保存并提供重试，不将读取错误当作清空配置', () => {
    f.queryError = new Error('合成读取失败');
    const page = mount();
    try {
      expect(page.select().disabled).toBe(true);
      expect(page.host.textContent).toContain('默认聊天模型读取失败');
      act(() => page.host.querySelector<HTMLButtonElement>('button')!.click());
      expect(f.refetch).toHaveBeenCalled();
      expect(f.save).not.toHaveBeenCalled();
    } finally {
      page.close();
    }
  });
});
