import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';

afterEach(() => {
  useDialog.getState().close();
  vi.unstubAllGlobals();
});

it('系统子窗中的确认框及 Esc 留在该窗口，不出现在主窗口', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(DialogHost)));
    let result: Promise<boolean>;
    act(() => {
      result = useDialog.getState().confirm('删除群文件', '合成确认', {
        ownerDocument: popup.document as unknown as Document,
      });
    });
    expect(document.querySelector('.weq-message-modal')).toBeNull();
    expect(popup.document.querySelector('.weq-message-modal')).not.toBeNull();
    act(() => {
      popup.document.dispatchEvent(new popup.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await expect(result!).resolves.toBe(false);
    expect(popup.document.querySelector('.weq-message-modal')).toBeNull();
  } finally {
    act(() => root.unmount());
    popup.close();
  }
});

it('关闭所属系统子窗会结束等待中的确认，不影响之后主窗口的消息框', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new HappyWindow();
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(DialogHost)));
    let result: Promise<boolean>;
    act(() => {
      result = useDialog.getState().confirm('移动群文件', '合成确认', {
        ownerDocument: popup.document as unknown as Document,
      });
    });
    act(() => popup.dispatchEvent(new popup.Event('beforeunload')));
    await expect(result!).resolves.toBe(false);
    act(() => useDialog.getState().showInfo('已完成', '合成主窗口提示'));
    expect(document.querySelector('.weq-message-modal')).not.toBeNull();
    act(() => popup.dispatchEvent(new popup.Event('unload')));
    expect(useDialog.getState().current?.title).toBe('已完成');
  } finally {
    act(() => root.unmount());
    popup.close();
  }
});
