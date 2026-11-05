import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTENT_TUNING } from '@weq/service/intent-context';
import { IntentSenseSection } from '../src/renderer/src/components/settings/IntentSenseSection';
import { InteractionProfileSection } from '../src/renderer/src/components/settings/InteractionProfileSection';
import { ReplySuggestionsSection } from '../src/renderer/src/components/settings/ReplySuggestionsSection';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  loading: false,
  pending: false,
  error: null as Error | null,
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(),
  refetch: vi.fn(),
  showError: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({ useDialog: () => state.showError }));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get(_target, key) {
        if (key === 'useUtils') return () => proxy('utils');
        if (key === 'invalidate') return state.invalidate;
        if (key === 'setData') return state.setData;
        if (key === 'useQuery')
          return () => ({
            data: state.loading ? undefined : state.data[path],
            isLoading: state.loading,
            error: path === 'account.intentSense.getStatus' ? state.error : null,
            refetch: state.refetch,
          });
        if (key === 'useMutation')
          return () => ({ isLoading: state.pending, mutateAsync: state.save });
        if (key === 'useSubscription') return () => {};
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy() };
});

const pages: { title: string; component: ComponentType; enabled: string; model: string }[] = [
  { title: '意图感知', component: IntentSenseSection, enabled: 'enabled', model: 'providerRef' },
  {
    title: '互动画像',
    component: InteractionProfileSection,
    enabled: 'profileEnabled',
    model: 'profileProviderRef',
  },
  {
    title: '推荐回复',
    component: ReplySuggestionsSection,
    enabled: 'suggestionsEnabled',
    model: 'suggestionProviderRef',
  },
];
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.loading = false;
  state.pending = false;
  state.error = null;
  state.data = {
    'account.intentSense.getStatus': {
      ...DEFAULT_INTENT_TUNING,
      enabled: false,
      suggestionsEnabled: false,
      profileEnabled: false,
      engine: 'api',
      profileEngine: 'api',
      providerRef: null,
      profileProviderRef: null,
      suggestionProviderRef: null,
    },
    'bootstrap.getLocalEngine': { available: true, models: [] },
    'bootstrap.localModelResources': { selected: { intent: 'auto' } },
    'bootstrap.getAgentLabDefaultModel': { ref: null, available: false },
    'bootstrap.listAgentLabProviders': [
      { id: 'synthetic', name: '合成服务', models: [{ id: 'model', label: '合成模型' }] },
    ],
  };
  state.save.mockReset().mockImplementation(async (patch) => ({
    ...(state.data['account.intentSense.getStatus'] as object),
    ...patch,
  }));
  state.setData.mockReset();
  state.invalidate.mockReset();
  state.refetch.mockReset();
  state.showError.mockReset();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});

function mount(component: ComponentType, active = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(TabActivity, { active }, createElement(component))));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return {
    host,
    toggle: (title: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="启用${title}"]`)!,
    model: (title: string) =>
      host.querySelector<HTMLSelectElement>(`[aria-label="${title} API 模型"]`)!,
    open: () =>
      act(() => {
        const details = host.querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      }),
  };
}

describe.each(pages)('$title 独立设置页', ({ title, component, enabled, model }) => {
  it('共用项目顺序与文案一致，关闭功能仍可配置模型，不出现其他功能开关', async () => {
    const f = mount(component);
    expect(
      [...f.host.querySelectorAll('.weq-set > section .weq-set-card-title')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['基础', '模型']);
    expect(f.host.querySelector('summary')?.textContent).toBe('高级设置');
    const row = f.model(title).closest('.weq-set-row')!;
    expect(row.querySelector('.weq-set-row-label')?.textContent).toBe('服务商与模型');
    expect(row.querySelector('.weq-set-row-desc')?.textContent).toBe(
      '使用所选服务商与模型处理消息文本。',
    );
    expect(f.toggle(title).getAttribute('aria-checked')).toBe('false');
    expect(f.model(title).disabled).toBe(false);
    expect(f.model(title).querySelector('option')?.textContent).toBe('未选择');
    for (const other of pages.filter((page) => page.title !== title))
      expect(f.toggle(other.title)).toBeNull();
    await act(async () => {
      f.model(title).value = JSON.stringify(['synthetic', 'model']);
      f.model(title).dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(state.save).toHaveBeenLastCalledWith({
      [model]: { providerId: 'synthetic', model: 'model' },
    });
    expect(state.invalidate).toHaveBeenCalledTimes(3);
    await act(async () => f.toggle(title).click());
    expect(state.save).toHaveBeenLastCalledWith({ [enabled]: true });
  });

  it.each(['loading', 'error', 'pending', 'inactive'])(
    '%s 时统一禁用配置与高级保存，读取失败可重试',
    async (kind) => {
      state.loading = kind === 'loading';
      state.pending = kind === 'pending';
      state.error = kind === 'error' ? new Error('合成读取失败') : null;
      const f = mount(component, kind !== 'inactive');
      expect(f.toggle(title).disabled).toBe(true);
      if (f.model(title)) expect(f.model(title).disabled).toBe(true);
      else expect(f.host.textContent).toContain('待确认');
      f.open();
      for (const input of f.host.querySelectorAll<HTMLInputElement>('input[type="number"]'))
        expect(input.disabled).toBe(true);
      for (const form of f.host.querySelectorAll('form'))
        await act(async () => {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        });
      if (kind === 'error') {
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>(`[aria-label="重新读取${title}设置"]`)!.click(),
        );
        expect(state.refetch).toHaveBeenCalledOnce();
      }
      expect(state.save).not.toHaveBeenCalled();
    },
  );

  it('保存失败不更新缓存，提示对应页面并重读状态', async () => {
    state.save.mockRejectedValueOnce(new Error('合成保存失败'));
    const f = mount(component);
    await act(async () => f.toggle(title).click());
    expect(state.showError).toHaveBeenCalledWith(`${title}设置失败`, '合成保存失败');
    expect(state.setData).not.toHaveBeenCalled();
    expect(state.invalidate).not.toHaveBeenCalled();
    expect(state.refetch).toHaveBeenCalledOnce();
  });

  it('同一在途操作不重复提交，收起的高级控件不可修改', async () => {
    let finish!: (value: unknown) => void;
    state.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const f = mount(component);
    await act(async () => {
      f.toggle(title).click();
      f.toggle(title).click();
    });
    expect(state.save).toHaveBeenCalledTimes(1);
    f.open();
    await act(async () => {
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(state.save).toHaveBeenCalledTimes(1);
    act(() => {
      const details = f.host.querySelector('details')!;
      details.open = false;
      details.dispatchEvent(new Event('toggle'));
    });
    for (const input of f.host.querySelectorAll<HTMLInputElement>('input[type="number"]'))
      expect(input.disabled).toBe(true);
    for (const button of f.host.querySelectorAll<HTMLButtonElement>(
      'details button[role="switch"]',
    ))
      expect(button.disabled).toBe(true);
    await act(async () => finish(state.data['account.intentSense.getStatus']));
    expect(state.setData).toHaveBeenCalledOnce();
  });
});
