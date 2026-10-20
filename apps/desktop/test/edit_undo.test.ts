import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  on: vi.fn(),
  appOn: vi.fn(),
  focused: vi.fn(),
  undoItem: { label: '', enabled: false, visible: true },
  redoItem: { label: '', enabled: false, visible: true },
  nativeUndo: { visible: false },
  nativeRedo: { visible: false },
}));
vi.mock('electron', () => ({
  app: {
    on: fixture.appOn,
    getPreferredSystemLanguages: () => ['zh-CN'],
    getLocale: () => 'zh-CN',
  },
  Menu: {
    getApplicationMenu: () => ({
      getMenuItemById: (id: string) =>
        id === 'weq-edit-undo'
          ? fixture.undoItem
          : id === 'weq-edit-redo'
            ? fixture.redoItem
            : id === 'weq-edit-native-undo'
              ? fixture.nativeUndo
              : id === 'weq-edit-native-redo'
                ? fixture.nativeRedo
                : null,
    }),
  },
  ipcMain: { on: fixture.on },
  webContents: { getFocusedWebContents: fixture.focused },
}));
import {
  registerEditUndoIpc,
  undoFocusedContent,
  redoFocusedContent,
  updateEditMenu,
} from '../src/main/edit_undo';

it('原生撤销仅派发给焦点窗口，未接桥、开发者工具及文字回退不受影响', () => {
  registerEditUndoIpc();
  const handler = (channel: string) => fixture.on.mock.calls.find(([name]) => name === channel)![1];
  const a = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn(), redo: vi.fn(), on: vi.fn() };
  const b = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn() };
  fixture.focused.mockReturnValue(a);
  updateEditMenu();
  expect(fixture.nativeUndo.visible).toBe(true);
  expect(fixture.nativeRedo.visible).toBe(true);
  expect(fixture.undoItem.visible).toBe(false);
  undoFocusedContent();
  expect(a.undo).toHaveBeenCalledTimes(1);
  handler('edit:undo-ready')({ sender: a });
  expect(fixture.undoItem.enabled).toBe(false);
  handler('edit:menu-state')({ sender: a }, { undo: 'mark-unread', redo: null });
  expect(fixture.undoItem).toEqual({ label: '撤销标为未读', enabled: true, visible: true });
  expect(fixture.redoItem).toEqual({ label: '重做', enabled: false, visible: true });
  expect(fixture.nativeUndo.visible).toBe(false);
  expect(fixture.nativeRedo.visible).toBe(false);
  redoFocusedContent();
  expect(a.redo).not.toHaveBeenCalled();
  undoFocusedContent();
  expect(a.send).toHaveBeenCalledWith('edit:undo');
  expect(a.undo).toHaveBeenCalledTimes(1);
  handler('edit:menu-state')({ sender: a }, { undo: null, redo: 'text' });
  expect(fixture.undoItem).toEqual({ label: '撤销', enabled: false, visible: false });
  expect(fixture.redoItem).toEqual({ label: '重做文本编辑', enabled: true, visible: false });
  expect(fixture.nativeUndo.visible).toBe(true);
  expect(fixture.nativeRedo.visible).toBe(true);
  redoFocusedContent();
  expect(a.redo).toHaveBeenCalledOnce();
  handler('edit:menu-state')({ sender: a }, { undo: 'invalid', redo: 'text' });
  expect(fixture.undoItem.enabled).toBe(false);
  fixture.focused.mockReturnValue(b);
  updateEditMenu();
  expect(fixture.nativeUndo.visible).toBe(true);
  undoFocusedContent();
  expect(b.undo).toHaveBeenCalledTimes(1);
  expect(b.send).not.toHaveBeenCalled();
  handler('edit:undo-text')({ sender: a });
  expect(a.undo).toHaveBeenCalledTimes(2);
  fixture.focused.mockReturnValue(a);
  fixture.appOn.mock.calls.find(([event]) => event === 'web-contents-created')![1]({}, a);
  handler('edit:menu-state')({ sender: a }, { undo: 'mark-read', redo: null });
  expect(fixture.undoItem.visible).toBe(true);
  a.on.mock.calls.find(([event]) => event === 'render-process-gone')![1]();
  expect(fixture.nativeUndo.visible).toBe(true);
  expect(fixture.undoItem.visible).toBe(false);
  fixture.focused.mockReturnValue(null);
  updateEditMenu();
  expect(fixture.undoItem.visible).toBe(false);
  expect(fixture.undoItem.enabled).toBe(false);
  expect(fixture.nativeUndo.visible).toBe(true);
  expect(undoFocusedContent).not.toThrow();
});
