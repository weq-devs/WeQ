import { act, cloneElement, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QzonePaginationSettings } from '../src/renderer/src/components/settings/QzonePaginationSettings';
import { McpServerSection } from '../src/renderer/src/components/settings/McpServerSection';
import { AssistantSection } from '../src/renderer/src/components/settings/AssistantSection';
import { SsePushSection } from '../src/renderer/src/components/settings/SsePushSection';
import { ExternalRkeySection } from '../src/renderer/src/components/settings/ExternalRkeySection';
import { useToast } from '../src/renderer/src/components/Toast';
import { useDialog } from '../src/renderer/src/components/Dialog';
import { IntentTuningPanel } from '../src/renderer/src/components/settings/IntentTuningPanel';
import {
  DEFAULT_INTENT_TUNING,
  INTENT_TUNING,
  INTENT_TUNING_KEYS,
} from '@weq/service/intent-context';

const state = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutate: vi.fn(async (_path: string, _input: unknown): Promise<unknown> => ({})),
  pending: false,
}));
vi.mock('../src/renderer/src/hooks/useQQAutoRefresh', () => ({
  useQQAutoRefresh: () => ({ enabled: true }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get(_target, key) {
        if (key === 'useUtils') return () => proxy('utils');
        if (key === 'invalidate' || key === 'setData') return vi.fn(async () => undefined);
        if (key === 'useQuery')
          return () => ({
            data: state.data[path],
            isLoading: false,
            refetch: async () => ({ data: state.data[path] }),
          });
        if (key === 'useMutation')
          return () => ({
            isLoading: state.pending,
            mutateAsync: (input: unknown) => state.mutate(path, input),
          });
        if (key === 'mutate') return (input: unknown) => state.mutate(path, input);
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.pending = false;
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useDialog.setState({ current: null });
  state.data = {
    'bootstrap.getSettings': {
      qzonePagination: { windowSeconds: 10, maxPages: 5 },
      ssePush: { servers: [], enabledServerId: null, debounceMs: 2000, massThreshold: 50 },
    },
    'bootstrap.getMcpStatus': {
      enabled: false,
      port: 48765,
      token: '',
      url: '',
      host: '127.0.0.1',
    },
    'bootstrap.listMcpAgentTargets': [],
    'bootstrap.getWeqAssistantStatus': { enabled: false, port: 27182, url: '' },
    'account.intentSense.getStatus': { ...DEFAULT_INTENT_TUNING },
  };
  state.mutate.mockReset().mockResolvedValue({ port: 48765 });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function mount(element: ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(cloneElement(element)));
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const save = () =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) =>
        button.textContent?.trim() === '保存' || button.textContent?.trim() === '保存调优',
    )!;
  return { host, save, render };
}
describe('显式保存设置不以未变化禁用', () => {
  it('公众号推送端口重读不覆盖草稿，未编辑时跟随实际端口，保存仍提交输入值', async () => {
    const f = mount(createElement(AssistantSection));
    const input = f.host.querySelector<HTMLInputElement>('[aria-label="QQ 公众号推送端口"]')!;
    expect(input.value).toBe('27182');
    state.data['bootstrap.getWeqAssistantStatus'] = { enabled: false, port: 28000, url: '' };
    f.render();
    expect(input.value).toBe('28000');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '28001',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    state.data['bootstrap.getWeqAssistantStatus'] = { enabled: false, port: 29000, url: '' };
    f.render();
    expect(input.value).toBe('28001');
    await act(async () => f.save().click());
    expect(state.mutate).toHaveBeenCalledWith('bootstrap.setWeqAssistantPort', { port: 28001 });
  });
  it('空间限速是两个填空的单行表单，重读不覆盖草稿且仍按原范围校验', async () => {
    const f = mount(createElement(QzonePaginationSettings));
    const form = f.host.querySelector<HTMLFormElement>('form[aria-label="在线翻页限速"]')!;
    expect([...form.children].map((node) => node.tagName)).toEqual([
      'SPAN',
      'INPUT',
      'SPAN',
      'INPUT',
      'SPAN',
      'BUTTON',
    ]);
    const inputs = [...form.querySelectorAll('input')];
    const edit = (index: number, value: string) =>
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          inputs[index],
          value,
        );
        inputs[index]!.dispatchEvent(new Event('input', { bubbles: true }));
      });
    edit(0, '12');
    edit(1, '6');
    state.data['bootstrap.getSettings'] = { qzonePagination: { windowSeconds: 20, maxPages: 8 } };
    f.render();
    expect(inputs.map((node) => node.value)).toEqual(['12', '6']);
    edit(0, '0');
    expect(f.save().disabled).toBe(true);
    edit(0, '12');
    expect(f.save().disabled).toBe(false);
    await act(async () => f.save().click());
    expect(state.mutate).toHaveBeenCalledWith('bootstrap.setQzonePagination', {
      windowSeconds: 12,
      maxPages: 6,
    });
  });
  it.each(['rkey', 'sse'] as const)(
    '%s 连接测试只更新原横幅，不阻止切换编辑目标或以失败弹窗干扰新表单',
    async (kind) => {
      const server = {
        id: 'synthetic-a',
        name: '合成 A',
        baseUrl: 'https://a.example.invalid',
        pushUrl: 'https://a.example.invalid/push',
        accessToken: 'synthetic-a-token',
      };
      const other = {
        ...server,
        id: 'synthetic-b',
        name: '合成 B',
        baseUrl: 'https://b.example.invalid',
        pushUrl: 'https://b.example.invalid/push',
        accessToken: 'synthetic-b-token',
      };
      state.data['bootstrap.getSettings'] = {
        externalRkey: { servers: [server, other], enabledServerId: null },
        ssePush: {
          servers: [server, other],
          enabledServerId: null,
          debounceMs: 2000,
          massThreshold: 50,
        },
      };
      let fail!: (error: Error) => void;
      state.mutate.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
      const f = mount(createElement(kind === 'rkey' ? ExternalRkeySection : SsePushSection));
      try {
        const edits = f.host.querySelectorAll<HTMLButtonElement>('[aria-label="编辑"]');
        act(() => edits[0]!.click());
        await act(async () =>
          f.host.querySelector<HTMLButtonElement>('.weq-set-server-form-actions button')!.click(),
        );
        expect(useToast.getState().toasts[0]!.loading).toBe(true);
        expect(state.mutate).toHaveBeenCalledWith(
          kind === 'rkey' ? 'bootstrap.testExternalRkeyServer' : 'bootstrap.testSsePushServer',
          expect.objectContaining({ accessToken: server.accessToken }),
        );
        act(() => edits[1]!.click());
        expect(
          f.host.querySelector<HTMLButtonElement>('.weq-set-server-form-actions button')!.disabled,
        ).toBe(false);
        expect(
          f.host.querySelector<HTMLInputElement>('.weq-set-server-form input[type="password"]')!
            .value,
        ).toBe(other.accessToken);
        await act(async () => fail(Error('合成连接超时')));
        expect(useToast.getState().toasts[0]).toMatchObject({
          tone: 'error',
          loading: false,
          detail: '合成连接超时',
        });
        expect(useDialog.getState().current).toBeNull();
        expect(
          f.host.querySelector<HTMLInputElement>('.weq-set-server-form input[type="password"]')!
            .value,
        ).toBe(other.accessToken);
      } finally {
        if (fail) await act(async () => fail(Error('合成测试收尾')));
      }
    },
  );
  it.each([
    {
      label: '翻页频率',
      view: () => createElement(QzonePaginationSettings),
      route: 'bootstrap.setQzonePagination',
      input: { windowSeconds: 10, maxPages: 5 },
    },
    {
      label: 'MCP 端口',
      view: () => createElement(McpServerSection),
      route: 'bootstrap.setMcpPort',
      input: { port: 48765 },
    },
    {
      label: '助手端口',
      view: () => createElement(AssistantSection),
      route: 'bootstrap.setWeqAssistantPort',
      input: { port: 27182 },
    },
    {
      label: 'SSE 调优',
      view: () => createElement(SsePushSection),
      route: 'bootstrap.setSsePushTuning',
      input: { debounceMs: 2000, massThreshold: 50 },
    },
    {
      label: '意图参数',
      view: () => createElement(IntentTuningPanel, { group: 'analysis' }),
      route: 'account.intentSense.setConfig',
      input: Object.fromEntries(
        INTENT_TUNING_KEYS.filter((key) => INTENT_TUNING[key].group === 'analysis').map((key) => [
          key,
          DEFAULT_INTENT_TUNING[key],
        ]),
      ),
    },
  ])('$label 原值可保存，点击才提交，保存后仍可再提交', async ({ view, route, input }) => {
    const f = mount(view());
    expect(f.save()).toBeDefined();
    expect(f.save().disabled).toBe(false);
    expect(state.mutate).not.toHaveBeenCalled();
    await act(async () => f.save().click());
    expect(state.mutate).toHaveBeenCalledWith(route, input);
    expect(f.save().disabled).toBe(false);
    await act(async () => f.save().click());
    expect(state.mutate.mock.calls.filter(([path]) => path === route)).toHaveLength(2);
    state.pending = true;
    f.render();
    expect(f.save().disabled).toBe(true);
    act(() => f.save().click());
    expect(state.mutate.mock.calls.filter(([path]) => path === route)).toHaveLength(2);
  });
});
