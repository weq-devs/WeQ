import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PageDataCache } from '../src/renderer/src/lib/pageDataCache';
import { PageSnapshots, usePageDataCache } from '../src/renderer/src/components/PageSnapshots';
import { messageTemplateContext } from '../src/renderer/src/lib/messageTemplateContext';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('页面数据按最近使用、容量和生存期淘汰，不缓存超大或循环值', () => {
  vi.useFakeTimers();
  const cache = new PageDataCache(2, 100, 1000);
  cache.put('a', [1]);
  cache.put('b', [2]);
  expect(cache.get('a')).toEqual([1]);
  cache.put('c', [3]);
  expect(cache.get('b')).toBeUndefined();
  cache.put('large', 'x'.repeat(100));
  expect(cache.get('large')).toBeUndefined();
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  cache.put('cycle', cycle);
  expect(cache.get('cycle')).toBeUndefined();
  vi.advanceTimersByTime(1001);
  expect(cache.get('a')).toBeUndefined();
});
it('同账号页面重挂载可读缓存，切换数据源后不回流', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  let write!: () => void;
  function Page() {
    const cache = usePageDataCache();
    write = () => cache.write('result', ['cached']);
    return h('output', null, JSON.stringify(cache.read('result') ?? null));
  }
  const render = (scope: string, show: boolean) =>
    act(() => root.render(h(PageSnapshots, { scope }, show ? h(Page) : null)));
  try {
    render('source-a', true);
    write();
    render('source-a', false);
    render('source-a', true);
    expect(host.textContent).toBe('["cached"]');
    render('source-b', true);
    expect(host.textContent).toBe('null');
  } finally {
    act(() => root.unmount());
  }
});
it('消息模板上下文忽略未读和会话预览，但对端资料变化仍会失效', () => {
  const conversation = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
  expect(messageTemplateContext({ ...conversation, unreadCount: 10, updatedAt: 'new' })).toBe(
    messageTemplateContext(conversation),
  );
  expect(
    messageTemplateContext({
      ...conversation,
      otherUser: { ...conversation.otherUser, displayName: '新备注' },
    }),
  ).not.toBe(messageTemplateContext(conversation));
});
