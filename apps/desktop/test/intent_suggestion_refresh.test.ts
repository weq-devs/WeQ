import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';

const fixture = vi.hoisted(() => ({
  data: [{ text: '旧候选' }] as { text: string }[] | undefined,
  fetching: false,
  status: { suggestionsEnabled: true, suggestionRevision: 0 },
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({ data: fixture.status }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      intentSense: {
        getSuggestions: {
          useQuery: () => ({ data: fixture.data, isFetching: fixture.fetching }),
        },
      },
    },
  },
}));
afterEach(() => vi.unstubAllGlobals());

it('新消息加载保留可点击的旧候选，结果到达后替换，会话及配置切换不沿用旧候选', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onInsert = vi.fn();
  const render = (latestMessageId = 'first', conv = 'fixture', kind: 'group' | 'c2c' = 'group') =>
    act(() =>
      root.render(createElement(IntentSuggestionBar, { kind, conv, latestMessageId, onInsert })),
    );
  const text = () => host.querySelector('.weq-int-suggest-text')?.textContent;
  try {
    render();
    fixture.data = undefined;
    fixture.fetching = true;
    render('second');
    expect(text()).toBe('旧候选');
    expect(host.querySelector('.is-skeleton')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.weq-int-suggest-pill')!.click());
    expect(onInsert).toHaveBeenCalledWith('旧候选');
    render('third');
    expect(text()).toBe('旧候选');
    fixture.data = [{ text: '新候选' }];
    fixture.fetching = false;
    render('third');
    expect(text()).toBe('新候选');
    fixture.data = undefined;
    fixture.fetching = true;
    render('fourth', 'other');
    expect(text()).toBeUndefined();
    fixture.data = [{ text: '另一会话候选' }];
    fixture.fetching = false;
    render('fourth', 'other');
    fixture.data = undefined;
    fixture.fetching = true;
    render('fifth', 'other', 'c2c');
    expect(text()).toBeUndefined();
    fixture.data = [{ text: '新配置前候选' }];
    fixture.fetching = false;
    render();
    fixture.data = undefined;
    fixture.fetching = true;
    fixture.status.suggestionRevision++;
    render('sixth');
    expect(text()).toBeUndefined();
    fixture.data = [];
    fixture.fetching = false;
    render('sixth');
    expect(host.querySelector('.weq-int-suggest')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
