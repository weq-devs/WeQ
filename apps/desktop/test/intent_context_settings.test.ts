import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntentSenseSection } from '../src/renderer/src/components/settings/IntentSenseSection';
import { AI_SETTING_ITEMS } from '../src/renderer/src/components/settings/aiSettingsCatalog';
import { searchAppEntries } from '../src/renderer/src/components/search/appSearchCatalog';
import { revealSetting } from '../src/renderer/src/components/settings/searchTarget';
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

function renderFixture(open = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (page: 'intent' | 'suggestions' = 'intent') =>
    act(() => root.render(createElement(IntentSenseSection, { page })));
  render();
  if (open)
    act(() => {
      const details = host.querySelector('details')!;
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
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
  const save = () => host.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
  return { host, render, input, edit, save };
}

it('分别编辑两个条数，只提交对应配置并刷新相关缓存，支持零条上文', async () => {
  const f = renderFixture();
  expect(f.input('意图感知上文条数').value).toBe(String(DEFAULT_ANALYSIS_CONTEXT_MESSAGES));
  expect(f.input('推荐回复上文条数')).toBeNull();
  expect(f.input('意图感知上文条数').max).toBe(String(MAX_INTENT_CONTEXT_MESSAGES));
  expect(f.save().disabled).toBe(false);
  f.edit('意图感知上文条数', '0');
  expect(f.save().disabled).toBe(false);
  await act(async () => f.save().click());
  expect(fixture.save).toHaveBeenCalledWith({
    analysisContextMessages: 0,
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(3);
  f.render();
  expect(f.save().disabled).toBe(false);
  f.render('suggestions');
  expect(f.input('意图感知上文条数')).toBeNull();
  expect(f.input('推荐回复上文条数').value).toBe(String(DEFAULT_SUGGESTION_CONTEXT_MESSAGES));
  f.edit('推荐回复上文条数', '2');
  await act(async () => f.save().click());
  expect(fixture.save).toHaveBeenLastCalledWith({ suggestionContextMessages: 2 });
  expect(fixture.invalidate).toHaveBeenCalledTimes(6);
  f.render('suggestions');
  expect(f.save().disabled).toBe(false);
});

it('无效、空值、在途及主进程尚未支持时不能保存或误提示成功', () => {
  const f = renderFixture();
  for (const value of ['-1', '1.5', '', String(MAX_INTENT_CONTEXT_MESSAGES + 1)]) {
    f.edit('意图感知上文条数', value);
    expect(f.save().disabled).toBe(true);
    act(() =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  }
  expect(fixture.save).not.toHaveBeenCalled();
  f.edit('意图感知上文条数', '2');
  fixture.pending = true;
  f.render();
  expect(f.input('意图感知上文条数').disabled).toBe(true);
  expect(f.save().disabled).toBe(true);
  fixture.pending = false;
  Reflect.deleteProperty(fixture.status, 'analysisContextMessages');
  f.render();
  expect(f.input('意图感知上文条数').disabled).toBe(true);
  expect(f.host.textContent).toContain('当前主进程尚未提供参数');
  expect(fixture.save).not.toHaveBeenCalled();
});

it('常驻与悬停显示独立保存，只在意图感知页展示，在途禁用', async () => {
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
  expect(toggle('常驻显示').disabled).toBe(true);
  expect(toggle('悬停显示').disabled).toBe(true);
  f.render('suggestions');
  expect(toggle('常驻显示')).toBeNull();
  expect(toggle('悬停显示')).toBeNull();
});

it.each(['local', 'api'] as const)('%s 模式只保留一份全局意图资源，并放在对应分区', (engine) => {
  fixture.status.engine = engine;
  const f = renderFixture();
  const resources = f.host.querySelectorAll('[data-setting-id="intent-model-resources"]');
  expect(resources).toHaveLength(1);
  expect(resources[0]?.textContent).toContain('意图模型资源（全局）');
  expect(Boolean(resources[0]?.closest('details'))).toBe(engine === 'api');
  f.render('suggestions');
  expect(f.host.querySelector('[data-setting-id="intent-model-resources"]')).toBeNull();
  expect(f.host.querySelector('details')).not.toBeNull();
  expect(fixture.save).not.toHaveBeenCalled();
});

it('API 高级区域收起时停用全局模型读取/订阅；搜索只展开定位且不保存或启动', async () => {
  fixture.status.engine = 'api';
  const f = renderFixture(false);
  expect(searchAppEntries('使用下载镜像')[0]?.target).toMatchObject({
    section: 'intent-sense',
    settingId: 'intent-model-resources',
  });
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  let cleanup = () => {};
  await act(async () => {
    cleanup = revealSetting(f.host, { settingId: 'intent-model-resources' });
    f.host.querySelector('details')!.dispatchEvent(new Event('toggle'));
  });
  expect(f.host.querySelector('details')!.open).toBe(true);
  expect(fixture.resourceActive).toBe(true);
  expect(fixture.resourceSubscriptionActive).toBe(true);
  const input = f.input('意图感知上文条数');
  f.edit('意图感知上文条数', '7');
  act(() => {
    const details = f.host.querySelector('details')!;
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  expect(f.save().disabled).toBe(true);
  act(() => {
    const details = f.host.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
  expect(f.input('意图感知上文条数')).toBe(input);
  expect(input.value).toBe('7');
  expect(fixture.save).not.toHaveBeenCalled();
  cleanup();
});

it('意图与推荐全部公开参数有真实稳定节点及搜索目标，条件资源有说明节点', () => {
  fixture.status.engine = 'local';
  const f = renderFixture();
  for (const [page, section] of [
    ['intent', 'intent-sense'],
    ['suggestions', 'reply-suggestions'],
  ] as const) {
    f.render(page);
    for (const item of AI_SETTING_ITEMS.filter((item) => item.section === section)) {
      expect(f.host.querySelectorAll(`[data-setting-id="${item.id}"]`), item.id).toHaveLength(1);
      expect(
        searchAppEntries(item.label).some(
          (entry) => entry.target.kind === 'setting' && entry.target.settingId === item.id,
        ),
        item.id,
      ).toBe(true);
    }
  }
});

it.each(['loading', 'error'])('设置 %s 时保留条件摘要并禁止改配置，错误可重试', (kind) => {
  fixture.hasStatus = false;
  fixture.statusError = kind === 'error' ? new Error('合成设置读取失败') : null;
  const f = renderFixture(false);
  expect(f.host.querySelector<HTMLButtonElement>('[aria-label="启用意图感知"]')!.disabled).toBe(
    true,
  );
  expect(f.host.querySelector('[data-setting-id="intent-model-resources"]')?.textContent).toContain(
    '待确认',
  );
  expect(f.host.querySelector('[data-setting-id="intent-api-model"]')?.textContent).toContain(
    '待确认',
  );
  expect(fixture.resourceActive).toBe(false);
  expect(fixture.resourceSubscriptionActive).toBe(false);
  if (kind === 'error') {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="重新读取意图设置"]')!.click());
    expect(fixture.retry).toHaveBeenCalledOnce();
  }
  expect(fixture.save).not.toHaveBeenCalled();
});
