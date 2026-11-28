// @vitest-environment node
import { expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  on: vi.fn(),
  appOn: vi.fn(),
  focused: vi.fn(),
  setMenu: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: fixture.appOn },
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: fixture.setMenu,
  },
  ipcMain: { on: fixture.on },
  webContents: { getFocusedWebContents: fixture.focused },
}));
import { installMacApplicationMenu, registerEditUndoIpc } from '../src/main/edit_undo';
import type { MenuItemConstructorOptions } from 'electron';

it('只在当前窗口的会话撤销状态变化时更新菜单，其他编辑上下文交还原生操作', () => {
  registerEditUndoIpc();
  const handler = (channel: string) => fixture.on.mock.calls.find(([name]) => name === channel)![1];
  const appHandler = (event: string) =>
    fixture.appOn.mock.calls.find(([name]) => name === event)![1];
  const edit = () => {
    const menu: MenuItemConstructorOptions[] = fixture.setMenu.mock.lastCall![0];
    return menu.find((item) => item.role === 'editMenu')!.submenu as MenuItemConstructorOptions[];
  };
  const nativeEdit = () =>
    expect(
      edit()
        .slice(0, 2)
        .map((item) => item.role),
    ).toEqual(['undo', 'redo']);
  const a = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn(), on: vi.fn() };
  const b = { isDestroyed: () => false, send: vi.fn(), undo: vi.fn() };
  fixture.focused.mockReturnValue(a);
  appHandler('web-contents-created')({}, a);
  installMacApplicationMenu(vi.fn(), vi.fn(), 'zh-CN');
  nativeEdit();

  handler('edit:menu-state')({ sender: a }, 'mark-unread');
  expect(edit()[0]).toMatchObject({ label: '撤销标为未读', accelerator: 'CmdOrCtrl+Z' });
  const click = edit()[0]!.click as () => void;
  click();
  expect(a.send).toHaveBeenCalledWith('edit:undo');

  handler('edit:menu-state')({ sender: a }, 'mark-unread');
  handler('edit:menu-state')({ sender: b }, 'mark-read');
  handler('edit:menu-state')({ sender: a }, 'invalid');
  expect(fixture.setMenu).toHaveBeenCalledTimes(2);

  handler('edit:menu-state')({ sender: a }, null);
  nativeEdit();
  handler('edit:undo-text')({ sender: a });
  expect(a.undo).toHaveBeenCalledOnce();

  fixture.focused.mockReturnValue(b);
  appHandler('browser-window-focus')();
  expect(edit()[0]?.label).toBe('撤销标为已读');
  handler('edit:undo-text')({ sender: a });
  expect(a.undo).toHaveBeenCalledOnce();
  handler('edit:undo-ready')({ sender: b });
  nativeEdit();

  fixture.focused.mockReturnValue(a);
  handler('edit:menu-state')({ sender: a }, 'mark-read');
  a.on.mock.calls.find(([event]) => event === 'render-process-gone')![1]();
  nativeEdit();
  fixture.focused.mockReturnValue(null);
  appHandler('browser-window-blur')();
  nativeEdit();
});
