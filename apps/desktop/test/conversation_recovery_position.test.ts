import { act, createElement as h, useRef } from 'react';
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

function setFixtureBounds(scroll: HTMLElement) {
  const readHeight = vi.fn(() => 400);
  Object.defineProperties(scroll, {
    scrollHeight: { value: 2000 },
    clientHeight: { get: readHeight },
  });
  scroll.getBoundingClientRect = () => new DOMRect(0, 0, 500, 400);
  const message = scroll.querySelector<HTMLElement>('.message-line')!;
  message.getBoundingClientRect = () => new DOMRect(0, 50, 400, 60);
  return readHeight;
}

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
      const scrollRef = useRef<HTMLDivElement>(null);
      state = useConversationRecoveryPosition({
        conv: 'synthetic',
        kind,
        rows,
        enabled: true,
        atLatest: true,
        resumeReadingPosition: true,
        visitedHistoryRef: useRef(false),
        scrollRef,
      });
      return h(
        'div',
        { className: 'weq-readonly-chat' },
        h(
          'div',
          { className: 'message-scroll', ref: scrollRef },
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
      const readHeight = setFixtureBounds(scroll);
      scroll.scrollTop = bottom ? 1600 : 500;
      act(() => scroll.dispatchEvent(new Event('scroll')));
      if (!bottom) {
        readHeight.mockClear();
        act(() => scroll.dispatchEvent(new Event('scroll')));
        expect(readHeight).not.toHaveBeenCalled();
      }
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
    const scrollRef = useRef<HTMLDivElement>(null);
    state = useConversationRecoveryPosition({
      conv: 'synthetic',
      kind: 'c2c',
      rows,
      enabled: true,
      atLatest: true,
      resumeReadingPosition: true,
      visitedHistoryRef: useRef(false),
      scrollRef,
    });
    return h(
      'div',
      { className: 'weq-readonly-chat' },
      h(
        'div',
        { className: 'message-scroll', ref: scrollRef },
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
    setFixtureBounds(scroll);
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

it('从历史读到最新消息下沿后，底部留白不保留续读快照', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const rows = [{ msgId: 'message-42', msgSeq: '42' }];
  let state: ReturnType<typeof useConversationRecoveryPosition>;
  function Probe() {
    const scrollRef = useRef<HTMLDivElement>(null);
    state = useConversationRecoveryPosition({
      conv: 'synthetic',
      kind: 'c2c',
      rows,
      enabled: true,
      atLatest: true,
      resumeReadingPosition: false,
      visitedHistoryRef: useRef(false),
      scrollRef,
    });
    return h(
      'div',
      { ref: scrollRef, 'data-latest-message-id': 'message-42' },
      h('div', { className: 'message-line', 'data-message-id': 'message-42' }),
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  let root = createRoot(host);
  const render = () => act(() => root.render(h(PageSnapshots, { scope: 'a:c' }, h(Probe))));
  try {
    render();
    const scroll = host.firstElementChild as HTMLElement;
    setFixtureBounds(scroll);
    const message = scroll.firstElementChild as HTMLElement;
    message.getBoundingClientRect = () => new DOMRect(0, 1920 - scroll.scrollTop, 400, 60);
    scroll.scrollTop = 1550;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(localStorage.length).toBe(1);

    scroll.scrollTop = 1580;
    act(() => scroll.dispatchEvent(new Event('scroll')));
    await act(() => vi.advanceTimersByTimeAsync(200));
    act(() => root.unmount());
    root = createRoot(host);
    render();
    expect(state!.read('synthetic', 'c2c')).toBeUndefined();
  } finally {
    act(() => root.unmount());
  }
});
