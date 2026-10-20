import { app, ipcMain, Menu, webContents, type WebContents } from 'electron';
import { editMenuLabels, EMPTY_EDIT_MENU, type EditMenuState } from '../shared/edit_menu';

const bridged = new WeakSet<WebContents>();
const states = new WeakMap<WebContents, EditMenuState>();

export function updateEditMenu(): void {
  const focused = webContents.getFocusedWebContents();
  const state: EditMenuState =
    focused && !focused.isDestroyed() ? (states.get(focused) ?? EMPTY_EDIT_MENU) : EMPTY_EDIT_MENU;
  const labels = editMenuLabels(app.getPreferredSystemLanguages()[0] ?? app.getLocale(), state);
  const business = Boolean(
    focused &&
      !focused.isDestroyed() &&
      bridged.has(focused) &&
      (state.undo === 'mark-read' || state.undo === 'mark-unread') &&
      state.redo === null,
  );
  const nativeText = !business;
  const menu = Menu.getApplicationMenu();
  for (const action of ['undo', 'redo'] as const) {
    const item = menu?.getMenuItemById(`weq-edit-${action}`);
    if (item) {
      item.label = labels[action];
      item.enabled = state[action] !== null;
      item.visible = !nativeText;
    }
    const nativeItem = menu?.getMenuItemById(`weq-edit-native-${action}`);
    if (nativeItem) nativeItem.visible = nativeText;
  }
}

export function registerEditUndoIpc(): void {
  ipcMain.on('edit:undo-ready', (event) => {
    bridged.add(event.sender);
    states.delete(event.sender);
    updateEditMenu();
  });
  ipcMain.on('edit:menu-state', (event, state: unknown) => {
    if (!state || typeof state !== 'object') return;
    const candidate = state as Partial<EditMenuState>;
    if (
      (candidate.undo !== null &&
        candidate.undo !== 'text' &&
        candidate.undo !== 'mark-read' &&
        candidate.undo !== 'mark-unread') ||
      (candidate.redo !== null && candidate.redo !== 'text')
    )
      return;
    states.set(event.sender, candidate as EditMenuState);
    updateEditMenu();
  });
  ipcMain.on('edit:undo-text', (event) => {
    if (!event.sender.isDestroyed()) {
      event.sender.undo();
      event.sender.send('edit:refresh');
    }
  });
  app.on('web-contents-created', (_event, contents) => {
    contents.on('focus', updateEditMenu);
    contents.on('render-process-gone', () => {
      states.delete(contents);
      bridged.delete(contents);
      updateEditMenu();
    });
    contents.on('destroyed', updateEditMenu);
  });
  app.on('browser-window-focus', updateEditMenu);
  app.on('browser-window-blur', updateEditMenu);
}

export function redoFocusedContent(): void {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  if (bridged.has(focused) && states.get(focused)?.redo !== 'text') return;
  focused.redo();
  focused.send('edit:refresh');
}

/** 无桥接的网页或开发者工具仍由 Electron 原生撤销。 */
export function undoFocusedContent(): void {
  const focused = webContents.getFocusedWebContents();
  if (!focused || focused.isDestroyed()) return;
  if (bridged.has(focused)) focused.send('edit:undo');
  else focused.undo();
}
