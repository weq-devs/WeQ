import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ForwardWindowHost, openForwardWindow } from '../src/renderer/src/components/ForwardWindow';
import { Modal } from '../src/renderer/src/components/Dialog';

vi.mock('../src/renderer/src/trpc/client', () => ({ client: { account: {} }, trpc: {} }));

it('复用转发宿主仍提升到新父窗上方，聚焦父记录不遮住子记录，并在入口附近避让窄屏', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('innerWidth', 375);
  vi.stubGlobal('innerHeight', 800);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const toolClose = vi.fn();
  const render = (open: boolean, presentation: 'floating' | 'modal' = 'floating') =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(ForwardWindowHost),
          h(
            Modal,
            { open, presentation, title: '父工具', onClose: toolClose },
            h('button', null, '工具'),
          ),
        ),
      ),
    );
  const forwardLayer = () => document.querySelector<HTMLElement>('.weq-forward-layer')!;
  try {
    render(false);
    act(() =>
      openForwardWindow({
        title: '父记录',
        kind: 'c2c',
        conv: '',
        msgId: 'fixture-1',
        records: [],
      }),
    );
    render(true);
    const toolLayer = document.querySelector<HTMLElement>('.weq-window-layer')!;
    expect(Number(toolLayer.style.zIndex)).toBeGreaterThan(Number(forwardLayer().style.zIndex));
    act(() =>
      openForwardWindow({
        title: '子记录',
        kind: 'c2c',
        conv: '',
        msgId: 'fixture-2',
        records: [],
        parentId: 1,
        anchor: new DOMRect(340, 740, 27, 30),
      }),
    );
    expect(Number(forwardLayer().style.zIndex)).toBeGreaterThan(Number(toolLayer.style.zIndex));
    const parent = document.querySelector<HTMLElement>('[aria-label="父记录"]')!;
    const child = document.querySelector<HTMLElement>('[aria-label="子记录"]')!;
    act(() => parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(Number(child.style.zIndex)).toBeGreaterThan(Number(parent.style.zIndex));
    expect(child.style.left).toBe('8px');
    expect(child.style.top).toBe('172px');
    render(true, 'modal');
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(toolClose).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('.weq-forward-window')).toHaveLength(2);
  } finally {
    act(() => {
      for (const button of document.querySelectorAll<HTMLButtonElement>('.weq-forward-close'))
        button.click();
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  }
});
