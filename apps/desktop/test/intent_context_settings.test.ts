import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IntentSenseSection } from '../src/renderer/src/components/settings/IntentSenseSection';
import {
  DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
  DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  MAX_INTENT_CONTEXT_MESSAGES,
} from '@weq/service/intent-context';

const fixture = vi.hoisted(() => ({
  status: {
    enabled: true,
    engine: 'local' as const,
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
      getLocalEngine: {
        useQuery: () => ({
          data: { available: false, modelDownloaded: false, engineReady: false, models: [] },
        }),
      },
      localModelResources: { useQuery: () => ({ data: { selected: { intent: 'auto' } } }) },
      setLocalModelResource: { useMutation: () => ({ isLoading: false }) },
      downloadLocalModel: { useMutation: () => ({ isLoading: false }) },
      startLocalEngine: { useMutation: () => ({ isLoading: false }) },
      onModelDownloadProgress: { useSubscription: () => {} },
    },
    account: {
      intentSense: {
        getStatus: {
          useQuery: () => ({ data: fixture.status, isLoading: false, refetch: vi.fn() }),
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
    analysisContextMessages: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
    suggestionContextMessages: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
  };
  fixture.pending = false;
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
  const render = (page: 'intent' | 'suggestions' = 'intent') =>
    act(() => root.render(createElement(IntentSenseSection, { page })));
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
  const save = () => host.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
  return { host, render, input, edit, save };
}

it('分别编辑两个条数，只提交对应配置并刷新相关缓存，支持零条上文', async () => {
  const f = renderFixture();
  expect(f.input('意图分析上文条数').value).toBe(String(DEFAULT_ANALYSIS_CONTEXT_MESSAGES));
  expect(f.input('推荐回复上文条数')).toBeNull();
  expect(f.input('意图分析上文条数').max).toBe(String(MAX_INTENT_CONTEXT_MESSAGES));
  expect(f.save().disabled).toBe(true);
  f.edit('意图分析上文条数', '0');
  expect(f.save().disabled).toBe(false);
  await act(async () => f.save().click());
  expect(fixture.save).toHaveBeenCalledWith({
    analysisContextMessages: 0,
  });
  expect(fixture.invalidate).toHaveBeenCalledTimes(3);
  f.render();
  expect(f.save().disabled).toBe(true);
  f.render('suggestions');
  expect(f.input('意图分析上文条数')).toBeNull();
  expect(f.input('推荐回复上文条数').value).toBe(String(DEFAULT_SUGGESTION_CONTEXT_MESSAGES));
  f.edit('推荐回复上文条数', '2');
  await act(async () => f.save().click());
  expect(fixture.save).toHaveBeenLastCalledWith({ suggestionContextMessages: 2 });
  expect(fixture.invalidate).toHaveBeenCalledTimes(6);
  f.render('suggestions');
  expect(f.save().disabled).toBe(true);
});

it('无效、空值、在途及主进程尚未支持时不能保存或误提示成功', () => {
  const f = renderFixture();
  for (const value of ['-1', '1.5', '', String(MAX_INTENT_CONTEXT_MESSAGES + 1)]) {
    f.edit('意图分析上文条数', value);
    expect(f.save().disabled).toBe(true);
    act(() =>
      f.host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  }
  expect(fixture.save).not.toHaveBeenCalled();
  f.edit('意图分析上文条数', '2');
  fixture.pending = true;
  f.render();
  expect(f.input('意图分析上文条数').disabled).toBe(true);
  expect(f.save().disabled).toBe(true);
  fixture.pending = false;
  Reflect.deleteProperty(fixture.status, 'analysisContextMessages');
  f.render();
  expect(f.input('意图分析上文条数').disabled).toBe(true);
  expect(f.host.textContent).toContain('当前主进程未加载上文设置');
  expect(fixture.save).not.toHaveBeenCalled();
});
