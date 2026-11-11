import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots } from '../src/renderer/src/lib/pageSnapshots';
import { IntentSenseSection } from '../src/renderer/src/components/settings/IntentSenseSection';
import { ReplySuggestionsSection } from '../src/renderer/src/components/settings/ReplySuggestionsSection';
import { AI_SETTING_ITEMS } from '../src/renderer/src/components/settings/aiSettingsCatalog';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import {
  revealSetting,
  findSettingElement,
} from '../src/renderer/src/components/settings/searchTarget';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
  DEFAULT_INTENT_TUNING,
} from '@weq/service/intent-context';

const fixture = vi.hoisted(() => ({
  status: {
    enabled: true,
    persistentDisplay: true,
    hoverDisplay: true,
    engine: 'local' as 'api' | 'local',
    providerRef: null,
    suggestionsEnabled: true,
    hfMirror: true,
    apiConfigured: false,
    localAvailable: false,
    localReady: false,
    analysisContextMessages: 0,
    suggestionContextMessages: 0,
  },
  pending: false,
  save: vi.fn(),
  setData: vi.fn(),
  invalidate: vi.fn(async () => {}),
  error: vi.fn(),
  resourceActive: false,
  resourceSubscriptionActive: false,
  hasStatus: true,
  statusError: null as Error | null,
  retry: vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select: (state: { showError: typeof fixture.error }) => unknown) =>
    select({ showError: fixture.error }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        intentSense: {
          getStatus: { setData: fixture.setData },
          listMessageAnalyses: { invalidate: fixture.invalidate },
          getSuggestions: { invalidate: fixture.invalidate },
          getProfile: { invalidate: fixture.invalidate },
        },
      },
    }),
    bootstrap: {
      listAgentLabProviders: { useQuery: () => ({ data: [] }) },
      getAgentLabDefaultModel: { useQuery: () => ({ data: { ref: null, available: false } }) },
      getLocalEngine: {
        useQuery: () => ({
          data: { available: false, modelDownloaded: false, engineReady: false, models: [] },
        }),
      },
      localModelResources: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          fixture.resourceActive = options.enabled;
          return { data: { selected: { intent: 'auto' } } };
        },
      },
      setLocalModelResource: { useMutation: () => ({ isLoading: false }) },
      downloadLocalModel: { useMutation: () => ({ isLoading: false }) },
      startLocalEngine: { useMutation: () => ({ isLoading: false }) },
      onModelDownloadProgress: {
        useSubscription: (_input: unknown, options: { enabled: boolean }) => {
          fixture.resourceSubscriptionActive = options.enabled;
        },
      },
    },
    account: {
      intentSense: {
        getStatus: {
          useQuery: () => ({
            data: fixture.hasStatus
              ? {
                  ...DEFAULT_INTENT_TUNING,
                  ...fixture.status,
                  analysisContextMessages: fixture.status.analysisContextMessages,
                  suggestionContextMessages: fixture.status.suggestionContextMessages,
                }
              : undefined,
            error: fixture.statusError,
            isLoading: !fixture.hasStatus && !fixture.statusError,
            refetch: fixture.retry,
          }),
        },
        getLocalEngine: {
          useQuery: () => ({
            data: {
              available: false,
              modelDownloaded: false,
              engineReady: false,
              downloading: false,
            },
          }),
        },
        onModelDownloadProgress: { useSubscription: () => {} },
        setConfig: {
          useMutation: () => ({ mutateAsync: fixture.save, isLoading: fixture.pending }),
        },
        clearCache: { useMutation: () => ({ isLoading: false }) },
        downloadLocalModel: { useMutation: () => ({ isLoading: false }) },
        startLocalEngine: { useMutation: () => ({ isLoading: false }) },
      },
    },
  },
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.status = {
    ...fixture.status,
    persistentDisplay: true,
    hoverDisplay: true,
    analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
    suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  };
  fixture.pending = false;
  fixture.hasStatus = true;
  fixture.statusError = null;
  fixture.retry.mockClear();
  fixture.resourceActive = false;
  fixture.resourceSubscriptionActive = false;
  fixture.save.mockReset().mockImplementation(async (patch: Partial<typeof fixture.status>) => ({
    ...fixture.status,
    ...patch,
  }));
  fixture.setData.mockReset().mockImplementation((_input: unknown, next: typeof fixture.status) => {
    fixture.status = next;
  });
  fixture.error.mockClear();
  fixture.invalidate.mockClear();
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});

function renderFixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (page: 'intent' | 'suggestions' = 'intent', active = true) => {
    act(() =>
      root.render(
        createElement(
          TabActivity,
          { active },
          createElement(page === 'intent' ? IntentSenseSection : ReplySuggestionsSection),
        ),
      ),
    );
  };
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const input = (label: string) =>
    host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const edit = (label: string, value: string) =>
    act(() => {
      const node = input(label);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const commit = (label: string) =>
    act(async () =>
      input(label).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
  return { host, render, input, edit, commit };
}

it('服务端初始参数不误报未保存，用户改动仍保留草稿标记', () => {
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          PageSnapshots,
          { scope: 'intent-fixture' },
          createElement(IntentSenseSection),
        ),
      ),
    );
    expect(pageSnapshots.hasDrafts('intent-fixture')).toBe(false);
    const input = host.querySelector<HTMLInputElement>('[aria-label="意图感知上文条数"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(pageSnapshots.hasDrafts('intent-fixture')).toBe(true);
  } finally {
    act(() => root.unmount());
  }
});

it('分别编辑两个条数，只提交对应配置并刷新相关缓存，支持零条上文', async () => {
  const f = renderFixture();
  expect(f.input('意图感知上文条数').value).toBe(String(DEFAULT_ANALYSIS_CONTEXT_MESSAGES));
  expect(f.input('推荐回复上文条数')).toBeNull();
  expect(f.input('意图感知上文条数').max).toBe(String(MAX_INTENT_CONTEXT_MESSAGES));
  expect(f.host.querySelector('form button[type="submit"]')).toBeNull();
  f.edit('意图感知上文条数', '0');
  await f.commit('意图感知上文条数');
  expect(fixture.save).toHaveBeenCalledWith({
    analysisContextMessages: 0,
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(3);
  f.render();
  f.render('suggestions');
  expect(f.input('意图感知上文条数')).toBeNull();
  expect(f.input('推荐回复上文条数').value).toBe(String(DEFAULT_SUGGESTION_CONTEXT_MESSAGES));
  f.edit('推荐回复上文条数', '2');
  await f.commit('推荐回复上文条数');
  expect(fixture.save).toHaveBeenLastCalledWith({ suggestionContextMessages: 2 });
  expect(fixture.invalidate).toHaveBeenCalledTimes(6);
  f.render('suggestions');
});

it('无效、空值及主进程尚未支持时不能保存，在途允许编辑', async () => {
  const f = renderFixture();
  for (const value of ['-1', '1.5', '', String(MAX_INTENT_CONTEXT_MESSAGES + 1)]) {
    f.edit('意图感知上文条数', value);
    await f.commit('意图感知上文条数');
  }
  expect(fixture.save).not.toHaveBeenCalled();
  f.edit('意图感知上文条数', '2');
  fixture.pending = true;
  f.render();
  expect(f.input('意图感知上文条数').disabled).toBe(false);
  fixture.pending = false;
  Reflect.deleteProperty(fixture.status, 'analysisContextMessages');
  f.render();
  expect(f.input('意图感知上文条数').disabled).toBe(true);
  expect(f.host.textContent).toContain('当前主进程尚未提供参数');
  expect(fixture.save).not.toHaveBeenCalled();
});

it('最近推荐期限在缓存与历史内独立编辑保存，-1 表示永不过期', async () => {
  const f = renderFixture();
  f.render('suggestions');
  const label = '最近推荐过期时间（分钟）';
  const input = f.input(label);
  expect(input.value).toBe(String(DEFAULT_INTENT_TUNING.suggestionExpiryMinutes));
  expect(input.closest('.weq-set-card')?.textContent).toContain('缓存与历史');
  expect(input.closest('.weq-set-card')?.textContent).toContain('-1 表示永不过期');
  for (const value of ['-2', '1.5', '']) {
    f.edit(label, value);
    await f.commit(label);
    expect(fixture.save).not.toHaveBeenCalled();
  }
  for (const value of [5, 0, -1]) {
    f.edit(label, String(value));
    await f.commit(label);
    expect(fixture.save).toHaveBeenLastCalledWith({ suggestionExpiryMinutes: value });
    f.render('suggestions');
    expect(f.input(label).value).toBe(String(value));
  }
});

it('常驻与悬停显示独立串行保存，只在意图感知页展示', async () => {
  const f = renderFixture();
  const toggle = (label: string) =>
    f.host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  expect(toggle('常驻显示').getAttribute('aria-checked')).toBe('true');
  expect(toggle('悬停显示').getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle('常驻显示').click());
  expect(fixture.save).toHaveBeenLastCalledWith({ persistentDisplay: false });
  f.render();
  expect(toggle('常驻显示').getAttribute('aria-checked')).toBe('false');
  expect(toggle('悬停显示').getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle('悬停显示').click());
  expect(fixture.save).toHaveBeenLastCalledWith({ hoverDisplay: false });
  fixture.pending = true;
  f.render();
  expect(toggle('常驻显示').disabled).toBe(false);
  expect(toggle('悬停显示').disabled).toBe(false);
  f.render('suggestions');
  expect(toggle('常驻显示')).toBeNull();
  expect(toggle('悬停显示')).toBeNull();
});

it.each(['local', 'api'] as const)('%s 模式只保留一份全局意图资源，并放在对应分区', (engine) => {
  fixture.status.engine = engine;
  const f = renderFixture();
  const resources = f.host.querySelectorAll('[data-setting-id="intent-model-resources"]');
  expect(resources).toHaveLength(engine === 'local' ? 1 : 0);
  if (engine === 'local') {
    expect(resources[0]?.textContent).toContain('意图模型资源（全局）');
    expect(
      resources[0]?.closest('.weq-set-card')?.querySelector('.weq-set-card-title')?.textContent,
    ).toBe('功能与模型');
    expect(f.host.querySelector('.weq-set-card .weq-set-card')).toBeNull();
  } else
    expect(
      findSettingElement(f.host, { settingId: 'intent-model-resources' })?.dataset.settingId,
    ).toBe('intent-engine');
  f.render('suggestions');
  expect(f.host.querySelector('[data-setting-id="intent-model-resources"]')).toBeNull();
  expect(f.host.querySelector('details')).toBeNull();
  expect(fixture.save).not.toHaveBeenCalled();
});

it('API 模式不读本地资源；搜索仅定位运行方式，不保存或启动，非活动页禁用但保留草稿', async () => {
  fixture.status.engine = 'api';
  const f = renderFixture();
  expect(searchAppEntries('使用下载镜像')[0]?.target).toMatchObject({
    section: 'intent-sense',
    settingId: 'intent-model-resources',
  });
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  let cleanup = () => {};
  await act(async () => {
    cleanup = revealSetting(f.host, { settingId: 'intent-model-resources' });
  });
  expect(
    f.host
      .querySelector('[data-setting-id="intent-engine"]')
      ?.hasAttribute('data-search-highlight'),
  ).toBe(true);
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  const input = f.input('意图感知上文条数');
  f.edit('意图感知上文条数', '7');
  f.render('intent', false);
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  expect(input.disabled).toBe(true);
  f.render();
  expect(f.input('意图感知上文条数')).toBe(input);
  expect(input.value).toBe('7');
  expect(fixture.save).not.toHaveBeenCalled();
  cleanup();
});

it('意图与推荐全部公开参数有稳定节点或条件跳转及搜索目标', () => {
  fixture.status.engine = 'api';
  const f = renderFixture();
  for (const [page, section] of [
    ['intent', 'intent-sense'],
    ['suggestions', 'reply-suggestions'],
  ] as const) {
    f.render(page);
    for (const item of AI_SETTING_ITEMS.filter((item) => item.section === section)) {
      expect(findSettingElement(f.host, { settingId: item.id }), item.id).not.toBeNull();
      expect(
        searchAppEntries(item.label).some(
          (entry) => entry.target.kind === 'setting' && entry.target.settingId === item.id,
        ),
        item.id,
      ).toBe(true);
    }
  }
});

it.each(['loading', 'error'])('设置 %s 时不显示占位文案且禁止改配置，错误可重试', (kind) => {
  fixture.hasStatus = false;
  fixture.statusError = kind === 'error' ? new Error('合成设置读取失败') : null;
  const f = renderFixture();
  expect(f.host.querySelector<HTMLButtonElement>('[aria-label="启用意图感知"]')!.disabled).toBe(
    true,
  );
  expect(f.host.querySelector('[aria-label="启用意图感知"]')?.getAttribute('aria-checked')).toBe(
    'mixed',
  );
  expect(f.host.querySelector('[aria-label="意图感知运行方式"] [aria-checked="true"]')).toBeNull();
  expect(f.host.querySelector('[data-setting-id="intent-model-resources"]')).toBeNull();
  expect(f.host.querySelector('[data-setting-id="intent-api-model"]')).toBeNull();
  expect(f.host.textContent).not.toContain('待确认');
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  if (kind === 'error') {
    act(() =>
      f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取意图感知设置"]')!.click(),
    );
    expect(fixture.retry).toHaveBeenCalledOnce();
  }
  expect(fixture.save).not.toHaveBeenCalled();
});
