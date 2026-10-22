import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
} from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('框内消息和缺口实时高亮但不提前提交，取消恢复，松开保留最终选择', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = () =>
    act(() => {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    });
  const demo = createTemplateDemoData(),
    conversation = demo.conversations.find((row) => row.type === 'group')!;
  function Probe() {
    const selection = useContentMultiSelect({
      kind: 'messages',
      container: `group:${conversation.id}`,
    });
    return h('output', null, JSON.stringify([...selection.selectedIds]));
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const pointer = (target: Element, type: string, y: number) =>
    act(() =>
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 1,
          clientX: 10,
          clientY: y,
        }),
      ),
    );
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(Probe),
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages: [1, 4, 7].map((seq) => ({
              id: String(seq),
              msgSeq: String(seq),
              conversationId: conversation.id,
              senderId: 'u_peer',
              body: `合成消息 ${seq}`,
              createdAt: new Date(0).toISOString(),
            })),
            loading: false,
            draft: '',
            onDraftChange: () => {},
            onBack: () => {},
          }),
        ),
      ),
    );
    flush();
    const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300));
    Object.defineProperty(scroll, 'clientWidth', { value: 500 });
    Object.defineProperty(scroll, 'clientHeight', { value: 300 });
    const rows = [...scroll.querySelectorAll<HTMLElement>('[data-message-id]')];
    rows.forEach((row, index) => {
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 40 + index * 50, 500, 30),
      );
    });
    pointer(scroll, 'pointerdown', 35);
    pointer(scroll, 'pointermove', 165);
    flush();
    expect(
      rows
        .filter((row) => row.classList.contains('is-selected'))
        .map((row) => row.dataset.messageId),
    ).toEqual(['1', 'gap:1:4', '4']);
    expect(host.querySelector('output')?.textContent).toBe('[]');
    pointer(scroll, 'pointercancel', 165);
    expect(rows.some((row) => row.classList.contains('is-selected'))).toBe(false);
    expect(host.querySelector('output')?.textContent).toBe('[]');
    pointer(scroll, 'pointerdown', 35);
    pointer(scroll, 'pointermove', 165);
    flush();
    pointer(scroll, 'pointerup', 165);
    expect(JSON.parse(host.querySelector('output')!.textContent!)).toEqual(['1', 'gap:1:4', '4']);
    expect(
      rows
        .filter((row) => row.classList.contains('is-selected'))
        .map((row) => row.dataset.messageId),
    ).toEqual(['1', 'gap:1:4', '4']);
    expect(host.querySelector('.weq-message-marquee')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
