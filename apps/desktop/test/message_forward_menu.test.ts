import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessageContextMenu } from '../src/renderer/src/im-template/template/messageContextMenu';
import { createTemplateDemoData } from './support/templateDemoData';

it('转发入口按真实内容过滤，临时不可用保留禁用原因', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const base = createTemplateDemoData().messages[0]!;
  const forward = vi.fn();
  const render = async (type: string, reason?: string) => {
    await act(async () =>
      root.render(
        createElement(MessageContextMenu, {
          state: {
            x: 10,
            y: 10,
            message: { ...base, qqElements: [{ type, data: { textContent: '正文' } }] },
          },
          onCopy: vi.fn(),
          onForward: forward,
          forwardBlockedReason: reason,
        }),
      ),
    );
    return host.querySelector<HTMLButtonElement>('[aria-label="转发"]');
  };
  try {
    for (const type of ['wallet', 'call', 'grayTipPoke', 'onlineFile', 'inlineKeyboard', 'unknown'])
      expect(await render(type)).toBeNull();
    const disabled = await render('text', 'QQ 未在线');
    expect(disabled?.getAttribute('aria-disabled')).toBe('true');
    expect(disabled?.title).toBe('QQ 未在线');
    await act(async () => disabled!.click());
    expect(forward).not.toHaveBeenCalled();
    const enabled = await render('text');
    await act(async () => enabled!.click());
    expect(forward).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
