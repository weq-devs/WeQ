import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useOverlayAnchor } from '../src/renderer/src/lib/overlayAnchor';

afterEach(() => vi.unstubAllGlobals());

it.each([
  { width: 1280, x: 100, y: 80, preferred: 'side' as const, left: 408, top: 80 },
  { width: 1280, x: 900, y: 80, preferred: 'side' as const, left: 552, top: 80 },
  { width: 390, x: 10, y: 80, preferred: 'side' as const, left: 10, top: 288 },
  { width: 1280, x: 100, y: 650, preferred: 'side' as const, left: 408, top: 532 },
  { width: 1280, x: 100, y: 80, preferred: 'below' as const, left: 100, top: 288 },
  { width: 1280, x: 100, y: 400, preferred: 'above' as const, left: 100, top: 132 },
])('旁侧定位与既有上下定位：%j', ({ width, x, y, preferred, left, top }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', 800);
  const host = document.createElement('div');
  const anchor = document.createElement('button');
  const layer = document.createElement('div');
  const card = document.createElement('div');
  layer.append(card);
  document.body.append(host, anchor, layer);
  anchor.getBoundingClientRect = () => new DOMRect(x, y, 300, 200);
  card.getBoundingClientRect = () => new DOMRect(0, 0, 340, 260);
  const ref = { current: layer };
  function Fixture() {
    const placement = useOverlayAnchor(ref, true, true, anchor, preferred);
    return h('output', null, JSON.stringify(placement.position));
  }
  const root = createRoot(host);
  try {
    act(() => root.render(h(Fixture)));
    expect(JSON.parse(host.textContent!)).toEqual({
      '--weq-popover-left': `${left}px`,
      '--weq-popover-top': `${top}px`,
    });
  } finally {
    act(() => root.unmount());
    host.remove();
    anchor.remove();
    layer.remove();
  }
});
