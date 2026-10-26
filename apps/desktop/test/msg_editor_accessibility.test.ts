import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MsgElementEditor } from '../src/renderer/src/components/MsgElementEditor';

it('names the editor and close action, traps focus, and restores it after Escape', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [open, setOpen] = useState(false);
    return h(
      'div',
      {},
      h('button', { id: 'editor-trigger', onClick: () => setOpen(true) }, '编辑消息'),
      open
        ? h(MsgElementEditor, {
            msgId: 'synthetic',
            elements: [{ kind: 'text', text: '合成内容' }],
            onSave: async () => {},
            onClose: () => setOpen(false),
          })
        : null,
    );
  }
  try {
    act(() => root.render(h(Harness)));
    const trigger = host.querySelector<HTMLButtonElement>('#editor-trigger')!;
    trigger.focus();
    act(() => trigger.click());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)?.textContent).toContain('修改本地消息元件');
    const close = dialog.querySelector<HTMLButtonElement>('[aria-label="关闭消息编辑器"]')!;
    expect(close).not.toBeNull();
    expect(document.activeElement).toBe(close);
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    expect(document.activeElement).toBe(buttons.at(-1));
    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
