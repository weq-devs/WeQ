import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  on: vi.fn(),
  focused: vi.fn(),
  undoItem: { label: '', enabled: false },
  redoItem: { label: '', enabled: false },
}));
vi.mock('electron', () => ({
  app: { on: vi.fn(), getPreferredSystemLanguages: () => ['zh-CN'], getLocale: () => 'zh-CN' },
  Menu: {
    getApplicationMenu: () => ({
      getMenuItemById: (id: string) =>
        id === 'weq-edit-undo' ? fixture.undoItem : fixture.redoItem,
    }),
  },
  ipcMain: { on: fixture.on },
  webContents: { getFocusedWebContents: fixture.focused },
}));
import { registerEditUndoIpc, undoFocusedContent, redoFocusedContent } from '../src/main/edit_undo';

it('原生撤销仅派发给焦点窗口，未接桥、开发者工具及文字回退不受影响', () => {
  registerEditUndoIpc();
  const handler = (channel: string) => fixture.on.mock.calls.find(([name]) => name === channel)![1];
  const a = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn(), redo: vi.fn() };
  const b = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn() };
  fixture.focused.mockReturnValue(a);
  undoFocusedContent();
  expect(a.undo).toHaveBeenCalledTimes(1);
  handler('edit:undo-ready')({ sender: a });
  expect(fixture.undoItem.enabled).toBe(false);
  handler('edit:menu-state')({ sender: a }, { undo: 'mark-unread', redo: null });
  expect(fixture.undoItem).toEqual({ label: '撤销标为未读', enabled: true });
  expect(fixture.redoItem).toEqual({ label: '重做', enabled: false });
  redoFocusedContent();
  expect(a.redo).not.toHaveBeenCalled();
  undoFocusedContent();
  expect(a.send).toHaveBeenCalledWith('edit:undo');
  expect(a.undo).toHaveBeenCalledTimes(1);
  handler('edit:menu-state')({ sender: a }, { undo: null, redo: 'text' });
  expect(fixture.undoItem).toEqual({ label: '撤销', enabled: false });
  expect(fixture.redoItem).toEqual({ label: '重做文本编辑', enabled: true });
  redoFocusedContent();
  expect(a.redo).toHaveBeenCalledOnce();
  handler('edit:menu-state')({ sender: a }, { undo: 'invalid', redo: 'text' });
  expect(fixture.undoItem.enabled).toBe(false);
  fixture.focused.mockReturnValue(b);
  undoFocusedContent();
  expect(b.undo).toHaveBeenCalledTimes(1);
  expect(b.send).not.toHaveBeenCalled();
  handler('edit:undo-text')({ sender: a });
  expect(a.undo).toHaveBeenCalledTimes(2);
  fixture.focused.mockReturnValue(null);
  expect(undoFocusedContent).not.toThrow();
});
