import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QzoneForwardAction } from '../src/renderer/src/components/QzoneForwardAction';

let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
});
it.each([0, 73, null])(
  '转发入口区分服务端计数 %s，悬停只显示名单状态，点击才执行转发',
  async (count) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const click = vi.fn();
    close = () => {
      act(() => root.unmount());
      host.remove();
    };
    await act(async () => root.render(h(QzoneForwardAction, { count, onClick: click })));
    const button = host.querySelector('button')!;
    expect(button.textContent).toBe(`转发 ${count ?? '?'}`);
    await act(async () => button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(document.querySelector('[aria-label="转发列表"]')?.textContent).toContain(
      '暂无可信数据',
    );
    expect(click).not.toHaveBeenCalled();
    await act(async () => button.click());
    expect(click).toHaveBeenCalledOnce();
  },
);
