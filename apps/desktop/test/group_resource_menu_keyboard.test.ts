import { act, createElement, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationActionsMenu } from '../src/renderer/src/components/ConversationActionsMenu';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';
import { RenderDocumentContext } from '../src/renderer/src/lib/renderDocument';

vi.mock('../src/renderer/src/components/RemoteShellMenus', () => ({
  RemoteShellMenuItem: () => null,
}));

afterEach(() => vi.unstubAllGlobals());

it('系统子窗菜单的 Esc 不被背后的文件多选监听抢走，收起后仍可清除文件选择', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const exit = vi.fn();
  function FileList() {
    const [selected, setSelected] = useState(new Set(['file-a']));
    const [menu, setMenu] = useState(false);
    const multi = useMultiSelection({
      ids: ['file-a'],
      selected,
      onChange: setSelected,
      onExit: () => {
        exit();
        setSelected(new Set());
      },
    });
    return createElement(
      'div',
      multi.rootProps,
      createElement(
        'button',
        {
          ...multi.itemProps('file-a'),
          'data-file': 'file-a',
          onContextMenu: (event) => {
            event.preventDefault();
            setMenu(true);
          },
        },
        '合成文件',
      ),
      createElement('output', null, String(selected.size)),
      menu
        ? createElement(ConversationActionsMenu, {
            x: 16,
            y: 16,
            label: '群文件操作',
            onClose: () => setMenu(false),
            actions: [{ label: '重命名', icon: null, action: () => {} }],
          })
        : null,
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createPortal(
          createElement(
            RenderDocumentContext.Provider,
            { value: popup.document as unknown as Document },
            createElement(FileList),
          ),
          popup.document.body as unknown as HTMLElement,
        ),
      ),
    );
    const file = popup.document.querySelector<HTMLButtonElement>('[data-file]')!;
    act(() => {
      file.focus();
      file.dispatchEvent(new popup.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(popup.document.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      popup.document.activeElement!.dispatchEvent(
        new popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(popup.document.querySelector('[role="menu"]')).toBeNull();
    expect(exit).not.toHaveBeenCalled();
    expect(popup.document.querySelector('output')?.textContent).toBe('1');
    act(() => {
      file.focus();
      file.dispatchEvent(
        new popup.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(exit).toHaveBeenCalledOnce();
    expect(popup.document.querySelector('output')?.textContent).toBe('0');
  } finally {
    act(() => root.unmount());
    popup.close();
  }
});
