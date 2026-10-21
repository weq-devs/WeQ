import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { marqueeMessageIds, useMessageMarquee } from '../src/renderer/src/hooks/useMessageMarquee';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('框选只按竖直交集命中，支持反向、边界、追加及缩小范围', () => {
  const rows = [
    { id: 'a', top: 10, bottom: 40 },
    { id: 'b', top: 60, bottom: 90 },
    { id: 'c', top: 100, bottom: 130 },
  ];
  expect([...marqueeMessageIds(rows, 40, 100)]).toEqual(['a', 'b', 'c']);
  expect([...marqueeMessageIds(rows, 100, 40)]).toEqual(['a', 'b', 'c']);
  expect([...marqueeMessageIds(rows, 50, 70, new Set(['c']))]).toEqual(['c', 'b']);
  expect([...marqueeMessageIds(rows, 50, 55)]).toEqual([]);
  expect([...marqueeMessageIds(rows, 10, 90, new Set(['a', 'c']), { ctrlKey: true })]).toEqual([
    'c',
    'b',
  ]);
  expect([
    ...marqueeMessageIds(rows, 60, 90, new Set(['a']), {
      shiftKey: true,
      anchor: 'c',
      ordered: ['a', 'b', 'c'],
    }),
  ]).toEqual(['a', 'b', 'c']);
});

it('普通状态首次快速框选，即使浏览器未投递中间 pointermove 也按释放位置提交', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const selection = useContentMultiSelect({ kind: 'messages', container: 'group:fast' });
    const marquee = useMessageMarquee({
      conversationKey: 'fast',
      enabled: true,
      selectionMode: selection.selectionMode,
      selected: selection.selectedIds,
      onChange: selection.setSelectedIds,
      onStart: () => selection.setSelectionMode(true),
      anchorRef: selection.anchorRef,
    });
    return h(
      'div',
      { ...marquee.handlers, 'data-scroll': true },
      h('output', { 'data-mode': selection.selectionMode }, [...selection.selectedIds].join(',')),
      ...['a', 'b', 'c'].map((id) => h('div', { key: id, 'data-message-id': id }, id)),
    );
  }
  const pointer = (scroll: Element, type: string, x: number, y: number) =>
    act(() =>
      scroll.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX: x,
          clientY: y,
        }),
      ),
    );
  try {
    act(() => root.render(h(ContentSelectionProvider, null, h(View))));
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300));
    Object.defineProperty(scroll, 'clientWidth', { value: 500 });
    Object.defineProperty(scroll, 'clientHeight', { value: 300 });
    [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(200, 40 + index * 60, 100, 40),
      );
    });
    pointer(scroll, 'pointerdown', 10, 30);
    pointer(scroll, 'pointerup', 12, 32);
    expect(host.querySelector('output')?.getAttribute('data-mode')).toBe('false');
    pointer(scroll, 'pointerdown', 10, 35);
    pointer(scroll, 'pointerup', 15, 125);
    expect(host.querySelector('output')?.getAttribute('data-mode')).toBe('true');
    expect(host.querySelector('output')?.textContent).toBe('a,b');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('空白框选松开后才提交多选，正文不触发，取消和切会话不提交', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View({ conversationKey }: { conversationKey: string }) {
    const [mode, setMode] = useState(false),
      [selected, setSelected] = useState(new Set<string>());
    const marquee = useMessageMarquee({
      conversationKey,
      enabled: true,
      selectionMode: mode,
      selected,
      onChange: setSelected,
      onStart: () => setMode(true),
    });
    return h(
      'div',
      { ...marquee.handlers, 'data-scroll': true },
      h('output', { 'data-mode': mode }, [...selected].join(',')),
      ...['a', 'b', 'c'].map((id) =>
        h(
          'div',
          { key: id, 'data-message-id': id },
          h('span', { className: 'message-bubble' }, id),
        ),
      ),
      marquee.box && h('div', { 'data-marquee': true }),
    );
  }
  const pointer = (target: Element, type: string, x: number, y: number, ctrlKey = false) =>
    act(() =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX: x,
          clientY: y,
          ctrlKey,
        }),
      ),
    );
  try {
    act(() => root.render(h(View, { conversationKey: 'one' })));
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300));
    Object.defineProperty(scroll, 'clientWidth', { value: 500 });
    Object.defineProperty(scroll, 'clientHeight', { value: 300 });
    [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')].forEach((row, i) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(200, 40 + i * 60, 100, 40),
      );
    });
    pointer(scroll.querySelector('.message-bubble')!, 'pointerdown', 220, 50);
    pointer(scroll, 'pointermove', 240, 150);
    expect(host.querySelector('[data-marquee]')).toBeNull();
    pointer(scroll, 'pointerdown', 10, 35);
    pointer(scroll, 'pointermove', 15, 120);
    expect(host.querySelector('output')?.textContent).toBe('');
    expect(host.querySelector('output')?.getAttribute('data-mode')).toBe('false');
    expect(host.querySelector('[data-marquee]')).not.toBeNull();
    pointer(scroll, 'pointermove', 15, 85);
    expect(host.querySelector('output')?.textContent).toBe('');
    pointer(scroll, 'pointerup', 15, 85);
    expect(host.querySelector('output')?.textContent).toBe('a');
    expect(host.querySelector('output')?.getAttribute('data-mode')).toBe('true');
    expect(host.querySelector('[data-marquee]')).toBeNull();
    expect(frames.size).toBe(0);
    pointer(scroll, 'pointerdown', 10, 155, true);
    pointer(scroll, 'pointermove', 15, 190, true);
    expect(host.querySelector('output')?.textContent).toBe('a');
    pointer(scroll, 'pointercancel', 15, 190, true);
    expect(host.querySelector('output')?.textContent).toBe('a');
    pointer(scroll, 'pointerdown', 10, 155, true);
    pointer(scroll, 'pointermove', 15, 190, true);
    pointer(scroll, 'pointerup', 15, 190, true);
    expect(host.querySelector('output')?.textContent).toBe('a,c');
    // 不按修饰键也追加，横向离开气泡不会影响命中。
    pointer(scroll, 'pointerdown', 450, 95);
    pointer(scroll, 'pointermove', 460, 145);
    pointer(scroll, 'pointerup', 460, 145);
    expect(host.querySelector('output')?.textContent).toBe('a,c,b');
    // 多选时点消息同一垂直范围的空白处，也切换该消息。
    pointer(scroll, 'pointerdown', 450, 60);
    pointer(scroll, 'pointerup', 450, 60);
    expect(host.querySelector('output')?.textContent).toBe('c,b');
    pointer(scroll, 'pointerdown', 10, 95);
    pointer(scroll, 'pointermove', 15, 150);
    act(() => root.render(h(View, { conversationKey: 'two' })));
    expect(host.querySelector('output')?.textContent).toBe('c,b');
    expect(host.querySelector('[data-marquee]')).toBeNull();
    expect(frames.size).toBe(0);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
