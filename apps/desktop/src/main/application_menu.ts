import type { MenuItemConstructorOptions } from 'electron';
import type { ReadStateUndoAction } from '../shared/edit_menu';

export function nativeMenuLabels(locale: string) {
  return /^zh(?:-|_|$)/i.test(locale)
    ? {
        file: '文件',
        newWindow: '新建窗口',
        showWindow: '显示主窗口',
        restart: '重启 WeQ',
        quit: '退出 WeQ',
      }
    : {
        file: 'File',
        newWindow: 'New Window',
        showWindow: 'Show Main Window',
        restart: 'Restart WeQ',
        quit: 'Quit WeQ',
      };
}

function fileMenu(
  locale: string,
  newWindow: () => void,
  closeRole: 'close' | 'quit',
): MenuItemConstructorOptions {
  const labels = nativeMenuLabels(locale);
  return {
    label: labels.file,
    submenu: [
      { label: labels.newWindow, accelerator: 'CmdOrCtrl+N', click: newWindow },
      { type: 'separator' },
      { role: closeRole },
    ],
  };
}

export function desktopApplicationMenu(
  newWindow: () => void,
  locale: string,
): MenuItemConstructorOptions[] {
  return [
    fileMenu(locale, newWindow, 'quit'),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}

export function macApplicationMenu(
  newWindow: () => void,
  restart: () => void,
  locale = 'en',
  readStateUndo?: { action: ReadStateUndoAction; click: () => void },
): MenuItemConstructorOptions[] {
  const labels = nativeMenuLabels(locale);
  const zh = /^zh(?:-|_|$)/i.test(locale);
  const undoLabels = {
    'mark-read': zh ? '撤销标为已读' : 'Undo Mark as Read',
    'mark-unread': zh ? '撤销标为未读' : 'Undo Mark as Unread',
  };
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { label: labels.restart, click: restart },
        { role: 'quit' },
      ],
    },
    fileMenu(locale, newWindow, 'close'),
    {
      role: 'editMenu',
      label: zh ? '编辑' : 'Edit',
      submenu: [
        readStateUndo
          ? {
              label: undoLabels[readStateUndo.action],
              accelerator: 'CmdOrCtrl+Z',
              click: readStateUndo.click,
            }
          : { role: 'undo' },
        readStateUndo ? { label: zh ? '重做' : 'Redo', enabled: false } : { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: zh ? '语音' : 'Speech',
          submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
        },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
