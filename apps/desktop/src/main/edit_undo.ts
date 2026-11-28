import { app, ipcMain, Menu, webContents, type WebContents } from 'electron';
import type { ReadStateUndoAction } from '../shared/edit_menu';
import { macApplicationMenu } from './application_menu';

const states = new WeakMap<WebContents, ReadStateUndoAction>();
let updateMacMenu: (() => void) | undefined;

export function installMacApplicationMenu(
  newWindow: () => void,
  restart: () => void,
  locale: string,
): void {
  let currentAction: ReadStateUndoAction | null | undefined;
  updateMacMenu = () => {
    const focused = webContents.getFocusedWebContents();
    const action = focused && !focused.isDestroyed() ? (states.get(focused) ?? null) : null;
    if (action === currentAction) return;
    currentAction = action;
    // macOS 构建菜单时，同一个快捷键只能绑定一次，隐藏的菜单项也会占用绑定。
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        macApplicationMenu(
          newWindow,
          restart,
          locale,
          action ? { action, click: undoFocusedReadState } : undefined,
        ),
      ),
    );
  };
  updateMacMenu();
}

export function registerEditUndoIpc(): void {
  const refresh = () => updateMacMenu?.();
  ipcMain.on('edit:undo-ready', (event) => {
    states.delete(event.sender);
    refresh();
  });
  ipcMain.on('edit:menu-state', (event, action: unknown) => {
    if (action === null) states.delete(event.sender);
    else if (action === 'mark-read' || action === 'mark-unread') states.set(event.sender, action);
    else return;
    refresh();
  });
  ipcMain.on('edit:undo-text', (event) => {
    if (!event.sender.isDestroyed() && event.sender === webContents.getFocusedWebContents())
      event.sender.undo();
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('focus', refresh);
    contents.on('render-process-gone', () => {
      states.delete(contents);
      refresh();
    });
    contents.on('destroyed', refresh);
  });
  app.on('browser-window-focus', refresh);
  app.on('browser-window-blur', refresh);
}

function undoFocusedReadState(): void {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  if (states.has(focused)) focused.send('edit:undo');
  else focused.undo();
}
