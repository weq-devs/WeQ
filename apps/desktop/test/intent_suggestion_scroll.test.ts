import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { IntentSuggestionBar } from '../src/renderer/src/components/intentSense/IntentSuggestionBar';

const fixture = vi.hoisted(() => ({ list: [{ text: '建议回复'.repeat(30), tone: '自然' }] }));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({
    data: { enabled: true, apiConfigured: true, suggestionsEnabled: true },
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      intentSense: {
        getSuggestions: {
          useQuery: () => ({ data: fixture.list, isFetching: false, refetch: vi.fn() }),
        },
      },
    },
  },
}));

afterEach(() => vi.unstubAllGlobals());

it('滚轮由非被动监听统一平移建议条，支持双轴、行与页单位，缩放手势不接管', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onInsert = vi.fn();
  const render = (conv = 'fixture') =>
    act(() =>
      root.render(
        createElement(IntentSuggestionBar, {
          kind: 'group',
          conv,
          onInsert,
        }),
      ),
    );
  try {
    render();
    const track = host.querySelector<HTMLElement>('.weq-int-suggest-track')!;
    const text = host.querySelector<HTMLElement>('.weq-int-suggest-text')!;
    Object.defineProperties(track, { scrollWidth: { value: 2000 }, clientWidth: { value: 300 } });
    Object.defineProperties(text, { scrollWidth: { value: 800 }, clientWidth: { value: 240 } });
    const wheel = (options: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...options });
      // happy-dom 的 WheelEvent 未继承 MouseEvent，需补上真实浏览器的修饰键字段。
      Object.defineProperty(event, 'ctrlKey', { value: options.ctrlKey ?? false });
      text.dispatchEvent(event);
      return event;
    };
    expect(wheel({ deltaY: 20 }).defaultPrevented).toBe(true);
    expect(track.scrollLeft).toBe(20);
    expect(text.scrollLeft).toBe(0);
    wheel({ deltaX: 30, deltaY: 3 });
    expect(track.scrollLeft).toBe(50);
    wheel({ deltaX: -10 });
    expect(track.scrollLeft).toBe(40);
    wheel({ deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(track.scrollLeft).toBeGreaterThan(42);
    const beforePage = track.scrollLeft;
    wheel({ deltaY: 1, deltaMode: WheelEvent.DOM_DELTA_PAGE });
    expect(track.scrollLeft).toBe(beforePage + 300);
    const beforeZoom = track.scrollLeft;
    expect(wheel({ deltaY: 20, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(track.scrollLeft).toBe(beforeZoom);
    const scrollTo = vi.fn();
    text.scrollTo = scrollTo;
    text.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    text.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => text.closest('button')!.click());
    expect(onInsert).toHaveBeenCalledWith(fixture.list[0]!.text);
    render('other-conversation');
    expect(host.querySelector('.weq-int-suggest-track')).not.toBe(track);
    expect(host.querySelector('.weq-int-suggest-track')!.scrollLeft).toBe(0);
    expect(wheel({ deltaY: 10 }).defaultPrevented).toBe(false);
    expect(track.scrollLeft).toBe(beforeZoom);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
