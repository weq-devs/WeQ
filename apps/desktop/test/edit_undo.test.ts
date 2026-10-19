import { expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ on: vi.fn(), focused: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { on: fixture.on },
  webContents: { getFocusedWebContents: fixture.focused },
}));
import { registerEditUndoIpc, undoFocusedContent } from '../src/main/edit_undo';

it('原生撤销仅派发给焦点窗口，未接桥、开发者工具及文字回退不受影响', () => {
  registerEditUndoIpc();
  const handler = (channel: string) => fixture.on.mock.calls.find(([name]) => name === channel)![1];
  const a = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn() };
  const b = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn() };
  fixture.focused.mockReturnValue(a);
  undoFocusedContent();
  expect(a.undo).toHaveBeenCalledTimes(1);
  handler('edit:undo-ready')({ sender: a });
  undoFocusedContent();
  expect(a.send).toHaveBeenCalledWith('edit:undo');
  expect(a.undo).toHaveBeenCalledTimes(1);
  fixture.focused.mockReturnValue(b);
  undoFocusedContent();
  expect(b.undo).toHaveBeenCalledTimes(1);
  expect(b.send).not.toHaveBeenCalled();
  handler('edit:undo-text')({ sender: a });
  expect(a.undo).toHaveBeenCalledTimes(2);
  fixture.focused.mockReturnValue(null);
  expect(undoFocusedContent).not.toThrow();
});
