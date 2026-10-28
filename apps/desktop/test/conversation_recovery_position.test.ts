import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { useConversationRecoveryPosition } from '../src/renderer/src/hooks/useConversationRecoveryPosition';
import { timelineRowKey } from '../src/shared/roaming_timeline';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it.each([
  { bottom: true, source: undefined, verified: false, kind: 'c2c' as const, expected: undefined },
  {
    bottom: false,
    source: 'roaming' as const,
    verified: false,
    kind: 'c2c' as const,
    expected: undefined,
  },
  {
    bottom: false,
    source: 'roaming' as const,
    verified: true,
    kind: 'c2c' as const,
    expected: '42',
  },
  {
    bottom: false,
    source: 'roaming' as const,
    verified: false,
    kind: 'group' as const,
    expected: '42',
  },
])(
  '底部跟随最新；漫游私聊只使用核实过的本地序号：%j',
  async ({ bottom, source, verified, kind, expected }) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', new Storage());
    const rows = [{ msgId: 'message-42', msgSeq: '42', source, ntSeqVerified: verified }];
    let state: ReturnType<typeof useConversationRecoveryPosition>;
    function Probe() {
      state = useConversationRecoveryPosition({ conv: 'synthetic', kind, rows, enabled: true });
      return h(
        'div',
        { className: 'weq-readonly-chat' },
        h(
          'div',
          { className: 'message-scroll' },
          h('div', { className: 'message-line', 'data-message-id': timelineRowKey(rows[0]!) }),
        ),
      );
    }
    const host = document.createElement('div');
    document.body.append(host);
    let root = createRoot(host);
    const render = () => act(() => root.render(h(PageSnapshots, { scope: 'a:c' }, h(Probe))));
    try {
      render();
      const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
      Object.defineProperties(scroll, {
        scrollHeight: { value: 2000 },
        clientHeight: { value: 400 },
      });
      scroll.scrollTop = bottom ? 1600 : 500;
      act(() => scroll.dispatchEvent(new Event('scroll')));
      await act(() => vi.advanceTimersByTimeAsync(200));
      act(() => root.unmount());
      root = createRoot(host);
      render();
      expect(state!.read('synthetic', kind)?.anchorSeq).toBe(expected);
    } finally {
      act(() => root.unmount());
    }
  },
);

it('崩溃前滚动即保存锚点，重建后可读取，按账号数据源隔离且仅消费一次', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const rows = [{ msgId: 'message-42', msgSeq: '42' }];
  let state: ReturnType<typeof useConversationRecoveryPosition>;
  function Probe() {
    state = useConversationRecoveryPosition({
      conv: 'synthetic',
      kind: 'c2c',
      rows,
      enabled: true,
    });
    return h(
      'div',
      { className: 'weq-readonly-chat' },
      h(
        'div',
        { className: 'message-scroll' },
        h('div', { className: 'message-line', 'data-message-id': 'message-42' }),
      ),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const render = (scope: string) => act(() => root.render(h(PageSnapshots, { scope }, h(Probe))));
  try {
    render('account:config');
    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    Object.defineProperties(scroll, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 400 },
    });
    scroll.scrollTop = 500;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    await act(() => vi.advanceTimersByTimeAsync(200));
    // 不依赖卸载收尾：写入时旧界面仍然在运行。
    expect(
      [...Array(localStorage.length)]
        .map((_, i) => localStorage.getItem(localStorage.key(i)!))
        .join(''),
    ).toContain('message-42');
    act(() => root.unmount());
    root = createRoot(host);
    render('account:config');
    expect(state!.read('synthetic', 'c2c')).toMatchObject({
      anchorSeq: '42',
      anchorId: 'message-42',
    });
    expect(state!.read('other', 'c2c')).toBeUndefined();
    expect(state!.read('synthetic', 'group')).toBeUndefined();
    act(() => state!.applied());
    expect(state!.read('synthetic', 'c2c')).toBeUndefined();
    render('account:other-config');
    expect(state!.read('synthetic', 'c2c')).toBeUndefined();
  } finally {
    act(() => root.unmount());
  }
});
