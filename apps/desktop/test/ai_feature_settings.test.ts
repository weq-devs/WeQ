import { act, createElement, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INTENT_TUNING,
  DEFAULT_SUGGESTION_FALLBACK_TEXTS,
} from '@weq/service/intent-context';
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
            error: path === 'settings.intent.getStatus' ? state.error : null,
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

it.each([
  ['意图感知', IntentSenseSection, 'analysisMode'],
  ['互动画像', InteractionProfileSection, 'profileMode'],
  ['推荐回复', ReplySuggestionsSection, 'suggestionMode'],
] as const)('%s 模式复用分段选择并独立即时保存', async (title, component, field) => {
  const f = mount(component);
  const control = f.host.querySelector(`[aria-label="${title}模式"]`)!;
  const options = [...control.querySelectorAll<HTMLButtonElement>('button')];
  expect(options.map((button) => button.textContent)).toEqual(['自动', '手动']);
  expect(options[0]!.getAttribute('aria-checked')).toBe('true');
  await act(async () => options[1]!.click());
  expect(state.save).toHaveBeenLastCalledWith({ [field]: 'manual' });
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.loading = false;
  state.pending = false;
  state.error = null;
  state.data = {
    'settings.intent.getStatus': {
      ...DEFAULT_INTENT_TUNING,
      suggestionFallbackTexts: [...DEFAULT_SUGGESTION_FALLBACK_TEXTS],
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
    ...(state.data['settings.intent.getStatus'] as object),
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
  };
}

describe.each(pages)('$title 独立设置页', ({ title, component, enabled, model }) => {
  it('共用项目顺序与文案一致，关闭功能仍可配置模型，不出现其他功能开关', async () => {
    const f = mount(component);
    expect(
      [...f.host.querySelectorAll('.weq-set > section .weq-set-card-title')]
        .map((node) => node.textContent)
        .slice(0, 1),
    ).toEqual(['功能与模型']);
    expect(f.host.querySelector('details')).toBeNull();
    expect(f.host.textContent).not.toContain('当前使用');
    const row = f.model(title).closest('.weq-set-row')!;
    expect(row.querySelector('.weq-set-row-label')?.textContent).toBe('服务商与模型');
    expect(row.querySelector('.weq-set-row-desc')?.textContent).toBe(
      '使用所选服务商与模型处理消息文本。',
    );
    expect(f.toggle(title).getAttribute('aria-checked')).toBe('false');
    expect(f.model(title).disabled).toBe(false);
    expect(f.model(title).value).toBe('default');
    expect(f.model(title).querySelector('option[value=""]')).toBeNull();
    for (const other of pages.filter((page) => page.title !== title))
      expect(f.toggle(other.title)).toBeNull();
    await act(async () => {
      f.model(title).value = JSON.stringify(['synthetic', 'model']);
      f.model(title).dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(state.save).toHaveBeenLastCalledWith({
      [model]: { providerId: 'synthetic', model: 'model' },
    });
    expect(state.invalidate).toHaveBeenCalledTimes(4);
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
      expect(f.toggle(title).disabled).toBe(kind !== 'pending');
      if (f.model(title)) expect(f.model(title).disabled).toBe(kind !== 'pending');
      else expect(f.host.textContent).not.toContain('待确认');
      for (const input of f.host.querySelectorAll<HTMLInputElement>('input[type="number"]'))
        expect(input.disabled).toBe(kind !== 'pending');
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

  it('相同在途操作去重，数值输入在保存期间仍可编辑并按序提交', async () => {
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
    const input = f.host.querySelector<HTMLInputElement>('input[type="number"]')!;
    expect(input.disabled).toBe(false);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        String(Number(input.value) + 1),
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(state.save).toHaveBeenCalledTimes(1);
    await act(async () => finish(state.data['settings.intent.getStatus']));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(state.setData).toHaveBeenCalledTimes(2);
  });
});

it('等待动画独立保存；本地统计隐藏推断参数及所有模型占位文案', async () => {
  const intent = mount(IntentSenseSection);
  await act(async () =>
    intent.host.querySelector<HTMLButtonElement>('[aria-label="批量分析时显示胶囊动画"]')!.click(),
  );
  expect(state.save).toHaveBeenLastCalledWith({ loadingAnimation: false });
  Object.assign(state.data['settings.intent.getStatus'] as object, {
    profileEngine: 'heuristic',
  });
  const profile = mount(InteractionProfileSection);
  expect(profile.host.querySelector('[aria-label="画像推断温度"]')).toBeNull();
  expect(profile.host.querySelector('[aria-label="模型推断采样上限（条）"]')).toBeNull();
  expect(profile.host.querySelector('[aria-label="画像 API 请求超时（秒）"]')).toBeNull();
  expect(profile.host.querySelector('[aria-label="趋势展示天数"]')).not.toBeNull();
  expect(profile.host.textContent).not.toContain('当前使用');
});

it('回退列表直接编辑、增删、去空白与重复校验，开关不清空内容', async () => {
  Object.assign(state.data['settings.intent.getStatus'] as object, {
    suggestionFallbackTexts: ['A', 'B'],
  });
  const f = mount(ReplySuggestionsSection);
  const form = f.host.querySelector<HTMLFormElement>(
    '[data-setting-id="suggestions-fallback-texts"]',
  )!;
  expect(form.querySelector('[type="submit"]')).toBeNull();
  const flush = async () =>
    act(async () => {
      form
        .querySelector('input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  const edit = (value: string) =>
    act(() => {
      const node = form.querySelector('input')!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  edit(' B ');
  await flush();
  expect(state.save).not.toHaveBeenCalled();
  expect(form.textContent).toContain('不能重复');
  edit(' ');
  await flush();
  expect(state.save).not.toHaveBeenCalled();
  edit(' C ');
  await flush();
  expect(state.save).toHaveBeenLastCalledWith({ suggestionFallbackTexts: ['C', 'B'] });
  await act(async () =>
    f.host.querySelector<HTMLButtonElement>('[aria-label="启用回退内容"]')!.click(),
  );
  expect(state.save).toHaveBeenLastCalledWith({ suggestionFallbackEnabled: false });
  act(() => form.querySelector<HTMLButtonElement>('[aria-label="删除回退内容 2"]')!.click());
  expect(form.querySelectorAll('input')).toHaveLength(1);
  act(() => form.querySelector<HTMLButtonElement>('[aria-label="添加回退内容"]')!.click());
  expect(form.querySelectorAll('input')).toHaveLength(2);
  await flush();
  expect(form.querySelector('[aria-label="恢复默认回退内容列表"]')).toBeNull();
});
