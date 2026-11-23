import type { MenuItemConstructorOptions } from 'electron';
import { editMenuLabels, EMPTY_EDIT_MENU } from '../shared/edit_menu';

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
  undo?: () => void,
  redo?: () => void,
): MenuItemConstructorOptions[] {
  const labels = nativeMenuLabels(locale);
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
              acceleratorWorksWhenHidden: false,
            },
            {
              id: 'weq-edit-native-undo',
              role: 'undo',
              visible: false,
              acceleratorWorksWhenHidden: false,
            },
            redo
              ? {
                  id: 'weq-edit-redo',
                  label: editMenuLabels(locale, EMPTY_EDIT_MENU).redo,
                  accelerator: 'CmdOrCtrl+Shift+Z',
                  click: redo,
                  enabled: false,
                  acceleratorWorksWhenHidden: false,
                }
              : { role: 'redo' },
            ...(redo
              ? [
                  {
                    id: 'weq-edit-native-redo',
                    role: 'redo' as const,
                    visible: false,
                    acceleratorWorksWhenHidden: false,
                  },
                ]
              : []),
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
