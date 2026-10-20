import type { MenuItemConstructorOptions } from 'electron';
import { editMenuLabels, EMPTY_EDIT_MENU } from '../shared/edit_menu';

export function nativeMenuLabels(locale: string) {
  return /^zh(?:-|_|$)/i.test(locale)
    ? { file: '文件', newWindow: '新建窗口', showWindow: '显示主窗口', quit: '退出 WeQ' }
    : { file: 'File', newWindow: 'New Window', showWindow: 'Show Main Window', quit: 'Quit WeQ' };
}

export function macApplicationMenu(
  openMainWindow: () => void,
  locale = 'en',
  undo?: () => void,
  redo?: () => void,
): MenuItemConstructorOptions[] {
  const labels = nativeMenuLabels(locale);
  return [
    { role: 'appMenu' },
    {
      label: labels.file,
      submenu: [
        { label: labels.newWindow, accelerator: 'CmdOrCtrl+N', click: openMainWindow },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    undo
      ? {
          role: 'editMenu',
          label: /^zh(?:-|_|$)/i.test(locale) ? '编辑' : 'Edit',
          submenu: [
            {
              id: 'weq-edit-undo',
              label: editMenuLabels(locale, EMPTY_EDIT_MENU).undo,
              accelerator: 'CmdOrCtrl+Z',
              click: undo,
              enabled: false,
            },
            redo
              ? {
                  id: 'weq-edit-redo',
                  label: editMenuLabels(locale, EMPTY_EDIT_MENU).redo,
                  accelerator: 'CmdOrCtrl+Shift+Z',
                  click: redo,
                  enabled: false,
                }
              : { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            {
              label: /^zh(?:-|_|$)/i.test(locale) ? '语音' : 'Speech',
              submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
            },
          ],
        }
      : { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
